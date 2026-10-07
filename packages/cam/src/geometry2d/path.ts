// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    add,
    angleOf,
    cross,
    distance,
    fromAngle,
    lerp,
    normalize,
    type Point2,
    perpLeft,
    perpRight,
    sub,
} from "./vec";

/**
 * Toolpath geometry in the XY plane: chains of lines and circular arcs. Arcs are kept as
 * arcs (center, direction) so toolpaths come out as G2/G3 moves; `pathPoints` flattens a
 * path to a polyline within a chord tolerance when a polygon is needed.
 */

export type PathSegment =
    | { readonly kind: "line"; readonly from: Point2; readonly to: Point2 }
    /** A circular arc from `from` to `to` around `center`, counter-clockwise when `ccw`. */
    | {
          readonly kind: "arc";
          readonly from: Point2;
          readonly to: Point2;
          readonly center: Point2;
          readonly ccw: boolean;
      };

export interface Path2 {
    readonly segments: readonly PathSegment[];
    /** True when the last segment ends where the first starts. */
    readonly closed: boolean;
}

export const lineSegment = (from: Point2, to: Point2): PathSegment => ({ kind: "line", from, to });

export function arcSegment(from: Point2, to: Point2, center: Point2, ccw: boolean): PathSegment {
    return { kind: "arc", from, to, center, ccw };
}

export function arcRadius(segment: Extract<PathSegment, { kind: "arc" }>): number {
    return distance(segment.center, segment.from);
}

/**
 * The arc's sweep in [0, 2π). Coincident ends make a degenerate (zero) arc: a full circle is
 * always two (or more) arcs, which every controller accepts.
 */
export function arcSweep(segment: Extract<PathSegment, { kind: "arc" }>): number {
    if (distance(segment.from, segment.to) < 1e-9) return 0;
    const a0 = angleOf(sub(segment.from, segment.center));
    const a1 = angleOf(sub(segment.to, segment.center));
    let sweep = segment.ccw ? a1 - a0 : a0 - a1;
    while (sweep < 0) sweep += 2 * Math.PI;
    while (sweep >= 2 * Math.PI) sweep -= 2 * Math.PI;
    return sweep;
}

export function segmentLength(segment: PathSegment): number {
    if (segment.kind === "line") return distance(segment.from, segment.to);
    return arcRadius(segment) * arcSweep(segment);
}

export function pathLength(path: Path2 | readonly PathSegment[]): number {
    const segments = "segments" in path ? path.segments : path;
    return segments.reduce((sum, segment) => sum + segmentLength(segment), 0);
}

/** The point `s` mm along a segment from its start. */
export function segmentPointAt(segment: PathSegment, s: number): Point2 {
    const length = segmentLength(segment);
    if (segment.kind === "line")
        return length < 1e-15 ? segment.from : lerp(segment.from, segment.to, s / length);
    const r = arcRadius(segment);
    const a0 = angleOf(sub(segment.from, segment.center));
    const angle = a0 + ((segment.ccw ? 1 : -1) * s) / r;
    return add(segment.center, fromAngle(angle, r));
}

/** Unit direction of travel `s` mm along a segment. */
export function segmentTangentAt(segment: PathSegment, s: number): Point2 {
    if (segment.kind === "line") return normalize(sub(segment.to, segment.from));
    const p = segmentPointAt(segment, s);
    const radial = normalize(sub(p, segment.center));
    return segment.ccw ? perpLeft(radial) : perpRight(radial);
}

export const segmentStartTangent = (segment: PathSegment): Point2 => segmentTangentAt(segment, 0);
export const segmentEndTangent = (segment: PathSegment): Point2 =>
    segmentTangentAt(segment, segmentLength(segment));

/** Splits a segment `s` mm from its start into two (either may be degenerate). */
export function splitSegment(segment: PathSegment, s: number): [PathSegment, PathSegment] {
    const p = segmentPointAt(segment, s);
    if (segment.kind === "line") return [lineSegment(segment.from, p), lineSegment(p, segment.to)];
    return [
        arcSegment(segment.from, p, segment.center, segment.ccw),
        arcSegment(p, segment.to, segment.center, segment.ccw),
    ];
}

