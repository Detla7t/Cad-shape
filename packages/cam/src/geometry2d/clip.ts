// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Clipper64, ClipType, FillRule, type Path64, type Paths64, Point64 } from "clipper2-js";
import { ARC_TOLERANCE } from "./arcs";
import { arcStepAngle } from "./path";
import { oriented, pointInPolygon, removeDuplicatePoints, signedArea } from "./polygon";
import { add, cross, dot, normalize, type Point2, perpRight, rotate, scale, sub } from "./vec";

/**
 * Polygon offsetting and booleans over Clipper2 (clipper2-js, Boost license).
 *
 * Coordinates go to Clipper's integers at `SCALE` units per mm (0.1 µm). Booleans run on
 * Clipper's sweep engine. Offsets build the raw offset outline here — every edge moved
 * along its normal, gaps at convex vertices closed by round (or mitred) joins, overlaps at
 * concave vertices closed through the vertex — and let a Positive-fill union clean the
 * self-intersections, the same scheme as Clipper's own `ClipperOffset`. (clipper2-js 1.2.4's
 * `ClipperOffset` never advances its previous-vertex index, so its offsets are wrong, and its
 * `PolyTree` output stays empty; neither is used.)
 *
 * Regions are sets of loops oriented by the CAM convention: outer loops counter-clockwise,
 * holes clockwise. Every function returns loops in that orientation.
 */

export const SCALE = 1e4;

/** An outer loop and the holes (islands) inside it. */
export interface Region {
    readonly outer: readonly Point2[];
    readonly holes: readonly (readonly Point2[])[];
}

export type JoinKind = "round" | "miter";

export interface OffsetOptions {
    /** Round joins keep every point exactly `delta` from the input; mitres keep corners sharp. */
    readonly join?: JoinKind;
    /** Chord tolerance of round joins, mm. */
    readonly tolerance?: number;
    /** Longest mitre, in multiples of |delta|, before it is squared off. */
    readonly miterLimit?: number;
}

function toPath64(points: readonly Point2[]): Path64 {
    return points.map((p) => new Point64(p[0] * SCALE, p[1] * SCALE)) as Path64;
}

function fromPath64(path: Path64): Point2[] {
    return path.map((p) => [p.x / SCALE, p.y / SCALE] as Point2);
}

function cleanOutput(paths: Paths64, minArea: number): Point2[][] {
    const out: Point2[][] = [];
    for (const path of paths) {
        const points = removeDuplicatePoints(fromPath64(path), true, 0.5 / SCALE);
        if (points.length < 3 || Math.abs(signedArea(points)) < minArea) continue;
        out.push(points);
    }
    return out;
}

function run(
    type: ClipType,
    subject: readonly (readonly Point2[])[],
    clip: readonly (readonly Point2[])[],
    fill: FillRule,
): Point2[][] {
    const clipper = new Clipper64();
    clipper.addSubjectPaths(subject.filter((p) => p.length >= 3).map(toPath64) as Paths64);
    if (clip.length > 0) clipper.addClipPaths(clip.filter((p) => p.length >= 3).map(toPath64) as Paths64);
    const solution: Paths64 = [];
    clipper.execute(type, fill, solution);
    return cleanOutput(solution, 1e-10);
}

/** The union of regions (loops by the non-zero rule). */
export function union(a: readonly (readonly Point2[])[], b: readonly (readonly Point2[])[] = []): Point2[][] {
    return run(ClipType.Union, [...a, ...b], [], FillRule.NonZero);
}

export function difference(a: readonly (readonly Point2[])[], b: readonly (readonly Point2[])[]): Point2[][] {
    if (b.length === 0) return union(a);
    return run(ClipType.Difference, a, b, FillRule.NonZero);
}

export function intersection(
    a: readonly (readonly Point2[])[],
    b: readonly (readonly Point2[])[],
): Point2[][] {
    return run(ClipType.Intersection, a, b, FillRule.NonZero);
}

/** Area of a region given as loops (holes subtract). */
export function regionArea(loops: readonly (readonly Point2[])[]): number {
    return loops.reduce((sum, loop) => sum + signedArea(loop), 0);
}

/** The parts of open polylines inside (or outside) a region. */
export function clipPolylines(
    polylines: readonly (readonly Point2[])[],
    region: readonly (readonly Point2[])[],
    keep: "inside" | "outside" = "inside",
): Point2[][] {
    const clipper = new Clipper64();
    clipper.addOpenSubjectPaths(polylines.filter((p) => p.length >= 2).map(toPath64) as Paths64);
    clipper.addClipPaths(region.filter((p) => p.length >= 3).map(toPath64) as Paths64);
    const closed: Paths64 = [];
    const open: Paths64 = [];
    clipper.execute(
        keep === "inside" ? ClipType.Intersection : ClipType.Difference,
        FillRule.NonZero,
        closed,
        open,
    );
    return open
        .map((path) => removeDuplicatePoints(fromPath64(path), false, 0.5 / SCALE))
        .filter((p) => p.length >= 2);
}

