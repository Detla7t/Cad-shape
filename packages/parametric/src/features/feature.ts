// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type FeatureParameter,
    type I18nKeys,
    type IDocument,
    type IEdge,
    type IFace,
    type IShape,
    type Matrix4,
    OperationLog,
    type ParameterValue,
    Result,
    type Scope,
    ShapeTypes,
    selectConfiguredBoolean,
    type TrackedShape,
    type XYZLike,
} from "@chili3d/core";
import type { EdgeRef } from "./edgeRef";
import { resolveFeatureConfiguration } from "./featureConfiguration";
import { completeEdgeHistory, completeFaceHistory } from "./historyCompletion";
import type { ProfileRef } from "./profileRef";

export interface FeatureBase {
    readonly id: string;
    readonly type: string;
    /**
     * Suppressed features are skipped during evaluation and shown dimmed in the panel. A
     * `configure(…)` value over a list or checkbox input suppresses per configuration — read
     * it through `isFeatureSuppressed`, never as a truthy flag.
     */
    readonly suppressed?: boolean | string;
    /** User-assigned display name, overriding the kind's default in the feature panel. */
    readonly name?: string;
    /** Per-input bindings for declared scalar parameters; the original values remain as defaults. */
    readonly configuredParameters?: Readonly<Record<string, string>>;
}

/** Union of all feature payloads; grows as new feature kinds are added. */
export type FeatureData =
    | ExtrudeFeatureData
    | RevolveFeatureData
    | FilletFeatureData
    | ChamferFeatureData
    | BooleanFeatureData
    | FeatureScriptFeatureData
    | SheetMetalFeatureData;

export interface ExtrudeFeatureData extends FeatureBase {
    readonly type: "extrude";
    /** Sketch whose profiles are extruded; undefined when `source` faces are used instead. */
    readonly sketchId?: string;
    /**
     * Planar faces of an existing body to extrude from (press-pull), as profile
     * fingerprints captured in world coordinates (`profileRef.ts`). When `nodeId` is
     * the host body itself, the faces are re-matched on the feature's input shape.
     */
    readonly source?: { readonly nodeId: string; readonly profiles: ProfileRef[] };
    readonly depth: ParameterValue;
    /** When true, the profiles are extruded by `depth` in both directions of the sketch normal. */
    readonly symmetric?: boolean;
    /**
     * Distance the extrusion starts away from the profile plane, along the extrude
     * normal (positive moves the start in the normal direction). Zero keeps the start
     * on the profile plane.
     */
    readonly startOffset?: ParameterValue;
    /**
     * How the prism combines with the preceding feature's shape on the host body —
     * Fusion-style join (fuse) / cut / intersect (common). Undefined creates standalone
     * geometry; set when the extrude command appends the feature to a target body.
     */
    readonly operation?: BooleanOperation;
    /**
     * Fingerprints of the sketch profiles to extrude (`profileRef.ts`); undefined or
     * empty extrudes every closed profile of the sketch.
     */
    readonly profiles?: ProfileRef[];
}

export interface RevolveFeatureData extends FeatureBase {
    readonly type: "revolve";
    readonly sketchId: string;
    /**
     * Rotation axis in world space — a snapshot taken at creation time. When
     * `axisSource` is set it is re-derived from the referenced edge on every rebuild
     * and this only serves as a fallback (e.g. the source node was deleted).
     */
    readonly axis: { point: XYZLike; direction: XYZLike };
    /**
     * The axis as a reference: a line-edge fingerprint (`edgeRef.ts`) on another node,
     * re-matched against that node's current shape when it changes — moving the picked
     * axis line moves the revolve, like the axis reference in mainstream parametric CAD.
     */
    readonly axisSource?: { readonly nodeId: string; readonly edge: EdgeRef };
    /** In degrees. */
    readonly angle: ParameterValue;
    /**
     * Fingerprints of the sketch profiles to revolve (`profileRef.ts`); undefined or
     * empty revolves every closed profile of the sketch.
     */
    readonly profiles?: ProfileRef[];
}

