// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { fitArcs } from "../geometry2d/arcs";
import { offset } from "../geometry2d/clip";
import { nearestNeighborOrder } from "../geometry2d/order";
import {
    nearestArcLength,
    type Path2,
    type PathSegment,
    pathLength,
    pathPointAt,
    pathPoints,
    pathTangentAt,
    reversePath,
    startClosedPathAt,
    subPath,
} from "../geometry2d/path";
import { oriented, pointInPolygon, removeDuplicatePoints } from "../geometry2d/polygon";
import { add, distance, lerp, normalize, type Point2, perpLeft, scale, sub } from "../geometry2d/vec";
import type { CamOperationContext, CamOperationHandler, CamParameterSpec } from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolpathData, Vec3 } from "../model/toolpath";
import { toolpathOf } from "./common";
import { deepestPoint } from "./entries";
import { selectionGeometry } from "./geometry";
import { MoveBuilder } from "./moves";
import { options, ParamReader, when } from "./params";

/**
 * Wire EDM contours: each closed loop is cut from a threading point (start hole) with an
 * approach move, a rough pass offset by the wire radius plus spark gap plus the stock left
 * for skims, and N skim passes at decreasing offsets (alternating direction). A punch keeps
 * the inside (wire outside the loop), a die the outside. A tab — the last stretch of the
 * contour — stays uncut until a final separation pass after an optional stop.
 *
 * Moves are at the program plane height (`machine.wire.programPlaneHeight`). A constant
 * taper makes `taper` moves whose upper guide point lies at the UV plane height, offset
 * sideways by tan(angle) · (uvPlaneHeight − programPlaneHeight): each upper edge is the
 * lower edge moved exactly that far (corners mitred, arcs concentric).
 */

export const WIRE_PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "cutType",
        label: "Keep",
        kind: "enum",
        options: options({ punch: "Inside (punch)", die: "Outside (die)" }),
    },
    {
        key: "direction",
        label: "Direction",
        kind: "enum",
        options: options({ cw: "Clockwise", ccw: "Counter-clockwise" }),
    },
    { key: "sparkGap", label: "Spark gap (rough)", kind: "length", min: 0 },
    { key: "skims", label: "Skim passes", kind: "integer", min: 0, max: 9 },
    {
        key: "skimStock",
        label: "Stock for skims",
        kind: "length",
        min: 0,
        visibleWhen: when("skims", 1, 2, 3, 4, 5, 6, 7, 8, 9),
    },
    {
        key: "skimSparkGap",
        label: "Spark gap (skims)",
        kind: "length",
        min: 0,
        visibleWhen: when("skims", 1, 2, 3, 4, 5, 6, 7, 8, 9),
    },
    { key: "alternateSkims", label: "Alternate skim direction", kind: "boolean" },
    { key: "taperAngle", label: "Taper angle", kind: "angle", min: 0 },
    {
        key: "taperLean",
        label: "Upper guide leans to",
        kind: "enum",
        options: options({ scrap: "The scrap (part widens upward)", part: "The part (part narrows upward)" }),
    },
    {
        key: "approachLength",
        label: "Approach length",
        kind: "length",
        min: 0,
        description: "Start hole distance from the contour",
    },
    { key: "startX", label: "Start hole X", kind: "length", description: "Empty: automatic" },
    { key: "startY", label: "Start hole Y", kind: "length", description: "Empty: automatic" },
    { key: "tabLength", label: "Tab (separation) length", kind: "length", min: 0 },
    { key: "stopBeforeSeparation", label: "Stop before separation", kind: "boolean" },
    { key: "feed", label: "Rough feed", kind: "number", min: 0, description: "mm/min" },
    { key: "skimFeed", label: "Skim feed", kind: "number", min: 0, description: "mm/min" },
];

export interface WireSettings {
    readonly punch: boolean;
    readonly ccw: boolean;
    readonly wireRadius: number;
    readonly sparkGap: number;
    readonly skims: number;
    readonly skimStock: number;
    readonly skimSparkGap: number;
    readonly alternate: boolean;
    readonly taper: number;
    readonly leanToScrap: boolean;
    readonly approach: number;
    readonly start?: Point2;
    readonly tab: number;
    readonly stop: boolean;
    readonly feed: number;
    readonly skimFeed: number;
    readonly programZ: number;
    readonly uvZ: number;
}

