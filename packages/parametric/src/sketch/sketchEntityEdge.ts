// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type Plane, Precision, Result } from "@chili3d/core";
import { curvePoles } from "./curveGeometry";
import { arcAngles, rawArcSweep, type SketchEntityData, toWorld } from "./sketchModel";
import { sketchSpline } from "./sketchSpline";

export function sketchEntityEdge(plane: Plane, entity: SketchEntityData): Result<IEdge> {
    const p = entity.params;
    switch (entity.type) {
        case "point":
            return Result.err("Points do not define a profile edge");
        case "spline":
            return sketchSpline(plane, curvePoles(entity));
        case "bezier":
            return shapeFactory.bezier(curvePoles(entity).map(([u, v]) => toWorld(plane, u, v)));
        case "line":
            return shapeFactory.line(toWorld(plane, p[0], p[1]), toWorld(plane, p[2], p[3]));
        case "circle":
            return shapeFactory.circle(plane.normal, toWorld(plane, p[0], p[1]), p[2]);
        case "arc":
            return arcEdge(plane, p as [number, number, number, number, number, number]);
    }
}

/** arc params = [cx, cy, sx, sy, ex, ey]; the end point only fixes the sweep angle. */
function arcEdge(plane: Plane, params: [number, number, number, number, number, number]): Result<IEdge> {
    const [cx, cy, sx, sy] = params;
    if (Math.hypot(sx - cx, sy - cy) < Precision.Distance) {
        return Result.err("Arc radius is too small");
    }
    // Only a raw sweep of [0, Precision.Angle] is degenerate (start and end on
    // the same ray, within angular tolerance). A small NEGATIVE raw sweep is a
    // legitimate near-full-circle arc — arcAngles normalizes it to just under
    // 2π — and must build.
    const rawSweep = rawArcSweep(params);
    if (rawSweep >= 0 && rawSweep <= Precision.Angle) {
        return Result.err("Arc is degenerate (zero sweep)");
    }
    const [, sweep] = arcAngles(params);
    return shapeFactory.arc(
        plane.normal,
        toWorld(plane, cx, cy),
        toWorld(plane, sx, sy),
        (sweep * 180) / Math.PI,
    );
}
