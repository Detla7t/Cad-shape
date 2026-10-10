// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type Plane, Result, type XYZ } from "@chili3d/core";
import { interpolationDerivatives } from "./splineInterpolation";

/** A sketch-plane point (u, v), in mm. */
type UV = [number, number];

/** The kernel interpolation used by the sketch tool and FeatureScript's skFitSpline. */
export function sketchSpline(
    plane: Plane,
    points: UV[],
    parameters?: number[],
    startDerivative?: UV,
    endDerivative?: UV,
): Result<IEdge> {
    if (!shapeFactory.fitSpline)
        return Result.err("Spline interpolation requires the updated geometry kernel.");
    if (points.length < 2 || points.some((p) => p.some((v) => !Number.isFinite(v))))
        return Result.err("A spline needs at least two finite points.");
    const world = points.map((p) =>
            plane.origin.add(plane.xvec.multiply(p[0])).add(plane.yvec.multiply(p[1])),
        ),
        closed = world.length > 2 && world[0].distanceTo(world[world.length - 1]) < 1e-7,
        count = world.length - Number(closed),
        cumulative = [0];
    for (let i = 1; i < world.length; i++) {
        const length = world[i].distanceTo(world[i - 1]);
        if (length < 1e-7) return Result.err("Spline fit points must be distinct.");
        cumulative.push(cumulative[i - 1] + Math.sqrt(length));
    }
    const t = parameters ?? cumulative.map((v) => v / cumulative[cumulative.length - 1]);
    if (t.length !== world.length || t.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= t[i - 1])))
        return Result.err("Spline parameters must strictly increase and match the fit points.");
    const derivatives = new Array<XYZ | undefined>(count).fill(undefined),
        vector = (p: UV) => plane.xvec.multiply(p[0]).add(plane.yvec.multiply(p[1]));
    if (!closed && startDerivative) derivatives[0] = vector(startDerivative);
    if (!closed && endDerivative) derivatives[count - 1] = vector(endDerivative);
    if (derivatives.some((v) => v && (!Number.isFinite(v.length()) || v.length() < 1e-7)))
        return Result.err("Spline derivatives must be finite and nonzero.");
    try {
        const fitPoints = world.slice(0, count);
        return shapeFactory.fitSpline(
            fitPoints,
            t,
            interpolationDerivatives(fitPoints, t, derivatives, closed),
            closed,
        );
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}
