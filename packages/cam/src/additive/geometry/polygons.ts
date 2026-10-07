// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type FlatPaths,
    type PolygonFillRule,
    type PolygonJoin,
    polygonBoolean,
    polygonClipPolylines,
    polygonNesting,
    polygonOffset,
} from "@chili3d/rs";

/**
 * 2D polygon algebra for the slicer in integer coordinates: one unit is 1/`SCALE` mm (a
 * micrometre). Booleans, offsets and line clipping run on the Rust polygon kernel
 * (`@chili3d/rs`, over i_overlay) on that same micrometre grid, so their results are exact
 * integers here too.
 *
 * Closed paths follow the usual convention: outer boundaries counter-clockwise (positive
 * area), holes clockwise. A region is a flat list of such paths (what the booleans return:
 * each outer boundary followed by its holes); `islands` groups it into outer boundaries with
 * their holes.
 */

/** A point in integer units (1/`SCALE` mm). */
export interface IntPoint {
    x: number;
    y: number;
}

export type Path = IntPoint[];
export type Paths = Path[];
export type PointMm = readonly [number, number];

/** Units per millimetre. */
export const SCALE = 1000;

export const mm = (units: number) => units / SCALE;
export const units = (millimetres: number) => Math.round(millimetres * SCALE);

export function pathFromMm(points: readonly PointMm[]): Path {
    return points.map(([x, y]) => ({ x: units(x), y: units(y) }));
}

export function pathToMm(path: Path): [number, number][] {
    return path.map((p) => [mm(p.x), mm(p.y)]);
}

/** Fill rules of the booleans (which points a region's paths fill, by winding number). */
export const FillRule = {
    EvenOdd: "evenOdd",
    NonZero: "nonZero",
    Positive: "positive",
    Negative: "negative",
} as const satisfies Record<string, PolygonFillRule>;
export type FillRule = PolygonFillRule;

const GRID = { scale: SCALE };

/** Paths in millimetres, flat, for the kernel. */
function toFlat(paths: Paths): FlatPaths {
    let count = 0;
    for (const path of paths) count += path.length;
    const coords = new Float64Array(2 * count);
    const lengths = new Uint32Array(paths.length);
    let k = 0;
    paths.forEach((path, i) => {
        lengths[i] = path.length;
        for (const p of path) {
            coords[k++] = p.x / SCALE;
            coords[k++] = p.y / SCALE;
        }
    });
    return { coords, lengths };
}

/** Kernel paths back in units; points that round together are merged. */
function fromFlat(flat: FlatPaths, closed: boolean): Paths {
    const out: Paths = [];
    let k = 0;
    for (const length of flat.lengths) {
        const path: Path = [];
        for (let i = 0; i < length; i++, k += 2) {
            const p = { x: Math.round(flat.coords[k] * SCALE), y: Math.round(flat.coords[k + 1] * SCALE) };
            const last = path[path.length - 1];
            if (last === undefined || last.x !== p.x || last.y !== p.y) path.push(p);
        }
        if (path.length >= (closed ? 3 : 2)) out.push(path);
    }
    return out;
}

/** Drops repeated vertices (and a closing duplicate) and paths with fewer than 3 vertices. */
export function cleanPaths(paths: Paths, closed = true): Paths {
    const result: Paths = [];
    for (const path of paths) {
        const out: Path = [];
        for (const p of path) {
            const last = out[out.length - 1];
            // `+ 0` turns an occasional -0 into 0.
            if (last === undefined || last.x !== p.x || last.y !== p.y) out.push({ x: p.x + 0, y: p.y + 0 });
        }
        if (closed && out.length > 1) {
            const first = out[0];
            const last = out[out.length - 1];
            if (first.x === last.x && first.y === last.y) out.pop();
        }
        if (out.length >= (closed ? 3 : 2)) result.push(out);
    }
    return result;
}

export type JoinKind = "miter" | "round" | "bevel";

/** Chord tolerance of round joins, mm. */
const ROUND_TOLERANCE = 0.005;

/**
 * Grows (positive) or shrinks (negative) a region by `deltaMm`. Like a polygon offset group,
 * the path with the lowest vertex decides which orientation is outside: when it runs
 * clockwise, every path's role flips (and results come back clockwise too).
 */
