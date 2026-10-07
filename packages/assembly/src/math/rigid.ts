// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Matrix4 } from "@chili3d/core";

/**
 * Rigid-body math for assemblies, on plain tuples so the solver runs without the kernel.
 *
 * A `Rigid` maps a point p of its local coordinates to `R p + t` (R a proper rotation, stored
 * row-major). Composition reads right to left like functions: `compose(a, b)` applies `b`
 * first. `Matrix4` (core) is column-major and composes left to right (`m1.multiply(m2)` applies
 * `m1` first); `toMatrix4` / `fromMatrix4` are the only crossings between the two.
 *
 * A `Frame` is a right-handed orthonormal coordinate system — a mate connector.
 */

export type Vec3 = readonly [number, number, number];

/** Row-major 3×3 rotation. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export interface Rigid {
    readonly r: Mat3;
    readonly t: Vec3;
}

export interface Frame {
    readonly origin: Vec3;
    readonly x: Vec3;
    readonly y: Vec3;
    readonly z: Vec3;
}

export const ZERO: Vec3 = [0, 0, 0];
export const UNIT_X: Vec3 = [1, 0, 0];
export const UNIT_Y: Vec3 = [0, 1, 0];
export const UNIT_Z: Vec3 = [0, 0, 1];
export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const IDENTITY: Rigid = { r: IDENTITY3, t: ZERO };

// ------------------------------------------------------------------ Vectors

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.sqrt(dot(a, a));

export function normalize(a: Vec3, fallback: Vec3 = UNIT_Z): Vec3 {
    const length = norm(a);
    return length < 1e-12 ? fallback : scale(a, 1 / length);
}

/** Any unit vector perpendicular to `v` (which need not be normalized). */
export function perpendicular(v: Vec3): Vec3 {
    const n = normalize(v);
    // Cross with the world axis least aligned with v.
    const ax = Math.abs(n[0]);
    const ay = Math.abs(n[1]);
    const az = Math.abs(n[2]);
    const helper: Vec3 = ax <= ay && ax <= az ? UNIT_X : ay <= az ? UNIT_Y : UNIT_Z;
    return normalize(cross(n, helper));
}

// ------------------------------------------------------------------ Rotations

export function mulMat(a: Mat3, b: Mat3): Mat3 {
    const out = new Array<number>(9);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
        }
    }
    return out as unknown as Mat3;
}

export const applyMat = (m: Mat3, v: Vec3): Vec3 => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** The rotation by |w| radians about w (Rodrigues' formula); w = 0 is the identity. */
export function expMap(w: Vec3): Mat3 {
    const angle = norm(w);
    if (angle < 1e-15) return IDENTITY3;
    return axisAngle(scale(w, 1 / angle), angle);
}

/** Rotation by `angle` radians about the unit `axis`. */
export function axisAngle(axis: Vec3, angle: number): Mat3 {
    const [x, y, z] = axis;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const k = 1 - c;
    return [
        c + x * x * k,
        x * y * k - z * s,
        x * z * k + y * s,
        y * x * k + z * s,
        c + y * y * k,
        y * z * k - x * s,
        z * x * k - y * s,
        z * y * k + x * s,
        c + z * z * k,
    ];
}

/** The smallest rotation taking unit `from` onto unit `to` (a half turn about a perpendicular when opposite). */
export function rotationBetween(from: Vec3, to: Vec3, halfTurnAxis?: Vec3): Mat3 {
    const a = normalize(from);
    const b = normalize(to);
    const c = dot(a, b);
    if (c > 1 - 1e-14) return IDENTITY3;
    if (c < -1 + 1e-14) {
        const axis =
            halfTurnAxis !== undefined && Math.abs(dot(normalize(halfTurnAxis), a)) < 1e-6
                ? normalize(halfTurnAxis)
                : perpendicular(a);
        return axisAngle(axis, Math.PI);
    }
    const axis = cross(a, b);
    return axisAngle(normalize(axis), Math.atan2(norm(axis), c));
}

/** Re-orthonormalizes a nearly orthonormal matrix (Gram–Schmidt on its columns). */
export function orthonormalize(m: Mat3): Mat3 {
    const c0 = normalize([m[0], m[3], m[6]], UNIT_X);
    let c1: Vec3 = [m[1], m[4], m[7]];
    c1 = normalize(sub(c1, scale(c0, dot(c0, c1))), perpendicular(c0));
    const c2 = cross(c0, c1);
    return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
}

// ------------------------------------------------------------------ Rigid transforms

export const applyRigid = (m: Rigid, p: Vec3): Vec3 => add(applyMat(m.r, p), m.t);

/** `a ∘ b`: applies `b`, then `a`. */
export function compose(a: Rigid, b: Rigid): Rigid {
    return { r: mulMat(a.r, b.r), t: add(applyMat(a.r, b.t), a.t) };
}

export function invert(m: Rigid): Rigid {
    const rt = transpose(m.r);
    return { r: rt, t: scale(applyMat(rt, m.t), -1) };
}

export const translation = (t: Vec3): Rigid => ({ r: IDENTITY3, t });

/** The rigid map that takes the world frame onto `frame`. */
export function frameToRigid(frame: Frame): Rigid {
    const { x, y, z, origin } = frame;
    return { r: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]], t: origin };
}

