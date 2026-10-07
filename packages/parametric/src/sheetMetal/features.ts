// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    type FeatureParameter,
    I18n,
    type I18nKeys,
    type IEdge,
    type IShape,
    LENGTH_UNITS,
    Matrix4,
    type ParameterValue,
    Plane,
    Result,
    resolveUnitSpec,
    type Scope,
    ShapeNode,
    ShapeTypes,
    UNITLESS,
    XYZ,
} from "@chili3d/core";
import { matchEdgeIndexes } from "../features/edgeMatcher";
import { captureEdgeRef, type EdgeRef } from "../features/edgeRef";
import { findSketch } from "../features/extrude";
import {
    completeTrackedHistory,
    type FeatureContext,
    type FeatureHandler,
    registerFeature,
    type SheetLineRef,
    type SheetMetalBaseFeatureData,
    type SheetMetalBeadFeatureData,
    type SheetMetalBendFeatureData,
    type SheetMetalCrimpFeatureData,
    type SheetMetalEdgeFeatureData,
    type SheetMetalFeatureData,
    type SheetMetalFlattenFeatureData,
    type SheetMetalRollFeatureData,
    trackedIds,
} from "../features/feature";
import { resolveProfiles } from "../features/profileBuilder";
import { loopsOfFace, straightEdges } from "./blank";
import { buildSheetMetal } from "./build";
import { Arena, PlaneFrame, SheetError, type Vec3, v3, vec } from "./frame";
import { layoutOf, mapPoint } from "./layout";
import { registerSheetModel, type SheetFlange, type SheetMetalModel, sheetModelOf, type V2 } from "./model";
import { DEFAULTS, treatmentElements } from "./treatments";

/**
 * Sheet metal features. A part starts with `smBase` (a sketch profile becomes the flat
 * blank); every later sheet metal feature reads the model its input carries
 * (`sheetModelOf`), adds to it, and rebuilds the whole part from the flat description —
 * so bends, edge treatments and rolls compose, and Flatten is exact. A non-sheet-metal
 * feature in between ends the sheet metal chain.
 */

const SHEET_METAL_TYPES = new Set(["smBase", "smBend", "smEdge", "smRoll", "smCrimp", "smBead", "smFlatten"]);

export function isSheetMetalFeature(type: string): boolean {
    return SHEET_METAL_TYPES.has(type);
}

// ------------------------------------------------------------------ Shared plumbing

function length(value: ParameterValue | undefined, scope: Scope, fallback: number, label: string): number {
    if (value === undefined || value === "") return fallback;
    const resolved = resolveUnitSpec(value, scope, LENGTH_UNITS);
    if (!resolved.isOk) throw new SheetError(`${label}: ${resolved.error}`);
    return resolved.value;
}

function angle(value: ParameterValue | undefined, scope: Scope, fallback: number, label: string): number {
    if (value === undefined || value === "") return fallback;
    const resolved = resolveUnitSpec(value, scope, ANGLE_UNITS);
    if (!resolved.isOk) throw new SheetError(`${label}: ${resolved.error}`);
    return resolved.value;
}

function number(value: ParameterValue | undefined, scope: Scope, fallback: number, label: string): number {
    if (value === undefined || value === "") return fallback;
    const resolved = resolveUnitSpec(value, scope, UNITLESS);
    if (!resolved.isOk) throw new SheetError(`${label}: ${resolved.error}`);
    return resolved.value;
}

function positive(value: number, label: string): number {
    if (!(value > 0)) throw new SheetError(`${label} must be positive`);
    return value;
}

/** The model the input carries; sheet metal features after Flatten (or with no part) fail. */
function inputModel(context: FeatureContext): SheetMetalModel {
    const model = sheetModelOf(context.input);
    if (model === undefined) {
        throw new SheetError(
            "Sheet metal features need a sheet metal part before them (start with Sheet Metal)",
        );
    }
    if (model.flat) throw new SheetError("Sheet metal features must come before Flatten");
    return model;
}

/**
 * Builds the model, registers it on the output, and fills stable ids by geometric
 * identity with the input (sheet metal rebuilds report no kernel history).
 */
