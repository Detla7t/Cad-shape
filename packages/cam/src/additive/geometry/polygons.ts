// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Clipper,
    Clipper64,
    ClipperOffset,
    ClipType,
    EndType,
    FillRule,
    type IPoint64,
    JoinType,
    type Paths64,
    PathType,
} from "clipper2-js";
import { clipPolylines, RegionIndex } from "./lineClip";

/**
 * 2D polygon algebra for the slicer, on clipper2-js (Boost license) in integer coordinates:
 * one unit is 1/`SCALE` mm (a micrometre), so offsets and booleans are exact on that grid.
 *
 * Closed paths follow the usual convention: outer boundaries counter-clockwise (positive
 * area), holes clockwise. A region is a flat list of such paths (what Clipper returns);
 * `islands` groups it into outer boundaries with their holes.
 *
 * clipper2-js 1.2.4 has two defects worked around here, without patching the shared module:
 * `ClipperOffset.offsetPolygon` never advances the previous-normal index (the C# original
 * passes it by reference), so every vertex is joined against the last edge — offsets come
 * out skewed; this module offsets through a subclass whose prototype carries the corrected
 * loop. Its `stripDuplicates` compares points by reference, and boolean results carry
 * repeated vertices, so results are cleaned here instead. (Its `executePolyTree` also fails;
 * `islands` nests by containment instead of a poly tree.) Its open-path clipping is wrong
 * too (diagonal and vertical lines vanish); lines are clipped by `lineClip.ts` instead.
 * And it moves input vertices in place (an intersection snapped to a segment end returns
 * the input point object, whose y is then adjusted), so every call gets copies.
 *
 * For speed, every clipper here gets its own scanline set: the library's re-sorts its whole
 * array on each insert (quadratic in the number of distinct y values — an offset circle of a
 * few hundred vertices took ~10 ms); a binary-search insert gives identical results.
 */

export type Path = IPoint64[];
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

/** The sorted set of pending scanline y values a clipper sweeps (`pollLast` takes the largest). */
class ScanlineSet {
    private items: number[] = [];
    clear() {
        this.items.length = 0;
    }
    isEmpty() {
        return this.items.length === 0;
    }
    pollLast() {
        return this.items.pop();
    }
    add(y: number) {
        const items = this.items;
        let lo = 0;
        let hi = items.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (items[mid] < y) lo = mid + 1;
            else hi = mid;
        }
        if (items[lo] !== y) items.splice(lo, 0, y);
    }
}

function fastClipper(): Clipper64 {
    const clipper = new Clipper64();
    (clipper as unknown as { _scanlineList: ScanlineSet })._scanlineList = new ScanlineSet();
    return clipper;
}

function booleanOp(clipType: ClipType, subject: Paths, clip: Paths, fillRule: FillRule): Paths {
    const clipper = fastClipper();
    clipper.addPaths(copyPaths(subject), PathType.Subject);
    if (clip.length > 0) clipper.addPaths(copyPaths(clip), PathType.Clip);
    const solution: Paths64 = [];
    clipper.execute(clipType, fillRule, solution);
    return cleanPaths(solution);
}

interface OffsetInternals {
    _groupDelta: number;
    _groupList: { pathsReversed: boolean }[];
    _solution: Paths64;
    PreserveCollinear: boolean;
    ReverseSolution: boolean;
    executeInternal(delta: number): void;
    offsetPoint(group: unknown, path: Path, j: number, k: number): void;
}

interface OffsetGroup {
    outPath: Path;
    outPaths: Path[];
}

/** ClipperOffset with the corrected polygon loop (see the module comment). */
class FixedClipperOffset extends ClipperOffset {}
Object.defineProperty(FixedClipperOffset.prototype, "offsetPolygon", {
    value: function offsetPolygon(this: OffsetInternals, group: OffsetGroup, path: Path) {
        const area = Clipper.area(path);
        if (area < 0 !== this._groupDelta < 0) {
            const rect = Clipper.getBounds(path);
            const offsetMinDim = Math.abs(this._groupDelta) * 2;
            if (offsetMinDim > rect.width || offsetMinDim > rect.height) return;
        }
        group.outPath = [];
        const count = path.length;
        let previous = count - 1;
        for (let i = 0; i < count; i++) {
            this.offsetPoint(group, path, i, previous);
            previous = i;
        }
        group.outPaths.push(group.outPath);
    },
    writable: true,
    configurable: true,
});
// The library's execute, with the cleanup union on a fast clipper.
Object.defineProperty(FixedClipperOffset.prototype, "execute", {
    value: function execute(this: OffsetInternals, delta: number, solution: Paths64) {
        solution.length = 0;
        this.executeInternal(delta);
        if (this._groupList.length === 0) return;
        const clipper = fastClipper();
        clipper.preserveCollinear = this.PreserveCollinear;
        clipper.reverseSolution = this.ReverseSolution !== this._groupList[0].pathsReversed;
        clipper.addSubjectPaths(this._solution);
        clipper.execute(
            ClipType.Union,
            this._groupList[0].pathsReversed ? FillRule.Negative : FillRule.Positive,
            solution,
        );
    },
    writable: true,
    configurable: true,
});

