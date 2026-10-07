// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IPoint64 } from "clipper2-js";
import { type RegionIndex, scanLines, segmentInside } from "../geometry/lineClip";
import { clipLines, offset, type Path, type Paths, SCALE, signedArea } from "../geometry/polygons";

/**
 * Fill patterns as centre lines clipped to a region, and the ordering that turns them into
 * few, connected extrusions. Line positions sit on a grid fixed in bed coordinates, so the
 * lines of consecutive layers stack (sparse infill walls) regardless of the region's shape.
 */

/** Parallel lines at `angleDeg` (from +X), `pitchMm` apart, clipped to the region. */
export function rectilinearLines(region: Paths, angleDeg: number, pitchMm: number): Paths {
    if (region.length === 0 || pitchMm <= 0) return [];
    const pitch = pitchMm * SCALE;
    // Half a pitch off the origin: lines never run exactly along axis-aligned walls at integer mm.
    return scanLines(region, (angleDeg * Math.PI) / 180, pitch, pitch / 2);
}

/**
 * Gyroid infill: the curves where the gyroid sin x cos y + sin y cos z + sin z cos x = 0
 * meets the layer plane. Coordinates are scaled so the walls are `spacing / density` apart
 * like PrusaSlicer's (its 2.44 density adjustment). Where cos 2z ≥ 0 the curves are solved
 * as y(x), elsewhere as x(y), so they stay single-valued and continuous.
 */
export function gyroidLines(
    region: Paths,
    zMm: number,
    spacingMm: number,
    density: number,
    angleDeg: number,
    toleranceMm = 0.1,
): Paths {
    if (region.length === 0 || density <= 0) return [];
    const scale = spacingMm / (density * 2.44);
    const angle = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const path of region) {
        for (const p of path) {
            const x = p.x / SCALE;
            const y = p.y / SCALE;
            const u = (x * cos + y * sin) / scale;
            const v = (-x * sin + y * cos) / scale;
            if (u < minU) minU = u;
            if (u > maxU) maxU = u;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }
    }
    const w = zMm / scale;
    const swap = Math.cos(2 * w) < 0;
    // Solve b(a) for a along the sampled axis (u, or v when swapped).
    const [aMin, aMax, bMin, bMax] = swap ? [minV, maxV, minU, maxU] : [minU, maxU, minV, maxV];
    const step = Math.max(0.05, Math.min(0.5, toleranceMm / scale));
    const samples = Math.ceil((aMax - aMin) / step) + 2;
    const lines: Paths = [];
    const toPoint = (a: number, b: number): IPoint64 => {
        const [u, v] = swap ? [b, a] : [a, b];
        const x = (u * cos - v * sin) * scale;
        const y = (u * sin + v * cos) * scale;
        return { x: Math.round(x * SCALE), y: Math.round(y * SCALE) };
    };
    const kMin = Math.floor((bMin - Math.PI) / (2 * Math.PI)) - 1;
    const kMax = Math.ceil((bMax + Math.PI) / (2 * Math.PI)) + 1;
    for (const sign of [1, -1]) {
        for (let k = kMin; k <= kMax; k++) {
            const line: Path = [];
            for (let i = 0; i < samples; i++) {
                const a = aMin - step + i * step;
                // A cos b + B sin b = C (y(x) form) or the mirrored x(y) form.
                const A = swap ? Math.cos(a) : Math.sin(a);
                const B = swap ? Math.sin(w) : Math.cos(w);
                const C = swap ? -Math.sin(a) * Math.cos(w) : -Math.sin(w) * Math.cos(a);
                const R = Math.hypot(A, B);
                const ratio = Math.max(-1, Math.min(1, C / R));
                // swap: A' sin u + B' cos u = C'  →  cos(u − φ') with φ' = atan2(A', B').
                const phi = swap ? Math.atan2(A, B) : Math.atan2(B, A);
                const b = phi + sign * Math.acos(ratio) + 2 * Math.PI * k;
                line.push(toPoint(a, b));
            }
            lines.push(line);
        }
    }
    return clipLines(lines, region);
}

/** Concentric loops `pitchMm` apart, the first half a pitch inside the region. */
export function concentricLoops(region: Paths, pitchMm: number): Paths {
    const loops: Paths = [];
    for (let k = 0; k < 10000; k++) {
        const ring = offset(region, -(pitchMm / 2 + k * pitchMm));
        if (ring.length === 0) break;
        loops.push(...ring);
    }
    return loops;
}

