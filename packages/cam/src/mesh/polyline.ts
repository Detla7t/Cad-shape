// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Point2 } from "../geometry2d";

/**
 * Collinear-point reduction (Douglas–Peucker) for toolpath polylines: a point is dropped when
 * the chord between the kept neighbours passes within `tolerance` of it.
 */

/** 3D polyline as xyz triples; returns the kept triples. */
export function simplify3(points: readonly number[], tolerance: number): number[] {
    const n = points.length / 3;
    if (n <= 2) return points.slice();
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const tol2 = tolerance * tolerance;
    const stack: number[] = [0, n - 1];
    while (stack.length > 0) {
        const last = stack.pop() ?? 0;
        const first = stack.pop() ?? 0;
        const ax = points[first * 3];
        const ay = points[first * 3 + 1];
        const az = points[first * 3 + 2];
        const dx = points[last * 3] - ax;
        const dy = points[last * 3 + 1] - ay;
        const dz = points[last * 3 + 2] - az;
        const length2 = dx * dx + dy * dy + dz * dz;
        let worst = -1;
        let worstD2 = tol2;
        for (let i = first + 1; i < last; i++) {
            const px = points[i * 3] - ax;
            const py = points[i * 3 + 1] - ay;
            const pz = points[i * 3 + 2] - az;
            let t = length2 > 0 ? (px * dx + py * dy + pz * dz) / length2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = px - t * dx;
            const ey = py - t * dy;
            const ez = pz - t * dz;
            const d2 = ex * ex + ey * ey + ez * ez;
            if (d2 > worstD2) {
                worstD2 = d2;
                worst = i;
            }
        }
        if (worst >= 0) {
            keep[worst] = 1;
            stack.push(first, worst, worst, last);
        }
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    return out;
}

/** 2D open polyline. */
export function simplify2(points: readonly Point2[], tolerance: number): Point2[] {
    const n = points.length;
    if (n <= 2) return points.slice();
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const tol2 = tolerance * tolerance;
    const stack: number[] = [0, n - 1];
    while (stack.length > 0) {
        const last = stack.pop() ?? 0;
        const first = stack.pop() ?? 0;
        const [ax, ay] = points[first];
        const dx = points[last][0] - ax;
        const dy = points[last][1] - ay;
        const length2 = dx * dx + dy * dy;
        let worst = -1;
        let worstD2 = tol2;
        for (let i = first + 1; i < last; i++) {
            const px = points[i][0] - ax;
            const py = points[i][1] - ay;
            let t = length2 > 0 ? (px * dx + py * dy) / length2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = px - t * dx;
            const ey = py - t * dy;
            const d2 = ex * ex + ey * ey;
            if (d2 > worstD2) {
                worstD2 = d2;
                worst = i;
            }
        }
        if (worst >= 0) {
            keep[worst] = 1;
            stack.push(first, worst, worst, last);
        }
    }
    return points.filter((_, i) => keep[i] === 1);
}

/** 2D closed ring: split at the point farthest from the first, simplify both halves. */
export function simplifyClosed(points: readonly Point2[], tolerance: number): Point2[] {
    const n = points.length;
    if (n <= 3) return points.slice();
    let far = 0;
    let farD = -1;
    for (let i = 1; i < n; i++) {
        const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
        if (d > farD) {
            farD = d;
            far = i;
        }
    }
    const first = simplify2(points.slice(0, far + 1), tolerance);
    const second = simplify2([...points.slice(far), points[0]], tolerance);
    return [...first, ...second.slice(1, -1)];
}