/** Offset of each pass from the profile: rough first, then the skims, decreasing. */
export function passOffsets(
    s: Pick<WireSettings, "wireRadius" | "sparkGap" | "skims" | "skimStock" | "skimSparkGap">,
): number[] {
    const out = [s.wireRadius + s.sparkGap + (s.skims > 0 ? s.skimStock : 0)];
    for (let i = 1; i <= s.skims; i++)
        out.push(s.wireRadius + s.skimSparkGap + (s.skimStock * (s.skims - i)) / s.skims);
    return out;
}

/** Sideways distance of the upper guide at the UV plane for a taper angle (degrees). */
export function taperOffset(angle: number, programZ: number, uvZ: number): number {
    return Math.tan((angle * Math.PI) / 180) * (uvZ - programZ);
}

/**
 * The upper guide points of a polyline whose edges all lean `d` to the left of travel
 * (negative: right): each upper edge is the lower edge moved by `d`, corners mitred.
 */
export function upperPoints(points: readonly Point2[], closed: boolean, d: number): Point2[] {
    const n = points.length;
    const normals: Point2[] = [];
    const count = closed ? n : n - 1;
    for (let i = 0; i < count; i++) normals.push(perpLeft(normalize(sub(points[(i + 1) % n], points[i]))));
    return points.map((p, i) => {
        const before = closed ? normals[(i - 1 + n) % n] : normals[Math.max(0, i - 1)];
        const after = closed ? normals[i % n] : normals[Math.min(count - 1, i)];
        const sum = add(before, after);
        const cos = before[0] * after[0] + before[1] * after[1];
        if (1 + cos < 1e-9) return add(p, scale(after, d));
        return add(p, scale(sum, d / (1 + cos)));
    });
}

export function wireSettings(p: ParamReader, context: CamOperationContext): WireSettings {
    const wire = context.machine.wire;
    const tool = context.tool;
    const skims = Math.max(0, Math.min(9, p.int("skims", 0)));
    const sparkGap = Math.max(0, p.num("sparkGap", wire?.sparkGap ?? 0.02));
    const punch = p.pick("cutType", ["punch", "die"] as const, "punch") === "punch";
    const startX = p.optionalNum("startX");
    const startY = p.optionalNum("startY");
    const feed = p.num("feed", tool.cutting.feed);
    return {
        punch,
        ccw: p.pick("direction", ["cw", "ccw"] as const, "cw") === "ccw",
        wireRadius: (wire?.wireDiameter ?? tool.diameter) / 2,
        sparkGap,
        skims,
        skimStock: Math.max(0, p.num("skimStock", 0.05)),
        skimSparkGap: Math.max(0, p.num("skimSparkGap", sparkGap / 2)),
        alternate: p.bool("alternateSkims", true),
        taper: Math.max(0, p.num("taperAngle", 0)),
        leanToScrap: p.pick("taperLean", ["scrap", "part"] as const, "scrap") === "scrap",
        approach: Math.max(0.1, p.num("approachLength", 3)),
        ...(startX !== undefined && startY !== undefined ? { start: [startX, startY] as Point2 } : {}),
        tab: Math.max(0, p.num("tabLength", punch ? 3 : 0)),
        stop: p.bool("stopBeforeSeparation", true),
        feed,
        skimFeed: p.num("skimFeed", feed * 2),
        programZ: wire?.programPlaneHeight ?? 0,
        uvZ: wire?.uvPlaneHeight ?? 0,
    };
}

interface WirePass {
    readonly path: Path2;
    readonly feed: number;
    readonly label: string;
}

/** A pass path flattened to 1 µm chords with its upper guide points and chord lengths. */
interface Sampled {
    readonly points: readonly Point2[];
    readonly uppers: readonly Point2[];
    /** Cumulative chord length at each point; the closing chord ends at `total`. */
    readonly cum: readonly number[];
    readonly total: number;
    /** Chord length per path length (to map path positions onto the chords). */
    readonly ratio: number;
}

function sample(path: Path2, d: number): Sampled {
    const points = pathPoints(path, 0.001);
    const uppers = upperPoints(points, true, d);
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distance(points[i - 1], points[i]));
    const total = cum[cum.length - 1] + distance(points[points.length - 1], points[0]);
    return { points, uppers, cum, total, ratio: total / Math.max(1e-12, pathLength(path)) };
}

/** The lower and upper point `s` along the chords (s in [0, total]). */
function sampleAt(sampled: Sampled, s: number): { p: Point2; u: Point2 } {
    const n = sampled.points.length;
    for (let i = 0; i < n; i++) {
        const end = i + 1 < n ? sampled.cum[i + 1] : sampled.total;
        if (s <= end + 1e-12 || i === n - 1) {
            const length = end - sampled.cum[i];
            const t = length < 1e-15 ? 0 : Math.max(0, Math.min(1, (s - sampled.cum[i]) / length));
            const j = (i + 1) % n;
            return {
                p: lerp(sampled.points[i], sampled.points[j], t),
                u: lerp(sampled.uppers[i], sampled.uppers[j], t),
            };
        }
    }
    return { p: sampled.points[0], u: sampled.uppers[0] };
}

