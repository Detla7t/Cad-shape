// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    type FeatureParameter,
    type FeaturePickKind,
    findDataTable,
    type IDocument,
    type IFace,
    type IShape,
    isConfiguredValue,
    LENGTH_UNITS,
    Matrix4,
    type ParameterValue,
    Plane,
    ReferencePlaneNode,
    Result,
    resolveUnitSpec,
    type Scope,
    ShapeTypes,
    selectConfiguredArm,
    UNITLESS,
    type UnitSpec,
    XYZ,
} from "@chili3d/core";
import { matchEdgeIndexes, matchEdgesAnchored } from "../features/edgeMatcher";
import type { EdgeRef } from "../features/edgeRef";
import {
    type FeatureContext,
    type FeatureHandler,
    type FeatureScriptBodyRef,
    type FeatureScriptFaceRef,
    type FeatureScriptFeatureData,
    type FeatureScriptParameterValue,
    type FeatureScriptPlaneRef,
    type FeatureScriptQueryValue,
    registerFeature,
    type ShapeTracking,
} from "../features/feature";
import { captureFaceFingerprint } from "../features/historyCompletion";
import {
    type EntityRef,
    type FsBody,
    type FsContext,
    MM_PER_METER,
    toKernelPlane,
} from "./context/fsContext";
import { query, transientQuery } from "./context/queries";
import { type FeatureSpec, type FsParameterSpec, isParameterVisible } from "./featureSpec";
import type { FeatureExport } from "./lang/interpreter";
import { ANGLE, FsArray, FsMap, FsQuantity, type FsValue, LENGTH } from "./lang/values";
import { describeError, runFeature } from "./runtime";
import { makePlaneData, type Vec3 } from "./std/geometry";
import {
    type CompiledStudio,
    compileDocumentStudio,
    findStudio,
    studioDependencies,
    studioToken,
} from "./studioCompiler";

/**
 * The `featurescript` feature: runs one custom feature of a Feature Studio against the
 * body's chain shape. The studio is compiled once per source (`studioCompiler.ts`);
 * the feature's parameters come from its precondition (`featureSpec.ts`) and are shown in
 * the feature panel like any built-in feature's, honouring conditional visibility.
 *
 * Stable ids: the run's context tracks every entity's origin, so faces and edges that
 * survive from the input keep the input's ids, and new ones get ids scoped to this
 * feature and the FeatureScript operation that created them — a downstream fillet on an
 * edge the custom feature made re-matches across rebuilds like any other.
 */

export const FEATURESCRIPT_TYPE = "featurescript";

function isQueryValue(value: FeatureScriptParameterValue | undefined): value is FeatureScriptQueryValue {
    return typeof value === "object" && value !== null;
}

export function querySummary(value: FeatureScriptParameterValue | undefined): string {
    if (!isQueryValue(value)) return "—";
    const count = (n: number, one: string, many: string) => (n === 0 ? [] : [`${n} ${n === 1 ? one : many}`]);
    const parts = [
        ...count(value.bodies?.length ?? 0, "part", "parts"),
        ...count(value.planes?.length ?? 0, "plane", "planes"),
        ...count(value.faces?.length ?? 0, "face", "faces"),
        ...count(value.edges?.length ?? 0, "edge", "edges"),
        ...count(value.vertices?.length ?? 0, "vertex", "vertices"),
    ];
    return parts.length === 0 ? "—" : parts.join(", ");
}

interface ResolvedSpec {
    readonly compiled: CompiledStudio;
    readonly exported: FeatureExport;
    readonly spec: FeatureSpec;
}

/** The compiled studio + spec of a feature, or the reason they are unavailable. */
function resolveSpec(document: IDocument, feature: FeatureScriptFeatureData): Result<ResolvedSpec> {
    const compiled = compileDocumentStudio(document, feature.studioId);
    if (compiled === undefined) return Result.err("The Feature Studio of this feature was deleted");
    if (compiled.error !== undefined) {
        const studio = findStudio(document, feature.studioId);
        return Result.err(
            `Feature Studio "${studio?.name ?? feature.studioId}" has an error: ${compiled.error}`,
        );
    }
    const exported = compiled.feature(feature.featureName);
    const spec = compiled.spec(feature.featureName);
    if (exported === undefined || spec === undefined) {
        return Result.err(`The Feature Studio no longer exports the feature "${feature.featureName}"`);
    }
    return Result.ok({ compiled, exported, spec });
}

