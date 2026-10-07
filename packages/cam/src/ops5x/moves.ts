// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { ToolpathMove, Vec3 } from "../model/toolpath";
import { addScaled, type Mat3, mulMV, transpose, Z_AXIS } from "./vec";

/**
 * Move-list helpers shared by the 5-axis operations and posts: arcs and drill cycles turned
 * into straight moves (a tilted plane or a simultaneous block has no G2/G3 or canned cycle),
 * and toolpaths mapped between a tilted frame and the WCS.
 */

type ArcMove = Extract<ToolpathMove, { kind: "arc" }>;
type DrillMove = Extract<ToolpathMove, { kind: "drill" }>;

/** In-plane (u, v) and normal coordinate indices of an arc plane; u × v = +normal. */
const PLANE_AXES: Record<ArcMove["plane"], readonly [number, number, number]> = {
    XY: [0, 1, 2],
    ZX: [2, 0, 1],
    YZ: [1, 2, 0],
};

/** Points along an arc from `from` (excluded) to `arc.to` (included), within `tolerance` of the arc. */
export function arcPoints(from: Vec3, arc: ArcMove, tolerance: number): Vec3[] {
    const [iu, iv, iw] = PLANE_AXES[arc.plane];
    const su = from[iu] - arc.center[iu];
    const sv = from[iv] - arc.center[iv];
    const eu = arc.to[iu] - arc.center[iu];
    const ev = arc.to[iv] - arc.center[iv];
    const r0 = Math.hypot(su, sv);
    const r1 = Math.hypot(eu, ev);
    const a0 = Math.atan2(sv, su);
    let sweep = Math.atan2(ev, eu) - a0;
    if (arc.clockwise) {
        while (sweep >= -1e-12) sweep -= 2 * Math.PI;
    } else {
        while (sweep <= 1e-12) sweep += 2 * Math.PI;
    }
    const radius = Math.max(r0, r1);
    const step =
        radius > tolerance ? 2 * Math.acos(Math.max(-1, 1 - tolerance / radius)) : Math.abs(sweep) || 1;
    const count = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-6)));
    const points: Vec3[] = [];
    for (let i = 1; i <= count; i++) {
        if (i === count) {
            points.push(arc.to);
            break;
        }
        const t = i / count;
        const angle = a0 + sweep * t;
        const r = r0 + (r1 - r0) * t;
        const point = [0, 0, 0];
        point[iu] = arc.center[iu] + r * Math.cos(angle);
        point[iv] = arc.center[iv] + r * Math.sin(angle);
        point[iw] = from[iw] + (arc.to[iw] - from[iw]) * t;
        points.push(point as unknown as Vec3);
    }
    return points;
}

/**
 * A drill cycle as straight moves along −Z of its frame. `at` is the hole at its top,
 * `depth` the distance below it, `retract` the absolute height of the retract (R) plane —
 * a value below the hole top reads as a clearance above it.
 */
export function expandDrill(move: DrillMove): ToolpathMove[] {
    const [x, y, top] = move.at;
    const rPlane = move.retract >= top ? move.retract : top + Math.abs(move.retract);
    const bottom = top - Math.abs(move.depth);
    const at = (z: number): Vec3 => [x, y, z];
    const out: ToolpathMove[] = [{ kind: "rapid", to: at(rPlane) }];
    const dwell = (): void => {
        if (move.dwell !== undefined && move.dwell > 0) out.push({ kind: "dwell", seconds: move.dwell });
    };
    const peck = move.peck !== undefined && move.peck > 0 ? move.peck : undefined;
    if ((move.cycle === "peck" || move.cycle === "chipBreak") && peck !== undefined) {
        let z = top;
        while (z > bottom + 1e-9) {
            const next = Math.max(bottom, z - peck);
            if (move.cycle === "peck" && z < top)
                out.push({ kind: "rapid", to: at(Math.min(z + 0.5, rPlane)) });
            out.push({ kind: "linear", to: at(next), feed: move.feed });
            if (move.cycle === "peck") out.push({ kind: "rapid", to: at(rPlane) });
            else if (next > bottom + 1e-9) out.push({ kind: "rapid", to: at(next + 0.5) });
            z = next;
        }
        dwell();
    } else {
        out.push({ kind: "linear", to: at(bottom), feed: move.feed });
        dwell();
    }
    const feedOut = move.cycle === "tap" || move.cycle === "bore";
    out.push(
        feedOut ? { kind: "linear", to: at(rPlane), feed: move.feed } : { kind: "rapid", to: at(rPlane) },
    );
    return out;
}

/**
 * The moves with arcs and drill cycles expanded into rapid/linear moves (arcs within
 * `tolerance`). Moves that are not milling motion (taper, extrude, cutter on/off) fail.
 */
export function straightMoves(moves: readonly ToolpathMove[], tolerance: number): Result<ToolpathMove[]> {
    const out: ToolpathMove[] = [];
    let at: Vec3 | undefined;
    for (const move of moves) {
        switch (move.kind) {
            case "arc": {
                if (at === undefined) return Result.err("An arc move has no start point");
                for (const point of arcPoints(at, move, tolerance)) {
                    out.push({ kind: "linear", to: point, feed: move.feed });
                }
                at = move.to;
                break;
            }
            case "drill": {
                const expanded = expandDrill(move);
                out.push(...expanded);
                at = (expanded.at(-1) as { to: Vec3 }).to;
                break;
            }
            case "rapid":
            case "linear":
                out.push(move);
                at = move.to;
                break;
            case "dwell":
            case "comment":
            case "raw":
                out.push(move);
                break;
            default:
                return Result.err(`A "${move.kind}" move is not milling motion`);
        }
    }
    return Result.ok(out);
}

/** p_wcs = origin + F·p_frame */
export function frameToWcs(frame: Mat3, origin: Vec3, point: Vec3): Vec3 {
    return addScaled(origin, mulMV(frame, point), 1);
}

/** p_frame = Fᵀ·(p_wcs − origin) */
export function wcsToFrame(frame: Mat3, origin: Vec3, point: Vec3): Vec3 {
    return mulMV(transpose(frame), addScaled(point, origin, -1));
}

/**
 * Moves programmed in a tilted frame (columns of `frame` in WCS, at `origin`) mapped back
 * to WCS: positions through the frame, every motion with the frame's +Z (or its own axis,
 * rotated) as tool axis; arcs and drill cycles become straight moves first.
 */
export function mapFrameMoves(
    moves: readonly ToolpathMove[],
    frame: Mat3,
    origin: Vec3,
    tolerance: number,
): Result<ToolpathMove[]> {
    const straight = straightMoves(moves, tolerance);
    if (!straight.isOk) return straight;
    return Result.ok(
        straight.value.map((move): ToolpathMove => {
            if (move.kind !== "rapid" && move.kind !== "linear") return move;
            const to = frameToWcs(frame, origin, move.to);
            const axis = mulMV(frame, move.axis ?? Z_AXIS);
            return move.kind === "rapid"
                ? { kind: "rapid", to, axis }
                : { kind: "linear", to, feed: move.feed, axis };
        }),
    );
}
