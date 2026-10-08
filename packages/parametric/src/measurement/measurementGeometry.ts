// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BoundingBox,
    CurveUtils,
    type IEdge,
    type IElementarySurface,
    type IFace,
    type IShape,
    MEASUREMENT_LABELS,
    type MeasurementMode,
    type MeasurementResult,
    Result,
    ShapeTypes,
    XYZ,
} from "@chili3d/core";

/** Values come from kernel geometry; display segments never determine the measured value. */
export function measureShapes(mode: MeasurementMode, shapes: readonly IShape[]): Result<MeasurementResult> {
    if (!shapes.length) return Result.err("Select entities to measure.");
    try {
        const segments: [XYZ, XYZ][] = [];
        let value = 0;
        let label = MEASUREMENT_LABELS[mode];
        if (mode === "distance" || mode === "maxDistance") {
            if (shapes.length !== 2) return Result.err("Distance needs two entities.");
            const measured = shapes[0].distanceMeasure?.(shapes[1], mode === "maxDistance");
            if (!measured) return Result.err("This geometry provider cannot return distance witnesses.");
            if (!measured.isOk) return Result.err(measured.error);
            value = measured.value.value;
            segments.push([new XYZ(measured.value.first), new XYZ(measured.value.second)]);
        } else if (mode === "diameter" || mode === "radius") {
            if (shapes.length !== 1) return Result.err("Select one circular edge or round face.");
            const radial = roundGeometry(shapes[0]);
            if (!radial)
                return Result.err(
                    "Select a circle, arc, cylindrical face, spherical face, or circular planar face.",
                );
            const { center, offset, radius } = radial;
            value = radius * (mode === "diameter" ? 2 : 1);
            segments.push([mode === "diameter" ? center.sub(offset) : center, center.add(offset)]);
        } else {
            if (shapes.every((shape) => shape.shapeType === ShapeTypes.face)) label = "Perimeter";
            for (const shape of shapes) {
                const edges =
                    shape.shapeType === ShapeTypes.edge
                        ? [shape as IEdge]
                        : (shape.findSubShapes(ShapeTypes.edge) as IEdge[]);
                try {
                    if (!edges.length) return Result.err("Length needs curves or boundary edges.");
                    const seams = new Set(shape.seamEdges?.() ?? []);
                    for (const [index, edge] of edges.entries()) {
                        if (seams.has(index)) continue;
                        value += edge.length();
                        const u1 = edge.firstParameter(),
                            u2 = edge.lastParameter();
                        const curve = edge.curve;
                        let count = 48;
                        if (CurveUtils.isLine(curve.basisCurve)) count = 1;
                        for (let i = 0; i < count; i++)
                            segments.push([
                                edge.pointAt(u1 + ((u2 - u1) * i) / count),
                                edge.pointAt(u1 + ((u2 - u1) * (i + 1)) / count),
                            ]);
                    }
                } finally {
                    if (shape.shapeType !== ShapeTypes.edge) edges.forEach((edge) => edge.dispose());
                }
            }
        }
        return Number.isFinite(value) && value >= 0
            ? Result.ok({ mode, value, label, segments })
            : Result.err("The measurement is not finite.");
    } catch (error) {
        return Result.err(`Measurement failed: ${String(error)}`);
    }
}

function roundGeometry(shape: IShape): { center: XYZ; offset: XYZ; radius: number } | undefined {
    if (shape.shapeType === ShapeTypes.edge) {
        const edge = shape as IEdge,
            curve = edge.curve;
        {
            const circle = curve.basisCurve;
            if (!CurveUtils.isCircle(circle)) return undefined;
            const offset = edge
                .pointAt((edge.firstParameter() + edge.lastParameter()) / 2)
                .sub(circle.center);
            return { center: circle.center, offset, radius: circle.radius };
        }
    }
    if (shape.shapeType !== ShapeTypes.face) return undefined;
    const surface = (shape as IFace).surface();
    try {
        if ("radius" in surface && typeof surface.radius === "number") {
            const round = surface as IElementarySurface & { radius: number; volume?: () => number };
            const origin = round.location,
                axis = round.axis;
            const center = round.volume
                ? origin
                : origin.add(axis.multiply(BoundingBox.center(shape.boundingBox()).sub(origin).dot(axis)));
            return { center, offset: round.coordinates.xvec.multiply(round.radius), radius: round.radius };
        }
        if (!surface.isPlanar()) return undefined;
    } finally {
        surface.dispose();
    }
    const edges = shape.findSubShapes(ShapeTypes.edge);
    try {
        // A disk's single circular boundary is also a useful diameter selection.
        return edges.length === 1 ? roundGeometry(edges[0]) : undefined;
    } finally {
        edges.forEach((edge) => edge.dispose());
    }
}
