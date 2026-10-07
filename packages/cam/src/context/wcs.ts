// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Matrix4 } from "@chili3d/core";
import type { SetupData } from "../model/setup";
import type { Vec3 } from "../model/toolpath";

/**
 * The work coordinate system of a setup: an origin and two axes in model coordinates. The
 * pipeline moves parts into it (model → WCS), the preview moves toolpaths out of it (WCS →
 * model). Matrices follow core's row-vector convention: `a.multiply(b)` applies `a` first.
 */
export type WcsData = SetupData["wcs"];

export const WORLD_WCS: WcsData = { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] };

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];

function unit(a: Vec3): Vec3 | undefined {
    const n = Math.hypot(a[0], a[1], a[2]);
    return n < 1e-12 ? undefined : [a[0] / n, a[1] / n, a[2] / n];
}

/**
 * An orthonormal WCS from an origin, a z axis and a hint for x (projected into the plane
 * ⟂ z; any perpendicular when the hint is parallel to z).
 */
export function makeWcs(origin: Vec3, zAxis: Vec3, xHint: Vec3 = [1, 0, 0]): WcsData {
    const z = unit(zAxis) ?? [0, 0, 1];
    let x = unit([
        xHint[0] - z[0] * dot(xHint, z),
        xHint[1] - z[1] * dot(xHint, z),
        xHint[2] - z[2] * dot(xHint, z),
    ]);
    if (x === undefined) {
        const helper: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        x = unit([
            helper[0] - z[0] * dot(helper, z),
            helper[1] - z[1] * dot(helper, z),
            helper[2] - z[2] * dot(helper, z),
        ])!;
    }
    return { origin: [origin[0], origin[1], origin[2]], xAxis: x, zAxis: z };
}

/** The WCS with its axes re-orthonormalized (a hand-edited or legacy WCS). */
export function normalizeWcs(wcs: WcsData): WcsData {
    return makeWcs(wcs.origin, wcs.zAxis, wcs.xAxis);
}

export function wcsYAxis(wcs: WcsData): Vec3 {
    return cross(wcs.zAxis, wcs.xAxis);
}

/** WCS → model coordinates. */
export function wcsToModelMatrix(wcs: WcsData): Matrix4 {
    const { origin: o, xAxis: x, zAxis: z } = normalizeWcs(wcs);
    const y = cross(z, x);
    return Matrix4.fromArray([
        x[0],
        x[1],
        x[2],
        0,
        y[0],
        y[1],
        y[2],
        0,
        z[0],
        z[1],
        z[2],
        0,
        o[0],
        o[1],
        o[2],
        1,
    ]);
}

/** Model → WCS coordinates. */
export function modelToWcsMatrix(wcs: WcsData): Matrix4 {
    const { origin: o, xAxis: x, zAxis: z } = normalizeWcs(wcs);
    const y = cross(z, x);
    return Matrix4.fromArray([
        x[0],
        y[0],
        z[0],
        0,
        x[1],
        y[1],
        z[1],
        0,
        x[2],
        y[2],
        z[2],
        0,
        -dot(o, x),
        -dot(o, y),
        -dot(o, z),
        1,
    ]);
}

/** A WCS point in model coordinates. */
export function wcsPointToModel(wcs: WcsData, p: Vec3): Vec3 {
    const { origin: o, xAxis: x, zAxis: z } = wcs;
    const y = cross(z, x);
    return [
        o[0] + p[0] * x[0] + p[1] * y[0] + p[2] * z[0],
        o[1] + p[0] * x[1] + p[1] * y[1] + p[2] * z[1],
        o[2] + p[0] * x[2] + p[1] * y[2] + p[2] * z[2],
    ];
}

/** A WCS direction in model coordinates. */
export function wcsVectorToModel(wcs: WcsData, v: Vec3): Vec3 {
    const { xAxis: x, zAxis: z } = wcs;
    const y = cross(z, x);
    return [
        v[0] * x[0] + v[1] * y[0] + v[2] * z[0],
        v[0] * x[1] + v[1] * y[1] + v[2] * z[1],
        v[0] * x[2] + v[1] * y[2] + v[2] * z[2],
    ];
}

/** A model point in WCS coordinates. */
export function modelPointToWcs(wcs: WcsData, p: Vec3): Vec3 {
    const { origin: o, xAxis: x, zAxis: z } = wcs;
    const y = cross(z, x);
    const d: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    return [dot(d, x), dot(d, y), dot(d, z)];
}