/** One continuous extrusion: points in order, closed loops repeat nothing (see `closed`). */
export interface OrderedPath {
    readonly points: Path;
    readonly closed: boolean;
}

const distSq = (a: IPoint64, b: IPoint64) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/**
 * Orders open polylines greedily by nearest endpoint (each may be reversed), from `start`.
 * When `connect` is given, a polyline whose start is within `maxDistanceMm` of the previous
 * end, along a connector `isInside` accepts, is appended to it: fill lines become zigzags.
 */
export function orderPolylines(
    lines: Paths,
    start: IPoint64,
    connect?: { readonly maxDistanceMm: number; readonly isInside: (a: IPoint64, b: IPoint64) => boolean },
): OrderedPath[] {
    const remaining = lines.filter((line) => line.length >= 2);
    const used = new Uint8Array(remaining.length);
    const out: { points: Path; closed: boolean }[] = [];
    let at = start;
    const maxSq = connect ? (connect.maxDistanceMm * SCALE) ** 2 : 0;
    for (let n = 0; n < remaining.length; n++) {
        let best = -1;
        let bestSq = Number.POSITIVE_INFINITY;
        let reverse = false;
        for (let i = 0; i < remaining.length; i++) {
            if (used[i]) continue;
            const line = remaining[i];
            const d0 = distSq(at, line[0]);
            const d1 = distSq(at, line[line.length - 1]);
            if (d0 < bestSq) {
                bestSq = d0;
                best = i;
                reverse = false;
            }
            if (d1 < bestSq) {
                bestSq = d1;
                best = i;
                reverse = true;
            }
        }
        used[best] = 1;
        const points = reverse ? [...remaining[best]].reverse() : remaining[best];
        const previous = out[out.length - 1];
        if (
            previous !== undefined &&
            connect !== undefined &&
            bestSq <= maxSq &&
            connect.isInside(previous.points[previous.points.length - 1], points[0])
        ) {
            previous.points.push(...points);
        } else out.push({ points: [...points], closed: false });
        at = points[points.length - 1];
    }
    return out;
}

/** Orders closed loops by nearest vertex; each loop starts at the vertex `seam` picks. */
export function orderLoops(
    loops: Paths,
    start: IPoint64,
    seam: (loop: Path, from: IPoint64) => number,
): OrderedPath[] {
    const remaining = loops.filter((loop) => loop.length >= 3);
    const used = new Uint8Array(remaining.length);
    const out: OrderedPath[] = [];
    let at = start;
    for (let n = 0; n < remaining.length; n++) {
        let best = -1;
        let bestSq = Number.POSITIVE_INFINITY;
        for (let i = 0; i < remaining.length; i++) {
            if (used[i]) continue;
            for (const p of remaining[i]) {
                const d = distSq(at, p);
                if (d < bestSq) {
                    bestSq = d;
                    best = i;
                }
            }
        }
        used[best] = 1;
        const loop = remaining[best];
        const s = seam(loop, at);
        const points = [...loop.slice(s), ...loop.slice(0, s)];
        out.push({ points, closed: true });
        at = points[0];
    }
    return out;
}

/** Whether a straight connector stays inside a region. */
export function connectorInside(region: RegionIndex, a: IPoint64, b: IPoint64): boolean {
    return segmentInside(region, a, b);
}

/** Index of the vertex with the largest y (ties: smallest x) — a "rear" seam. */
export function rearVertex(loop: Path): number {
    let best = 0;
    for (let i = 1; i < loop.length; i++) {
        const p = loop[i];
        const b = loop[best];
        if (p.y > b.y || (p.y === b.y && p.x < b.x)) best = i;
    }
    return best;
}

export function nearestVertex(loop: Path, to: IPoint64): number {
    let best = 0;
    let bestSq = Number.POSITIVE_INFINITY;
    for (let i = 0; i < loop.length; i++) {
        const d = distSq(loop[i], to);
        if (d < bestSq) {
            bestSq = d;
            best = i;
        }
    }
    return best;
}

/** True for counter-clockwise (outer) loops. */
export const isOuterLoop = (loop: Path) => signedArea(loop) > 0;
