// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Continuities,
    type Continuity,
    I18n,
    type IDocument,
    type IShape,
    type IWire,
    Result,
} from "@chili3d/core";
import type { SketchNode } from "../sketch/sketchNode";
import { findSketch } from "./extrude";
import {
    type BooleanOperation,
    type FeatureContext,
    type FeatureHandler,
    type LoftFeatureData,
    type LoftSectionRef,
    registerFeature,
} from "./feature";
import { resolveProfiles } from "./profileBuilder";

/** Default continuity between the section surfaces of a smooth (non-ruled) loft. */
export const DEFAULT_LOFT_CONTINUITY: Continuity = "c0";

/**
 * Resolves one section to the outer wire of its sketch profile: the referenced region
 * (fingerprint re-matched on the sketch's current shape) or, without a ref, the sketch's
 * first outer profile.
 */
export function resolveLoftSection(
    document: IDocument,
    section: LoftSectionRef,
): Result<{ sketch: SketchNode; wire: IWire }> {
    const sketch = findSketch(document, section.sketchId);
    if (sketch === undefined) return Result.err("Loft section sketch not found");
    const profiles = resolveProfiles(sketch, section.profile === undefined ? undefined : [section.profile]);
    if (!profiles.isOk) return Result.err(profiles.error);
    const face = profiles.value[0]?.face;
    if (face === undefined) return Result.err(`${sketch.name} has no closed profile to loft`);
    return Result.ok({ sketch, wire: face.outerWire() });
}

/** Builds the loft surface/solid through the sections' outer wires. */
export function buildLoft(
    document: IDocument,
    feature: Pick<LoftFeatureData, "sections" | "solid" | "ruled" | "continuity">,
): Result<IShape> {
    const sections = feature.sections ?? [];
    if (sections.length < 2) return Result.err("A loft needs at least two profiles");
    const wires: IWire[] = [];
    for (const section of sections) {
        const resolved = resolveLoftSection(document, section);
        if (!resolved.isOk) return Result.err(resolved.error);
        wires.push(resolved.value.wire);
    }
    return shapeFactory.loft(
        wires,
        feature.solid !== false,
        feature.ruled === true,
        feature.continuity ?? DEFAULT_LOFT_CONTINUITY,
    );
}

/** Join/cut/intersect with the chain input (Fusion-style); "new" returns the loft itself. */
function combineWithInput(
    built: Result<IShape>,
    operation: BooleanOperation | undefined,
    context: FeatureContext,
): Result<IShape> {
    if (!built.isOk || operation === undefined) return built;
    if (context.input === undefined) {
        built.value.dispose();
        return Result.err("Loft join/cut/intersect requires a preceding feature");
    }
    try {
        switch (operation) {
            case "cut":
                return shapeFactory.booleanCut([context.input], [built.value]);
            case "common":
                return shapeFactory.booleanCommon([context.input], [built.value]);
            default:
                return shapeFactory.booleanFuse([context.input], [built.value], true);
        }
    } finally {
        // the loft body is an intermediate input — the kernel reads it eagerly
        built.value.dispose();
    }
}

/** The distinct sketches the sections come from, in section order (a damaged payload has none). */
function sectionSketchIds(feature: LoftFeatureData): string[] {
    return [...new Set((feature.sections ?? []).map((section) => section.sketchId))];
}

const loftHandler: FeatureHandler<LoftFeatureData> = {
    display: "command.feature.loft",
    icon: "icon-loft",

    nodeIds: (feature) => sectionSketchIds(feature),

    references: (feature) =>
        sectionSketchIds(feature).map((nodeId, index) => ({
            key: `section${index}`,
            display: "body.sketch",
            nodeId,
        })),

    parameters: (feature) => [
        {
            key: "sections",
            display: "prompt.select.section",
            value: `${feature.sections?.length ?? 0} profiles`,
            text: true,
            configurable: false,
        },
        { key: "solid", display: "option.command.isSolid", value: feature.solid !== false },
        {
            key: "operation",
            display: "option.command.operation",
            value: feature.operation ?? "new",
            options: [
                { value: "new", label: I18n.translate("option.command.operation.new") },
                { value: "fuse", label: I18n.translate("option.command.operation.join") },
                { value: "cut", label: I18n.translate("option.command.operation.cut") },
                { value: "common", label: I18n.translate("option.command.operation.intersect") },
            ],
        },
        { key: "ruled", display: "option.command.isRuled", value: feature.ruled === true },
        {
            key: "continuity",
            display: "option.command.continuity",
            value: feature.continuity ?? DEFAULT_LOFT_CONTINUITY,
            options: Continuities.map((value) => ({ value, label: value })),
        },
    ],

    setParameter: (feature, key, value) => {
        switch (key) {
            case "solid":
                return { ...feature, solid: value === true || value === "true" };
            case "ruled":
                return { ...feature, ruled: value === true || value === "true" };
            case "continuity":
                return Continuities.includes(value as Continuity)
                    ? { ...feature, continuity: value as Continuity }
                    : feature;
            case "operation":
                return {
                    ...feature,
                    operation:
                        value === "new"
                            ? undefined
                            : value === "fuse" || value === "cut" || value === "common"
                              ? value
                              : feature.operation,
                };
            default:
                return feature;
        }
    },

    evaluate(feature, context): Result<IShape> {
        return combineWithInput(buildLoft(context.document, feature), feature.operation, context);
    },
};

registerFeature("loft", loftHandler);