export interface FilletFeatureData extends FeatureBase {
    readonly type: "fillet";
    readonly radius: ParameterValue;
    readonly edges: EdgeRef[];
}

export interface ChamferFeatureData extends FeatureBase {
    readonly type: "chamfer";
    readonly distance: ParameterValue;
    readonly edges: EdgeRef[];
}

export type BooleanOperation = "fuse" | "cut" | "common";

export interface BooleanFeatureData extends FeatureBase {
    readonly type: "boolean";
    readonly operation: BooleanOperation;
    /** Node ids of the tool bodies; the body watches them for changes. */
    readonly toolIds: string[];
    /**
     * When true (the default), tool nodes become children of the body — hidden from
     * the scene, still listed and editable under the body in the model tree.
     */
    readonly consumeTools?: boolean;
}

/**
 * A FeatureScript query parameter: the host body's entities the user picked, stored the
 * way the built-in features store theirs — edge fingerprints with tracked ids
 * (`EdgeRef`), face fingerprints with tracked ids, vertex positions.
 */
export interface FeatureScriptQueryValue {
    readonly edges?: EdgeRef[];
    readonly faces?: FeatureScriptFaceRef[];
    readonly vertices?: { readonly point: XYZLike }[];
}

export interface FeatureScriptFaceRef {
    readonly faceId?: string;
    readonly center: XYZLike;
    readonly area: number;
    /** Outward normal, for planar faces only. */
    readonly normal?: XYZLike;
}

export type FeatureScriptParameterValue = ParameterValue | boolean | FeatureScriptQueryValue;

/**
 * A custom feature defined in FeatureScript: an exported `defineFeature` constant of a
 * Feature Studio, run against the body's chain shape. Parameter values are stored by
 * definition field, in app units (mm, degrees) — numeric ones may be expressions over
 * the document's variables like any other feature parameter.
 */
export interface FeatureScriptFeatureData extends FeatureBase {
    readonly type: "featurescript";
    /** Node id of the `FeatureStudioNode` holding the source. */
    readonly studioId: string;
    /** The exported feature constant's name. */
    readonly featureName: string;
    readonly definition: Record<string, FeatureScriptParameterValue>;
}

/** A straight sketch line a sheet metal feature uses (a bend line, a bead path). */
export interface SheetLineRef {
    /** The sketch (or other node) the line belongs to — watched for changes. */
    readonly nodeId: string;
    readonly edge: EdgeRef;
    /** World-space snapshot, the fallback when the line can no longer be matched. */
    readonly start: XYZLike;
    readonly end: XYZLike;
}

export type SheetDirection = "up" | "down";

/** Sheet metal from a closed sketch profile: the flat blank and the part's material settings. */
export interface SheetMetalBaseFeatureData extends FeatureBase {
    readonly type: "smBase";
    readonly sketchId: string;
    readonly profiles?: ProfileRef[];
    readonly thickness: ParameterValue;
    readonly radius: ParameterValue;
    readonly kFactor: ParameterValue;
}

/** Bends the sheet along sketch lines. */
export interface SheetMetalBendFeatureData extends FeatureBase {
    readonly type: "smBend";
    readonly lines: SheetLineRef[];
    readonly angle: ParameterValue;
    readonly direction: SheetDirection;
    /** Inner radius override; the part's default bend radius when undefined. */
    readonly radius?: ParameterValue;
}

/** An edge treatment on straight outline edges of the sheet (picked on the formed part). */
export interface SheetMetalEdgeFeatureData extends FeatureBase {
    readonly type: "smEdge";
    readonly kind: "easyEdge" | "pittsburgh" | "hem" | "flange";
    readonly edges: EdgeRef[];
    readonly direction: SheetDirection;
    /** Easy edge / flange leg, hem length, or Pittsburgh pocket depth. */
    readonly length: ParameterValue;
    /** Pittsburgh lip height. */
    readonly height?: ParameterValue;
    /** Pittsburgh slot clearance. */
    readonly clearance?: ParameterValue;
    /** Flange angle, degrees. */
    readonly angle?: ParameterValue;
    readonly radius?: ParameterValue;
}

