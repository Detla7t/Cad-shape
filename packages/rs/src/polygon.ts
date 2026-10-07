// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * 2D polygon operations in millimetres (the `polygon` crate, over i_overlay): booleans with a
 * fill rule, closed offsets with round, mitre or bevel joins, open-polyline clipping and the
 * nesting of loops. Booleans and offsets snap to an integer grid of `scale` units per mm
 * (default 10 000: 0.1 µm, ±53 m around the input) and return clean loops — outer boundaries
 * counter-clockwise, each followed by its clockwise holes. Paths cross the boundary as flat
 * typed arrays; malformed input (a length mismatch, a non-finite coordinate, geometry beyond
 * the grid's range) throws.
 */

import {
    type PolygonPaths,
    polygon_boolean,
    polygon_clip_polylines,
    polygon_nesting,
    polygon_offset,
} from "../lib/chili_rs.js";
import { assertRustReady } from "./runtime";

/** Which points loops fill, by their winding number (odd / non-zero / above zero / below zero). */
export type PolygonFillRule = "evenOdd" | "nonZero" | "positive" | "negative";

export type PolygonBooleanOp = "union" | "difference" | "intersection" | "xor";

/**
 * How an offset closes convex corners: arcs as chords within `tolerance` mm; mitres, cut square
 * where they would reach past `limit` × the distance (turns under 5° are bevelled); or chords.
 */
export type PolygonJoin =
    | { readonly kind: "round"; readonly tolerance: number }
    | { readonly kind: "miter"; readonly limit: number }
    | { readonly kind: "bevel" };

/** Paths as flat arrays: x0, y0, x1, y1, … of every path in turn, and each path's point count. */
export interface FlatPaths {
    readonly coords: Float64Array;
    readonly lengths: Uint32Array;
}

/** The default grid, units per millimetre. */
export const POLYGON_SCALE = 1e4;

export interface PolygonGridOptions {
    /** Grid units per millimetre. */
    readonly scale?: number;
}

export interface PolygonBooleanOptions extends PolygonGridOptions {
    /** How each operand's loops fill (default non-zero). */
    readonly fill?: PolygonFillRule;
}

export interface PolygonOffsetOptions extends PolygonGridOptions {
    /** Default: round, within 0.002 mm. */
    readonly join?: PolygonJoin;
}

export interface PolygonClipOptions extends PolygonGridOptions {
    /** The parts inside the region (its boundary included) or outside it (default inside). */
    readonly keep?: "inside" | "outside";
    /** How the region's loops fill (default non-zero). */
    readonly fill?: PolygonFillRule;
}

/** A containment tree of loops (see `polygonNesting`). */
export interface PolygonNesting {
    /** Loop indices by decreasing area (ties in input order), degenerate loops left out. */
    readonly order: Uint32Array;
    /** Per loop: the smallest larger loop containing it, or -1. */
    readonly parent: Int32Array;
    /** Per loop: how many loops contain it (even: material boundary, odd: hole). */
    readonly depth: Uint32Array;
}

/** Packs point lists into flat arrays. */
export function flatPaths(paths: readonly (readonly (readonly [number, number])[])[]): FlatPaths {
    let count = 0;
    for (const path of paths) count += path.length;
    const coords = new Float64Array(2 * count);
    const lengths = new Uint32Array(paths.length);
    let k = 0;
    paths.forEach((path, i) => {
        lengths[i] = path.length;
        for (const [x, y] of path) {
            coords[k++] = x;
            coords[k++] = y;
        }
    });
    return { coords, lengths };
}

/** Unpacks flat arrays into point lists. */
export function pathsOf(flat: FlatPaths): [number, number][][] {
    const out: [number, number][][] = [];
    let k = 0;
    for (const length of flat.lengths) {
        const path: [number, number][] = new Array(length);
        for (let i = 0; i < length; i++, k += 2) path[i] = [flat.coords[k], flat.coords[k + 1]];
        out.push(path);
    }
    return out;
}

const EMPTY: FlatPaths = { coords: new Float64Array(0), lengths: new Uint32Array(0) };

function take(result: PolygonPaths): FlatPaths {
    try {
        return { coords: result.take_coords(), lengths: result.take_lengths() };
    } finally {
        result.free();
    }
}

/** A boolean of two regions, each filled by the fill rule over its own loops. */
export function polygonBoolean(
    op: PolygonBooleanOp,
    subject: FlatPaths,
    clip: FlatPaths = EMPTY,
    options: PolygonBooleanOptions = {},
): FlatPaths {
    assertRustReady();
    return take(
        polygon_boolean(
            op,
            subject.coords,
            subject.lengths,
            clip.coords,
            clip.lengths,
            options.fill ?? "nonZero",
            options.scale ?? POLYGON_SCALE,
        ),
    );
}

/** The region loops fill by `fill`, as clean loops (self-intersections and overlaps resolved). */
export function polygonSimplify(loops: FlatPaths, options: PolygonBooleanOptions = {}): FlatPaths {
    return polygonBoolean("union", loops, EMPTY, options);
}

/**
 * Closed loops offset by `delta` mm: positive grows the region (outer loops out, holes in),
 * negative shrinks it. Counter-clockwise loops bound material, clockwise ones are holes; the
 * offsets are united, so parts thinner than twice an inward offset vanish.
 */
export function polygonOffset(
    loops: FlatPaths,
    delta: number,
    options: PolygonOffsetOptions = {},
): FlatPaths {
    assertRustReady();
    const join = options.join ?? { kind: "round", tolerance: 0.002 };
    const parameter = join.kind === "round" ? join.tolerance : join.kind === "miter" ? join.limit : 0;
    return take(
        polygon_offset(
            loops.coords,
            loops.lengths,
            delta,
            join.kind,
            parameter,
            options.scale ?? POLYGON_SCALE,
        ),
    );
}

/**
 * The parts of open polylines inside (or outside) a region: each polyline's own pieces, in its
 * order and direction, joined across its vertices (crossing polylines never merge).
 */
export function polygonClipPolylines(
    lines: FlatPaths,
    region: FlatPaths,
    options: PolygonClipOptions = {},
): FlatPaths {
    assertRustReady();
    return take(
        polygon_clip_polylines(
            lines.coords,
            lines.lengths,
            region.coords,
            region.lengths,
            options.fill ?? "nonZero",
            options.keep ?? "inside",
            options.scale ?? POLYGON_SCALE,
        ),
    );
}

/**
 * How closed loops (any orientation, not crossing one another) nest: outer boundaries, their
 * holes, islands in the holes, … A loop lies in another when most of its vertices do.
 */
export function polygonNesting(loops: FlatPaths): PolygonNesting {
    assertRustReady();
    const result = polygon_nesting(loops.coords, loops.lengths);
    try {
        return { order: result.take_order(), parent: result.take_parent(), depth: result.take_depth() };
    } finally {
        result.free();
    }
}
