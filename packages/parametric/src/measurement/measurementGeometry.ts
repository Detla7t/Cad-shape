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
    type MeasurementFrame,
    type MeasurementMode,
    type MeasurementResult,
    measurementAxis,
    Result,
    ShapeTypes,
    XYZ,
    type XYZLike,
} from "@chili3d/core";

const WORLD_FRAME: MeasurementFrame = {
    origin: XYZ.zero,
    xvec: XYZ.unitX,
    yvec: XYZ.unitY,
    zvec: XYZ.unitZ,
};

/** The frame's origin and unit axes. */
function frameAxes(frame: MeasurementFrame = WORLD_FRAME): { origin: XYZ; axes: readonly [XYZ, XYZ, XYZ] } {
    const unit = (v: XYZLike, fallback: XYZ) => new XYZ(v).normalize() ?? fallback;
    return {
        origin: new XYZ(frame.origin),
        axes: [unit(frame.xvec, XYZ.unitX), unit(frame.yvec, XYZ.unitY), unit(frame.zvec, XYZ.unitZ)],
    };
}

/** A world point's coordinates in the frame (the world's when none is given). */
export function frameCoordinates(point: XYZLike, frame?: MeasurementFrame): [number, number, number] {
    const { origin, axes } = frameAxes(frame);
    const d = new XYZ(point).sub(origin);
    return [d.dot(axes[0]), d.dot(axes[1]), d.dot(axes[2])];
}

/** The staircase from one witness point to the other: one leg per frame axis, in world space. */
function staircase(
    from: XYZ,
    to: XYZ,
    frame?: MeasurementFrame,
): { axis: "x" | "y" | "z"; value: number; segment: [XYZ, XYZ] }[] {
    const { axes } = frameAxes(frame);
    const d = to.sub(from);
    let cursor = from;
    return (["x", "y", "z"] as const).map((axis, i) => {
        const step = d.dot(axes[i]);
        const next = cursor.add(axes[i].multiply(step));
        const leg = { axis, value: Math.abs(step), segment: [cursor, next] as [XYZ, XYZ] };
        cursor = next;
        return leg;
    });
}

/** The closest (or farthest) points of two shapes and their distance. */
function distanceWitnesses(
    a: IShape,
    b: IShape,
    maximum: boolean,
): Result<{ value: number; points: [XYZ, XYZ] }> {
    const measured = a.distanceMeasure?.(b, maximum);
    if (!measured) return Result.err("This geometry provider cannot return distance witnesses.");
    if (!measured.isOk) return Result.err(measured.error);
    return Result.ok({
        value: measured.value.value,
        points: [new XYZ(measured.value.first), new XYZ(measured.value.second)],
    });
}

/** Values come from kernel geometry; display segments never determine the measured value. */
export function measureShapes(
    mode: MeasurementMode,
    shapes: readonly IShape[],
    frame?: MeasurementFrame,
): Result<MeasurementResult> {
    if (!shapes.length) return Result.err("Select entities to measure.");
    try {
        const segments: [XYZ, XYZ][] = [];
        let value = 0;
        let label = MEASUREMENT_LABELS[mode];
        const axis = measurementAxis(mode);
        const axisIndex = axis === undefined ? -1 : "xyz".indexOf(axis);
        if (mode === "distance" || mode === "maxDistance") {
            if (shapes.length !== 2) return Result.err("Distance needs two entities.");
            const measured = distanceWitnesses(shapes[0], shapes[1], mode === "maxDistance");
            if (!measured.isOk) return Result.err(measured.error);
            value = measured.value.value;
            segments.push(measured.value.points);
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
        } else if (mode === "angle" || mode === "tangentAngle") {
            if (shapes.length !== 2) return Result.err("An angle needs two entities.");
            const angle =
                mode === "angle" ? angleBetween(shapes[0], shapes[1]) : tangentAngle(shapes[0], shapes[1]);
            if (angle === undefined)
                return Result.err(
                    mode === "angle"
                        ? "Angle needs two straight edges or planar faces."
                        : "Face tangent angle needs two faces.",
                );
            value = angle;
        } else if (mode === "area") {
            for (const shape of shapes) {
                const faces =
                    shape.shapeType === ShapeTypes.face
                        ? [shape as IFace]
                        : (shape.findSubShapes(ShapeTypes.face) as IFace[]);
                try {
                    if (!faces.length) return Result.err("Area needs faces.");
                    for (const face of faces) value += face.area();
                } finally {
                    if (shape.shapeType !== ShapeTypes.face) for (const face of faces) face.dispose();
                }
            }
        } else if (axisIndex >= 0 && mode.startsWith("delta")) {
            if (shapes.length !== 2) return Result.err("Distance needs two entities.");
            const measured = distanceWitnesses(shapes[0], shapes[1], false);
            if (!measured.isOk) return Result.err(measured.error);
            const leg = staircase(measured.value.points[0], measured.value.points[1], frame)[axisIndex];
            value = leg.value;
            segments.push(leg.segment);
        } else if (axisIndex >= 0) {
            if (shapes.length !== 1) return Result.err("A position needs one entity.");
            const point = centerOf(shapes[0]);
            if (point === undefined) return Result.err("Position needs a point, circle, arc or round face.");
            value = frameCoordinates(point, frame)[axisIndex];
            segments.push([point, point]);
            if (shapes[0].shapeType !== ShapeTypes.vertex) label = `Center ${label}`;
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
                    if (shape.shapeType !== ShapeTypes.edge) for (const edge of edges) edge.dispose();
                }
            }
        }
        // A coordinate is signed; every other measurement is a size.
        const signed = axisIndex >= 0 && mode.startsWith("position");
        return Number.isFinite(value) && (signed || value >= 0)
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

