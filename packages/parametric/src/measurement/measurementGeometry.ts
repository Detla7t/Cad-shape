// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BoundingBox,
    CurveUtils,
    type IEdge,
    type IElementarySurface,
    type IFace,
    type IPlaneSurface,
    type IShape,
    type IVertex,
    MEASUREMENT_LABELS,
    type MeasurementDetail,
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
        } else if (mode === "centerDistance") {
            if (shapes.length !== 2) return Result.err("Distance needs two entities.");
            const [a, b] = shapes.map(centerOf);
            if (a === undefined || b === undefined)
                return Result.err("Center distance needs points, circles, arcs or round faces.");
            value = a.distanceTo(b);
            segments.push([a, b]);
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

/** A point's position, or the center of a circle, arc or round face — what "Center" measures from. */
export function centerOf(shape: IShape): XYZ | undefined {
    if (shape.shapeType === ShapeTypes.vertex) return (shape as IVertex).point();
    return roundGeometry(shape)?.center;
}

/** A straight edge's direction, or a planar face's normal — what an angle is measured between. */
function directionOf(shape: IShape): { vector: XYZ; kind: "line" | "plane" } | undefined {
    if (shape.shapeType === ShapeTypes.edge) {
        const curve = (shape as IEdge).curve.basisCurve;
        return CurveUtils.isLine(curve) ? { vector: curve.direction.normalize()!, kind: "line" } : undefined;
    }
    if (shape.shapeType !== ShapeTypes.face) return undefined;
    const surface = (shape as IFace).surface();
    try {
        if (!surface.isPlanar() || !("plane" in surface)) return undefined;
        return { vector: (surface as IPlaneSurface).plane.normal, kind: "plane" };
    } finally {
        surface.dispose();
    }
}

const DEG = 180 / Math.PI;

/**
 * The values Onshape's measure panel shows beside the main measurement: the ΔX/ΔY/ΔZ of a
 * distance (a staircase from the first witness point to the second, one leg per axis), the angle
 * between two straight edges or planar faces, a face's area, a single point's coordinates.
 */
export function measurementDetails(
    shapes: readonly IShape[],
    distance?: MeasurementResult,
): MeasurementDetail[] {
    const details: MeasurementDetail[] = [];
    if (distance && distance.segments.length > 0) {
        const [from, to] = distance.segments[0].map((p) => new XYZ(p));
        const corner1 = new XYZ(to.x, from.y, from.z);
        const corner2 = new XYZ(to.x, to.y, from.z);
        const legs: [MeasurementDetail["axis"], number, XYZ, XYZ][] = [
            ["x", Math.abs(to.x - from.x), from, corner1],
            ["y", Math.abs(to.y - from.y), corner1, corner2],
            ["z", Math.abs(to.z - from.z), corner2, to],
        ];
        for (const [axis, value, a, b] of legs)
            details.push({
                label: `Δ${axis!.toUpperCase()}`,
                value,
                quantity: "length",
                axis,
                segments: [[a, b]],
            });
    }
    if (shapes.length === 2) {
        const [a, b] = shapes.map(directionOf);
        if (a && b) {
            const cos = Math.min(1, Math.abs(a.vector.dot(b.vector)));
            // lines have no orientation (0–90°); a line against a plane is measured against its surface
            const between = Math.acos(cos) * DEG;
            const angle = a.kind !== b.kind ? 90 - between : between;
            details.push({ label: "Angle", value: angle, quantity: "angle" });
        }
    }
    if (shapes.length === 1 && shapes[0].shapeType === ShapeTypes.face)
        details.push({ label: "Area", value: (shapes[0] as IFace).area(), quantity: "area" });
    if (shapes.length === 1 && shapes[0].shapeType === ShapeTypes.vertex) {
        const point = (shapes[0] as IVertex).point();
        for (const [axis, value] of [
            ["x", point.x],
            ["y", point.y],
            ["z", point.z],
        ] as const)
            details.push({ label: axis.toUpperCase(), value, quantity: "length", axis });
    }
    return details;
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