/** The stored value, or the spec default when the feature has none for the key. */
function storedValue(feature: FeatureScriptFeatureData, spec: FsParameterSpec): FeatureScriptParameterValue {
    return feature.definition[spec.key] ?? spec.defaultValue;
}

const UNITS: Partial<Record<FsParameterSpec["kind"], UnitSpec>> = {
    length: LENGTH_UNITS,
    angle: ANGLE_UNITS,
    integer: UNITLESS,
    real: UNITLESS,
};

/** The value a parameter holds: stored by key, the spec default when absent. */
type StoredValues = (parameter: FsParameterSpec) => FeatureScriptParameterValue;

const storedIn =
    (values: Readonly<Record<string, FeatureScriptParameterValue>>): StoredValues =>
    (parameter) =>
        values[parameter.key] ?? parameter.defaultValue;

/**
 * A definition built from stored values without resolving entity picks — what the panel
 * evaluates visibility conditions against. Unresolvable numeric expressions become
 * undefined, so a condition on them simply does not hold.
 */
function previewDefinition(spec: FeatureSpec, scope: Scope, stored: StoredValues): FsMap {
    const definition = new FsMap();
    for (const parameter of spec.parameters) {
        if (parameter.kind === "query") {
            definition.set(parameter.key, query("NOTHING"));
            continue;
        }
        const value = convertValue(parameter, stored(parameter), scope);
        if (value.isOk) definition.set(parameter.key, value.value);
    }
    return definition;
}

/**
 * The definition a custom table runs on, from values stored by key (the spec's default
 * for a missing key). Query parameters have no picks here and pass an empty query; a
 * hidden parameter's bad value is skipped, a visible one's is the error.
 */
export function plainDefinition(
    spec: FeatureSpec,
    values: Readonly<Record<string, FeatureScriptParameterValue>>,
    scope: Scope,
): Result<FsMap> {
    const stored = storedIn(values);
    const preview = previewDefinition(spec, scope, stored);
    const definition = new FsMap();
    for (const parameter of spec.parameters) {
        if (parameter.kind === "query") {
            definition.set(parameter.key, query("NOTHING"));
            continue;
        }
        const value = convertValue(parameter, stored(parameter), scope);
        if (!value.isOk) {
            if (!isParameterVisible(spec, parameter, preview)) continue;
            return Result.err(value.error);
        }
        definition.set(parameter.key, value.value);
    }
    return Result.ok(definition);
}

/**
 * The parameters a panel shows for values stored by key: the visible ones, as feature
 * panel rows (query parameters are left out — a table has no entity picks).
 */
export function plainParameterRows(
    spec: FeatureSpec,
    values: Readonly<Record<string, FeatureScriptParameterValue>>,
    scope: Scope,
): FeatureParameter[] {
    const stored = storedIn(values);
    const preview = previewDefinition(spec, scope, stored);
    return spec.parameters
        .filter((parameter) => parameter.kind !== "query" && isParameterVisible(spec, parameter, preview))
        .map((parameter) => toFeatureParameter(stored(parameter), parameter, scope));
}