/** Taper moves along the chords from `s0` to `s1` (backwards when `s1 < s0`). */
function emitTaperRange(
    builder: MoveBuilder,
    sampled: Sampled,
    s0: number,
    s1: number,
    feed: number,
    s: WireSettings,
) {
    const at = (q: { p: Point2; u: Point2 }) =>
        builder.push({
            kind: "taper",
            to: [q.p[0], q.p[1], s.programZ],
            upper: [q.u[0], q.u[1], s.uvZ],
            feed,
        });
    const n = sampled.points.length;
    if (s1 >= s0) {
        for (let k = 0; k < n; k++) {
            if (sampled.cum[k] > s0 + 1e-9 && sampled.cum[k] < s1 - 1e-9)
                at({ p: sampled.points[k], u: sampled.uppers[k] });
        }
    } else {
        for (let k = n - 1; k >= 0; k--) {
            if (sampled.cum[k] < s0 - 1e-9 && sampled.cum[k] > s1 + 1e-9)
                at({ p: sampled.points[k], u: sampled.uppers[k] });
        }
    }
    at(sampleAt(sampled, s1));
}

/** Emits one contour: approach, rough and skims short of the tab, then the separation. */
function emitWireContour(
    builder: MoveBuilder,
    loop: readonly Point2[],
    s: WireSettings,
    from: Point2,
): Result<void> {
    const ccwLoop = oriented(loop, true);
    // The scrap side: outside a punch, inside a die.
    const sign = s.punch ? 1 : -1;
    const offsets = passOffsets(s);
    const hint = s.start ?? from;
    const passes: WirePass[] = [];
    for (let i = 0; i < offsets.length; i++) {
        const loops = offset([ccwLoop], sign * offsets[i]);
        if (loops.length === 0) return Result.err("The wire does not fit inside the die opening");
        const fitted = fitArcs(loops[0], true);
        const directed = s.ccw ? fitted : reversePath(fitted);
        // Every pass starts at its point nearest the start hole, so the passes line up.
        const started = startClosedPathAt(directed, nearestArcLength(directed, hint).s);
        passes.push({
            path: started,
            feed: i === 0 ? s.feed : s.skimFeed,
            label: i === 0 ? "Rough cut" : `Skim ${i}`,
        });
    }
    const rough = passes[0].path;
    const roughStart = pathPointAt(rough, 0);
    // The scrap is left of travel around a die opening run counter-clockwise or a punch run clockwise.
    const scrapLeft = s.ccw !== s.punch;
    let threading = s.start;
    if (threading === undefined) {
        const outward = scale(perpLeft(pathTangentAt(rough, 0)), scrapLeft ? 1 : -1);
        threading = add(roughStart, scale(outward, s.approach));
        if (!s.punch && !pointInPolygon(threading, ccwLoop))
            threading = deepestPoint([ccwLoop])?.point ?? threading;
    }
    const d = taperOffset(s.taper, s.programZ, s.uvZ) * (s.leanToScrap ? 1 : -1) * (scrapLeft ? 1 : -1);
    const tapered = Math.abs(d) > 1e-12;
    const at = (p: Point2): Vec3 => [p[0], p[1], s.programZ];

    builder.comment(`Thread wire at X${threading[0].toFixed(3)} Y${threading[1].toFixed(3)}`);
    builder.rapid(at(threading));
    const sampled = tapered ? passes.map((pass) => sample(pass.path, d)) : [];
    // Approach: the wire tilts from vertical at the start hole to the contour's taper.
    if (tapered) {
        const start = sampleAt(sampled[0], 0);
        builder.push({
            kind: "taper",
            to: at(start.p),
            upper: [start.u[0], start.u[1], s.uvZ],
            feed: s.feed,
        });
    } else builder.linear(at(roughStart), s.feed);

    const total = pathLength(rough);
    const tab = Math.min(s.tab, total * 0.5);
    passes.forEach((pass, i) => {
        builder.comment(`${pass.label}: offset ${offsets[i].toFixed(4)}`);
        const forward = i === 0 || !s.alternate || i % 2 === 0;
        const cutTo = pathLength(pass.path) - tab;
        if (tapered) {
            const smp = sampled[i];
            const end = cutTo * smp.ratio;
            const [s0, s1] = forward ? [0, end] : [end, 0];
            const first = sampleAt(smp, s0);
            builder.push({
                kind: "taper",
                to: at(first.p),
                upper: [first.u[0], first.u[1], s.uvZ],
                feed: pass.feed,
            });
            emitTaperRange(builder, smp, s0, s1, pass.feed, s);
            return;
        }
        const span = subPath(pass.path, 0, cutTo);
        const segments = forward ? span : [...span].reverse().map(reverseSeg);
        if (segments.length === 0) return;
        builder.linear(at(segments[0].from), pass.feed);
        for (const segment of segments) {
            if (segment.kind === "line") builder.linear(at(segment.to), pass.feed);
            else builder.arc(at(segment.to), segment.center, segment.ccw, pass.feed);
        }
    });

    if (tab > 1e-9) {
        if (s.stop) {
            builder.comment("Stop: secure the part before the separation cut");
            builder.push({ kind: "raw", code: "M00" });
        }
        builder.comment("Separation cut");
        if (tapered) {
            const smp = sampled[0];
            const from = (total - tab) * smp.ratio;
            const first = sampleAt(smp, from);
            builder.push({
                kind: "taper",
                to: at(first.p),
                upper: [first.u[0], first.u[1], s.uvZ],
                feed: s.feed,
            });
            emitTaperRange(builder, smp, from, smp.total, s.feed, s);
        } else {
            const segments = subPath(rough, total - tab, total);
            if (segments.length > 0) builder.linear(at(segments[0].from), s.feed);
            for (const segment of segments) {
                if (segment.kind === "line") builder.linear(at(segment.to), s.feed);
                else builder.arc(at(segment.to), segment.center, segment.ccw, s.feed);
            }
        }
    }
    return Result.ok(undefined);
}

