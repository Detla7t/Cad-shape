// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DEG, type Mat3, wrap180 } from "../vec";

/**
 * Angle triples describing a tilted work plane (frame columns in WCS) the way each control
 * wants them. All in degrees.
 */

const SINGULAR = 1e-9;

/**
 * Fanuc G68.2 I J K: Euler Z-X-Z (rotate about Z, the new X, the new Z) — R = Rz(I)·Rx(J)·Rz(K).
 * Of the two equivalent triples (J and −J) the one with the smaller I and K is returned.
 */
export function eulerZXZ(frame: Mat3): [number, number, number] {
    const [x, y, z] = [0, 1, 2].map((i) => [frame[0][i], frame[1][i], frame[2][i]]);
    const j = Math.acos(Math.max(-1, Math.min(1, z[2])));
    if (Math.sin(j) < SINGULAR) {
        // About the WCS Z only (or upside down): fold everything into I.
        return [Math.atan2(x[1], x[0]) / DEG, j / DEG, 0];
    }
    const i = Math.atan2(z[0], -z[1]) / DEG;
    const k = Math.atan2(x[2], y[2]) / DEG;
    const mirrored: [number, number, number] = [wrap180(i + 180), -j / DEG, wrap180(k + 180)];
    const direct: [number, number, number] = [i, j / DEG, k];
    const size = (t: [number, number, number]) => Math.abs(t[0]) + Math.abs(t[2]);
    return size(mirrored) < size(direct) - 1e-9 ? mirrored : direct;
}

/** Siemens CYCLE800 axis by axis X-Y-Z (rotate about X, the new Y, the new Z) — R = Rx(A)·Ry(B)·Rz(C). */
export function axisByAxisXYZ(frame: Mat3): [number, number, number] {
    const [x, y, z] = [0, 1, 2].map((i) => [frame[0][i], frame[1][i], frame[2][i]]);
    const b = Math.asin(Math.max(-1, Math.min(1, z[0])));
    if (Math.cos(b) < SINGULAR) return [0, b / DEG, Math.atan2(x[1], y[1]) / DEG];
    return [Math.atan2(-z[1], z[2]) / DEG, b / DEG, Math.atan2(-y[0], x[0]) / DEG];
}

/** Heidenhain PLANE SPATIAL: about the fixed X, then the fixed Y, then the fixed Z — R = Rz(SPC)·Ry(SPB)·Rx(SPA). */
export function spatialAngles(frame: Mat3): [number, number, number] {
    const [x, y] = [0, 1].map((i) => [frame[0][i], frame[1][i], frame[2][i]]);
    const spb = Math.asin(Math.max(-1, Math.min(1, -x[2])));
    if (Math.cos(spb) < SINGULAR) return [0, spb / DEG, Math.atan2(-y[0], y[1]) / DEG];
    return [Math.atan2(y[2], frame[2][2]) / DEG, spb / DEG, Math.atan2(x[1], x[0]) / DEG];
}