/** Fresh point objects: clipper2-js may modify the points it is given. */
function copyPaths(paths: Paths): Paths64 {
    return paths.map((path) => path.map((p) => ({ x: p.x, y: p.y })));
}

/** Drops repeated vertices (and a closing duplicate) and paths with fewer than 3 vertices. */
export function cleanPaths(paths: Paths, closed = true): Paths {
    const result: Paths = [];
    for (const path of paths) {
        const out: Path = [];
        for (const p of path) {
            const last = out[out.length - 1];
            // `+ 0` turns clipper's occasional -0 into 0.
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

export type JoinKind = "miter" | "round" | "square";

const JOINS: Record<JoinKind, JoinType> = {
    miter: JoinType.Miter,
    round: JoinType.Round,
    square: JoinType.Square,
};

/** Grows (positive) or shrinks (negative) a region by `deltaMm`. */
export function offset(paths: Paths, deltaMm: number, join: JoinKind = "miter", miterLimit = 3): Paths {
    if (paths.length === 0) return [];
    const delta = deltaMm * SCALE;
    if (Math.abs(delta) < 0.5) return union(paths);
    const offsetter = new FixedClipperOffset(miterLimit, SCALE * 0.005);
    offsetter.addPaths(copyPaths(paths), JOINS[join], EndType.Polygon);
    const solution: Paths64 = [];
    offsetter.execute(delta, solution);
    return cleanPaths(solution);
}

/** Shrinks then grows back: removes the parts of a region narrower than 2 × `radiusMm`. */
export function opening(paths: Paths, radiusMm: number): Paths {
    return offset(offset(paths, -radiusMm), radiusMm);
}

export function union(subject: Paths, clip: Paths = [], fillRule: FillRule = FillRule.NonZero): Paths {
    if (subject.length === 0 && clip.length === 0) return [];
    return booleanOp(ClipType.Union, subject, clip, fillRule);
}

export function difference(subject: Paths, clip: Paths): Paths {
    if (subject.length === 0) return [];
    if (clip.length === 0) return subject;
    return booleanOp(ClipType.Difference, subject, clip, FillRule.NonZero);
}

export function intersection(subject: Paths, clip: Paths): Paths {
    if (subject.length === 0 || clip.length === 0) return [];
    return booleanOp(ClipType.Intersection, subject, clip, FillRule.NonZero);
}

/** The parts of open polylines inside a region (see `lineClip.ts`: not clipper2-js's). */
export function clipLines(lines: Paths, region: Paths): Paths {
    if (lines.length === 0 || region.length === 0) return [];
    return clipPolylines(lines, new RegionIndex(region));
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
export function pointInPath(point: IPoint64, path: Path): boolean {
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
export function pointInRegion(point: IPoint64, region: Paths): boolean {
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

/** Groups a cleaned region (outer CCW, holes CW, not overlapping) into islands. */
export function islands(region: Paths): Island[] {
    const outers = region
        .filter((path) => signedArea(path) > 0)
        .map((path) => ({ path, area: signedArea(path), holes: [] as Path[] }))
        .sort((a, b) => a.area - b.area);
    for (const hole of region) {
        const area = -signedArea(hole);
        if (area <= 0) continue;
        const probe = hole[0];
        const parent = outers.find((outer) => outer.area > area && pointInPath(probe, outer.path));
        parent?.holes.push(hole);
    }
    return outers.reverse().map(({ path, holes }) => ({ outer: path, holes }));
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

function distanceToSegmentSq(p: IPoint64, a: IPoint64, b: IPoint64): number {
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

/** Douglas–Peucker simplification of closed paths (the vertex farthest from the first is kept). */
export function simplifyClosed(paths: Paths, toleranceMm: number): Paths {
    const toleranceSq = (toleranceMm * SCALE) ** 2;
    const result: Paths = [];
    for (const path of paths) {
        if (path.length <= 3) {
            result.push(path);
            continue;
        }
        let far = 0;
        let farSq = -1;
        for (let i = 1; i < path.length; i++) {
            const d = (path[i].x - path[0].x) ** 2 + (path[i].y - path[0].y) ** 2;
            if (d > farSq) {
                farSq = d;
                far = i;
            }
        }
        const ring = [...path, path[0]];
        const keep = new Array<boolean>(ring.length).fill(false);
        keep[0] = true;
        keep[far] = true;
        keep[ring.length - 1] = true;
        douglasPeucker(ring, 0, far, toleranceSq, keep);
        douglasPeucker(ring, far, ring.length - 1, toleranceSq, keep);
        const out = ring.filter((_, i) => keep[i] && i < ring.length - 1);
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

export { FillRule };
