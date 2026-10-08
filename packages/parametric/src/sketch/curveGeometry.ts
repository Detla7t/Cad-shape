// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { SketchEntityData } from "./sketchModel";
export type UV = [number, number];
const binomial = (n: number, k: number) => {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - i + 1)) / i;
    return r;
};
/** A single-span interpolating B-spline, represented exactly by its Bernstein control polygon. */
export function curvePoles(entity: SketchEntityData): UV[] {
    const points: UV[] = [];
    for (let i = 0; i < entity.params.length; i += 2) points.push([entity.params[i], entity.params[i + 1]]);
    if (entity.type !== "spline" || points.length < 3) return points;
    const n = points.length - 1;
    const rows = points.map((p, i) => {
        const t = i / n;
        return [...points.map((_, j) => binomial(n, j) * t ** j * (1 - t) ** (n - j)), ...p];
    });
    for (let k = 0; k <= n; k++) {
        let pivot = k;
        for (let i = k + 1; i <= n; i++) if (Math.abs(rows[i][k]) > Math.abs(rows[pivot][k])) pivot = i;
        [rows[k], rows[pivot]] = [rows[pivot], rows[k]];
        const d = rows[k][k];
        for (let j = k; j < n + 3; j++) rows[k][j] /= d;
        for (let i = 0; i <= n; i++)
            if (i !== k) {
                const f = rows[i][k];
                for (let j = k; j < n + 3; j++) rows[i][j] -= f * rows[k][j];
            }
    }
    return rows.map((row) => [row[n + 1], row[n + 2]]);
}
export function evaluateBezier(poles: UV[], t: number): UV {
    const p = poles.map((v) => [...v] as UV);
    for (let n = p.length - 1; n > 0; n--)
        for (let i = 0; i < n; i++)
            p[i] = [p[i][0] * (1 - t) + p[i + 1][0] * t, p[i][1] * (1 - t) + p[i + 1][1] * t];
    return p[0];
}
export function sampleCurve(entity: SketchEntityData, pixel = 0.1): UV[] {
    const poles = curvePoles(entity);
    if (poles.length < 2) return poles;
    let length = 0;
    for (let i = 1; i < poles.length; i++)
        length += Math.hypot(poles[i][0] - poles[i - 1][0], poles[i][1] - poles[i - 1][1]);
    const count = Math.min(2048, Math.max(32, Math.ceil(Math.sqrt(length / Math.max(pixel, 1e-6)) * 8)));
    return Array.from({ length: count + 1 }, (_, i) => evaluateBezier(poles, i / count));
}