export function offset(paths: Paths, deltaMm: number, join: JoinKind = "miter", miterLimit = 3): Paths {
    if (paths.length === 0) return [];
    if (Math.abs(deltaMm * SCALE) < 0.5) return union(paths);
    const kind: PolygonJoin =
        join === "round"
            ? { kind: "round", tolerance: ROUND_TOLERANCE }
            : join === "miter"
              ? { kind: "miter", limit: miterLimit }
              : { kind: "bevel" };
    const reversed = lowestPathClockwise(paths);
    const input = reversed ? paths.map((path) => [...path].reverse()) : paths;
    const result = fromFlat(polygonOffset(toFlat(input), deltaMm, { join: kind, scale: SCALE }), true);
    return reversed ? result.map((path) => path.reverse()) : result;
}

function lowestPathClockwise(paths: Paths): boolean {
    let lowest: Path | undefined;
    let y = Number.POSITIVE_INFINITY;
    let x = Number.POSITIVE_INFINITY;
    for (const path of paths) {
        if (path.length < 3) continue;
        for (const p of path) {
            if (p.y < y || (p.y === y && p.x < x)) {
                y = p.y;
                x = p.x;
                lowest = path;
            }
        }
    }
    return lowest !== undefined && signedArea(lowest) < 0;
}

/** Shrinks then grows back: removes the parts of a region narrower than 2 × `radiusMm`. */
export function opening(paths: Paths, radiusMm: number): Paths {
    return offset(offset(paths, -radiusMm), radiusMm);
}

export function union(subject: Paths, clip: Paths = [], fillRule: FillRule = FillRule.NonZero): Paths {
    if (subject.length === 0 && clip.length === 0) return [];
    return fromFlat(
        polygonBoolean("union", toFlat(subject), toFlat(clip), { ...GRID, fill: fillRule }),
        true,
    );
}

export function difference(subject: Paths, clip: Paths): Paths {
    if (subject.length === 0) return [];
    if (clip.length === 0) return subject;
    return fromFlat(polygonBoolean("difference", toFlat(subject), toFlat(clip), GRID), true);
}

export function intersection(subject: Paths, clip: Paths): Paths {
    if (subject.length === 0 || clip.length === 0) return [];
    return fromFlat(polygonBoolean("intersection", toFlat(subject), toFlat(clip), GRID), true);
}

/** The parts of open polylines inside a region, each in its direction, joined across vertices. */
export function clipLines(lines: Paths, region: Paths): Paths {
    if (lines.length === 0 || region.length === 0) return [];
    return fromFlat(polygonClipPolylines(toFlat(lines), toFlat(region), GRID), false);
}

/** Signed area in units² (positive for counter-clockwise). */
export function signedArea(path: Path): number {
    let area = 0;
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
        area += (path[j].x + path[i].x) * (path[j].y - path[i].y);
    }
    return -area / 2;
}

/** Net area of a region in mm². */
export function areaMm2(paths: Paths): number {
    let area = 0;
    for (const path of paths) area += signedArea(path);
    return area / (SCALE * SCALE);
}

/** Crossing-number point-in-polygon; points on the boundary count as inside. */
export function pointInPath(point: IntPoint, path: Path): boolean {
    let inside = false;
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
        const a = path[i];
        const b = path[j];
        if (
            a.y === b.y &&
            a.y === point.y &&
            point.x >= Math.min(a.x, b.x) &&
            point.x <= Math.max(a.x, b.x)
        ) {
            return true;
        }
        if (a.y > point.y !== b.y > point.y) {
            const x = a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y);
            if (x === point.x) return true;
            if (point.x < x) inside = !inside;
        }
    }
    return inside;
}

/** Whether a point lies inside a region (non-zero winding over its paths). */
export function pointInRegion(point: IntPoint, region: Paths): boolean {
    let winding = 0;
    for (const path of region) {
        if (pointInPath(point, path)) winding += signedArea(path) > 0 ? 1 : -1;
    }
    return winding > 0;
}

export interface Island {
    readonly outer: Path;
    readonly holes: Path[];
}