/** One stored (non-query) value as the FeatureScript value the feature receives. */
function convertValue(
    parameter: FsParameterSpec,
    value: FeatureScriptParameterValue,
    scope: Scope,
): Result<FsValue> {
    // A configured value (`configure(Size, "S": …, "L": …)`) picks its active arm first; the
    // numeric kinds get the same through `resolveUnitSpec`.
    if (parameter.kind === "boolean" || parameter.kind === "string" || parameter.kind === "enum") {
        if (isConfiguredValue(value)) {
            const selected = selectConfiguredArm(value, scope);
            if (!selected.isOk) return Result.err(`${parameter.label}: ${selected.error}`);
            value = selected.value;
        }
    }
    switch (parameter.kind) {
        case "boolean":
            return Result.ok(value === true || value === "true");
        case "string":
            return Result.ok(typeof value === "string" ? value : String(value));
        case "enum": {
            const member =
                parameter.enumType?.member(String(value)) ??
                parameter.enumType?.member(String(parameter.defaultValue));
            return member === undefined
                ? Result.err(`${parameter.label}: unknown option "${String(value)}"`)
                : Result.ok(member);
        }
        case "query":
            return Result.ok(query("NOTHING"));
        default: {
            if (typeof value !== "number" && typeof value !== "string")
                return Result.err(`${parameter.label} needs a number`);
            const resolved = resolveUnitSpec(
                value as ParameterValue,
                scope,
                UNITS[parameter.kind] ?? UNITLESS,
            );
            if (!resolved.isOk) return Result.err(`${parameter.label}: ${resolved.error}`);
            const number = resolved.value;
            if (parameter.kind === "integer" && !Number.isInteger(Math.round(number * 1e9) / 1e9)) {
                return Result.err(`${parameter.label} must be a whole number`);
            }
            const tolerance = 1e-9 * Math.max(1, Math.abs(number));
            if (parameter.min !== undefined && number < parameter.min - tolerance) {
                return Result.err(`${parameter.label} must be at least ${parameter.min}`);
            }
            if (parameter.max !== undefined && number > parameter.max + tolerance) {
                return Result.err(`${parameter.label} must be at most ${parameter.max}`);
            }
            if (parameter.kind === "length") return Result.ok(new FsQuantity(number / MM_PER_METER, LENGTH));
            if (parameter.kind === "angle") return Result.ok(new FsQuantity((number * Math.PI) / 180, ANGLE));
            return Result.ok(parameter.kind === "integer" ? Math.round(number) : number);
        }
    }
}

/**
 * The document's variables as FeatureScript values, for `getVariable`. List and checkbox
 * configuration inputs are left out — Onshape hands FeatureScript only the configuration
 * VARIABLES; a list or checkbox reaches a feature through the parameters it configures.
 */
export function documentVariables(scope: Scope): Map<string, FsValue> {
    const variables = new Map<string, FsValue>();
    for (const [name, { value, unit, option }] of scope) {
        if (option !== undefined) continue;
        if (unit.length === 1 && unit.angle === 0)
            variables.set(name, new FsQuantity(value / MM_PER_METER, LENGTH));
        else if (unit.angle === 1 && unit.length === 0)
            variables.set(name, new FsQuantity((value * Math.PI) / 180, ANGLE));
        else variables.set(name, value);
    }
    return variables;
}

/** The names among `documentVariables` that are configuration variables (`getAllVariables`' flag). */
export function configurationVariableNames(scope: Scope): Set<string> {
    const names = new Set<string>();
    for (const [name, entry] of scope) {
        if (entry.configuration === true && entry.option === undefined) names.add(name);
    }
    return names;
}

// ------------------------------------------------------------------ Entity picks

interface PickResolution {
    readonly refs: EntityRef[];
    readonly edgeAnchors?: EdgeRef[];
}

/**
 * Re-matches one query parameter's picks on the host input: edges through the tracked
 * ids (`matchEdgesAnchored`) with fingerprint fallback, faces by tracked id then
 * fingerprint, vertices by position, parts by volume and centre. Indexes address the
 * whole input; `FsContext.hostEntity` maps them onto the host part holding the entity.
 * Planes resolve on the document's reference plane nodes.
 */
