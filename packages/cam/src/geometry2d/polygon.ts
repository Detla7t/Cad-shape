// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { distance, lerp, normalize, type Point2, segmentDistance, sub } from "./vec";

/**
 * Polygons and polylines as point lists. A closed polygon does not repeat its first point.
 * Orientation follows the CAM convention: outer boundaries counter-clockwise (positive
 * area), holes and islands clockwise.
 */

export interface Bounds2 {
    readonly min: Point2;
    readonly max: Point2;
}

/** Shoelace area: positive for counter-clockwise polygons. */
export function signedArea(points: readonly Point2[]): number {
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
    }
    return area / 2;
}

export function isCounterClockwise(points: readonly Point2[]): boolean {
    return signedArea(points) > 0;
}

/** The polygon in the requested orientation (a copy when it has to turn around). */
export function oriented(points: readonly Point2[], counterClockwise: boolean): Point2[] {
    return isCounterClockwise(points) === counterClockwise ? [...points] : [...points].reverse();
}

/** Even-odd point-in-polygon (points on the boundary may land on either side). */
export function pointInPolygon(p: Point2, polygon: readonly Point2[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

export function polylineLength(points: readonly Point2[], closed: boolean): number {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
    if (closed && points.length > 1) total += distance(points[points.length - 1], points[0]);
    return total;
}

export function bounds(points: Iterable<Point2>): Bounds2 {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [x, y] of points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    return { min: [minX, minY], max: [maxX, maxY] };
}

/** Area centroid of a simple polygon (the vertex mean for a degenerate one). */
export function centroid(points: readonly Point2[]): Point2 {
    const area = signedArea(points);
    if (Math.abs(area) < 1e-12) {
        const n = Math.max(1, points.length);
        return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
    }
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const f = points[j][0] * points[i][1] - points[i][0] * points[j][1];
        cx += (points[j][0] + points[i][0]) * f;
        cy += (points[j][1] + points[i][1]) * f;
    }
    return [cx / (6 * area), cy / (6 * area)];
}

/** Drops consecutive points closer than `tolerance` (and a closing duplicate). */
export function removeDuplicatePoints(
    points: readonly Point2[],
    closed: boolean,
    tolerance = 1e-7,
): Point2[] {
    const out: Point2[] = [];
    for (const p of points) {
        if (out.length === 0 || distance(out[out.length - 1], p) > tolerance) out.push(p);
    }
    if (closed) while (out.length > 1 && distance(out[0], out[out.length - 1]) <= tolerance) out.pop();
    return out;
}

/** The closest point of a polyline to `p`: the point, its segment index and the distance. */
export function closestPointOnPolyline(
    p: Point2,
    points: readonly Point2[],
    closed: boolean,
): { point: Point2; segment: number; t: number; distance: number } {
    let best = { point: points[0], segment: 0, t: 0, distance: distance(p, points[0]) };
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const hit = segmentDistance(p, a, b);
        if (hit.distance < best.distance)
            best = { point: lerp(a, b, hit.t), segment: i, t: hit.t, distance: hit.distance };
    }
    return best;
}

export function distanceToPolyline(p: Point2, points: readonly Point2[], closed: boolean): number {
    return closestPointOnPolyline(p, points, closed).distance;
}

/** The distance from `p` to the nearest boundary of a set of loops. */
export function distanceToLoops(p: Point2, loops: readonly (readonly Point2[])[]): number {
    let best = Number.POSITIVE_INFINITY;
    for (const loop of loops) best = Math.min(best, distanceToPolyline(p, loop, true));
    return best;
}

/** Inside a region given as loops (outer loops and holes), by even-odd over all of them. */
export function pointInLoops(p: Point2, loops: readonly (readonly Point2[])[]): boolean {
    let inside = false;
    for (const loop of loops) if (pointInPolygon(p, loop)) inside = !inside;
    return inside;
}

/** A point strictly inside a simple polygon (centroid when inside, else a probe near an edge). */
export function interiorPoint(points: readonly Point2[]): Point2 {
    const c = centroid(points);
    if (pointInPolygon(c, points)) return c;
    const ccw = isCounterClockwise(points);
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const d = normalize(sub(b, a));
        const len = distance(a, b);
        if (len < 1e-9) continue;
        const inward: Point2 = ccw ? [-d[1], d[0]] : [d[1], -d[0]];
        for (const eps of [len * 1e-3, 1e-4, 1e-6]) {
            const m = lerp(a, b, 0.5);
            const probe: Point2 = [m[0] + inward[0] * eps, m[1] + inward[1] * eps];
            if (pointInPolygon(probe, points)) return probe;
        }
    }
    return c;
}