/** Rolls the flat blank into a cylinder (round duct). */
export interface SheetMetalRollFeatureData extends FeatureBase {
    readonly type: "smRoll";
    /** The sketch axis the roll axis runs along. */
    readonly axis: "u" | "v";
    /** Inner radius; 0 closes the blank into a full cylinder. */
    readonly radius: ParameterValue;
    readonly direction: SheetDirection;
}

/** A crimped end on a round duct. */
export interface SheetMetalCrimpFeatureData extends FeatureBase {
    readonly type: "smCrimp";
    readonly end: "start" | "end";
    readonly length: ParameterValue;
    readonly depth: ParameterValue;
    readonly count: ParameterValue;
}

/** A stiffening bead: along a sketch line on a flat sheet, or around a rolled one. */
export interface SheetMetalBeadFeatureData extends FeatureBase {
    readonly type: "smBead";
    readonly line?: SheetLineRef;
    readonly offset?: ParameterValue;
    readonly from?: "start" | "end";
    readonly width: ParameterValue;
    readonly height: ParameterValue;
    readonly direction: "out" | "in";
}

/** Shows the part as its flat pattern, bend lines marked. */
export interface SheetMetalFlattenFeatureData extends FeatureBase {
    readonly type: "smFlatten";
}

export type SheetMetalFeatureData =
    | SheetMetalBaseFeatureData
    | SheetMetalBendFeatureData
    | SheetMetalEdgeFeatureData
    | SheetMetalRollFeatureData
    | SheetMetalCrimpFeatureData
    | SheetMetalBeadFeatureData
    | SheetMetalFlattenFeatureData;

/**
 * What a feature may ask of the body replaying it: its identity (to recognise a
 * self-reference, e.g. an extrude sourced on the host's own face) and its world
 * transform (boolean tools are mapped into the body's local space). Deliberately
 * narrower than `ShapeNode` so a caller driving a chain — the re-pick preview
 * evaluator, which is not a shape node — need only provide these two.
 */
export interface IShapeHost {
    readonly id: string;
    worldTransform(): Matrix4;
}

export interface FeatureContext {
    readonly document: IDocument;
    readonly host: IShapeHost;
    /** Output of the previous feature; undefined for the first (profile) feature. */
    readonly input?: IShape;
    /** The document's parameter table, resolved for this rebuild. */
    readonly scope: Scope;
    /**
     * Set by the body so handlers can report stable sub-shape ids via the kernel's
     * shape history. `inputFaceIds`/`inputEdgeIds` are the ids of `input`'s faces and
     * edges (findSubShapes order, empty for profile features); a handler on the tracked
     * path fills the output arrays — left empty when tracking is unavailable.
     */
    readonly tracking?: ShapeTracking;
}

export interface ShapeTracking {
    readonly inputFaceIds: readonly string[];
    outputFaceIds: string[];
    readonly inputEdgeIds: readonly string[];
    outputEdgeIds: string[];
    /**
     * Set by a profile-matching handler to the fingerprints of the faces it actually
     * matched this run; the body writes them back into the feature (re-anchoring) so
     * the next edit measures drift from the latest match, not the original pick.
     */
    resolvedProfiles?: ProfileRef[];
    /**
     * Set by an edge-matching handler to the per-ref anchors it actually matched
     * this run (`matchEdgesAnchored`, or a re-capture from the matched edge on the
     * untracked path): fillet/chamfer edges and revolve's axis edge. The body writes
     * them back into the feature, same re-anchoring contract as `resolvedProfiles`.
     */
    resolvedEdges?: EdgeRef[];
    /** A non-fatal message for the feature row (e.g. a FeatureScript `reportFeatureWarning`). */
    warning?: string;
}

