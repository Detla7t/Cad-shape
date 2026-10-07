// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** A point or vector in the setup's XY plane (WCS), millimetres. */
export type Point2 = readonly [number, number];

export const add = (a: Point2, b: Point2): Point2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Point2, b: Point2): Point2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Point2, s: number): Point2 => [a[0] * s, a[1] * s];
export const dot = (a: Point2, b: Point2): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Point2, b: Point2): number => a[0] * b[1] - a[1] * b[0];
export const length = (a: Point2): number => Math.hypot(a[0], a[1]);
export const distance = (a: Point2, b: Point2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a: Point2, b: Point2, t: number): Point2 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
];
export const midpoint = (a: Point2, b: Point2): Point2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
/** Rotated +90° (the left-hand normal of a direction). */
export const perpLeft = (a: Point2): Point2 => [-a[1], a[0]];
/** Rotated −90° (the right-hand normal of a direction). */
export const perpRight = (a: Point2): Point2 => [a[1], -a[0]];
export const angleOf = (a: Point2): number => Math.atan2(a[1], a[0]);
export const fromAngle = (angle: number, radius = 1): Point2 => [
    radius * Math.cos(angle),
    radius * Math.sin(angle),
];
export const samePoint = (a: Point2, b: Point2, tolerance = 1e-9): boolean => distance(a, b) <= tolerance;

export function normalize(a: Point2): Point2 {
    const n = length(a);
    return n < 1e-15 ? [0, 0] : [a[0] / n, a[1] / n];
}

export function rotate(a: Point2, angle: number, about: Point2 = [0, 0]): Point2 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const x = a[0] - about[0];
    const y = a[1] - about[1];
    return [about[0] + x * c - y * s, about[1] + x * s + y * c];
}

/** The signed angle from direction `a` to direction `b`, in (−π, π]. */
export function turnAngle(a: Point2, b: Point2): number {
    return Math.atan2(cross(a, b), dot(a, b));
}

/** Normalizes an angle into [0, 2π). */
export function normalizeAngle(angle: number): number {
    const t = angle % (2 * Math.PI);
    return t < 0 ? t + 2 * Math.PI : t;
}

/** Distance from `p` to the segment a–b, and the segment parameter of the closest point. */
export function segmentDistance(p: Point2, a: Point2, b: Point2): { distance: number; t: number } {
    const d = sub(b, a);
    const len2 = dot(d, d);
    const t = len2 < 1e-24 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), d) / len2));
    return { distance: distance(p, lerp(a, b, t)), t };
}

/** Whether the closed segments a–b and c–d intersect (touching counts). */
export function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2, eps = 1e-12): boolean {
    const d1 = cross(sub(b, a), sub(c, a));
    const d2 = cross(sub(b, a), sub(d, a));
    const d3 = cross(sub(d, c), sub(a, c));
    const d4 = cross(sub(d, c), sub(b, c));
    if (
        ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
        ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
    )
        return true;
    const onSegment = (p: Point2, q: Point2, r: Point2) =>
        Math.min(p[0], q[0]) - eps <= r[0] &&
        r[0] <= Math.max(p[0], q[0]) + eps &&
        Math.min(p[1], q[1]) - eps <= r[1] &&
        r[1] <= Math.max(p[1], q[1]) + eps;
    if (Math.abs(d1) <= eps && onSegment(a, b, c)) return true;
    if (Math.abs(d2) <= eps && onSegment(a, b, d)) return true;
    if (Math.abs(d3) <= eps && onSegment(c, d, a)) return true;
    if (Math.abs(d4) <= eps && onSegment(c, d, b)) return true;
    return false;
}