function resolvePicks(
    value: FeatureScriptQueryValue,
    fsContext: FsContext,
    context: FeatureContext,
    label: string,
): Result<PickResolution> {
    const refs: EntityRef[] = [];
    const edges = value.edges ?? [];
    const faces = value.faces ?? [];
    const vertices = value.vertices ?? [];
    const bodies = value.bodies ?? [];
    for (const plane of value.planes ?? []) {
        refs.push(planeEntity(fsContext, currentPlane(context.document, plane)));
    }
    if (edges.length + faces.length + vertices.length + bodies.length === 0) return Result.ok({ refs });
    const input = context.input;
    const hosts = fsContext.hostBodies();
    if (hosts.length === 0 || input === undefined)
        return Result.err(`${label}: there is no preceding geometry to pick from`);
    const tracking = context.tracking;
    const hostRef = (kind: "FACE" | "EDGE", index: number) => {
        const ref = fsContext.hostEntity(kind, index);
        if (ref !== undefined) refs.push(ref);
        return ref !== undefined;
    };

    let edgeAnchors: EdgeRef[] | undefined;
    if (edges.length > 0) {
        let indexes: number[];
        if (tracking !== undefined) {
            const matched = matchEdgesAnchored(input, edges, tracking.inputEdgeIds);
            if (!matched.isOk) return Result.err(`${label}: ${matched.error}`);
            edgeAnchors = matched.value.anchors;
            indexes = matched.value.indexes;
        } else {
            const matched = matchEdgeIndexes(input, edges);
            if (!matched.isOk) return Result.err(`${label}: ${matched.error}`);
            indexes = matched.value;
        }
        for (const index of indexes) {
            if (!hostRef("EDGE", index)) return Result.err(`${label}: a picked edge no longer exists`);
        }
    }
    if (faces.length > 0) {
        const inputFaces = fsContext.track(input.findSubShapes(ShapeTypes.face)) as IFace[];
        for (const face of faces) {
            const index = matchFace(inputFaces, face, tracking?.inputFaceIds);
            if (index === undefined || !hostRef("FACE", index))
                return Result.err(`${label}: a picked face no longer exists`);
        }
    }
    for (const vertex of vertices) {
        const target = new XYZ(vertex.point);
        const ref = hosts.flatMap((body) => {
            const index = body
                .vertices()
                .findIndex((candidate) => candidate.point().distanceTo(target) < 1e-4);
            return index < 0 ? [] : [{ body, kind: "VERTEX" as const, index }];
        })[0];
        if (ref === undefined) return Result.err(`${label}: a picked vertex no longer exists`);
        refs.push(ref);
    }
    for (const body of bodies) {
        const match = matchBody(hosts, body);
        if (match === undefined) return Result.err(`${label}: a picked part no longer exists`);
        refs.push({ body: match, kind: "BODY", index: 0 });
    }
    return Result.ok({ refs, edgeAnchors });
}

/** The fingerprint a part is re-found by. */
export function captureFeatureScriptBodyRef(shape: IShape): FeatureScriptBodyRef {
    const box = shape.boundingBox();
    return {
        center: {
            x: (box.min.x + box.max.x) / 2,
            y: (box.min.y + box.max.y) / 2,
            z: (box.min.z + box.max.z) / 2,
        },
        volume: shape.volume(),
    };
}

/** The host part nearest the fingerprint — refused when two parts are equally near. */
function matchBody(hosts: readonly FsBody[], ref: FeatureScriptBodyRef): FsBody | undefined {
    const size = Math.cbrt(Math.max(Math.abs(ref.volume), 1e-9));
    const ranked = hosts
        .map((body) => {
            try {
                const print = captureFeatureScriptBodyRef(body.shape);
                const score =
                    new XYZ(print.center).distanceTo(new XYZ(ref.center)) +
                    Math.abs(print.volume - ref.volume) / (size * size);
                return { body, score };
            } catch {
                return { body, score: Number.POSITIVE_INFINITY };
            }
        })
        .filter((entry) => Number.isFinite(entry.score))
        .sort((a, b) => a.score - b.score);
    const best = ranked[0];
    if (best === undefined) return undefined;
    if (ranked[1] !== undefined && ranked[1].score - best.score < 1e-6 * size) return undefined;
    return best.body;
}

/** The plane a ref names now: its node's current plane, the stored snapshot once the node is gone. */
function currentPlane(document: IDocument, ref: FeatureScriptPlaneRef): Plane {
    const node = document.modelManager.findNode((candidate) => candidate.id === ref.nodeId);
    if (node instanceof ReferencePlaneNode) return node.plane;
    return new Plane({ origin: new XYZ(ref.origin), normal: new XYZ(ref.normal), xvec: new XYZ(ref.xvec) });
}