export function rigidToFrame(m: Rigid): Frame {
    const r = m.r;
    return { origin: m.t, x: [r[0], r[3], r[6]], y: [r[1], r[4], r[7]], z: [r[2], r[5], r[8]] };
}

/** `frame` (given in m's local coordinates) expressed in m's target coordinates. */
export function transformFrame(m: Rigid, frame: Frame): Frame {
    return rigidToFrame(compose(m, frameToRigid(frame)));
}

/**
 * A frame at `origin` with Z along `z` and X as close to `xHint` as orthogonality allows (any
 * perpendicular when the hint is missing or parallel to Z).
 */
export function makeFrame(origin: Vec3, z: Vec3, xHint?: Vec3): Frame {
    const zn = normalize(z);
    let x = xHint === undefined ? perpendicular(zn) : sub(xHint, scale(zn, dot(xHint, zn)));
    x = norm(x) < 1e-9 ? perpendicular(zn) : normalize(x);
    return { origin, x, y: cross(zn, x), z: zn };
}

export const WORLD_FRAME: Frame = { origin: ZERO, x: UNIT_X, y: UNIT_Y, z: UNIT_Z };

// ------------------------------------------------------------------ Matrix4 boundary

/** Column-major 4×4 (the `Matrix4` layout, translation in 12..14) of a rigid map. */
export function rigidToArray(m: Rigid): number[] {
    const r = m.r;
    return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, m.t[0], m.t[1], m.t[2], 1];
}

/** The rigid part of a column-major 4×4 (rotation re-orthonormalized, scale dropped). */
export function arrayToRigid(a: ArrayLike<number>): Rigid {
    if (a.length < 16) return IDENTITY;
    const r: Mat3 = [a[0], a[4], a[8], a[1], a[5], a[9], a[2], a[6], a[10]];
    return { r: orthonormalize(r), t: [a[12], a[13], a[14]] };
}

export const toMatrix4 = (m: Rigid): Matrix4 => Matrix4.fromArray(rigidToArray(m));
export const fromMatrix4 = (m: Matrix4): Rigid => arrayToRigid(m.toArray());

/** Largest translation (mm) and rotation (rad) between two rigid maps. */
export function rigidDistance(a: Rigid, b: Rigid): { translation: number; rotation: number } {
    const delta = mulMat(a.r, transpose(b.r));
    const trace = delta[0] + delta[4] + delta[8];
    const rotation = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
    return { translation: norm(sub(a.t, b.t)), rotation };
}

export const vec = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
