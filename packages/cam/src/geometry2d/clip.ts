// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    flatPaths,
    type PolygonJoin,
    pathsOf,
    polygonBoolean,
    polygonClipPolylines,
    polygonNesting,
    polygonOffset,
} from "@chili3d/rs";
import { ARC_TOLERANCE } from "./arcs";
import { oriented, removeDuplicatePoints, signedArea } from "./polygon";
import type { Point2 } from "./vec";

/**
 * Polygon offsetting, booleans, open-path clipping and nesting on the Rust polygon kernel
 * (`@chili3d/rs`, over i_overlay). Booleans and offsets run on an integer grid of `SCALE` units
 * per mm (0.1 µm), so their results are exact on that grid; clipping and nesting are exact in
 * floating point.
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

export type JoinKind = "round" | "miter" | "bevel";

export interface OffsetOptions {
    /**
     * Round joins keep every point exactly `delta` from the input; mitres keep corners sharp;
     * bevels cut them by a chord.
     */
    readonly join?: JoinKind;
    /** Chord tolerance of round joins, mm. */
    readonly tolerance?: number;
    /** Longest mitre, in multiples of |delta|, before it is squared off. */
    readonly miterLimit?: number;
}

const GRID = { scale: SCALE };

/** The union of regions (loops by the non-zero rule). */
export function union(a: readonly (readonly Point2[])[], b: readonly (readonly Point2[])[] = []): Point2[][] {
    return pathsOf(polygonBoolean("union", flatPaths([...a, ...b]), undefined, GRID));
}

export function difference(a: readonly (readonly Point2[])[], b: readonly (readonly Point2[])[]): Point2[][] {
    if (b.length === 0) return union(a);
    return pathsOf(polygonBoolean("difference", flatPaths(a), flatPaths(b), GRID));
}

export function intersection(
    a: readonly (readonly Point2[])[],
    b: readonly (readonly Point2[])[],
): Point2[][] {
    return pathsOf(polygonBoolean("intersection", flatPaths(a), flatPaths(b), GRID));
}

/** Area of a region given as loops (holes subtract). */
export function regionArea(loops: readonly (readonly Point2[])[]): number {
    return loops.reduce((sum, loop) => sum + signedArea(loop), 0);
}

/**
 * The parts of open polylines inside (or outside) a region: each polyline's own pieces, in its
 * direction; a stretch along the region's boundary counts as inside.
 */
export function clipPolylines(
    polylines: readonly (readonly Point2[])[],
    region: readonly (readonly Point2[])[],
    keep: "inside" | "outside" = "inside",
): Point2[][] {
    return pathsOf(polygonClipPolylines(flatPaths(polylines), flatPaths(region), { keep, scale: SCALE }));
}

function joinOf(options: OffsetOptions): PolygonJoin {
    switch (options.join ?? "round") {
        case "miter":
            return { kind: "miter", limit: options.miterLimit ?? 4 };
        case "bevel":
            return { kind: "bevel" };
        default:
            return { kind: "round", tolerance: options.tolerance ?? ARC_TOLERANCE };
    }
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
    return pathsOf(polygonOffset(flatPaths(prepared), delta, { join: joinOf(options), scale: SCALE }));
}

/**
 * The loops of a region ordered into outer boundaries with their holes, by nesting depth:
 * even depths are material boundaries (counter-clockwise), odd depths holes (clockwise).
 * Regions come largest first.
 */
export function regions(loops: readonly (readonly Point2[])[]): Region[] {
    const clean = loops
        .map((points) => removeDuplicatePoints(points, true))
        .filter((points) => points.length >= 3 && Math.abs(signedArea(points)) > 1e-12);
    const tree = polygonNesting(flatPaths(clean));
    const out: { outer: Point2[]; holes: Point2[][] }[] = [];
    const index = new Map<number, number>();
    for (const i of tree.order) {
        if (tree.depth[i] % 2 !== 0) continue;
        index.set(i, out.length);
        out.push({ outer: oriented(clean[i], true), holes: [] });
    }
    for (const i of tree.order) {
        const parent = index.get(tree.parent[i]);
        if (tree.depth[i] % 2 === 1 && parent !== undefined)
            out[parent].holes.push(oriented(clean[i], false));
    }
    return out;
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