export function reverseSegment(segment: PathSegment): PathSegment {
    if (segment.kind === "line") return lineSegment(segment.to, segment.from);
    return arcSegment(segment.to, segment.from, segment.center, !segment.ccw);
}

export function reversePath(path: Path2): Path2 {
    return { closed: path.closed, segments: [...path.segments].reverse().map(reverseSegment) };
}

export const pathStart = (path: Path2): Point2 => path.segments[0].from;
export const pathEnd = (path: Path2): Point2 => path.segments[path.segments.length - 1].to;

/** The point `s` mm along a path (clamped; closed paths wrap). */
export function pathPointAt(path: Path2, s: number): Point2 {
    const { segment, offset } = locate(path, s);
    return segmentPointAt(segment, offset);
}

export function pathTangentAt(path: Path2, s: number): Point2 {
    const { segment, offset } = locate(path, s);
    return segmentTangentAt(segment, offset);
}

function locate(path: Path2, s: number): { segment: PathSegment; offset: number; index: number } {
    const total = pathLength(path);
    let t = s;
    if (path.closed && total > 0) t = ((s % total) + total) % total;
    t = Math.max(0, Math.min(total, t));
    for (let i = 0; i < path.segments.length; i++) {
        const length = segmentLength(path.segments[i]);
        if (t <= length || i === path.segments.length - 1) {
            return { segment: path.segments[i], offset: Math.min(t, length), index: i };
        }
        t -= length;
    }
    return { segment: path.segments[0], offset: 0, index: 0 };
}

const MIN_SEGMENT = 1e-9;

/**
 * The part of a path between `s0` and `s1` mm. On a closed path `s1 < s0` wraps through
 * the start; on an open path the range is clamped.
 */
export function subPath(path: Path2, s0: number, s1: number): PathSegment[] {
    const total = pathLength(path);
    if (path.closed && s1 < s0) return [...subPath(path, s0, total), ...subPath(path, 0, s1)];
    const a = Math.max(0, Math.min(total, s0));
    const b = Math.max(0, Math.min(total, s1));
    const out: PathSegment[] = [];
    let at = 0;
    for (const segment of path.segments) {
        const length = segmentLength(segment);
        const start = at;
        const end = at + length;
        at = end;
        if (end <= a + MIN_SEGMENT || start >= b - MIN_SEGMENT) continue;
        let piece = segment;
        const cutEnd = Math.min(b, end) - start;
        if (cutEnd < length - MIN_SEGMENT) piece = splitSegment(piece, cutEnd)[0];
        const cutStart = Math.max(a, start) - start;
        if (cutStart > MIN_SEGMENT) piece = splitSegment(piece, cutStart)[1];
        if (segmentLength(piece) > MIN_SEGMENT) out.push(piece);
    }
    return out;
}

/** A closed path started `s` mm along (same geometry, new seam). */
export function startClosedPathAt(path: Path2, s: number): Path2 {
    if (!path.closed) return path;
    const total = pathLength(path);
    const t = ((s % total) + total) % total;
    if (t < MIN_SEGMENT || total - t < MIN_SEGMENT) return path;
    return { closed: true, segments: [...subPath(path, t, total), ...subPath(path, 0, t)] };
}

/** Lines through the points, closed back to the first one when `closed`. */
export function pathFromPoints(points: readonly Point2[], closed: boolean): Path2 {
    const segments: PathSegment[] = [];
    for (let i = 1; i < points.length; i++) segments.push(lineSegment(points[i - 1], points[i]));
    if (closed && points.length > 2) segments.push(lineSegment(points[points.length - 1], points[0]));
    return { segments, closed: closed && points.length > 2 };
}

/** The chord angle that keeps an arc of `radius` within `tolerance` of its polygon. */
export function arcStepAngle(radius: number, tolerance: number): number {
    if (radius <= tolerance) return Math.PI / 2;
    return Math.min(Math.PI / 4, 2 * Math.acos(1 - tolerance / radius));
}

