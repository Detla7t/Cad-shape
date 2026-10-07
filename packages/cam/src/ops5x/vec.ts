// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Vec3 } from "../model/toolpath";

/**
 * Small vector and rotation helpers for the 5-axis module: tuples, not `XYZ`, so toolpath
 * points stay plain data. Angles are in degrees at the API, radians inside.
 */

/** A 3×3 matrix as three rows. */
export type Mat3 = readonly [Vec3, Vec3, Vec3];

export const X_AXIS: Vec3 = [1, 0, 0];
export const Y_AXIS: Vec3 = [0, 1, 0];
export const Z_AXIS: Vec3 = [0, 0, 1];
export const IDENTITY3: Mat3 = [X_AXIS, Y_AXIS, Z_AXIS];

export const DEG = Math.PI / 180;

export function add(a: Vec3, b: Vec3): Vec3 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
    return [a[0] * s, a[1] * s, a[2] * s];
}

/** a + b·s */
export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
    return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
    return Math.hypot(a[0], a[1], a[2]);
}

export function distance(a: Vec3, b: Vec3): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** The unit vector along `a`, or `fallback` when `a` is (nearly) zero. */
export function normalize(a: Vec3, fallback: Vec3 = Z_AXIS): Vec3 {
    const l = length(a);
    return l < 1e-12 ? fallback : [a[0] / l, a[1] / l, a[2] / l];
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** The angle between two vectors, degrees (robust near 0° and 180°). */
export function angleBetween(a: Vec3, b: Vec3): number {
    return Math.atan2(length(cross(a, b)), dot(a, b)) / DEG;
}

/** `v` without its component along the unit vector `n`. */
export function reject(v: Vec3, n: Vec3): Vec3 {
    return addScaled(v, n, -dot(v, n));
}

/** Spherical interpolation between unit vectors (linear when they are (anti)parallel). */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
    const omega = Math.atan2(length(cross(a, b)), dot(a, b));
    if (omega < 1e-9) return normalize(lerp(a, b, t), a);
    if (Math.PI - omega < 1e-9) {
        // Antiparallel: rotate about any perpendicular.
        return rotateVector(a, perpendicular(a), (omega * t) / DEG);
    }
    const s = Math.sin(omega);
    const wa = Math.sin((1 - t) * omega) / s;
    const wb = Math.sin(t * omega) / s;
    return normalize([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb], a);
}

/** Some unit vector perpendicular to `v`. */
export function perpendicular(v: Vec3): Vec3 {
    const n = normalize(v);
    const helper: Vec3 = Math.abs(n[0]) < 0.9 ? X_AXIS : Y_AXIS;
    return normalize(cross(n, helper));
}

/** Rotation matrix about the unit `axis` by `degrees`, right-handed. */
export function rotation(axis: Vec3, degrees: number): Mat3 {
    const [x, y, z] = normalize(axis);
    const c = Math.cos(degrees * DEG);
    const s = Math.sin(degrees * DEG);
    const t = 1 - c;
    return [
        [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
        [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
        [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
    ];
}

export function rotateVector(v: Vec3, axis: Vec3, degrees: number): Vec3 {
    return mulMV(rotation(axis, degrees), v);
}

export function mulMV(m: Mat3, v: Vec3): Vec3 {
    return [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
}

export function transpose(m: Mat3): Mat3 {
    return [
        [m[0][0], m[1][0], m[2][0]],
        [m[0][1], m[1][1], m[2][1]],
        [m[0][2], m[1][2], m[2][2]],
    ];
}

export function mulMM(a: Mat3, b: Mat3): Mat3 {
    const bt = transpose(b);
    return [
        [dot(a[0], bt[0]), dot(a[0], bt[1]), dot(a[0], bt[2])],
        [dot(a[1], bt[0]), dot(a[1], bt[1]), dot(a[1], bt[2])],
        [dot(a[2], bt[0]), dot(a[2], bt[1]), dot(a[2], bt[2])],
    ];
}

/** The matrix whose columns are `x`, `y`, `z` (a frame's axes in the parent frame). */
export function fromColumns(x: Vec3, y: Vec3, z: Vec3): Mat3 {
    return [
        [x[0], y[0], z[0]],
        [x[1], y[1], z[1]],
        [x[2], y[2], z[2]],
    ];
}

export function column(m: Mat3, index: 0 | 1 | 2): Vec3 {
    return [m[0][index], m[1][index], m[2][index]];
}

/**
 * A right-handed frame with +Z along `z` and +X as close to `xHint` as possible (projected
 * into the plane; WCS X, then WCS Y, when the hint is (nearly) parallel to `z`).
 */
export function frameFromZ(z: Vec3, xHint: Vec3 = X_AXIS): Mat3 {
    const zn = normalize(z);
    let x = reject(xHint, zn);
    if (length(x) < 1e-6) x = reject(X_AXIS, zn);
    if (length(x) < 1e-6) x = reject(Y_AXIS, zn);
    const xn = normalize(x);
    return fromColumns(xn, cross(zn, xn), zn);
}

/** Wraps degrees into (-180, 180]. */
export function wrap180(degrees: number): number {
    let a = degrees % 360;
    if (a <= -180) a += 360;
    if (a > 180) a -= 360;
    return a;
}

/** Point-to-segment distance. */
export function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    if (l2 < 1e-24) return distance(p, a);
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
    return distance(p, addScaled(a, ab, t));
}

export function almostEqualVec(a: Vec3, b: Vec3, tolerance = 1e-9): boolean {
    return (
        Math.abs(a[0] - b[0]) <= tolerance &&
        Math.abs(a[1] - b[1]) <= tolerance &&
        Math.abs(a[2] - b[2]) <= tolerance
    );
}