const reverseSeg = (segment: PathSegment): PathSegment =>
    segment.kind === "line"
        ? { kind: "line", from: segment.to, to: segment.from }
        : { kind: "arc", from: segment.to, to: segment.from, center: segment.center, ccw: !segment.ccw };

export function generateWireEdm(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const s = wireSettings(p, context);
    const maxTaper = context.machine.wire?.maxTaper;
    if (maxTaper !== undefined && s.taper > maxTaper + 1e-9) {
        return Result.err(`A ${s.taper}° taper exceeds the machine's ${maxTaper}°`);
    }
    if (s.taper > 0 && Math.abs(s.uvZ - s.programZ) < 1e-9) {
        return Result.err("Tapering needs the machine's program and UV plane heights");
    }
    const geometry = selectionGeometry(context);
    const loops = geometry.closed
        .filter((c) => c.role !== "bend" && c.role !== "mark")
        .map((c) => removeDuplicatePoints(c.points, true));
    if (loops.length === 0) return Result.err("Select closed loops (a sketch or a face) to cut");
    const builder = new MoveBuilder();
    builder.comment(
        `${operation.name}: wire EDM ${s.punch ? "punch" : "die"}, ${s.skims} skim${s.skims === 1 ? "" : "s"}${s.taper > 0 ? `, taper ${s.taper}°` : ""}`,
    );
    let here: Point2 = s.start ?? [context.stock.min[0], context.stock.min[1]];
    for (const loop of nearestNeighborOrder(loops, here, (l) => l[0])) {
        const result = emitWireContour(builder, loop, s, here);
        if (!result.isOk) return Result.err(result.error);
        const end = builder.position;
        if (end !== undefined) here = [end[0], end[1]];
    }
    return Result.ok(toolpathOf(builder, operation, context));
}

export const wireContourOperation: CamOperationHandler = {
    type: "wireContour",
    label: "Wire contour",
    category: "wire",
    machineKinds: ["wireEdm"],
    selects: ["sketch", "face", "edge"],
    defaults: (machine, tool) => ({
        cutType: "punch",
        direction: "cw",
        sparkGap: machine.wire?.sparkGap ?? 0.02,
        skims: 0,
        skimStock: 0.05,
        skimSparkGap: (machine.wire?.sparkGap ?? 0.02) / 2,
        alternateSkims: true,
        taperAngle: 0,
        taperLean: "scrap",
        approachLength: 3,
        tabLength: 3,
        stopBeforeSeparation: true,
        ...(tool !== undefined ? { feed: tool.cutting.feed, skimFeed: tool.cutting.feed * 2 } : {}),
    }),
    parameters: () => WIRE_PARAMETERS,
    generate: generateWireEdm,
};