/**
 * Groups a cleaned region (outer CCW, holes CW, not overlapping) into islands, largest first:
 * each hole goes with the smallest outer loop around it.
 */
export function islands(region: Paths): Island[] {
    const tree = polygonNesting(toFlat(region));
    const holes = new Map<number, Path[]>();
    const outers: number[] = [];
    for (const i of tree.order) {
        if (signedArea(region[i]) <= 0) continue;
        outers.push(i);
        holes.set(i, []);
    }
    region.forEach((hole, i) => {
        if (signedArea(hole) >= 0) return;
        let parent = tree.parent[i];
        while (parent >= 0 && !holes.has(parent)) parent = tree.parent[parent];
        holes.get(parent)?.push(hole);
    });
    return outers.map((i) => ({ outer: region[i], holes: holes.get(i) ?? [] }));
}

export function islandPaths(island: Island): Paths {
    return [island.outer, ...island.holes];
}

export interface Bounds {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
}

export function bounds(paths: Paths): Bounds | undefined {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const path of paths) {
        for (const p of path) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    return minX <= maxX ? { minX, minY, maxX, maxY } : undefined;
}

function distanceToSegmentSq(p: IntPoint, a: IntPoint, b: IntPoint): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    let t = lengthSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const x = a.x + t * dx - p.x;
    const y = a.y + t * dy - p.y;
    return x * x + y * y;
}

function douglasPeucker(points: Path, first: number, last: number, toleranceSq: number, keep: boolean[]) {
    let index = -1;
    let maxSq = toleranceSq;
    for (let i = first + 1; i < last; i++) {
        const d = distanceToSegmentSq(points[i], points[first], points[last]);
        if (d > maxSq) {
            maxSq = d;
            index = i;
        }
    }
    if (index < 0) return;
    keep[index] = true;
    douglasPeucker(points, first, index, toleranceSq, keep);
    douglasPeucker(points, index, last, toleranceSq, keep);
}

/**
 * Douglas–Peucker simplification of closed paths. The ring is anchored at its leftmost vertex
 * (a corner of the convex hull, so never one the tolerance would drop) and at the vertex
 * farthest from it, so the result does not depend on where the path starts; it keeps the
 * path's own order.
 */
export function simplifyClosed(paths: Paths, toleranceMm: number): Paths {
    const toleranceSq = (toleranceMm * SCALE) ** 2;
    const result: Paths = [];
    for (const path of paths) {
        const n = path.length;
        if (n <= 3) {
            result.push(path);
            continue;
        }
        let start = 0;
        for (let i = 1; i < n; i++) {
            if (path[i].x < path[start].x || (path[i].x === path[start].x && path[i].y < path[start].y))
                start = i;
        }
        const ring = Array.from({ length: n + 1 }, (_, i) => path[(start + i) % n]);
        let far = 0;
        let farSq = -1;
        for (let i = 1; i < n; i++) {
            const d = (ring[i].x - ring[0].x) ** 2 + (ring[i].y - ring[0].y) ** 2;
            if (d > farSq) {
                farSq = d;
                far = i;
            }
        }
        const keep = new Array<boolean>(n + 1).fill(false);
        keep[0] = true;
        keep[far] = true;
        keep[n] = true;
        douglasPeucker(ring, 0, far, toleranceSq, keep);
        douglasPeucker(ring, far, n, toleranceSq, keep);
        const out = path.filter((_, i) => keep[(i - start + n) % n]);
        if (out.length >= 3) result.push(out);
    }
    return result;
}

/** Douglas–Peucker simplification of an open polyline. */
export function simplifyOpen(path: Path, toleranceMm: number): Path {
    if (path.length <= 2) return path;
    const keep = new Array<boolean>(path.length).fill(false);
    keep[0] = true;
    keep[path.length - 1] = true;
    douglasPeucker(path, 0, path.length - 1, (toleranceMm * SCALE) ** 2, keep);
    return path.filter((_, i) => keep[i]);
}

export function pathLength(path: Path, closed: boolean): number {
    let length = 0;
    for (let i = 1; i < path.length; i++) {
        length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    }
    if (closed && path.length > 1) {
        length += Math.hypot(path[0].x - path[path.length - 1].x, path[0].y - path[path.length - 1].y);
    }
    return length;
}
