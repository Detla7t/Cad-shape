// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BoundingBox,
    type IDocument,
    type IEdge,
    type IFace,
    type IShape,
    type IVertex,
    MEASUREMENT_LABELS,
    type MeasurementFrame,
    type MeasurementMode,
    type MeasurementResult,
    measurementQuantity,
    Result,
    ShapeNode,
    ShapeTypes,
    type VariableType,
    type VisualShapeData,
    type XYZLike,
} from "@chili3d/core";
import { isBodyTrackingNode } from "../features/bodyTracking";
import { matchEdgesAnchored } from "../features/edgeMatcher";
import { captureEdgeRef, type EdgeRef } from "../features/edgeRef";
import { entityPointCount, shapeEntityIds, toWorld } from "../sketch/sketchModel";
import { SketchNode } from "../sketch/sketchNode";

export type { MeasurementMode } from "@chili3d/core";

import { sketchEntityEdge } from "../sketch/sketchEntityEdge";
import { measureShapes } from "./measurementGeometry";
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
    /** The coordinate system a component or position is measured in; the world when absent. */
    frame?: MeasurementFrame;
    suppression?: boolean | string;
    comment?: string;
}

/** The variable editor's tabs: each family is one way of measuring, refined by its method list. */
export type MeasurementFamily = "distance" | "length" | "diameter" | "angle" | "area" | "position";
export const MEASUREMENT_FAMILIES: Record<MeasurementFamily, readonly MeasurementMode[]> = {
    distance: ["distance", "maxDistance", "centerDistance", "deltaX", "deltaY", "deltaZ"],
    length: ["length"],
    diameter: ["diameter", "radius"],
    angle: ["angle", "tangentAngle"],
    area: ["area"],
    position: ["positionX", "positionY", "positionZ"],
};
export function measurementFamily(mode: MeasurementMode): MeasurementFamily {
    return (
        (Object.keys(MEASUREMENT_FAMILIES) as MeasurementFamily[]).find((family) =>
            MEASUREMENT_FAMILIES[family].includes(mode),
        ) ?? "length"
    );
}
/** The variable type a measurement's row declares: an area has no declarable unit, so it is a plain number of mm². */
export function measuredVariableType(mode: MeasurementMode): VariableType {
    const quantity = measurementQuantity(mode);
    return quantity === "angle" ? "angle" : quantity === "area" ? "unitless" : "length";
}
/** A measured value as the expression its row stores: millimetres, degrees, or a plain number. */
export function measuredExpression(mode: MeasurementMode, value: number): string {
    const quantity = measurementQuantity(mode);
    return quantity === "length" ? `${value} mm` : quantity === "angle" ? `${value} deg` : `${value}`;
}
/** A default name for a variable of the mode, as an identifier ("Delta_X", "Minimum_distance"). */
export function measuredVariableName(mode: MeasurementMode): string {
    return MEASUREMENT_LABELS[mode].replace(/Δ/g, "Delta_").replace(/ /g, "_");
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
            for (const edge of edges) edge.dispose();
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
            for (const face of faces) face.dispose();
        }
    }
    if (shape.shapeType === ShapeTypes.vertex) {
        const point = (shape as IVertex).point();
        const label = `Vertex of ${node.name}`;
        // A sketch's point is referenced through its entity, which survives the sketch's edits.
        if (node instanceof SketchNode)
            for (const entity of node.data.entities)
                for (let index = 0; index < entityPointCount(entity.type, entity.params); index++)
                    if (
                        toWorld(
                            node.plane,
                            entity.params[index * 2],
                            entity.params[index * 2 + 1],
                        ).distanceTo(point) < 1e-5
                    )
                        return Result.ok({
                            ...base,
                            label,
                            kind: "entity",
                            entityId: entity.id,
                            pointIndex: index,
                        });
        return Result.ok({ ...base, label, kind: "vertex", point });
    }
    if (node instanceof ShapeNode) return Result.ok({ ...base, kind: "node" });
    return Result.err("Select a sketch entity, edge, face, vertex, or part.");
}

/** Resolves a fresh, owned shape. A missing or ambiguous target reports an error instead of changing identity. */
export function resolveMeasurementReference(document: IDocument, ref: MeasurementReference): Result<IShape> {
    const node = document.modelManager.findNode((node) => node.id === ref.nodeId);
    if (!(node instanceof ShapeNode)) return Result.err(`Missing source: ${ref.label}`);
    if (node.evaluationError) return Result.err(`Source feature has an error: ${ref.label}`);
    const factory = document.application.shapeProvider.factory;
    if (ref.kind === "entity") {
        if (!(node instanceof SketchNode) || node.suppressed)
            return Result.err(`Sketch unavailable: ${ref.label}`);
        const entity = node.data.entities.find((entity) => entity.id === ref.entityId);
        if (!entity) return Result.err(`Sketch entity is missing or deleted: ${ref.label}`);
        const p = entity.params;
        const built =
            ref.pointIndex !== undefined || entity.type === "point"
                ? factory.point(
                      toWorld(node.plane, p[(ref.pointIndex ?? 0) * 2], p[(ref.pointIndex ?? 0) * 2 + 1]),
                  )
                : sketchEntityEdge(node.plane, entity);
        if (!built.isOk) return Result.err(built.error);
        try {
            return Result.ok(built.value.transformedMul(node.worldTransform()));
        } finally {
            built.value.dispose();
        }
    }
    if (!node.shape.isOk) return Result.err(`Source shape unavailable: ${ref.label}`);
    const shape = node.shape.value;
    const transform = node.worldTransform();
    if (ref.kind === "node") return Result.ok(shape.transformedMul(transform));
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
        return Result.ok(shapes[indexes[0]].transformedMul(transform));
    } finally {
        for (const shape of shapes) shape.dispose();
    }
}

export function measureReferences(
    document: IDocument,
    mode: MeasurementMode,
    refs: readonly MeasurementReference[],
    frame?: MeasurementFrame,
): Result<number> {
    const measured = measureReferenceDetails(document, mode, refs, frame);
    return measured.isOk ? Result.ok(measured.value.value) : Result.err(measured.error);
}

export function measureReferenceDetails(
    document: IDocument,
    mode: MeasurementMode,
    refs: readonly MeasurementReference[],
    frame?: MeasurementFrame,
): Result<MeasurementResult> {
    const owned: IShape[] = [];
    try {
        for (const ref of refs) {
            const result = resolveMeasurementReference(document, ref);
            if (!result.isOk) return Result.err(result.error);
            owned.push(result.value);
        }
        return measureShapes(mode, owned, frame);
    } catch (error) {
        return Result.err(`Measurement failed: ${String(error)}`);
    } finally {
        for (const shape of owned) shape.dispose();
    }
}