export function captureFeatureScriptPlaneRef(node: ReferencePlaneNode): FeatureScriptPlaneRef {
    const plane = node.plane;
    const xyz = (value: XYZ) => ({ x: value.x, y: value.y, z: value.z });
    return { nodeId: node.id, origin: xyz(plane.origin), normal: xyz(plane.normal), xvec: xyz(plane.xvec) };
}

/**
 * A plane as a context entity. A plane through the origin along a principal direction is
 * one of Onshape's default planes (Top, Front, Right) — the same entity std features see in
 * Onshape, with Onshape's orientation (Front's normal is −Y); any other plane is added as a
 * construction plane.
 */
function planeEntity(fsContext: FsContext, plane: Plane): EntityRef {
    const normal: Vec3 = [plane.normal.x, plane.normal.y, plane.normal.z];
    if (plane.origin.length() < 1e-9) {
        const datum = fsContext.bodies.find((body) => {
            const data = body.flags.plane;
            if (!body.flags.defaultGeometry || data === undefined) return false;
            const dot = data.normal[0] * normal[0] + data.normal[1] * normal[1] + data.normal[2] * normal[2];
            return Math.abs(Math.abs(dot) - 1) < 1e-9;
        });
        if (datum !== undefined) return { body: datum, kind: "FACE", index: 0 };
    }
    const data = makePlaneData(
        [plane.origin.x / MM_PER_METER, plane.origin.y / MM_PER_METER, plane.origin.z / MM_PER_METER],
        normal,
        [plane.xvec.x, plane.xvec.y, plane.xvec.z],
    );
    const face = shapeFactory.rect(toKernelPlane(data, -50, -50), 100, 100);
    if (!face.isOk) throw new Error(`A picked plane could not be built: ${face.error}`);
    const body = fsContext.addBody(face.value, `_plane${fsContext.bodies.length}`, {
        construction: true,
        plane: data,
        defaultGeometry: true,
    });
    return { body, kind: "FACE", index: 0 };
}

/** Tracked id first (best fingerprint among the id's pieces), then the nearest fingerprint. */
function matchFace(
    faces: readonly IFace[],
    ref: FeatureScriptFaceRef,
    ids: readonly string[] | undefined,
): number | undefined {
    const scores = (indexes: number[]) =>
        indexes
            .map((index) => ({ index, score: faceScore(faces[index], ref) }))
            .filter((entry) => Number.isFinite(entry.score))
            .sort((a, b) => a.score - b.score);
    if (ref.faceId !== undefined && ids !== undefined) {
        const byId = ids.flatMap((id, index) => (id === ref.faceId ? [index] : []));
        const best = scores(byId)[0];
        if (best !== undefined) return best.index;
    }
    const ranked = scores(faces.map((_, index) => index));
    const best = ranked[0];
    if (best === undefined) return undefined;
    const size = Math.sqrt(Math.max(ref.area, 1e-9));
    // An edit may move the face; accept the nearest one only while it is clearly nearest.
    if (best.score > size && ranked[1] !== undefined && ranked[1].score - best.score < 1e-6) return undefined;
    return best.index;
}

