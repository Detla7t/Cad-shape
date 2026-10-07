// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type I18nKeys,
    type IDocument,
    type IShape,
    type IShapeFactory,
    Matrix4,
    Result,
    ShapeNode,
    ShapeTypes,
    type TrackedShape,
} from "@chili3d/core";
import {
    type BooleanFeatureData,
    type BooleanOperation,
    completeTrackedHistory,
    type FeatureContext,
    type FeatureHandler,
    type IShapeHost,
    registerFeature,
} from "./feature";
import { mapBooleanIds } from "./operationIds";

const DISPLAYS: Record<BooleanOperation, I18nKeys> = {
    fuse: "command.feature.fuse",
    cut: "command.feature.cut",
    common: "command.feature.common",
};

const ICONS: Record<BooleanOperation, string> = {
    fuse: "icon-booleanFuse",
    cut: "icon-booleanCut",
    common: "icon-booleanCommon",
};

const booleanHandler: FeatureHandler<BooleanFeatureData> = {
    display: (feature) => DISPLAYS[feature.operation],
    icon: (feature) => ICONS[feature.operation],

    nodeIds: (feature) => feature.toolIds,

    parameters: (feature) => [
        { key: "consumeTools", display: "features.consumeTools", value: feature.consumeTools ?? true },
    ],

    setParameter: (feature, key, value) =>
        key === "consumeTools" ? { ...feature, consumeTools: value === true || value === "true" } : feature,

    evaluate(feature, context): Result<IShape> {
        if (context.input === undefined) {
            return Result.err("boolean requires a preceding feature");
        }
        const tools = collectTools(feature, context.document);
        if (!tools.isOk) return Result.err(tools.error);
        const tracked = TRACKED[feature.operation](shapeFactory);
        const toolShapes = toolShapesInHostSpace(tools.value, context.host);
        // `transformedMul` copies are intermediate inputs — the kernel reads them
        // eagerly, so dispose them once the operation returns.
        const owned = toolShapes.filter((x, i) => x !== tools.value[i].shape.unchecked());
        try {
            if (context.tracking !== undefined && tracked !== undefined) {
                return evaluateTracked(feature, context, tools.value, toolShapes, tracked);
            }
            switch (feature.operation) {
                case "common":
                    return commonOfAll(context.input, toolShapes);
                case "cut":
                    return shapeFactory.booleanCut([context.input], toolShapes);
                default:
                    return shapeFactory.booleanFuse([context.input], toolShapes, true);
            }
        } finally {
            owned.forEach((x) => x.dispose());
        }
    },
};

/**
 * Tools live anywhere in the scene, but the boolean runs in the host body's local
 * space (the result renders under the host's own transform), so map each tool
 * shape by hostWorld⁻¹ · toolWorld — a moved copy cuts where it is displayed, not
 * where its shape was generated. Identity mappings reuse the raw shape.
 */
function toolShapesInHostSpace(tools: ShapeNode[], host: IShapeHost): IShape[] {
    const hostInvert = host.worldTransform().invert();
    if (hostInvert === undefined) return tools.map((x) => x.shape.unchecked()!);
    const identity = Matrix4.identity();
    return tools.map((node) => {
        const shape = node.shape.unchecked()!;
        const matrix = hostInvert.multiply(node.worldTransform());
        return matrix.equals(identity) ? shape : shape.transformedMul(matrix);
    });
}

function collectTools(feature: BooleanFeatureData, document: IDocument): Result<ShapeNode[]> {
    const tools: ShapeNode[] = [];
    for (const id of feature.toolIds) {
        const node = document.modelManager.findNode((n) => n.id === id);
        if (!(node instanceof ShapeNode)) return Result.err("Boolean tool not found");
        if (!node.shape.isOk) return Result.err("Boolean tool has no shape");
        tools.push(node);
    }
    return Result.ok(tools);
}

const TRACKED: Record<BooleanOperation, (factory: IShapeFactory) => TrackedMethod | undefined> = {
    common: (factory) => factory.booleanCommonTracked?.bind(factory),
    cut: (factory) => factory.booleanCutTracked?.bind(factory),
    fuse: (factory) => factory.booleanFuseTracked?.bind(factory),
};

export type TrackedMethod = (shape1: IShape[], shape2: IShape[]) => Result<TrackedShape>;

/** The kernel's history-tracking variant of a boolean operation, when available. */
export function trackedBoolean(operation: BooleanOperation): TrackedMethod | undefined {
    return TRACKED[operation](shapeFactory);
}

/**
 * Intersect keeps what the input shares with EVERY tool (Onshape/SolidWorks semantics). One
 * kernel common over a tool list intersects with the tools' union instead, so several tools
 * are applied one after another.
 */
function commonOfAll(input: IShape, toolShapes: IShape[]): Result<IShape> {
    let shape = input;
    for (const tool of toolShapes) {
        const next = shapeFactory.booleanCommon([shape], [tool]);
        if (shape !== input) shape.dispose();
        if (!next.isOk) return next;
        shape = next.value;
    }
    return Result.ok(shape);
}

function evaluateTracked(
    feature: BooleanFeatureData,
    context: FeatureContext,
    tools: ShapeNode[],
    toolShapes: IShape[],
    tracked: TrackedMethod,
): Result<IShape> {
    const { input, tracking } = context;
    // Both are guaranteed by the caller's guards — the type just cannot see it.
    if (input === undefined || tracking === undefined) {
        return Result.err("boolean requires a preceding feature");
    }
    // Intersect runs one tool per step (see `commonOfAll`); fuse and cut take them all at once.
    const steps = feature.operation === "common" ? tools.map((_, k) => [k]) : [tools.map((_, k) => k)];
    let shape = input;
    let faceIds = tracking.inputFaceIds;
    let edgeIds = tracking.inputEdgeIds;
    for (const [step, picked] of steps.entries()) {
        const stepTools = picked.map((k) => tools[k]);
        const stepShapes = picked.map((k) => toolShapes[k]);
        const result = tracked([shape], stepShapes);
        if (!result.isOk) {
            if (shape !== input) shape.dispose();
            return Result.err(result.error);
        }
        const { edgeMap, faceMap } = completeTrackedHistory([shape, ...stepShapes], result.value);
        // Later steps scope their new sub-shapes apart from the earlier steps' ones.
        const scope = step === 0 ? feature.id : `${feature.id}~${step}`;
        faceIds = mapBooleanIds(
            scope,
            shape,
            faceIds,
            stepTools,
            faceMap,
            ShapeTypes.face,
            result.value.faceAncestors,
        );
        edgeIds = mapBooleanIds(
            scope,
            shape,
            edgeIds,
            stepTools,
            edgeMap,
            ShapeTypes.edge,
            result.value.edgeAncestors,
        );
        // An intermediate step's shape is ours; the chain input is not.
        if (shape !== input) shape.dispose();
        shape = result.value.shape;
    }
    tracking.outputFaceIds = [...faceIds];
    tracking.outputEdgeIds = [...edgeIds];
    return Result.ok(shape);
}

registerFeature("boolean", booleanHandler);