/** Points along a segment within `tolerance`, without its start point. */
export function segmentPoints(segment: PathSegment, tolerance: number): Point2[] {
    if (segment.kind === "line") return [segment.to];
    const r = arcRadius(segment);
    const sweep = arcSweep(segment);
    const n = Math.max(1, Math.ceil(sweep / arcStepAngle(r, tolerance)));
    const a0 = angleOf(sub(segment.from, segment.center));
    const sign = segment.ccw ? 1 : -1;
    const out: Point2[] = [];
    for (let i = 1; i < n; i++) out.push(add(segment.center, fromAngle(a0 + (sign * sweep * i) / n, r)));
    out.push(segment.to);
    return out;
}

/** The path as a polyline within `tolerance` (a closed path does not repeat its start). */
export function pathPoints(path: Path2 | readonly PathSegment[], tolerance = 0.002): Point2[] {
    const segments = "segments" in path ? path.segments : path;
    const closed = "segments" in path ? path.closed : false;
    if (segments.length === 0) return [];
    const out: Point2[] = [segments[0].from];
    for (const segment of segments) out.push(...segmentPoints(segment, tolerance));
    if (closed && out.length > 1 && distance(out[0], out[out.length - 1]) < 1e-9) out.pop();
    return out;
}

/** Splits arcs sweeping more than `maxSweep` (default 180°) into equal pieces. */
export function limitArcSweep(segments: readonly PathSegment[], maxSweep = Math.PI): PathSegment[] {
    const out: PathSegment[] = [];
    for (const segment of segments) {
        if (segment.kind !== "arc") {
            out.push(segment);
            continue;
        }
        const sweep = arcSweep(segment);
        const n = Math.ceil(sweep / maxSweep - 1e-9);
        if (n <= 1) {
            out.push(segment);
            continue;
        }
        const length = segmentLength(segment);
        let from = segment.from;
        for (let i = 1; i <= n; i++) {
            const to = i === n ? segment.to : segmentPointAt(segment, (length * i) / n);
            out.push(arcSegment(from, to, segment.center, segment.ccw));
            from = to;
        }
    }
    return out;
}

/** Signed area enclosed by a closed path (arcs exact): positive counter-clockwise. */
export function pathSignedArea(path: Path2): number {
    let area = 0;
    for (const segment of path.segments) {
        area += cross(segment.from, segment.to) / 2;
        if (segment.kind === "arc") {
            const r = arcRadius(segment);
            const theta = arcSweep(segment);
            area += ((segment.ccw ? 1 : -1) * r * r * (theta - Math.sin(theta))) / 2;
        }
    }
    return area;
}

/** The point of a segment nearest to `p`: its distance along the segment and from `p`. */
export function nearestOnSegment(segment: PathSegment, p: Point2): { s: number; distance: number } {
    if (segment.kind === "line") {
        const d = sub(segment.to, segment.from);
        const len2 = d[0] * d[0] + d[1] * d[1];
        const t =
            len2 < 1e-24
                ? 0
                : Math.max(
                      0,
                      Math.min(1, ((p[0] - segment.from[0]) * d[0] + (p[1] - segment.from[1]) * d[1]) / len2),
                  );
        return { s: t * Math.sqrt(len2), distance: distance(p, lerp(segment.from, segment.to, t)) };
    }
    const r = arcRadius(segment);
    const sweep = arcSweep(segment);
    let offset = angleOf(sub(p, segment.center)) - angleOf(sub(segment.from, segment.center));
    if (!segment.ccw) offset = -offset;
    offset = ((offset % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (offset <= sweep) return { s: offset * r, distance: Math.abs(distance(p, segment.center) - r) };
    const toStart = distance(p, segment.from);
    const toEnd = distance(p, segment.to);
    return toStart <= toEnd ? { s: 0, distance: toStart } : { s: sweep * r, distance: toEnd };
}

/** The arc-length position of the path point nearest to `p`. */
export function nearestArcLength(
    path: Path2 | readonly PathSegment[],
    p: Point2,
): { s: number; distance: number } {
    const segments = "segments" in path ? path.segments : path;
    let best = { s: 0, distance: Number.POSITIVE_INFINITY };
    let at = 0;
    for (const segment of segments) {
        const hit = nearestOnSegment(segment, p);
        if (hit.distance < best.distance) best = { s: at + hit.s, distance: hit.distance };
        at += segmentLength(segment);
    }
    return best;
}