function faceScore(face: IFace, ref: FeatureScriptFaceRef): number {
    try {
        const fingerprint = captureFaceFingerprint(face);
        if ((fingerprint.normal === undefined) !== (ref.normal === undefined))
            return Number.POSITIVE_INFINITY;
        if (fingerprint.normal !== undefined && ref.normal !== undefined) {
            const a = new XYZ(fingerprint.normal);
            const b = new XYZ(ref.normal);
            if (!a.isParallelTo(b)) return Number.POSITIVE_INFINITY;
        }
        const center = new XYZ(fingerprint.center).distanceTo(new XYZ(ref.center));
        const size = Math.sqrt(Math.max(fingerprint.area, ref.area, 1e-9));
        return center + Math.abs(fingerprint.area - ref.area) / size;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

export function captureFeatureScriptFaceRef(face: IFace, faceId: string | undefined): FeatureScriptFaceRef {
    const fingerprint = captureFaceFingerprint(face);
    return { faceId, center: fingerprint.center, area: fingerprint.area, normal: fingerprint.normal };
}

// ------------------------------------------------------------------ Evaluation

function evaluateFeatureScript(feature: FeatureScriptFeatureData, context: FeatureContext): Result<IShape> {
    const resolved = resolveSpec(context.document, feature);
    if (!resolved.isOk) return Result.err(resolved.error);
    const { compiled, exported, spec } = resolved.value;
    const interpreter = compiled.interpreter;
    interpreter.resetBudget();
    const tracking = context.tracking;
    const edgeAnchors: EdgeRef[] = [];
    let anchorsComplete = true;

    let run: ReturnType<typeof runFeature>;
    try {
        run = runFeature({
            interpreter,
            feature: exported,
            input: context.input,
            instanceId: instanceIdOf(feature),
            variables: documentVariables(context.scope),
            configurationVariables: configurationVariableNames(context.scope),
            dataTables: (reference) => findDataTable(context.document, reference),
            definition: (fsContext) =>
                buildDefinition(
                    feature,
                    spec,
                    context,
                    fsContext,
                    edgeAnchors,
                    () => (anchorsComplete = false),
                ),
        });
    } catch (error) {
        return Result.err(describeError(error).error);
    }
    try {
        const bodies = run.bodies;
        if (bodies.length === 0) return Result.err(`"${spec.displayName}" produced no geometry`);
        const shape = outputShape(bodies, context.input);
        if (!shape.isOk) return shape;
        if (tracking !== undefined) {
            assignTrackedIds(feature, bodies, shape.value, tracking);
            if (anchorsComplete && edgeAnchors.length > 0) tracking.resolvedEdges = edgeAnchors;
        }
        if (run.warnings.length > 0 && tracking !== undefined) tracking.warning = run.warnings.join("\n");
        run.context.dispose([shape.value, ...bodies.map((body) => body.shape)]);
        return shape;
    } catch (error) {
        run.context.dispose();
        return Result.err(describeError(error).error);
    }
}

/** A FeatureScript-safe Id component for this feature instance. */
function instanceIdOf(feature: FeatureScriptFeatureData): string {
    return `F${feature.id.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function buildDefinition(
    feature: FeatureScriptFeatureData,
    spec: FeatureSpec,
    context: FeatureContext,
    fsContext: FsContext,
    edgeAnchors: EdgeRef[],
    anchorsIncomplete: () => void,
): FsMap {
    const definition = new FsMap();
    // Query parameters resolve in stored-key order — the order `applyResolvedRefs`
    // slices the flat edge-anchor list back by.
    for (const [key, value] of Object.entries(feature.definition)) {
        const parameter = spec.parameters.find((p) => p.key === key);
        if (parameter?.kind !== "query" || !isQueryValue(value)) continue;
        const picks = resolvePicks(value, fsContext, context, parameter.label);
        if (!picks.isOk) throw new Error(picks.error);
        definition.set(
            key,
            picks.value.refs.length === 0
                ? query("NOTHING")
                : query("UNION", { subqueries: new FsArray(picks.value.refs.map(transientQuery)) }),
        );
        if (picks.value.edgeAnchors !== undefined) edgeAnchors.push(...picks.value.edgeAnchors);
        else if ((value.edges?.length ?? 0) > 0) anchorsIncomplete();
    }
    const preview = previewDefinition(spec, context.scope, (parameter) => storedValue(feature, parameter));
    for (const parameter of spec.parameters) {
        if (parameter.kind === "query") {
            if (!definition.has(parameter.key)) definition.set(parameter.key, query("NOTHING"));
            continue;
        }
        const value = convertValue(parameter, storedValue(feature, parameter), context.scope);
        if (!value.isOk) {
            // A hidden parameter's bad value cannot block the feature: it is not in play.
            if (!isParameterVisible(spec, parameter, preview)) continue;
            throw new Error(value.error);
        }
        definition.set(parameter.key, value.value);
    }
    return definition;
}

function outputShape(bodies: readonly FsBody[], input: IShape | undefined): Result<IShape> {
    if (bodies.length === 1) {
        const shape = bodies[0].shape;
        // The chain must never see the same shape object twice (the body's cache would
        // dispose it under the other entry): an untouched input is re-wrapped.
        return Result.ok(shape === input ? shape.transformedMul(Matrix4.identity()) : shape);
    }
    return shapeFactory.combine(bodies.map((body) => body.shape));
}

/**
 * Stable ids for the output: an entity derived from the host input keeps the input's id;
 * anything else is scoped to this feature, the operation that created it (minus the
 * instance prefix) and its occurrence among that operation's entities.
 */
function assignTrackedIds(
    feature: FeatureScriptFeatureData,
    bodies: readonly FsBody[],
    shape: IShape,
    tracking: ShapeTracking,
): void {
    const prefix = `${instanceIdOf(feature)}/`;
    const counters = new Map<string, number>();
    const scoped = (createdBy: string, cap: string | undefined, kind: string) => {
        const origin = createdBy.startsWith(prefix) ? createdBy.slice(prefix.length) : createdBy;
        const base = `${feature.id}:${kind}:${origin}${cap === undefined ? "" : `:${cap}`}`;
        const n = counters.get(base) ?? 0;
        counters.set(base, n + 1);
        return `${base}:${n}`;
    };
    const faceIds: string[] = [];
    const edgeIds: string[] = [];
    for (const body of bodies) {
        for (const attr of body.faceAttrs) {
            faceIds.push(
                attr.hostIndex !== undefined && attr.hostIndex < tracking.inputFaceIds.length
                    ? tracking.inputFaceIds[attr.hostIndex]
                    : scoped(attr.createdBy, attr.cap, "f"),
            );
        }
        for (const attr of body.edgeAttrs) {
            edgeIds.push(
                attr.hostIndex !== undefined && attr.hostIndex < tracking.inputEdgeIds.length
                    ? tracking.inputEdgeIds[attr.hostIndex]
                    : scoped(attr.createdBy, undefined, "e"),
            );
        }
    }
    // Ids only make sense when they line up with the output's own enumeration.
    const faceCount = shape.findSubShapes(ShapeTypes.face).length;
    const edgeCount = shape.findSubShapes(ShapeTypes.edge).length;
    if (faceCount === faceIds.length) tracking.outputFaceIds = faceIds;
    if (edgeCount === edgeIds.length) tracking.outputEdgeIds = edgeIds;
}

// ------------------------------------------------------------------ Handler

const featureScriptHandler: FeatureHandler<FeatureScriptFeatureData> = {
    display: "featurescript.feature",
    icon: (feature) => feature.toolIcon ?? "icon-macro",

    nodeIds: (feature) => [
        feature.studioId,
        ...studioDependencies(feature.studioId),
        ...Object.values(feature.definition).flatMap((value) =>
            isQueryValue(value) ? (value.planes ?? []).map((plane) => plane.nodeId) : [],
        ),
    ],

    references: (feature) =>
        feature.toolIcon !== undefined
            ? []
            : [{ key: "studio", display: "featurescript.studio", nodeId: feature.studioId }],

    cacheToken: (feature, document) => studioToken(document, feature.studioId),

    parameters(feature, document): FeatureParameter[] {
        if (document === undefined) return [];
        const resolved = resolveSpec(document, feature);
        if (!resolved.isOk) return [];
        const { spec } = resolved.value;
        const scope = document.variables.evaluate().scope;
        const preview = previewDefinition(spec, scope, (parameter) => storedValue(feature, parameter));
        return spec.parameters
            .filter((parameter) => !hasHint(parameter, "ALWAYS_HIDDEN"))
            .filter((parameter) => isParameterVisible(spec, parameter, preview))
            .map((parameter) => toFeatureParameter(storedValue(feature, parameter), parameter, scope));
    },

    setParameter(feature, key, value, document) {
        const parameter =
            document === undefined
                ? undefined
                : specOf(document, feature)?.parameters.find((p) => p.key === key);
        let stored: FeatureScriptParameterValue = value;
        if (parameter?.kind === "string" || parameter?.kind === "enum") stored = String(value);
        // A configured checkbox keeps its `configure(…)`; the rebuild selects the arm.
        if (parameter?.kind === "boolean") {
            stored = isConfiguredValue(value) ? value : value === true || String(value) === "true";
        }
        return { ...feature, definition: { ...feature.definition, [key]: stored } };
    },

    applyResolvedRefs(feature, { resolvedEdges }) {
        if (resolvedEdges === undefined) return feature;
        let offset = 0;
        const definition: Record<string, FeatureScriptParameterValue> = { ...feature.definition };
        for (const [key, value] of Object.entries(feature.definition)) {
            if (!isQueryValue(value)) continue;
            const count = value.edges?.length ?? 0;
            if (count === 0) continue;
            const slice = resolvedEdges.slice(offset, offset + count);
            offset += count;
            if (slice.length === count) definition[key] = { ...value, edges: slice };
        }
        return offset === resolvedEdges.length ? { ...feature, definition } : feature;
    },

    evaluate: evaluateFeatureScript,
};

function hasHint(parameter: FsParameterSpec, ...hints: string[]): boolean {
    return parameter.uiHints?.some((hint) => hints.includes(hint)) ?? false;
}

function specOf(document: IDocument, feature: FeatureScriptFeatureData): FeatureSpec | undefined {
    const resolved = resolveSpec(document, feature);
    return resolved.isOk ? resolved.value.spec : undefined;
}

/**
 * A checkbox, dropdown or text slot's configured value: the stored `configure(…)` and what the
 * active configuration selects from it (the stored text itself when nothing can be selected —
 * the rebuild reports why).
 */
function configuredDisplay(
    value: FeatureScriptParameterValue,
    scope: Scope,
): { readonly configured: string; readonly selected: ParameterValue } | undefined {
    if (!isConfiguredValue(value)) return undefined;
    const selected = selectConfiguredArm(value, scope);
    return { configured: value, selected: selected.isOk ? selected.value : value };
}

function toFeatureParameter(
    value: FeatureScriptParameterValue,
    parameter: FsParameterSpec,
    scope: Scope,
): FeatureParameter {
    const base = { key: parameter.key, display: "featurescript.parameter" as const, label: parameter.label };
    const configured = configuredDisplay(value, scope);
    const shown = configured === undefined ? value : configured.selected;
    const flags = {
        configurable: true,
        ...(configured === undefined ? {} : { configured: configured.configured }),
    };
    switch (parameter.kind) {
        case "boolean":
            return {
                ...base,
                ...flags,
                value: shown === true || shown === "true",
                ...(hasHint(parameter, "OPPOSITE_DIRECTION", "OPPOSITE_DIRECTION_CIRCULAR")
                    ? { flip: true }
                    : {}),
            };
        case "enum":
            return {
                ...base,
                ...flags,
                value: String(shown),
                options: parameter.options ?? [],
                ...(hasHint(parameter, "HORIZONTAL_ENUM") ? { optionStyle: "tabs" as const } : {}),
            };
        case "string":
            return { ...base, ...flags, value: String(shown), text: true };
        case "query":
            return {
                ...base,
                value: querySummary(value),
                pick: {
                    kinds: (parameter.filter ?? ["EDGE", "FACE"]).map(
                        (kind) => kind.toLowerCase() as FeaturePickKind,
                    ),
                },
            };
        default:
            return {
                ...base,
                value: typeof value === "number" || typeof value === "string" ? value : String(value),
                unit: UNITS[parameter.kind],
            };
    }
}

/** The spec of a feature for callers outside the handler (commands, the program engine). */
export function featureScriptSpec(
    document: IDocument,
    feature: FeatureScriptFeatureData,
): Result<FeatureSpec> {
    const resolved = resolveSpec(document, feature);
    return resolved.isOk ? Result.ok(resolved.value.spec) : Result.err(resolved.error);
}

registerFeature(FEATURESCRIPT_TYPE, featureScriptHandler);