function output(
    feature: SheetMetalFeatureData,
    context: FeatureContext,
    model: SheetMetalModel,
): Result<IShape> {
    const built = buildSheetMetal(model);
    if (!built.isOk) return built;
    const shape = registerSheetModel(built.value, model);
    const tracking = context.tracking;
    if (tracking !== undefined) {
        const faces = shape.findSubShapes(ShapeTypes.face);
        const edges = shape.findSubShapes(ShapeTypes.edge);
        const history = {
            shape,
            faceMap: faces.map(() => -1),
            edgeMap: edges.map(() => -1),
        };
        for (const sub of [...faces, ...edges]) sub.dispose();
        const completed = completeTrackedHistory(context.input === undefined ? [] : [context.input], history);
        tracking.outputFaceIds = trackedIds(feature.id, tracking.inputFaceIds, completed.faceMap);
        tracking.outputEdgeIds = trackedIds(feature.id, tracking.inputEdgeIds, completed.edgeMap);
        for (const sub of [...completed.outputFaces, ...completed.outputEdges]) sub.dispose();
    }
    return Result.ok(shape);
}

function guard(run: () => Result<IShape>): Result<IShape> {
    try {
        return run();
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

const sign = (direction: string): 1 | -1 => (direction === "down" || direction === "in" ? -1 : 1);

function option(value: string, label: I18nKeys) {
    return { value, label: I18n.translate(label) ?? value };
}

const DIRECTION_OPTIONS = () => [option("up", "sheetMetal.up"), option("down", "sheetMetal.down")];

function lengthParameter(
    key: string,
    display: I18nKeys,
    value: ParameterValue | undefined,
    fallback: number,
): FeatureParameter {
    return { key, display, value: value ?? round(fallback), unit: LENGTH_UNITS };
}

const round = (value: number) => Math.round(value * 1e4) / 1e4;

/** Parameter edits: enums and expressions stored as given, numbers as numbers. */
function setValue<F>(feature: F, key: string, value: ParameterValue | boolean): F {
    return { ...feature, [key]: typeof value === "boolean" ? String(value) : value };
}

/** Body-local 2D line in the blank plane from a sketch line reference. */
function resolveLine(context: FeatureContext, ref: SheetLineRef, frame: PlaneFrame): [V2, V2] {
    let start: Vec3 = [ref.start.x, ref.start.y, ref.start.z];
    let end: Vec3 = [ref.end.x, ref.end.y, ref.end.z];
    const node = context.document.modelManager.findNode((n) => n.id === ref.nodeId);
    if (node instanceof ShapeNode && node.shape.isOk) {
        const edges = node.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        try {
            const matched = matchEdgeIndexes(node.shape.value, [ref.edge]);
            if (matched.isOk) {
                const edge = edges[matched.value[0]];
                const world = node.worldTransform();
                start = v3(world.ofPoint(edge.startPoint()));
                end = v3(world.ofPoint(edge.endPoint()));
            }
        } finally {
            for (const edge of edges) edge.dispose();
        }
    }
    const local = context.host.worldTransform().invert() ?? Matrix4.identity();
    const a = frame.local(v3(local.ofPoint(new XYZ(start[0], start[1], start[2]))));
    const b = frame.local(v3(local.ofPoint(new XYZ(end[0], end[1], end[2]))));
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6)
        throw new SheetError("A sheet metal line has zero length in the sheet's plane");
    return [a, b];
}

/** Captures a sketch line (world space) as a `SheetLineRef`. */
export function captureSheetLine(nodeId: string, edge: IEdge, world: Matrix4): SheetLineRef {
    const start = world.ofPoint(edge.startPoint());
    const end = world.ofPoint(edge.endPoint());
    return {
        nodeId,
        edge: captureEdgeRef(edge),
        start: { x: start.x, y: start.y, z: start.z },
        end: { x: end.x, y: end.y, z: end.z },
    };
}

// ------------------------------------------------------------------ Base

const baseHandler: FeatureHandler<SheetMetalBaseFeatureData> = {
    display: "command.sheetMetal.base",
    icon: "icon-thickSolid",
    nodeIds: (feature) => [feature.sketchId],
    references: (feature) => [{ key: "sketchId", display: "body.sketch", nodeId: feature.sketchId }],
    parameters: (feature) => [
        lengthParameter("thickness", "sheetMetal.thickness", feature.thickness, 1),
        lengthParameter("radius", "sheetMetal.radius", feature.radius, 1),
        { key: "kFactor", display: "sheetMetal.kFactor", value: feature.kFactor, unit: UNITLESS },
    ],
    setParameter: setValue,
    evaluate: (feature, context) =>
        guard(() => {
            if (context.input !== undefined)
                throw new SheetError("Sheet Metal must be the body's first feature");
            const sketch = findSketch(context.document, feature.sketchId);
            if (sketch === undefined) throw new SheetError("The blank's sketch was deleted");
            const profiles = resolveProfiles(sketch, feature.profiles);
            if (!profiles.isOk) throw new SheetError(profiles.error);
            if (profiles.value.length === 0)
                throw new SheetError("The sketch has no closed profile for the blank");
            const scope = context.scope;
            const thickness = positive(length(feature.thickness, scope, 1, "Thickness"), "Thickness");
            const radius = positive(length(feature.radius, scope, thickness, "Bend radius"), "Bend radius");
            const kFactor = number(feature.kFactor, scope, 0.44, "K-factor");
            if (kFactor < 0 || kFactor > 1) throw new SheetError("The K-factor must be between 0 and 1");

            const toLocal = context.host.worldTransform().invert() ?? Matrix4.identity();
            const plane = transformPlane(sketch.plane, toLocal);
            const frame = new PlaneFrame(plane);
            // The largest profile is the blank (a sketch may also hold bend lines and the like).
            const face = profiles.value.reduce((best, p) =>
                p.face.area() > best.face.area() ? p : best,
            ).face;
            const local = toLocal.equals(Matrix4.identity()) ? face : face.transformedMul(toLocal);
            try {
                const model: SheetMetalModel = {
                    plane,
                    thickness,
                    radius,
                    kFactor,
                    blank: loopsOfFace(local as typeof face, frame),
                    bends: [],
                    flanges: [],
                    crimps: [],
                    beads: [],
                    flat: false,
                };
                return output(feature, context, model);
            } finally {
                if (local !== face) local.dispose();
            }
        }),
};

function transformPlane(plane: Plane, matrix: Matrix4): Plane {
    if (matrix.equals(Matrix4.identity())) return plane;
    return new Plane({
        origin: matrix.ofPoint(plane.origin),
        normal: matrix.ofVector(plane.normal),
        xvec: matrix.ofVector(plane.xvec),
    });
}

// ------------------------------------------------------------------ Bend lines

const bendHandler: FeatureHandler<SheetMetalBendFeatureData> = {
    display: "command.sheetMetal.bend",
    icon: "icon-dAngle",
    nodeIds: (feature) => [...new Set(feature.lines.map((line) => line.nodeId))],
    parameters: (feature) => [
        { key: "angle", display: "sheetMetal.angle", value: feature.angle, unit: ANGLE_UNITS },
        {
            key: "direction",
            display: "sheetMetal.direction",
            value: feature.direction,
            options: DIRECTION_OPTIONS(),
        },
        { key: "radius", display: "sheetMetal.radius", value: feature.radius ?? "", unit: LENGTH_UNITS },
    ],
    setParameter: setValue,
    evaluate: (feature, context) =>
        guard(() => {
            const model = inputModel(context);
            if (model.roll !== undefined) throw new SheetError("A rolled sheet cannot also have bend lines");
            const frame = new PlaneFrame(model.plane);
            const bendAngle = angle(feature.angle, context.scope, 90, "Angle");
            if (bendAngle <= 0 || bendAngle >= 180)
                throw new SheetError("The bend angle must be between 0° and 180°");
            const radius = positive(
                length(feature.radius, context.scope, model.radius, "Bend radius"),
                "Bend radius",
            );
            if (feature.lines.length === 0) throw new SheetError("Pick the bend lines");
            const bends = feature.lines.map((line) => {
                const [a, b] = resolveLine(context, line, frame);
                return { a, b, angle: bendAngle * sign(feature.direction), radius };
            });
            return output(feature, context, { ...model, bends: [...model.bends, ...bends] });
        }),
};

// ------------------------------------------------------------------ Edge treatments

const EDGE_DISPLAY: Record<SheetMetalEdgeFeatureData["kind"], I18nKeys> = {
    easyEdge: "command.sheetMetal.easyEdge",
    pittsburgh: "command.sheetMetal.pittsburgh",
    hem: "command.sheetMetal.hem",
    flange: "command.sheetMetal.flange",
};

const EDGE_ICON: Record<SheetMetalEdgeFeatureData["kind"], string> = {
    easyEdge: "icon-extend",
    pittsburgh: "icon-sew",
    hem: "icon-offset",
    flange: "icon-fromSection",
};

export const EDGE_LENGTH_DEFAULT: Record<SheetMetalEdgeFeatureData["kind"], number> = {
    easyEdge: DEFAULTS.easyEdgeLength,
    pittsburgh: DEFAULTS.pocketDepth,
    hem: DEFAULTS.hemLength,
    flange: DEFAULTS.flangeLength,
};

const edgeHandler: FeatureHandler<SheetMetalEdgeFeatureData> = {
    display: (feature) => EDGE_DISPLAY[feature.kind],
    icon: (feature) => EDGE_ICON[feature.kind],
    reselectable: true,
    nodeIds: () => [],
    parameters(feature) {
        const lengthLabel: I18nKeys =
            feature.kind === "pittsburgh" ? "sheetMetal.pocketDepth" : "sheetMetal.length";
        const parameters: FeatureParameter[] = [
            lengthParameter("length", lengthLabel, feature.length, EDGE_LENGTH_DEFAULT[feature.kind]),
            {
                key: "direction",
                display: "sheetMetal.direction",
                value: feature.direction,
                options: DIRECTION_OPTIONS(),
            },
        ];
        if (feature.kind === "pittsburgh") {
            parameters.push(
                lengthParameter("height", "sheetMetal.lipHeight", feature.height, DEFAULTS.lipHeight),
            );
            parameters.push({
                key: "clearance",
                display: "sheetMetal.clearance",
                value: feature.clearance ?? "",
                unit: LENGTH_UNITS,
            });
        }
        if (feature.kind === "flange") {
            parameters.push({
                key: "angle",
                display: "sheetMetal.angle",
                value: feature.angle ?? 90,
                unit: ANGLE_UNITS,
            });
        }
        if (feature.kind !== "hem") {
            parameters.push({
                key: "radius",
                display: "sheetMetal.radius",
                value: feature.radius ?? "",
                unit: LENGTH_UNITS,
            });
        }
        return parameters;
    },
    setParameter: setValue,
    applyResolvedRefs: (feature, { resolvedEdges }) =>
        resolvedEdges === undefined ? feature : { ...feature, edges: resolvedEdges },
    evaluate: (feature, context) =>
        guard(() => {
            const model = inputModel(context);
            const scope = context.scope;
            const t = model.thickness;
            const parameters = {
                kind: feature.kind,
                direction: sign(feature.direction),
                length: positive(
                    length(feature.length, scope, EDGE_LENGTH_DEFAULT[feature.kind], "Length"),
                    "Length",
                ),
                height: length(feature.height, scope, DEFAULTS.lipHeight, "Lip height"),
                clearance: length(feature.clearance, scope, Math.max(0.25, t / 2), "Slot clearance"),
                angle: angle(feature.angle, scope, 90, "Angle"),
                radius: positive(length(feature.radius, scope, model.radius, "Bend radius"), "Bend radius"),
                thickness: t,
            };
            let elements: ReturnType<typeof treatmentElements>;
            try {
                elements = treatmentElements(parameters);
            } catch (error) {
                throw new SheetError((error as Error).message);
            }
            if (feature.edges.length === 0) throw new SheetError("Pick the edges to treat");
            const matched = matchBlankEdges(model, feature.edges);
            const flanges: SheetFlange[] = matched.map(({ a, b }) => ({
                kind: feature.kind,
                a,
                b,
                elements,
                seamDepth:
                    feature.kind === "easyEdge" || feature.kind === "pittsburgh"
                        ? parameters.length
                        : undefined,
            }));
            const next = { ...model, flanges: [...model.flanges, ...flanges] };
            if (context.tracking !== undefined) {
                context.tracking.resolvedEdges = matched.map((entry) => entry.anchor);
                const fit = seamFit(next);
                if (fit !== undefined) context.tracking.warning = fit;
            }
            return output(feature, context, next);
        }),
};

/**
 * The blank outline edges the picked refs name: each picked edge is matched to the straight
 * outline edge whose formed image (its bottom or top copy) lies nearest. The anchors are the
 * images re-captured, so the refs follow the part through upstream edits.
 */
function matchBlankEdges(
    model: SheetMetalModel,
    refs: readonly EdgeRef[],
): { a: V2; b: V2; anchor: EdgeRef }[] {
    const arena = new Arena();
    try {
        const layout = layoutOf(arena, model);
        const used = new Set(model.flanges.map((flange) => key(flange.a, flange.b)));
        const candidates = straightEdges(model.blank).flatMap((edge) => {
            if (used.has(key(edge.a, edge.b))) return [];
            const images: [Vec3, Vec3][] = [];
            for (const z of [0, model.thickness]) {
                const a = mapPoint(layout, edge.a, z);
                const b = mapPoint(layout, edge.b, z);
                if (a !== undefined && b !== undefined) images.push([a, b]);
            }
            return images.length === 0 ? [] : [{ ...edge, images }];
        });
        return refs.map((ref) => {
            if (ref.kind !== "line") throw new SheetError("Pick straight outline edges of the sheet");
            const start: Vec3 = [ref.start.x, ref.start.y, ref.start.z];
            const end: Vec3 = [ref.end.x, ref.end.y, ref.end.z];
            let best: { a: V2; b: V2; score: number; image: [Vec3, Vec3] } | undefined;
            for (const candidate of candidates) {
                for (const image of candidate.images) {
                    const score = segmentDistance(start, end, image[0], image[1]);
                    if (best === undefined || score < best.score)
                        best = { a: candidate.a, b: candidate.b, score, image };
                }
            }
            const size = vec.norm(vec.sub(end, start));
            if (best === undefined || best.score > Math.max(model.thickness * 3, size * 0.25)) {
                throw new SheetError("A picked edge is not a straight outline edge of the sheet");
            }
            used.add(key(best.a, best.b));
            const [a, b] = best.image;
            return {
                a: best.a,
                b: best.b,
                anchor: {
                    kind: "line",
                    start: { x: a[0], y: a[1], z: a[2] },
                    end: { x: b[0], y: b[1], z: b[2] },
                },
            };
        });
    } finally {
        arena.dispose();
    }
}

const key = (a: V2, b: V2) => {
    const p = [a, b].map((q) => `${q[0].toFixed(5)},${q[1].toFixed(5)}`).sort();
    return p.join("|");
};

/** How far apart two segments are: endpoint distance, in either orientation, plus a direction penalty. */
function segmentDistance(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3): number {
    const forward = vec.norm(vec.sub(a0, b0)) + vec.norm(vec.sub(a1, b1));
    const backward = vec.norm(vec.sub(a0, b1)) + vec.norm(vec.sub(a1, b0));
    return Math.min(forward, backward) / 2;
}

/**
 * When a part carries both halves of a Pittsburgh lock (a one-piece wrapper), the easy edge
 * must fit the pocket: its leg no deeper than the pocket.
 */
function seamFit(model: SheetMetalModel): string | undefined {
    const pocket = model.flanges.find((flange) => flange.kind === "pittsburgh");
    const male = model.flanges.find((flange) => flange.kind === "easyEdge");
    if (pocket?.seamDepth === undefined || male?.seamDepth === undefined) return undefined;
    if (male.seamDepth > pocket.seamDepth + 1e-9) {
        return `The easy edge (${round(male.seamDepth)} mm) is deeper than the Pittsburgh pocket (${round(pocket.seamDepth)} mm)`;
    }
    return undefined;
}

// ------------------------------------------------------------------ Round duct

const rollHandler: FeatureHandler<SheetMetalRollFeatureData> = {
    display: "command.sheetMetal.roll",
    icon: "icon-cylinder",
    nodeIds: () => [],
    parameters: (feature) => [
        {
            key: "axis",
            display: "sheetMetal.axis",
            value: feature.axis,
            options: [option("u", "sheetMetal.axisX"), option("v", "sheetMetal.axisY")],
        },
        { key: "radius", display: "sheetMetal.rollRadius", value: feature.radius, unit: LENGTH_UNITS },
        {
            key: "direction",
            display: "sheetMetal.direction",
            value: feature.direction,
            options: DIRECTION_OPTIONS(),
        },
    ],
    setParameter: setValue,
    evaluate: (feature, context) =>
        guard(() => {
            const model = inputModel(context);
            if (model.roll !== undefined) throw new SheetError("The sheet is already rolled");
            const radius = length(feature.radius, context.scope, 0, "Inner radius");
            if (radius < 0) throw new SheetError("The inner radius cannot be negative");
            return output(feature, context, {
                ...model,
                roll: {
                    axis: feature.axis,
                    radius: radius > 0 ? radius : undefined,
                    direction: sign(feature.direction),
                },
            });
        }),
};

const END_OPTIONS = () => [option("start", "sheetMetal.start"), option("end", "sheetMetal.finish")];

const crimpHandler: FeatureHandler<SheetMetalCrimpFeatureData> = {
    display: "command.sheetMetal.crimp",
    icon: "icon-pipe",
    nodeIds: () => [],
    parameters: (feature) => [
        { key: "end", display: "sheetMetal.end", value: feature.end, options: END_OPTIONS() },
        lengthParameter("length", "sheetMetal.length", feature.length, 38.1),
        lengthParameter("depth", "sheetMetal.depth", feature.depth, 1.5),
        { key: "count", display: "sheetMetal.count", value: feature.count, unit: UNITLESS },
    ],
    setParameter: setValue,
    evaluate: (feature, context) =>
        guard(() => {
            const model = inputModel(context);
            if (model.roll === undefined) throw new SheetError("A crimp needs a rolled sheet (Roll first)");
            if (model.crimps.some((crimp) => crimp.end === feature.end))
                throw new SheetError("That end is already crimped");
            const scope = context.scope;
            const crimp = {
                end: feature.end,
                length: positive(length(feature.length, scope, 38.1, "Length"), "Length"),
                depth: positive(length(feature.depth, scope, 1.5, "Depth"), "Depth"),
                count: Math.round(number(feature.count, scope, 36, "Corrugations")),
            };
            return output(feature, context, { ...model, crimps: [...model.crimps, crimp] });
        }),
};

const beadHandler: FeatureHandler<SheetMetalBeadFeatureData> = {
    display: "command.sheetMetal.bead",
    icon: "icon-arc3point",
    nodeIds: (feature) => (feature.line === undefined ? [] : [feature.line.nodeId]),
    parameters(feature) {
        const parameters: FeatureParameter[] = [
            lengthParameter("width", "sheetMetal.width", feature.width, 8),
            lengthParameter("height", "sheetMetal.height", feature.height, 3),
            {
                key: "direction",
                display: "sheetMetal.direction",
                value: feature.direction,
                options: [option("out", "sheetMetal.out"), option("in", "sheetMetal.in")],
            },
        ];
        if (feature.line === undefined) {
            parameters.push(lengthParameter("offset", "sheetMetal.offset", feature.offset, 50));
            parameters.push({
                key: "from",
                display: "sheetMetal.end",
                value: feature.from ?? "end",
                options: END_OPTIONS(),
            });
        }
        return parameters;
    },
    setParameter: setValue,
    evaluate: (feature, context) =>
        guard(() => {
            const model = inputModel(context);
            const scope = context.scope;
            const width = positive(length(feature.width, scope, 8, "Width"), "Width");
            const height = positive(length(feature.height, scope, 3, "Height"), "Height");
            const direction = sign(feature.direction);
            if (feature.line !== undefined) {
                if (model.roll !== undefined)
                    throw new SheetError("Line beads go on a flat sheet, before rolling");
                const [a, b] = resolveLine(context, feature.line, new PlaneFrame(model.plane));
                return output(feature, context, {
                    ...model,
                    beads: [...model.beads, { kind: "line", a, b, width, height, direction }],
                });
            }
            if (model.roll === undefined)
                throw new SheetError("A ring bead needs a rolled sheet; pick a line for a flat bead");
            const offset = length(feature.offset, scope, 50, "Offset");
            return output(feature, context, {
                ...model,
                beads: [
                    ...model.beads,
                    { kind: "ring", offset, from: feature.from ?? "end", width, height, direction },
                ],
            });
        }),
};

const flattenHandler: FeatureHandler<SheetMetalFlattenFeatureData> = {
    display: "command.sheetMetal.flatten",
    icon: "icon-toFace",
    nodeIds: () => [],
    parameters: () => [],
    setParameter: (feature) => feature,
    evaluate: (feature, context) =>
        guard(() => output(feature, context, { ...inputModel(context), flat: true })),
};

registerFeature("smBase", baseHandler);
registerFeature("smBend", bendHandler);
registerFeature("smEdge", edgeHandler);
registerFeature("smRoll", rollHandler);
registerFeature("smCrimp", crimpHandler);
registerFeature("smBead", beadHandler);
registerFeature("smFlatten", flattenHandler);
