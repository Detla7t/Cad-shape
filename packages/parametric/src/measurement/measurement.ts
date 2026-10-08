// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BoundingBox,
    CurveUtils,
    type IDocument,
    type IEdge,
    type IFace,
    type IShape,
    type IVertex,
    Result,
    ShapeNode,
    ShapeTypes,
    type VisualShapeData,
    type XYZLike,
} from "@chili3d/core";
import { isBodyTrackingNode } from "../features/bodyTracking";
import { matchEdgesAnchored } from "../features/edgeMatcher";
import { captureEdgeRef, type EdgeRef } from "../features/edgeRef";
import { shapeSourceOf } from "../sketch/shapeSource";
import { arcAngles, shapeEntityIds, toWorld } from "../sketch/sketchModel";
import { SketchNode } from "../sketch/sketchNode";

export type MeasurementMode = "length" | "distance" | "diameter";
export type MeasurementReference = { nodeId: string; label: string } & (
    | { kind: "entity"; entityId: number; pointIndex?: number }
    | { kind: "edge"; ref: EdgeRef }
    | { kind: "face"; faceId?: string; center: XYZLike; area: number }
    | { kind: "vertex"; point: XYZLike }
    | { kind: "node" }
);
export interface MeasuredVariableData {
    name: string;
    description?: string;
    source: "assigned" | "measured";
    expression?: string;
    mode: MeasurementMode;
    entities: MeasurementReference[];
    suppression?: boolean | string;
    comment?: string;
}

export function captureMeasurement(data: VisualShapeData): Result<MeasurementReference> {
    const node = data.owner.node;
    const base = { nodeId: node.id, label: node.name };
    const shape = data.shape;
    if (shape.shapeType === ShapeTypes.edge) {
        const edges =
            node instanceof ShapeNode && node.shape.isOk
                ? node.shape.value.findSubShapes(ShapeTypes.edge)
                : [];
        const index = edges.findIndex((edge) => edge.isSame(shape));
        try {
            if (node instanceof SketchNode) {
                const entityId = shapeEntityIds(node.data)[index >= 0 ? index : data.indexes[0]];
                if (entityId !== undefined)
                    return Result.ok({ ...base, label: `Edge of ${node.name}`, kind: "entity", entityId });
            }
            return Result.ok({
                ...base,
                label: `Edge of ${node.name}`,
                kind: "edge",
                ref: captureEdgeRef(
                    shape as IEdge,
                    isBodyTrackingNode(node) ? node.edgeIdAt(index) : undefined,
                ),
            });
        } finally {
            edges.forEach((edge) => edge.dispose());
        }
    }
    if (shape.shapeType === ShapeTypes.face) {
        const faces =
            node instanceof ShapeNode && node.shape.isOk
                ? node.shape.value.findSubShapes(ShapeTypes.face)
                : [];
        const index = faces.findIndex((face) => face.isSame(shape));
        try {
            return Result.ok({
                ...base,
                label: `Face of ${node.name}`,
                kind: "face",
                faceId: isBodyTrackingNode(node) ? node.faceIdAt(index) : undefined,
                center: BoundingBox.center(shape.boundingBox()),
                area: (shape as IFace).area(),
            });
        } finally {
            faces.forEach((face) => face.dispose());
        }
    }
    if (shape.shapeType === ShapeTypes.vertex)
        return Result.ok({ ...base, kind: "vertex", point: (shape as IVertex).point() });
    if (node instanceof ShapeNode) return Result.ok({ ...base, kind: "node" });
    return Result.err("Select a sketch entity, edge, face, vertex, or part.");
}

/** Resolves a fresh, owned shape. A missing or ambiguous target reports an error instead of changing identity. */
function resolveReference(document: IDocument, ref: MeasurementReference): Result<IShape> {
    const node = document.modelManager.findNode((node) => node.id === ref.nodeId);
    if (!(node instanceof ShapeNode)) return Result.err(`Missing source: ${ref.label}`);
    const factory = document.application.shapeProvider.factory;
    if (ref.kind === "entity") {
        if (!(node instanceof SketchNode) || node.suppressed)
            return Result.err(`Sketch unavailable: ${ref.label}`);
        const entity = node.data.entities.find((entity) => entity.id === ref.entityId);
        if (!entity) return Result.err(`Sketch entity was deleted: ${ref.label}`);
        const p = entity.params;
        if (ref.pointIndex !== undefined)
            return factory.point(toWorld(node.plane, p[ref.pointIndex * 2], p[ref.pointIndex * 2 + 1]));
        if (entity.type === "line")
            return factory.line(toWorld(node.plane, p[0], p[1]), toWorld(node.plane, p[2], p[3]));
        if (entity.type === "circle")
            return factory.circle(node.plane.normal, toWorld(node.plane, p[0], p[1]), p[2]);
        return factory.arc(
            node.plane.normal,
            toWorld(node.plane, p[0], p[1]),
            toWorld(node.plane, p[2], p[3]),
            (arcAngles(p)[1] * 180) / Math.PI,
        );
    }
    if (!node.shape.isOk) return Result.err(`Source shape unavailable: ${ref.label}`);
    const shape = node.shape.value;
    const transform = shapeSourceOf(document, node, shape).transform;
    if (ref.kind === "node") return Result.ok(shape.transformed(transform));
    const type =
        ref.kind === "edge" ? ShapeTypes.edge : ref.kind === "face" ? ShapeTypes.face : ShapeTypes.vertex;
    const shapes = shape.shapeType === type ? [shape.clone()] : shape.findSubShapes(type);
    try {
        let indexes: number[] = [];
        if (ref.kind === "edge") {
            const matched = matchEdgesAnchored(
                shape,
                [ref.ref],
                shapes.map((_, i) => (isBodyTrackingNode(node) ? (node.edgeIdAt(i) ?? "") : "")),
            );
            if (!matched.isOk) return Result.err(matched.error);
            indexes = matched.value.indexes;
            if (shape.shapeType === ShapeTypes.edge && shapes.length === 1) indexes = [0];
        } else if (ref.kind === "face") {
            indexes = ref.faceId && isBodyTrackingNode(node) ? node.faceIndexesOfId(ref.faceId) : [];
            if (!indexes.length)
                indexes = shapes.flatMap((face, i) => {
                    const center = BoundingBox.center(face.boundingBox());
                    return center.distanceTo(ref.center) < 1e-5 &&
                        Math.abs((face as IFace).area() - ref.area) < 1e-5
                        ? [i]
                        : [];
                });
        } else
            indexes = shapes.flatMap((vertex, i) =>
                (vertex as IVertex).point().distanceTo(ref.point) < 1e-5 ? [i] : [],
            );
        if (indexes.length !== 1 || !shapes[indexes[0]])
            return Result.err(`Reference is missing or ambiguous: ${ref.label}. Reselect it.`);
        return Result.ok(shapes[indexes[0]].transformed(transform));
    } finally {
        shapes.forEach((shape) => shape.dispose());
    }
}

