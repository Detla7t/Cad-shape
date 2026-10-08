// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, Result, Transaction } from "@chili3d/core";
import type { ParametricBodyNode } from "../parametricBodyNode";
import { FeatureStudioNode } from "./featureStudioNode";
import { insertCustomFeature } from "./insertFeature";
import { providedOnshapeStd } from "./runtime";
import { compileStudioSource, documentStudios } from "./studioCompiler";

/** Supported modes with the same replay/selection/undo path as document Feature Studios. */
export const STANDARD_FEATURES = [
    { featureName: "neutralPlaneDraft", displayName: "Draft — neutral plane" },
    { featureName: "splineThroughVertices", displayName: "3D fit spline — vertices" },
    { featureName: "fillBoundary", displayName: "Fill — position continuity" },
] as const;

// Source is saved inside the document, so the wrappers are editable and travel with exports/history.
// They call Onshape's own features; each wrapper exposes only modes backed by our kernel.
export const STANDARD_FEATURE_SOURCE = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

annotation { "Feature Type Name" : "Draft" }
export const neutralPlaneDraft = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {
        annotation { "Name" : "Neutral plane", "Filter" : EntityType.FACE, "MaxNumberOfPicks" : 1 }
        definition.neutralPlane is Query;
        annotation { "Name" : "Faces to draft", "Filter" : EntityType.FACE }
        definition.draftFaces is Query;
        annotation { "Name" : "Draft angle" }
        isAngle(definition.angle, ANGLE_STRICT_90_BOUNDS);
        annotation { "Name" : "Opposite direction" }
        definition.pullDirection is boolean;
        annotation { "Name" : "Tangent propagation", "Default" : true }
        definition.tangentPropagation is boolean;
    } {
        draft(context, id + "draft", definition);
    }, { "angle" : 3 * degree, "pullDirection" : false, "tangentPropagation" : true });

annotation { "Feature Type Name" : "3D fit spline" }
export const splineThroughVertices = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {
        annotation { "Name" : "Vertices in order", "Filter" : EntityType.VERTEX, "UIHint" : UIHint.ALLOW_QUERY_ORDER }
        definition.vertices is Query;
        annotation { "Name" : "Closed spline" }
        definition.closed is boolean;
    } {
        fitSpline(context, id + "spline", definition);
    }, { "closed" : false });

annotation { "Feature Type Name" : "Fill" }
export const fillBoundary = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {
        annotation { "Name" : "Closed boundary", "Filter" : EntityType.EDGE }
        definition.boundary is Query;
        annotation { "Name" : "Guide vertices", "Filter" : EntityType.VERTEX }
        definition.guides is Query;
    } {
        fill(context, id + "fill", { "edges" : [{ "entities" : definition.boundary, "continuity" : GeometricContinuity.G0 }],
            "surfaceOperationType" : NewSurfaceOperationType.NEW,
            "addGuides" : !isQueryEmpty(context, definition.guides), "guideEntities" : definition.guides });
    });
`;

export function insertStandardFeature(
    document: IDocument,
    featureName: string,
    body?: ParametricBodyNode,
): Result<ParametricBodyNode> {
    if (!providedOnshapeStd()) return Result.err("The Onshape standard library has not loaded");
    const entry = STANDARD_FEATURES.find((item) => item.featureName === featureName);
    if (!entry) return Result.err("Unknown standard feature");
    // Compile before changing the document; a broken asset cannot leave an empty studio behind.
    const compiled = compileStudioSource(
        "standard-feature-check",
        "Standard modeling tools",
        STANDARD_FEATURE_SOURCE,
        () => undefined,
    );
    if (compiled.error || !compiled.spec(featureName))
        return Result.err(compiled.error ?? "Standard feature parameters could not be loaded");
    const existing = documentStudios(document).find((studio) => studio.source === STANDARD_FEATURE_SOURCE);
    const studio =
        existing ??
        new FeatureStudioNode({ document, name: "Standard modeling tools", source: STANDARD_FEATURE_SOURCE });
    let result: Result<ParametricBodyNode> = Result.err("Feature insertion failed");
    try {
        Transaction.execute(document, "insert standard feature", () => {
            if (!existing) document.modelManager.addNode(studio);
            result = insertCustomFeature(document, { studio, ...entry }, body);
            if (!result.isOk) throw new Error(result.error);
        });
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
    return result;
}