/**
 * Maps kernel sub-shape history to stable ids: a sub-shape derived from an input
 * sub-shape keeps that id, a brand-new one gets an id scoped to the creating feature.
 * Feature-scoped ids are positional — stable while the kernel enumerates unchanged
 * geometry the same way, NOT geometry-stable — so consumers re-verify an id hit
 * against the ref's rigid-move invariants (`edgeMatchesRefInvariant`) and demote a
 * realigned id to fingerprint matching instead of trusting it blindly.
 */
export function trackedIds(featureId: string, inputIds: readonly string[], map: number[]): string[] {
    return map.map((inputIndex, outputIndex) =>
        inputIndex >= 0 && inputIndex < inputIds.length
            ? inputIds[inputIndex]
            : `${featureId}:${outputIndex}`,
    );
}

/**
 * Face ids for sweeps (prism/revol): face-history hits keep the input face id; a side
 * face generated from a profile edge takes that edge's seed — stable across rebuilds
 * even when the kernel re-enumerates faces (a mirrored profile flips the side-face
 * order); anything else is feature-scoped.
 */
export function trackedFaceIds(
    featureId: string,
    inputFaceIds: readonly string[],
    inputEdgeIds: readonly string[],
    faceMap: number[],
    faceEdgeMap?: number[],
): string[] {
    return faceMap.map((inputIndex, outputIndex) => {
        if (inputIndex >= 0 && inputIndex < inputFaceIds.length) return inputFaceIds[inputIndex];
        const edgeIndex = faceEdgeMap?.[outputIndex] ?? -1;
        if (edgeIndex >= 0 && edgeIndex < inputEdgeIds.length) return inputEdgeIds[edgeIndex];
        return `${featureId}:${outputIndex}`;
    });
}

/** The completed maps of `completeTrackedHistory`, plus the enumerated output sub-shapes for reuse. */
export interface CompletedTrackedHistory {
    readonly edgeMap: number[];
    readonly faceMap: number[];
    /** `result.shape`'s sub-shapes in findSubShapes order — reused by callers for seed generation. */
    readonly outputEdges: IEdge[];
    readonly outputFaces: IFace[];
}

/**
 * Geometry-identical completion of BOTH sub-shape kinds of a tracked kernel
 * history (`completeEdgeHistory`/`completeFaceHistory`): recovers the unchanged
 * sub-shapes a sparse kernel history missed, so they keep the input's stable id
 * instead of a feature-scoped one. Kernel geometry is read eagerly — call
 * before disposing any input shape.
 *
 * ORDERING CONTRACT (load-bearing): the kernel's history input enumerates the
 * MAIN shape's sub-shapes first, then each tool's in order, and the map indexes
 * point into that enumeration. Pass `inputs` in that same order — the consumers
 * of the completed maps (`mapOperationIds`' main/tool boundary, `mapFusedIds`,
 * `mapBooleanIds`) all interpret the indexes against it.
 *
 * `enumerated` hands over input sub-shape lists the caller already enumerated
 * (the sweep sites keep the profile's edges for seed generation), skipping the
 * repeat `findSubShapes`; the returned output lists are the enumerated result
 * sub-shapes, for the same reuse.
 */
export function completeTrackedHistory(
    inputs: readonly IShape[],
    result: TrackedShape,
    enumerated?: {
        readonly inputEdges?: readonly IEdge[];
        readonly inputFaces?: readonly IFace[];
    },
): CompletedTrackedHistory {
    const inputEdges =
        enumerated?.inputEdges ?? inputs.flatMap((shape) => shape.findSubShapes(ShapeTypes.edge) as IEdge[]);
    const inputFaces =
        enumerated?.inputFaces ?? inputs.flatMap((shape) => shape.findSubShapes(ShapeTypes.face) as IFace[]);
    const outputEdges = result.shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    const outputFaces = result.shape.findSubShapes(ShapeTypes.face) as IFace[];
    return {
        edgeMap: completeEdgeHistory(inputEdges, outputEdges, result.edgeMap),
        faceMap: completeFaceHistory(inputFaces, outputFaces, result.faceMap),
        outputEdges,
        outputFaces,
    };
}