/** The angle between two straight edges or planar faces, degrees 0–90; undefined when neither has a direction. */
function angleBetween(a: IShape, b: IShape): number | undefined {
    const [da, db] = [directionOf(a), directionOf(b)];
    if (!da || !db) return undefined;
    const cos = Math.min(1, Math.abs(da.vector.dot(db.vector)));
    // lines have no orientation (0–90°); a line against a plane is measured against its surface
    const between = Math.acos(cos) * DEG;
    return da.kind !== db.kind ? 90 - between : between;
}

/**
 * Onshape's face tangent angle: the angle between the tangent planes of two faces where they
 * come closest, degrees 0–90 (0 for faces that meet tangentially, 90 for a box's neighbours).
 */
function tangentAngle(a: IShape, b: IShape): number | undefined {
    if (a.shapeType !== ShapeTypes.face || b.shapeType !== ShapeTypes.face) return undefined;
    const witnesses = distanceWitnesses(a, b, false);
    if (!witnesses.isOk) return undefined;
    const normals = [a, b].map((shape, index) => {
        const face = shape as IFace;
        const surface = face.surface();
        try {
            const uv = surface.parameter(witnesses.value.points[index], 1e-2);
            return uv ? face.normal(uv.u, uv.v)[1].normalize() : undefined;
        } finally {
            surface.dispose();
        }
    });
    if (!normals[0] || !normals[1]) return undefined;
    return Math.acos(Math.min(1, Math.abs(normals[0].dot(normals[1])))) * DEG;
}

function isPlanarFace(shape: IShape): boolean {
    return directionOf(shape)?.kind === "plane";
}

/**
 * The values Onshape's measure panel shows beside the main measurement: the ΔX/ΔY/ΔZ of a
 * distance (a staircase from the first witness point to the second, one leg per axis of the
 * frame), the angle between two straight edges or planar faces, the tangent angle between two
 * faces, a face's area, a point's coordinates or a round entity's center. Each detail names the
 * mode that measures it alone, so a variable can be made of it.
 */
export function measurementDetails(
    shapes: readonly IShape[],
    distance?: MeasurementResult,
    frame?: MeasurementFrame,
): MeasurementDetail[] {
    const details: MeasurementDetail[] = [];
    if (distance && distance.segments.length > 0) {
        const [from, to] = distance.segments[0].map((p) => new XYZ(p));
        for (const leg of staircase(from, to, frame)) {
            const axis = leg.axis.toUpperCase() as "X" | "Y" | "Z";
            details.push({
                label: `Δ${axis}`,
                value: leg.value,
                quantity: "length",
                axis: leg.axis,
                segments: [leg.segment],
                mode: `delta${axis}`,
            });
        }
    }
    if (shapes.length === 2) {
        const angle = angleBetween(shapes[0], shapes[1]);
        if (angle !== undefined)
            details.push({ label: "Angle", value: angle, quantity: "angle", mode: "angle" });
        // two planar faces already have their angle; the tangent angle is for curved faces
        if (!shapes.every(isPlanarFace)) {
            const tangent = tangentAngle(shapes[0], shapes[1]);
            if (tangent !== undefined)
                details.push({
                    label: "Face tangent angle",
                    value: tangent,
                    quantity: "angle",
                    mode: "tangentAngle",
                });
        }
    }
    if (shapes.length === 1 && shapes[0].shapeType === ShapeTypes.face)
        details.push({ label: "Area", value: (shapes[0] as IFace).area(), quantity: "area", mode: "area" });
    if (shapes.length === 1) {
        const center = centerOf(shapes[0]);
        if (center !== undefined) {
            const prefix = shapes[0].shapeType === ShapeTypes.vertex ? "" : "Center ";
            const coordinates = frameCoordinates(center, frame);
            for (const [index, axis] of (["x", "y", "z"] as const).entries()) {
                const upper = axis.toUpperCase() as "X" | "Y" | "Z";
                details.push({
                    label: `${prefix}${upper}`,
                    value: coordinates[index],
                    quantity: "length",
                    axis,
                    mode: `position${upper}`,
                });
            }
        }
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
        for (const edge of edges) edge.dispose();
    }
}