export function measureReferences(
    document: IDocument,
    mode: MeasurementMode,
    refs: readonly MeasurementReference[],
): Result<number> {
    if (!refs.length) return Result.err("Select entities to measure.");
    if (mode === "distance" && refs.length !== 2) return Result.err("Distance needs two entities.");
    if (mode === "diameter" && refs.length !== 1)
        return Result.err("Diameter needs one circular edge, arc, or cylindrical face.");
    const owned: IShape[] = [];
    try {
        // Analytic sketch lengths do not require a kernel rebuild or tessellation.
        if (
            mode !== "distance" &&
            refs.every((ref) => ref.kind === "entity" && ref.pointIndex === undefined)
        ) {
            const values = refs.map((ref) => {
                const node = document.modelManager.findNode((node) => node.id === ref.nodeId);
                if (!(node instanceof SketchNode) || node.suppressed || ref.kind !== "entity")
                    return undefined;
                const entity = node.data.entities.find((entity) => entity.id === ref.entityId);
                if (!entity) return undefined;
                const p = entity.params;
                if (entity.type === "line")
                    return mode === "length" ? Math.hypot(p[2] - p[0], p[3] - p[1]) : undefined;
                const radius = entity.type === "circle" ? p[2] : Math.hypot(p[2] - p[0], p[3] - p[1]);
                return mode === "diameter"
                    ? 2 * radius
                    : radius * (entity.type === "circle" ? 2 * Math.PI : arcAngles(p)[1]);
            });
            return values.every((value) => value !== undefined && Number.isFinite(value))
                ? Result.ok((values as number[]).reduce((sum, value) => sum + value, 0))
                : Result.err(
                      "A selected sketch entity is missing, suppressed, or incompatible with this measurement.",
                  );
        }
        for (const ref of refs) {
            const result = resolveReference(document, ref);
            if (!result.isOk) return Result.err(result.error);
            owned.push(result.value);
        }
        let value: number;
        if (mode === "distance") value = owned[0].extremaDistance(owned[1]);
        else if (mode === "diameter") {
            const shape = owned[0];
            if (shape.shapeType === ShapeTypes.edge) {
                const curve = (shape as IEdge).curve;
                try {
                    if (!CurveUtils.isCircle(curve.basisCurve))
                        return Result.err("Diameter requires a circle or circular arc.");
                    value = curve.basisCurve.radius * 2;
                } finally {
                    curve.dispose();
                }
            } else if (shape.shapeType === ShapeTypes.face) {
                const surface = (shape as IFace).surface();
                try {
                    if (!("radius" in surface) || typeof surface.radius !== "number")
                        return Result.err("This face has no single diameter.");
                    value = surface.radius * 2;
                } finally {
                    surface.dispose();
                }
            } else return Result.err("Diameter requires a circular edge or cylindrical face.");
        } else {
            value = 0;
            for (const shape of owned) {
                const edges =
                    shape.shapeType === ShapeTypes.edge
                        ? [shape as IEdge]
                        : (shape.findSubShapes(ShapeTypes.edge) as IEdge[]);
                try {
                    if (!edges.length)
                        return Result.err(
                            "Length requires edges, curves, or a face/part with boundary edges.",
                        );
                    value += edges.reduce((sum, edge) => sum + edge.length(), 0);
                } finally {
                    if (shape.shapeType !== ShapeTypes.edge) edges.forEach((edge) => edge.dispose());
                }
            }
        }
        return Number.isFinite(value) && value >= 0
            ? Result.ok(value)
            : Result.err("The measurement is not finite.");
    } catch (error) {
        return Result.err(`Measurement failed: ${String(error)}`);
    } finally {
        owned.forEach((shape) => shape.dispose());
    }
}