/** The raw (self-intersecting) offset outline of one oriented loop. */
function rawOffset(points: readonly Point2[], delta: number, options: OffsetOptions): Point2[] {
    const n = points.length;
    const join = options.join ?? "round";
    const tolerance = options.tolerance ?? ARC_TOLERANCE;
    const miterLimit = options.miterLimit ?? 4;
    const normals: Point2[] = [];
    for (let i = 0; i < n; i++) normals.push(perpRight(normalize(sub(points[(i + 1) % n], points[i]))));
    const step = arcStepAngle(Math.abs(delta), tolerance);
    const out: Point2[] = [];
    for (let j = 0; j < n; j++) {
        const k = (j - 1 + n) % n;
        const p = points[j];
        const nk = normals[k];
        const nj = normals[j];
        const turn = Math.atan2(cross(nk, nj), dot(nk, nj));
        if (Math.abs(turn) < 1e-9) {
            out.push(add(p, scale(nj, delta)));
        } else if (turn * delta < 0) {
            // The offset edges overlap here: pass through the vertex so the union can clean it.
            out.push(add(p, scale(nk, delta)), p, add(p, scale(nj, delta)));
        } else if (join === "miter" && 1 / Math.cos(turn / 2) <= miterLimit) {
            const q = delta / (1 + Math.cos(turn));
            out.push(add(p, scale(add(nk, nj), q)));
        } else if (join === "miter") {
            // Square off a mitre that would run too far.
            const bisector = normalize(add(nk, nj));
            const reach = Math.abs(delta) * miterLimit;
            const tip = add(p, scale(bisector, Math.sign(delta) * reach));
            const across = perpRight(bisector);
            const a = add(p, scale(nk, delta));
            const b = add(p, scale(nj, delta));
            const along = (from: Point2, dir: Point2) => {
                const denominator = cross(dir, across);
                if (Math.abs(denominator) < 1e-12) return from;
                const s = cross(sub(tip, from), across) / denominator;
                return add(from, scale(dir, s));
            };
            out.push(along(a, perpRight(nk)), along(b, perpRight(nj)));
        } else {
            const steps = Math.max(1, Math.ceil(Math.abs(turn) / step));
            const start = scale(nk, delta);
            out.push(add(p, start));
            for (let i = 1; i < steps; i++) out.push(add(p, rotate(start, (turn * i) / steps)));
            out.push(add(p, scale(nj, delta)));
        }
    }
    return out;
}

/**
 * Offsets a region: positive `delta` grows the material (outer loops move out, holes
 * shrink), negative shrinks it. Loops are oriented first by nesting (`orientRegionLoops`),
 * so any loop set describing a region by the even-odd rule works.
 */
export function offset(
    loops: readonly (readonly Point2[])[],
    delta: number,
    options: OffsetOptions = {},
): Point2[][] {
    const prepared = orientRegionLoops(loops);
    if (Math.abs(delta) < 0.5 / SCALE) return union(prepared);
    const raw: Point2[][] = [];
    for (const loop of prepared) {
        const clean = removeDuplicatePoints(loop, true, 0.5 / SCALE);
        if (clean.length >= 3) raw.push(rawOffset(clean, delta, options));
    }
    return run(ClipType.Union, raw, [], FillRule.Positive);
}

/**
 * The loops of a region ordered into outer boundaries with their holes, by nesting depth:
 * even depths are material boundaries (counter-clockwise), odd depths holes (clockwise).
 */
export function regions(loops: readonly (readonly Point2[])[]): Region[] {
    const nodes = loops
        .map((points) => removeDuplicatePoints(points, true))
        .filter((points) => points.length >= 3 && Math.abs(signedArea(points)) > 1e-12)
        .map((points) => ({ points, area: Math.abs(signedArea(points)), parent: -1, depth: 0 }))
        .sort((a, b) => b.area - a.area);
    for (let i = 0; i < nodes.length; i++) {
        let best = -1;
        for (let j = 0; j < i; j++) {
            if (nodes[j].area <= nodes[i].area) continue;
            if (!loopInside(nodes[i].points, nodes[j].points)) continue;
            if (best < 0 || nodes[j].area < nodes[best].area) best = j;
        }
        nodes[i].parent = best;
        nodes[i].depth = best < 0 ? 0 : nodes[best].depth + 1;
    }
    const out: { outer: Point2[]; holes: Point2[][] }[] = [];
    const index = new Map<number, number>();
    nodes.forEach((node, i) => {
        if (node.depth % 2 === 0) {
            index.set(i, out.length);
            out.push({ outer: oriented(node.points, true), holes: [] });
        }
    });
    for (const node of nodes) {
        const parent = index.get(node.parent);
        if (node.depth % 2 === 1 && parent !== undefined)
            out[parent].holes.push(oriented(node.points, false));
    }
    return out;
}

/** Whether loop `a` lies inside loop `b` (by a majority of sampled vertices). */
function loopInside(a: readonly Point2[], b: readonly Point2[]): boolean {
    const samples = Math.min(5, a.length);
    let inside = 0;
    for (let i = 0; i < samples; i++) {
        if (pointInPolygon(a[Math.floor((i * a.length) / samples)], b)) inside++;
    }
    return inside * 2 > samples;
}

/** The loops re-oriented by nesting: outer boundaries CCW, holes CW. */
export function orientRegionLoops(loops: readonly (readonly Point2[])[]): Point2[][] {
    return regions(loops).flatMap((region) => [region.outer as Point2[], ...(region.holes as Point2[][])]);
}

export const regionLoops = (region: Region): Point2[][] => [
    region.outer as Point2[],
    ...(region.holes as Point2[][]),
];

/** Offsets one region and groups the result into regions again. */
export function offsetRegion(region: Region, delta: number, options: OffsetOptions = {}): Region[] {
    return regions(offset(regionLoops(region), delta, options));
}