/**
 * A node reference a feature declares — the body resolves `nodeId` against the
 * document to build the panel's link row (see `FeatureReference`).
 */
export interface FeatureNodeRef {
    readonly key: string;
    readonly display: I18nKeys;
    readonly nodeId: string;
}

/** Per-feature-kind behavior. Implementations live next to their feature file. */
export interface FeatureHandler<F extends FeatureData = any> {
    /** i18n key shown in the feature list; a function picks the key per feature (e.g. boolean operation). */
    readonly display: I18nKeys | ((feature: F) => I18nKeys);
    /** Iconfont key shown in the feature list; a function picks the icon per feature. */
    readonly icon?: string | ((feature: F) => string);
    /** Set when the user can re-pick the shapes the feature references (e.g. edges). */
    readonly reselectable?: boolean;
    evaluate(feature: F, context: FeatureContext): Result<IShape>;
    /** Ids of nodes this feature references — the body watches them for changes. */
    nodeIds(feature: F): string[];
    /**
     * Nodes the user is meant to reach from this feature (e.g. the sketch it
     * consumes), shown as link rows in its panel row. A subset of `nodeIds` in
     * practice: `nodeIds` is what the body must watch, this is what the user needs
     * a door to. Dangles are dropped, not rendered.
     */
    references?(feature: F): FeatureNodeRef[];
    /** `document` lets a feature whose parameters live elsewhere (a FeatureScript studio) read them. */
    parameters(feature: F, document?: IDocument): FeatureParameter[];
    setParameter(feature: F, key: string, value: ParameterValue | boolean, document?: IDocument): F;
    /**
     * Extra cache-key material for state the feature JSON does not carry (a studio's
     * source): a change in the token re-evaluates the feature even when its JSON, its
     * input and its watched shapes are all unchanged.
     */
    cacheToken?(feature: F, document: IDocument): string;
    /**
     * Writes the refs the last evaluation actually matched back into the feature
     * (re-anchoring — see `ShapeTracking.resolvedProfiles`/`resolvedEdges`). Each
     * handler knows where its refs live; a feature whose entry is absent is
     * returned unchanged.
     */
    applyResolvedRefs?(feature: F, refs: { resolvedProfiles?: ProfileRef[]; resolvedEdges?: EdgeRef[] }): F;
}

const handlers = new Map<string, FeatureHandler>();

export function registerFeature(type: string, handler: FeatureHandler): void {
    handlers.set(type, handler);
}

export function featureHandler(type: string): FeatureHandler | undefined {
    return handlers.get(type);
}

export function evaluateFeature(feature: FeatureData, context: FeatureContext): Result<IShape> {
    const operation = OperationLog.begin("feature.rebuild", {
        documentId: context.document.id,
        featureId: feature.id,
        featureType: feature.type,
    });
    try {
        const handler = handlers.get(feature.type);
        const configured = handler && resolveFeatureConfiguration(feature, handler, context.document);
        const result: Result<IShape> = !handler
            ? Result.err(`Unknown feature type: ${feature.type}`)
            : configured!.isOk
              ? handler.evaluate(configured!.value, context)
              : Result.err(configured!.error);
        operation.finish(result.isOk ? "success" : "error", result.isOk ? undefined : result.error);
        return result;
    } catch (error) {
        operation.finish("error", error);
        throw error;
    }
}

/**
 * Whether `feature` is suppressed in the active configuration. `suppressed` is `true`/`false`
 * or a configured value over a list or checkbox input (`configure(Holes, true: false, false:
 * true)`); one that cannot be resolved reports why, and the feature then stays in.
 */
export function featureSuppression(feature: FeatureBase, scope: Scope): Result<boolean> {
    return selectConfiguredBoolean(feature.suppressed ?? false, scope);
}

/** `featureSuppression`, with an unresolvable configured suppression counting as not suppressed. */
export function isFeatureSuppressed(feature: FeatureBase, scope: Scope): boolean {
    const suppressed = featureSuppression(feature, scope);
    return suppressed.isOk && suppressed.value;
}
