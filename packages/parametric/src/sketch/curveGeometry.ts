// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane } from "@chili3d/core";
import type { SketchEntityData } from "./sketchModel";
import { sketchSpline } from "./sketchSpline";
export type UV = [number, number];
/** Control points for a Bezier, fit points for an interpolating spline. */
export function curvePoles(entity: SketchEntityData): UV[] {
    const points: UV[] = [];
    for (let i = 0; i < entity.params.length; i += 2) points.push([entity.params[i], entity.params[i + 1]]);
    return points;
}
export function evaluateBezier(poles: UV[], t: number): UV {
    const p = poles.map((v) => [...v] as UV);
    for (let n = p.length - 1; n > 0; n--)
        for (let i = 0; i < n; i++)
            p[i] = [p[i][0] * (1 - t) + p[i + 1][0] * t, p[i][1] * (1 - t) + p[i + 1][1] * t];
    return p[0];
}
const splineSamples = new Map<string, UV[]>();
export function sampleCurve(entity: SketchEntityData, pixel = 0.1): UV[] {
    const poles = curvePoles(entity);
    if (poles.length < 2) return poles;
    let length = 0;
    for (let i = 1; i < poles.length; i++)
        length += Math.hypot(poles[i][0] - poles[i - 1][0], poles[i][1] - poles[i - 1][1]);
    const count = Math.min(2048, Math.max(32, Math.ceil(Math.sqrt(length / Math.max(pixel, 1e-6)) * 8)));
    if (entity.type === "spline") {
        const key = `${entity.params.join(",")}:${count}`;
        const cached = splineSamples.get(key);
        if (cached) return cached;
        const curve = sketchSpline(Plane.XY, poles);
        if (!curve.isOk) return [];
        try {
            const start = curve.value.firstParameter(),
                span = curve.value.lastParameter() - start;
            const points: UV[] = Array.from({ length: count + 1 }, (_, i) => {
                const p = curve.value.pointAt(start + (span * i) / count);
                return [p.x, p.y];
            });
            if (splineSamples.size >= 32) splineSamples.delete(splineSamples.keys().next().value!);
            splineSamples.set(key, points);
            return points;
        } finally {
            curve.value.dispose();
        }
    }
    return Array.from({ length: count + 1 }, (_, i) => evaluateBezier(poles, i / count));
}
