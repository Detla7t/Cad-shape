// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, Id, Result, Transaction } from "@chili3d/core";
import type { FeatureScriptFeatureData, FeatureScriptParameterValue } from "../features/feature";
import { ParametricBodyNode } from "../parametricBodyNode";
import { FEATURESCRIPT_TYPE } from "./featureScriptFeature";
import type { FeatureStudioNode } from "./featureStudioNode";
import { compileDocumentStudio, documentStudios } from "./studioCompiler";

/** One custom feature a document offers: which studio exports it, under which name. */
export interface CustomFeatureEntry {
    readonly studio: FeatureStudioNode;
    readonly featureName: string;
    readonly displayName: string;
}

/** Every custom feature the document's studios export (studios that fail to compile offer none). */
export function customFeatures(document: IDocument, studio?: FeatureStudioNode): CustomFeatureEntry[] {
    const studios = studio === undefined ? documentStudios(document) : [studio];
    return studios.flatMap((candidate) => {
        const compiled = compileDocumentStudio(document, candidate.id);
        if (compiled === undefined || compiled.error !== undefined) return [];
        // Re-exported features belong to the studio that defines them.
        return compiled.features
            .filter((feature) => feature.module === compiled.module)
            .map((feature) => ({
                studio: candidate,
                featureName: feature.name,
                displayName: feature.displayName,
            }));
    });
}

/**
 * A new feature row for `featureName`, with every non-pick parameter stored at its
 * default — like Onshape's dialog, the defaults are captured when the feature is
 * inserted, so a later edit of the studio's defaults does not silently move it.
 */
export function newFeatureScriptFeature(
    document: IDocument,
    studio: FeatureStudioNode,
    featureName: string,
    overrides: Record<string, FeatureScriptParameterValue> = {},
): Result<FeatureScriptFeatureData> {
    const compiled = compileDocumentStudio(document, studio.id);
    if (compiled === undefined) return Result.err(`Feature Studio "${studio.name}" was not found`);
    if (compiled.error !== undefined)
        return Result.err(`Feature Studio "${studio.name}" has an error: ${compiled.error}`);
    const spec = compiled.spec(featureName);
    if (spec === undefined) {
        const known = compiled.features.map((feature) => feature.name).join(", ") || "none";
        return Result.err(`"${studio.name}" exports no feature "${featureName}" (exported: ${known})`);
    }
    const definition: Record<string, FeatureScriptParameterValue> = {};
    for (const parameter of spec.parameters) {
        if (parameter.kind !== "query") definition[parameter.key] = parameter.defaultValue;
    }
    for (const [key, value] of Object.entries(overrides)) {
        if (!spec.parameters.some((parameter) => parameter.key === key)) {
            return Result.err(
                `"${featureName}" has no parameter "${key}" (parameters: ${spec.parameters.map((p) => p.key).join(", ")})`,
            );
        }
        definition[key] = value;
    }
    return Result.ok({
        id: Id.generate(),
        type: FEATURESCRIPT_TYPE,
        studioId: studio.id,
        featureName,
        name: spec.displayName,
        definition,
    });
}

/**
 * Adds a custom feature to `body` (or to a new body when undefined) as one undo step and
 * selects the body so its feature panel opens on the new row. Returns the body.
 */
export function insertCustomFeature(
    document: IDocument,
    entry: CustomFeatureEntry,
    body: ParametricBodyNode | undefined,
): Result<ParametricBodyNode> {
    const feature = newFeatureScriptFeature(document, entry.studio, entry.featureName);
    if (!feature.isOk) return Result.err(feature.error);
    const target = body ?? new ParametricBodyNode({ document, features: [] });
    Transaction.execute(document, "insert custom feature", () => {
        if (body === undefined) {
            target.name = entry.displayName;
            document.modelManager.addNode(target);
        }
        target.setFeaturesEmitShapeChanged([...target.features, feature.value]);
        document.visual.update();
    });
    document.selection.setSelectedNodes([target], false);
    return Result.ok(target);
}
