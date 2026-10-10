// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IEdge,
    type IFace,
    type IShape,
    type IVertex,
    type IWire,
    Line,
    Matrix4,
    Plane,
    type Result,
    ShapeTypes,
    type TrackedShape,
    XYZ,
} from "@chili3d/core";
import {
    ANGLE,
    expectArray,
    expectMap,
    expectNumber,
    expectQuantity,
    FsArray,
    FsMap,
    type FsValue,
    fail,
    LENGTH,
    toDisplayString,
} from "../lang/values";
import { idString } from "../std/feature";
import {
    type AffineData,
    applyAffine,
    applyLinear,
    composeAffine,
    type LineData,
    makeTransform,
    mirrorAffine,
    readDirection,
    readLine,
    readPlane,
    readPoint,
    readTransform,
    rotationAffine,
    type Vec3,
    vec,
} from "../std/geometry";
import { arg, enumName, optionalEnum, type StdBuilder } from "../std/registry";
import {
    type EntityRef,
    type FsBody,
    FsContext,
    historySource,
    MM_PER_METER,
    toKernelPlane,
} from "./fsContext";
import { profileHistory, recordBlends, recordCopy, recordMoved, recordSweep } from "./history";
import {
    curveTypeOf,
    facePlane,
    isQuery,
    ownerBodies,
    relatedEntities,
    resolveQuery,
    surfaceTypeOf,
} from "./queries";

// ------------------------------------------------------------------ Shared helpers

export function kernel<T>(result: Result<T>, what: string): T {
    if (!result.isOk) fail(`${what} failed: ${result.error}`);
    return result.value;
}

export function definitionOf(args: FsValue[], fn: string): [FsContext, string, FsMap] {
    const ctx = FsContext.of(arg(args, 0, fn));
    const id = idString(arg(args, 1, fn));
    const definition = args[2] === undefined ? new FsMap() : expectMap(args[2], `${fn} definition`);
    return [ctx, id, definition];
}

const mm = (v: Vec3): XYZ => new XYZ(v[0] * MM_PER_METER, v[1] * MM_PER_METER, v[2] * MM_PER_METER);
const xyz = (v: Vec3): XYZ => new XYZ(v[0], v[1], v[2]);

export function lengthMm(value: FsValue, what: string): number {
    return expectQuantity(value, LENGTH, what) * MM_PER_METER;
}

export function optionalLengthMm(value: FsValue, what: string, fallback = 0): number {
    return value === undefined ? fallback : lengthMm(value, what);
}

export function angleDeg(value: FsValue, what: string): number {
    // Onshape's operations take a bare number as radians (std's fCone: `"angleForward" : 2 * PI`).
    const radians = typeof value === "number" ? value : expectQuantity(value, ANGLE, what);
    return (radians * 180) / Math.PI;
}

/** An affine (meters) as a kernel `Matrix4` (mm, column-major). */
export function kernelMatrix(a: AffineData): Matrix4 {
    const m = a.m;
    const t = a.t.map((x) => x * MM_PER_METER);
    return Matrix4.fromArray([
        m[0],
        m[3],
        m[6],
        0,
        m[1],
        m[4],
        m[7],
        0,
        m[2],
        m[5],
        m[8],
        0,
        t[0],
        t[1],
        t[2],
        1,
    ]);
}

/** Faces named by a query: FACE refs, or every face of SHEET bodies. */
export function facesOf(refs: readonly EntityRef[]): { body: FsBody; face: IFace }[] {
    const result: { body: FsBody; face: IFace }[] = [];
    for (const ref of refs) {
        if (ref.kind === "FACE") result.push({ body: ref.body, face: ref.body.faces()[ref.index] });
        else if (ref.kind === "BODY" && ref.body.kind === "SHEET") {
            for (const face of ref.body.faces()) result.push({ body: ref.body, face });
        }
    }
    return result;
}

/** Edge refs named by a query: EDGE refs, a face's edges, a wire body's edges. */
export function edgeRefsOf(refs: readonly EntityRef[]): EntityRef[] {
    const seen = new Set<string>();
    const result: EntityRef[] = [];
    for (const ref of refs) {
        const edges = ref.kind === "EDGE" ? [ref] : ref.kind === "VERTEX" ? [] : relatedEntities(ref, "EDGE");
        for (const edge of edges) {
            const key = `${edge.body.key}:${edge.index}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(edge);
        }
    }
    return result;
}

export function groupByBody(refs: readonly EntityRef[]): Map<FsBody, number[]> {
    const groups = new Map<FsBody, number[]>();
    for (const ref of refs) {
        const list = groups.get(ref.body) ?? [];
        list.push(ref.index);
        groups.set(ref.body, list);
    }
    return groups;
}

/** Solid model bodies the user can modify — the default scope of ADD/REMOVE/INTERSECT. */
function modifiableSolids(ctx: FsContext, exclude: ReadonlySet<FsBody>): FsBody[] {
    return ctx.bodies.filter((body) => body.isModelGeometry && body.kind === "SOLID" && !exclude.has(body));
}

/** The sweep direction of a profile face: its sketch's normal, else the face's outward normal. */
function profileNormal(body: FsBody, face: IFace): Vec3 {
    if (body.flags.plane !== undefined) return body.flags.plane.normal;
    const plane = facePlane(face);
    if (plane === undefined) fail("Extrude entities must be planar faces or sketch regions");
    return plane.normal;
}

/** A very long distance covering every body in the context — THROUGH_ALL's stand-in. */
export function throughAllDepthMm(ctx: FsContext): number {
    let extent = 0;
    for (const body of ctx.bodies) {
        if (body.flags.defaultGeometry) continue;
        try {
            const box = body.shape.boundingBox();
            extent = Math.max(
                extent,
                Math.abs(box.min.x),
                Math.abs(box.min.y),
                Math.abs(box.min.z),
                Math.abs(box.max.x),
                Math.abs(box.max.y),
                Math.abs(box.max.z),
            );
        } catch {
            // An unmeasurable body does not widen the range.
        }
    }
    return Math.max(1000, extent * 4 + 100);
}

export function removeIfEmpty(ctx: FsContext, body: FsBody): void {
    if (body.faces().length === 0 && body.edges().length === 0) ctx.removeBody(body);
}

// ------------------------------------------------------------------ Extrude

interface ExtrudeExtent {
    /** Distance (mm) in the extrude direction. */
    readonly end: number;
    /** Distance (mm) backwards from the profile. */
    readonly start: number;
}

function sweepFace(
    ctx: FsContext,
    opId: string,
    face: IFace,
    direction: Vec3,
    extent: ExtrudeExtent,
    owner?: FsBody,
): FsBody {
    if (extent.end + extent.start <= 1e-9) fail("Extrude depth must be positive");
    const dir = xyz(direction);
    let profile: IShape = face;
    if (Math.abs(extent.start) > 1e-12) {
        profile = ctx.track(
            face.transformedMul(
                Matrix4.fromTranslation(-dir.x * extent.start, -dir.y * extent.start, -dir.z * extent.start),
            ),
        );
    }
    const vector = dir.multiply(extent.end + extent.start);
    if (shapeFactory.prismTracked !== undefined) {
        const tracked = kernel(shapeFactory.prismTracked(profile, vector), "Extrude");
        const caps = new Set(tracked.capFaces ?? []);
        const starts = new Set(tracked.faceMap.flatMap((input, i) => (input >= 0 ? [i] : [])));
        const body = ctx.addBody(
            tracked.shape,
            opId,
            {},
            {
                faceExtra: (i) => (caps.has(i) ? { cap: "END" } : starts.has(i) ? { cap: "START" } : {}),
            },
        );
        if (owner !== undefined) recordSweep(ctx, opId, body, tracked, profileHistory(owner, face, profile));
        return body;
    }
    return ctx.addBody(kernel(shapeFactory.prism(profile, vector), "Extrude"), opId);
}

function sweepEdge(
    ctx: FsContext,
    opId: string,
    edge: IEdge,
    direction: Vec3,
    extent: ExtrudeExtent,
    owner?: FsBody,
): FsBody {
    const dir = xyz(direction);
    let profile: IShape = edge;
    if (Math.abs(extent.start) > 1e-12) {
        profile = ctx.track(
            edge.transformedMul(
                Matrix4.fromTranslation(-dir.x * extent.start, -dir.y * extent.start, -dir.z * extent.start),
            ),
        );
    }
    const vector = dir.multiply(extent.end + extent.start);
    if (shapeFactory.prismTracked !== undefined) {
        const tracked = kernel(shapeFactory.prismTracked(profile, vector), "Extrude");
        const body = ctx.addBody(tracked.shape, opId);
        if (owner !== undefined) recordSweep(ctx, opId, body, tracked, profileHistory(owner, edge, profile));
        return body;
    }
    return ctx.addBody(kernel(shapeFactory.prism(profile, vector), "Extrude"), opId);
}

/** Extrudes the faces (or edges, making sheets) of `refs`; returns the new bodies, merged when several. */
function extrudeEntities(
    ctx: FsContext,
    opId: string,
    refs: EntityRef[],
    direction: Vec3 | undefined,
    extent: ExtrudeExtent,
): FsBody[] {
    const faces = facesOf(refs);
    const bodies: FsBody[] = [];
    for (const { body, face } of faces) {
        const dir = direction ?? profileNormal(body, face);
        bodies.push(sweepFace(ctx, opId, face, dir, extent, body));
    }
    if (faces.length === 0) {
        const edges = edgeRefsOf(refs);
        if (edges.length === 0) fail("Extrude needs faces, sketch regions or edges");
        if (direction === undefined) fail("Extruding edges needs a direction");
        for (const ref of edges)
            bodies.push(sweepEdge(ctx, opId, ref.body.edges()[ref.index], direction, extent, ref.body));
    }
    // Adjacent regions (a sketch split into touching pieces) become one part, as they would
    // when extruded together.
    if (bodies.length > 1 && bodies.every((body) => body.kind === "SOLID")) {
        const [first, ...rest] = bodies;
        booleanInto(ctx, opId, first, rest, "UNION", false);
        return [first];
    }
    return bodies;
}

// ------------------------------------------------------------------ Booleans

type TrackedBoolean = (a: IShape[], b: IShape[]) => Result<TrackedShape>;

function trackedBooleanOf(kind: "UNION" | "SUBTRACTION" | "INTERSECTION"): TrackedBoolean | undefined {
    const factory = shapeFactory;
    if (kind === "UNION") return factory.booleanFuseTracked?.bind(factory);
    if (kind === "SUBTRACTION") return factory.booleanCutTracked?.bind(factory);
    return factory.booleanCommonTracked?.bind(factory);
}

function plainBoolean(
    kind: "UNION" | "SUBTRACTION" | "INTERSECTION",
    a: IShape[],
    b: IShape[],
): Result<IShape> {
    if (kind === "UNION") return shapeFactory.booleanFuse(a, b, true);
    if (kind === "SUBTRACTION") return shapeFactory.booleanCut(a, b);
    return shapeFactory.booleanCommon(a, b);
}

/** Combines `tools` into `target` in place (attributes inherited through the boolean history). */
export function booleanInto(
    ctx: FsContext,
    opId: string,
    target: FsBody,
    tools: FsBody[],
    kind: "UNION" | "SUBTRACTION" | "INTERSECTION",
    keepTools: boolean,
): void {
    if (tools.length === 0) return;
    const sources = [historySource(target), ...tools.map(historySource)];
    const tracked = trackedBooleanOf(kind);
    const toolShapes = tools.map((tool) => tool.shape);
    const label =
        kind === "UNION"
            ? "Boolean union"
            : kind === "SUBTRACTION"
              ? "Boolean subtraction"
              : "Boolean intersection";
    const result =
        tracked !== undefined
            ? kernel(tracked([target.shape], toolShapes), label)
            : kernel(plainBoolean(kind, [target.shape], toolShapes), label);
    ctx.rebuildBody(target, result, sources, opId);
    if (!keepTools) for (const tool of tools) ctx.removeBody(tool);
    removeIfEmpty(ctx, target);
}

/** The NewBodyOperationType step of a high-level feature: merge/cut/intersect new bodies with the scope. */
function applyOperationType(ctx: FsContext, opId: string, definition: FsMap, created: FsBody[]): void {
    const operation = optionalEnum(
        definition.field("operationType"),
        "NewBodyOperationType",
        "operationType",
        "NEW",
    );
    if (operation === "NEW" || created.length === 0) return;
    const createdSet = new Set(created);
    const useDefault = definition.field("defaultScope") !== false;
    const targets = useDefault
        ? modifiableSolids(ctx, createdSet)
        : ownerBodies(resolveQuery(ctx, definition.field("booleanScope")))
              .map((ref) => ref.body)
              .filter((body) => !createdSet.has(body));
    if (targets.length === 0) {
        if (operation === "ADD") return;
        fail(`${operation === "REMOVE" ? "Remove" : "Intersect"} found no part to modify`);
    }
    if (operation === "ADD") {
        const [first, ...rest] = targets;
        booleanInto(ctx, opId, first, [...rest, ...created], "UNION", false);
        return;
    }
    const kind = operation === "REMOVE" ? "SUBTRACTION" : "INTERSECTION";
    for (const target of targets) booleanInto(ctx, opId, target, created, kind, true);
    for (const body of created) ctx.removeBody(body);
}

// ------------------------------------------------------------------ Registration

export function installOperations(std: StdBuilder): void {
    installPrimitives(std);
    installSweeps(std);
    installModifiers(std);
    installBodyOps(std);
    installFeatures(std);
}

function installPrimitives(std: StdBuilder): void {
    std.fn("fCuboid", (args) => {
        const [ctx, id, definition] = definitionOf(args, "fCuboid");
        const a = readPoint(definition.field("corner1"), "corner1");
        const b = readPoint(definition.field("corner2"), "corner2");
        const min: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
        const size = [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])].map(
            (x) => x * MM_PER_METER,
        );
        if (size.some((x) => x < 1e-9)) fail("fCuboid corners must differ in every coordinate");
        const plane = new Plane({ origin: mm(min), normal: XYZ.unitZ, xvec: XYZ.unitX });
        ctx.addBody(kernel(shapeFactory.box(plane, size[0], size[1], size[2]), "fCuboid"), id);
        return undefined;
    });
    std.fn("fCylinder", (args) => {
        const [ctx, id, definition] = definitionOf(args, "fCylinder");
        const top = readPoint(definition.field("topCenter"), "topCenter");
        const bottom = readPoint(definition.field("bottomCenter"), "bottomCenter");
        const radius = lengthMm(definition.field("radius"), "radius");
        const axis = vec.sub(top, bottom);
        const height = vec.norm(axis) * MM_PER_METER;
        if (height < 1e-9 || radius <= 0) fail("fCylinder needs distinct centers and a positive radius");
        ctx.addBody(
            kernel(shapeFactory.cylinder(xyz(vec.normalize(axis)), mm(bottom), radius, height), "fCylinder"),
            id,
        );
        return undefined;
    });
    std.fn("fCone", (args) => {
        const [ctx, id, definition] = definitionOf(args, "fCone");
        const top = readPoint(definition.field("topCenter"), "topCenter");
        const bottom = readPoint(definition.field("bottomCenter"), "bottomCenter");
        const topRadius = lengthMm(definition.field("topRadius"), "topRadius");
        const bottomRadius = lengthMm(definition.field("bottomRadius"), "bottomRadius");
        const axis = vec.sub(top, bottom);
        const height = vec.norm(axis) * MM_PER_METER;
        if (height < 1e-9) fail("fCone needs distinct centers");
        ctx.addBody(
            kernel(
                shapeFactory.cone(xyz(vec.normalize(axis)), mm(bottom), bottomRadius, topRadius, height),
                "fCone",
            ),
            id,
        );
        return undefined;
    });
    std.fn("fSphere", (args) => {
        const [ctx, id, definition] = definitionOf(args, "fSphere");
        const radius = lengthMm(definition.field("radius"), "radius");
        if (radius <= 0) fail("fSphere radius must be positive");
        ctx.addBody(
            kernel(shapeFactory.sphere(sphereCenter(ctx, definition.field("center")), radius), "fSphere"),
            id,
        );
        return undefined;
    });
    std.fn("opPoint", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opPoint");
        ctx.addBody(
            kernel(shapeFactory.point(mm(readPoint(definition.field("point"), "point"))), "opPoint"),
            id,
        );
        return undefined;
    });
    std.fn("opPlane", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opPlane");
        const plane = readPlane(definition.field("plane"), "plane");
        const width = optionalLengthMm(definition.field("width"), "width", 150);
        const height = optionalLengthMm(definition.field("height"), "height", 150);
        const face = kernel(
            shapeFactory.rect(toKernelPlane(plane, -width / 2, -height / 2), width, height),
            "opPlane",
        );
        ctx.addBody(face, id, { construction: true, plane });
        return undefined;
    });
    std.fn("opHelix", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opHelix");
        const { axis, turns, pitch } = helixDefinition(definition);
        const start = readPoint(definition.field("startPoint"), "startPoint");
        const radial = vec.sub(
            start,
            vec.add(
                axis.origin,
                vec.scale(axis.direction, vec.dot(vec.sub(start, axis.origin), axis.direction)),
            ),
        );
        const radius = vec.norm(radial) * MM_PER_METER;
        if (radius < 1e-9) fail("opHelix startPoint must be off the axis");
        const wire = kernel(
            shapeFactory.helix(
                mm(vec.sub(start, radial)),
                xyz(axis.direction),
                xyz(vec.normalize(radial)),
                radius,
                pitch,
                turns * 360,
            ),
            "opHelix",
        );
        ctx.addBody(wire, id);
        return undefined;
    });
}

/**
 * A helix's axis, turn count and pitch (mm), in Onshape's form — `direction`, `axisStart`,
 * `interval` (in turns) and `helicalPitch` — or the short `axis` / `turns` / `pitch` one.
 */
function helixDefinition(definition: FsMap): { axis: LineData; turns: number; pitch: number } {
    if (!definition.has("axisStart")) {
        return {
            axis: readLine(definition.field("axis"), "axis"),
            turns: expectNumber(definition.field("turns") ?? 1, "turns"),
            pitch: lengthMm(definition.field("pitch") ?? definition.field("height"), "pitch"),
        };
    }
    const [from, to] = expectArray(definition.field("interval"), "interval").items.map((turn) =>
        expectNumber(turn, "interval"),
    );
    if (from !== 0 || definition.field("clockwise") === true)
        fail("opHelix supports counter-clockwise helices starting at turn 0 only");
    if (optionalLengthMm(definition.field("spiralPitch"), "spiralPitch") !== 0)
        fail("opHelix does not support a spiral pitch");
    return {
        axis: {
            origin: readPoint(definition.field("axisStart"), "axisStart"),
            direction: readDirection(definition.field("direction"), "direction"),
        },
        turns: to - from,
        pitch: lengthMm(definition.field("helicalPitch"), "helicalPitch"),
    };
}

/** As std's `fSphere`: the center is optional (the origin), a vertex query, or a point. */
function sphereCenter(ctx: FsContext, value: FsValue): XYZ {
    if (value === undefined) return new XYZ(0, 0, 0);
    if (!isQuery(value)) return mm(readPoint(value, "center"));
    const vertex = resolveQuery(ctx, value).find((ref) => ref.kind === "VERTEX");
    if (vertex === undefined) fail("fSphere center must be a vertex");
    const point = vertex.body.vertices()[vertex.index].point();
    return new XYZ(point.x, point.y, point.z);
}

function installSweeps(std: StdBuilder): void {
    std.fn("opExtrude", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opExtrude");
        const refs = resolveQuery(ctx, definition.field("entities"));
        const direction =
            definition.field("direction") === undefined
                ? undefined
                : readDirection(definition.field("direction"), "direction");
        extrudeEntities(ctx, id, refs, direction, opExtrudeExtent(ctx, definition));
        return undefined;
    });
    std.fn("opRevolve", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opRevolve");
        const axis = readLine(definition.field("axis"), "axis");
        const { startDeg, spanDeg } = revolveSpan(definition);
        revolveEntities(
            ctx,
            id,
            resolveQuery(ctx, definition.field("entities")),
            axis,
            spanDeg + startDeg,
            -startDeg,
        );
        return undefined;
    });
    std.fn("opSweep", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opSweep");
        rejectSweepOptions(ctx, definition);
        const profiles = resolveQuery(ctx, definition.field("profiles"));
        const path = wireOf(ctx, edgeRefsOf(resolveQuery(ctx, definition.field("path"))), "opSweep path");
        if (!shapeFactory.sweepProfile) fail("opSweep needs the profile sweep kernel binding");
        const keepOrientation =
            definition.field("keepProfileOrientation") === true ||
            optionalEnum(
                definition.field("profileControl"),
                "ProfileControlMode",
                "profileControl",
                "NONE",
            ) === "KEEP_ORIENTATION";
        const sweep = (wire: IWire, solid: boolean) =>
            ctx.track(kernel(shapeFactory.sweepProfile!(wire, path, solid, keepOrientation), "opSweep"));
        const results: IShape[] = [];
        // Each region is a separate sweep, not a section of one varying-profile pipe.
        // Sweep and subtract every inner loop so annular profiles retain their holes.
        for (const { face } of facesOf(profiles)) {
            const outer = ctx.track(face.outerWire());
            let shape = sweep(outer, true);
            const loops = face.findSubShapes(ShapeTypes.wire).map((wire) => ctx.track(wire) as IWire);
            const holes = loops.filter((wire) => !wire.isSame(outer)).map((wire) => sweep(wire, true));
            if (holes.length) shape = ctx.track(kernel(shapeFactory.booleanCut([shape], holes), "opSweep"));
            results.push(shape);
        }
        const edges = profiles.filter(
            (ref) => ref.kind === "EDGE" || (ref.kind === "BODY" && ref.body.kind === "WIRE"),
        );
        if (edges.length) results.push(sweep(wireOf(ctx, edgeRefsOf(edges), "opSweep profile"), false));
        if (!results.length) fail("opSweep needs face or edge profiles");
        // Publish only after all profiles succeed.
        for (const shape of results) ctx.addBody(shape, id);
        return undefined;
    });
    std.fn("opLoft", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opLoft");
        for (const field of ["guideSubqueries", "connections", "derivativeInfo"]) {
            const value = definition.field(field);
            if (value !== undefined && (!(value instanceof FsArray) || value.size > 0))
                fail(`opLoft: ${field} is not supported yet`);
        }
        for (const field of ["makePeriodic", "addSections", "trimProfiles", "trimGuidesByProfiles"])
            if (definition.field(field) === true) fail(`opLoft: ${field} is not supported yet`);
        const subqueries = expectArray(definition.field("profileSubqueries"), "profileSubqueries").items;
        if (subqueries.length < 2) fail("opLoft needs at least two profiles");
        const sections = subqueries.map((sub, i) => loftSection(ctx, resolveQuery(ctx, sub), i));
        const bodyType = optionalEnum(definition.field("bodyType"), "ToolBodyType", "bodyType", "SOLID");
        if (bodyType !== "SOLID" && bodyType !== "SURFACE") fail(`opLoft: unsupported bodyType ${bodyType}`);
        ctx.addBody(
            kernel(
                shapeFactory.loft(sections, bodyType === "SOLID", definition.field("ruled") === true, "c2"),
                "opLoft",
            ),
            id,
        );
        return undefined;
    });
    std.fn("opThicken", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opThicken");
        const t1 = optionalLengthMm(definition.field("thickness1"), "thickness1");
        const t2 = optionalLengthMm(definition.field("thickness2"), "thickness2");
        if (t1 < 0 || t2 < 0 || t1 + t2 <= 0)
            fail("opThicken needs nonnegative thicknesses and a positive total thickness");
        const slab = (face: IFace, thickness: number): IShape => {
            const shape = ctx.track(
                kernel(shapeFactory.makeThickSolidBySimple(face, thickness), "opThicken"),
            );
            // The kernel hands back the along-the-normal slab inside out (negative volume):
            // flip it, or a boolean with it acts on its complement.
            if (shape.volume() < 0) shape.reserve();
            return shape;
        };
        const selected = facesOf(resolveQuery(ctx, definition.field("entities")));
        if (!selected.length) fail("opThicken needs sheet bodies or faces");
        for (const body of new Set(selected.map((entry) => entry.body))) {
            if (selected.filter((entry) => entry.body === body).length > 1)
                fail("opThicken: multiple faces of one body are not supported yet");
        }
        const results: IShape[] = [];
        for (const { face } of selected) {
            const parts: IShape[] = [];
            if (t1 > 0) parts.push(slab(face, t1));
            if (t2 > 0) parts.push(slab(face, -t2));
            const shape =
                parts.length === 1
                    ? parts[0]
                    : ctx.track(kernel(shapeFactory.booleanFuse([parts[0]], [parts[1]], true), "opThicken"));
            results.push(shape);
        }
        for (const shape of results) ctx.addBody(shape, id);
        if (definition.field("keepTools") === false) {
            for (const body of new Set(selected.map((entry) => entry.body))) {
                if (body.kind !== "SHEET" || body.flags.sketch) continue;
                if (
                    body
                        .faces()
                        .every((face) =>
                            selected.some((entry) => entry.body === body && entry.face.isSame(face)),
                        )
                )
                    ctx.removeBody(body);
            }
        }
        return undefined;
    });
}

function opExtrudeExtent(ctx: FsContext, definition: FsMap): ExtrudeExtent {
    const endBound = optionalEnum(definition.field("endBound"), "BoundingType", "endBound", "BLIND");
    const startBound = optionalEnum(definition.field("startBound"), "BoundingType", "startBound", "BLIND");
    const end = boundDistance(ctx, endBound, definition.field("endDepth"), "endDepth");
    const start =
        definition.field("startDepth") === undefined && startBound === "BLIND"
            ? 0
            : boundDistance(ctx, startBound, definition.field("startDepth"), "startDepth");
    // `isStartBoundOpposite : false` measures the start along the extrude direction (std's symmetric
    // extrude passes `startDepth : -depth / 2`); by default it runs backwards from the profile.
    const along = definition.field("isStartBoundOpposite") === false && startBound === "BLIND";
    return { end, start: along ? -start : start };
}

function boundDistance(ctx: FsContext, bound: string, depth: FsValue, what: string): number {
    switch (bound) {
        case "BLIND":
            return lengthMm(depth, what);
        case "THROUGH_ALL":
            return throughAllDepthMm(ctx);
        default:
            fail(`BoundingType.${bound} is not supported yet (use BLIND or THROUGH_ALL)`);
    }
}

function wireOf(ctx: FsContext, refs: EntityRef[], what: string): IWire {
    const edges = refs.map((ref) => ref.body.edges()[ref.index]);
    if (edges.length === 0) fail(`${what} needs edges`);
    return ctx.track(kernel(shapeFactory.wire(edges), what));
}

function loftSection(ctx: FsContext, refs: EntityRef[], index: number): IVertex | IEdge | IWire {
    const vertex = refs.find((ref) => ref.kind === "VERTEX");
    if (vertex !== undefined && refs.length === 1) return vertex.body.vertices()[vertex.index];
    const faces = facesOf(refs);
    if (faces.length > 0) {
        if (faces.length !== 1) fail(`opLoft profile ${index}: multiple regions are not supported yet`);
        const loops = faces[0].face.findSubShapes(ShapeTypes.wire).map((wire) => ctx.track(wire));
        if (loops.length !== 1) fail(`opLoft profile ${index}: profiles with holes are not supported yet`);
        return ctx.track(faces[0].face.outerWire());
    }
    return wireOf(ctx, edgeRefsOf(refs), `opLoft profile ${index}`);
}

function rejectSweepOptions(ctx: FsContext, definition: FsMap): void {
    for (const field of ["hasTwist", "hasScale"])
        if (definition.field(field) === true) fail(`opSweep: ${field} is not supported yet`);
    const control = definition.field("profileControl");
    if (
        control !== undefined &&
        !["NONE", "KEEP_ORIENTATION"].includes(enumName(control, "ProfileControlMode", "profileControl"))
    )
        fail(`opSweep: ${enumName(control, "ProfileControlMode", "profileControl")} is not supported yet`);
    if (definition.field("lockDirection") !== undefined) fail("opSweep: lockDirection is not supported yet");
    const faces = definition.field("lockFaces");
    if (faces !== undefined && resolveQuery(ctx, faces).length)
        fail("opSweep: lockFaces is not supported yet");
    if (definition.field("extendToFullPath") === false)
        fail("opSweep: limiting the path at the profile is not supported yet");
}

/**
 * Where a revolve starts and how far it turns, in degrees. Two forms: `angleForward` /
 * `angleBack` (the revolve turns `angleForward` on from the profile and `angleBack` the
 * other way), and the bounds form std's `revolve` feature passes — `startBoundAngle` and
 * `endBoundAngle`, both measured forward, equal meaning a full turn.
 */
function revolveSpan(definition: FsMap): { startDeg: number; spanDeg: number } {
    if (definition.field("angleForward") === undefined && definition.has("endBoundAngle")) {
        for (const bound of ["endBound", "startBound"]) {
            const value = definition.field(bound);
            if (value !== undefined && optionalEnum(value, "RevolveBoundingType", bound, "BLIND") !== "BLIND")
                fail("A revolve up to a face, part or vertex is not supported");
        }
        const end = angleDeg(definition.field("endBoundAngle"), "endBoundAngle");
        const start = definition.has("startBoundAngle")
            ? angleDeg(definition.field("startBoundAngle"), "startBoundAngle")
            : 0;
        const span = (((end - start) % 360) + 360) % 360;
        const startDeg = start > 180 ? start - 360 : start;
        return { startDeg, spanDeg: span < 1e-9 ? 360 : span };
    }
    const forward = angleDeg(definition.field("angleForward"), "angleForward");
    const back =
        definition.field("angleBack") === undefined
            ? 0
            : angleDeg(definition.field("angleBack"), "angleBack");
    return { startDeg: -back, spanDeg: forward + back };
}

function revolveEntities(
    ctx: FsContext,
    opId: string,
    refs: EntityRef[],
    axis: LineData,
    forwardDeg: number,
    backDeg: number,
): FsBody[] {
    const total = forwardDeg + backDeg;
    if (total <= 1e-9) fail("Revolve angle must be positive");
    const kernelAxis = new Line({ point: mm(axis.origin), direction: xyz(axis.direction) });
    const rotateBack =
        Math.abs(backDeg) > 1e-12
            ? kernelMatrix(rotationAffine(axis.origin, axis.direction, (-backDeg * Math.PI) / 180))
            : undefined;
    const bodies: FsBody[] = [];
    const profiles: { shape: IShape; owner: FsBody }[] = facesOf(refs).map((entry) => ({
        shape: entry.face,
        owner: entry.body,
    }));
    if (profiles.length === 0)
        for (const ref of edgeRefsOf(refs))
            profiles.push({ shape: ref.body.edges()[ref.index], owner: ref.body });
    if (profiles.length === 0) fail("Revolve needs faces, sketch regions or edges");
    for (const { shape: profile, owner } of profiles) {
        const start = rotateBack === undefined ? profile : ctx.track(profile.transformedMul(rotateBack));
        const angle = Math.min(total, 360);
        if (shapeFactory.revolveTracked !== undefined) {
            const tracked = kernel(shapeFactory.revolveTracked(start, kernelAxis, angle), "Revolve");
            const caps = new Set(tracked.capFaces ?? []);
            const starts = new Set(tracked.faceMap.flatMap((input, i) => (input >= 0 ? [i] : [])));
            const body = ctx.addBody(
                tracked.shape,
                opId,
                {},
                {
                    faceExtra: (i) => (caps.has(i) ? { cap: "END" } : starts.has(i) ? { cap: "START" } : {}),
                },
            );
            recordSweep(ctx, opId, body, tracked, profileHistory(owner, profile, start));
            bodies.push(body);
        } else {
            bodies.push(ctx.addBody(kernel(shapeFactory.revolve(start, kernelAxis, angle), "Revolve"), opId));
        }
    }
    if (bodies.length > 1 && bodies.every((body) => body.kind === "SOLID")) {
        const [first, ...rest] = bodies;
        booleanInto(ctx, opId, first, rest, "UNION", false);
        return [first];
    }
    return bodies;
}

function installModifiers(std: StdBuilder): void {
    std.fn("opFillet", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opFillet");
        edgeCorner(ctx, id, definition, "fillet", lengthMm(definition.field("radius"), "radius"));
        return undefined;
    });
    std.fn("opChamfer", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opChamfer");
        const type = optionalEnum(
            definition.field("chamferType"),
            "ChamferType",
            "chamferType",
            "EQUAL_OFFSETS",
        );
        const width = definition.field("width") ?? definition.field("width1") ?? definition.field("distance");
        if (type !== "EQUAL_OFFSETS")
            ctx.notes.warnings.push(`ChamferType.${type} is approximated by an equal-offset chamfer`);
        edgeCorner(ctx, id, definition, "chamfer", lengthMm(width, "width"));
        return undefined;
    });
    std.fn("opShell", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opShell");
        shellOp(ctx, id, definition, "operation");
        return undefined;
    });
    std.fn("opBoolean", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opBoolean");
        booleanOp(ctx, id, definition);
        return undefined;
    });
}

/**
 * Shells solids. `opShell` follows Onshape's operation contract — positive thickness grows
 * outward, negative shells inward — while the `shell` feature takes a positive thickness
 * kept inside the boundary, `oppositeDirection` flipping it outward.
 */
function shellOp(ctx: FsContext, opId: string, definition: FsMap, form: "operation" | "feature"): void {
    const thickness = lengthMm(definition.field("thickness"), "thickness");
    if (Math.abs(thickness) < 1e-9) fail("Shell thickness must be non-zero");
    const refs = resolveQuery(ctx, definition.field("entities"));
    const faceRefs = refs.filter((ref) => ref.kind === "FACE");
    const bodies = new Set([
        ...faceRefs.map((ref) => ref.body),
        ...refs.filter((ref) => ref.kind === "BODY").map((ref) => ref.body),
    ]);
    if (bodies.size === 0) fail("Shell needs faces to remove (or bodies to hollow)");
    const sign = form === "operation" || definition.field("oppositeDirection") === true ? 1 : -1;
    for (const body of bodies) {
        if (body.kind !== "SOLID") continue;
        const faces = faceRefs.filter((ref) => ref.body === body).map((ref) => body.faces()[ref.index]);
        const offset = sign * thickness;
        const direct = shapeFactory.makeThickSolidByJoin(body.shape, faces, offset, "intersection");
        const result = direct.isOk
            ? direct.value
            : kernel(collapsedBlendShell(body, faces, offset, direct), "Shell");
        ctx.rebuildBody(body, result, [historySource(body)], opId);
    }
}

/**
 * An inward shell whose wall swallows convex round blends. Offsetting a convex cylinder or
 * sphere of radius r inward by t ≥ r collapses it, which the kernel's thick-solid refuses;
 * Onshape (Parasolid) gives the cavity a sharp corner there. That cavity is the one the part
 * would have without those blends, so: remove the blends (defeaturing), shell that part,
 * take its cavity (defeatured − shelled) and cut it from the original. Other failures keep
 * the kernel's error.
 */
function collapsedBlendShell(
    body: FsBody,
    removed: readonly IFace[],
    offset: number,
    failure: Result<IShape>,
): Result<IShape> {
    if (offset >= 0) return failure;
    const blends = body.faces().filter((face) => {
        if (removed.some((open) => open.isSame(face))) return false;
        return collapsesInward(face, -offset);
    });
    if (blends.length === 0) return failure;
    const sharp = shapeFactory.removeFeature(body.shape, blends);
    if (!sharp.isOk) return failure;
    const sharpFaces = sharp.value.findSubShapes(ShapeTypes.face) as IFace[];
    try {
        // The faces to remove, re-found on the defeatured part (blend removal re-trims them).
        const open = removed.map((face) => {
            const plane = facePlane(face);
            if (plane === undefined) return undefined;
            return sharpFaces.find((candidate) => {
                const other = facePlane(candidate);
                return (
                    other !== undefined &&
                    vec.dot(other.normal, plane.normal) > 1 - 1e-9 &&
                    Math.abs(vec.dot(plane.normal, vec.sub(other.origin, plane.origin))) < 1e-10
                );
            });
        });
        if (open.some((face) => face === undefined)) return failure;
        const shelled = shapeFactory.makeThickSolidByJoin(
            sharp.value,
            open as IFace[],
            offset,
            "intersection",
        );
        if (!shelled.isOk) return failure;
        const cavity = shapeFactory.booleanCut([sharp.value], [shelled.value]);
        if (!cavity.isOk) return failure;
        const result = shapeFactory.booleanCut([body.shape], [cavity.value]);
        shelled.value.dispose();
        cavity.value.dispose();
        return result.isOk && result.value.checkShape() ? result : failure;
    } finally {
        sharpFaces.forEach((face) => face.dispose());
        sharp.value.dispose();
    }
}

/** A convex cylinder or sphere face whose radius an inward offset of `depth` reaches. */
function collapsesInward(face: IFace, depth: number): boolean {
    const type = surfaceTypeOf(face);
    if (type !== "CYLINDER" && type !== "SPHERE") return false;
    const surface = face.surface() as unknown as {
        location?: XYZ;
        axis?: XYZ;
        radius?: number;
        bounds(): { u1: number; u2: number; v1: number; v2: number };
        dispose(): void;
    };
    try {
        const radius = surface.radius;
        if (radius === undefined || surface.location === undefined || radius > depth + 1e-7) return false;
        const { u1, u2, v1, v2 } = surface.bounds();
        const [point, normal] = face.normal((u1 + u2) / 2, (v1 + v2) / 2);
        // Convex when the outward normal points away from the centre (axis or sphere centre).
        let center = surface.location;
        if (type === "CYLINDER" && surface.axis !== undefined) {
            const axis = surface.axis.normalize() ?? surface.axis;
            center = center.add(axis.multiply(point.sub(center).dot(axis)));
        }
        return point.sub(center).dot(normal) > 0;
    } catch {
        return false;
    } finally {
        surface.dispose();
    }
}

function edgeCorner(
    ctx: FsContext,
    opId: string,
    definition: FsMap,
    method: "fillet" | "chamfer",
    size: number,
): void {
    if (size <= 0) fail(`${method} size must be positive`);
    const edges = edgeRefsOf(resolveQuery(ctx, definition.field("entities"))).filter(
        (ref) => ref.body.kind === "SOLID" && ref.body.isModelGeometry,
    );
    if (edges.length === 0) fail(`${method === "fillet" ? "opFillet" : "opChamfer"} found no solid edges`);
    for (const [body, indexes] of groupByBody(edges)) {
        const tracked = method === "fillet" ? shapeFactory.filletTracked : shapeFactory.chamferTracked;
        const result =
            tracked !== undefined
                ? kernel(
                      tracked.call(shapeFactory, body.shape, indexes, size),
                      method === "fillet" ? "Fillet" : "Chamfer",
                  )
                : kernel(
                      shapeFactory[method](body.shape, indexes, size),
                      method === "fillet" ? "Fillet" : "Chamfer",
                  );
        const corners = indexes.map((index) => ({
            shape: body.edges()[index],
            serial: body.edgeAttrs[index].serial,
        }));
        const mark = ctx.serialMark();
        ctx.rebuildBody(body, result, [historySource(body)], opId);
        recordBlends(ctx, opId, body, corners, mark);
    }
}

function booleanOp(ctx: FsContext, opId: string, definition: FsMap): void {
    const operation = enumName(definition.field("operationType"), "BooleanOperationType", "operationType");
    const keepTools = definition.field("keepTools") === true;
    const tools = ownerBodies(resolveQuery(ctx, definition.field("tools")))
        .map((ref) => ref.body)
        .filter((body) => body.isModelGeometry);
    const targetsValue = definition.field("targets");
    const targets =
        targetsValue === undefined
            ? []
            : ownerBodies(resolveQuery(ctx, targetsValue))
                  .map((ref) => ref.body)
                  .filter((body) => !tools.includes(body));
    switch (operation) {
        case "UNION": {
            const [first, ...rest] = [...targets, ...tools];
            if (first === undefined || rest.length === 0) return;
            booleanInto(ctx, opId, first, rest, "UNION", keepTools);
            return;
        }
        case "SUBTRACTION":
            if (targets.length === 0) fail("A subtraction needs targets");
            for (const target of targets) booleanInto(ctx, opId, target, tools, "SUBTRACTION", true);
            if (!keepTools) for (const tool of tools) ctx.removeBody(tool);
            return;
        case "INTERSECTION": {
            if (targets.length === 0) {
                if (tools.length < 2) return;
                const [first, ...rest] = tools;
                booleanInto(ctx, opId, first, rest, "INTERSECTION", false);
                return;
            }
            for (const target of targets) booleanInto(ctx, opId, target, tools, "INTERSECTION", true);
            if (!keepTools) for (const tool of tools) ctx.removeBody(tool);
            return;
        }
        case "SUBTRACT_COMPLEMENT":
            // Removes from every target what lies outside the tools (std's NewBodyOperationType.INTERSECT).
            if (targets.length === 0) fail("A subtract-complement needs targets");
            for (const target of targets) booleanInto(ctx, opId, target, tools, "INTERSECTION", true);
            if (!keepTools) for (const tool of tools) ctx.removeBody(tool);
            return;
        default:
            fail(`BooleanOperationType.${operation} is not supported`);
    }
}

function installBodyOps(std: StdBuilder): void {
    std.fn("opTransform", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opTransform");
        const affine = readTransform(definition.field("transform"), "transform");
        const bodies = ownerBodies(resolveQuery(ctx, definition.field("bodies"))).map((ref) => ref.body);
        // Mate connectors attached to a moved body follow it.
        const moved = new Set(bodies.map((body) => body.bodyAttr.serial));
        for (const body of ctx.bodies) {
            const attachedTo = body.flags.mateConnector?.attachedTo;
            if (attachedTo !== undefined && moved.has(attachedTo) && !bodies.includes(body))
                bodies.push(body);
        }
        for (const body of bodies) transformBody(ctx, id, body, affine);
        return undefined;
    });
    std.fn("opPattern", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opPattern");
        const transforms = expectArray(definition.field("transforms"), "transforms").items.map((t, i) =>
            readTransform(t, `transforms[${i}]`),
        );
        const namesValue = definition.field("instanceNames");
        const names =
            namesValue === undefined
                ? transforms.map((_, i) => `${i}`)
                : expectArray(namesValue, "instanceNames").items.map((n) => toDisplayString(n));
        if (names.length !== transforms.length) fail("opPattern needs one instance name per transform");
        const refs = resolveQuery(ctx, definition.field("entities"));
        // A face pattern rebuilds the faces on their own part; copying the whole part instead is wrong.
        if (refs.some((ref) => ref.kind === "FACE"))
            fail("opPattern of faces (a face pattern) is not supported");
        const bodies = ownerBodies(refs).map((ref) => ref.body);
        patternBodies(ctx, id, bodies, transforms, names);
        return undefined;
    });
    std.fn("opMirror", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opMirror");
        const plane = mirrorPlaneOf(ctx, definition.field("mirrorPlane"));
        const bodies = ownerBodies(resolveQuery(ctx, definition.field("entities"))).map((ref) => ref.body);
        patternBodies(ctx, id, bodies, [mirrorAffine(plane)], ["mirror"]);
        return undefined;
    });
    std.fn("opDeleteBodies", (args) => {
        const [ctx, , definition] = definitionOf(args, "opDeleteBodies");
        for (const ref of ownerBodies(resolveQuery(ctx, definition.field("entities")))) {
            if (!ref.body.flags.defaultGeometry) ctx.removeBody(ref.body);
        }
        return undefined;
    });
    std.fn("setProperty", (args) => {
        const ctx = FsContext.of(arg(args, 0, "setProperty"));
        const definition = expectMap(arg(args, 1, "setProperty"), "setProperty definition");
        const property = enumName(definition.field("propertyType"), "PropertyType", "propertyType");
        if (property !== "NAME") return undefined;
        for (const ref of ownerBodies(resolveQuery(ctx, definition.field("entities"))))
            ref.body.name = toDisplayString(definition.field("value"));
        return undefined;
    });
    std.fn("getProperty", (args) => {
        const ctx = FsContext.of(arg(args, 0, "getProperty"));
        const definition = expectMap(arg(args, 1, "getProperty"), "getProperty definition");
        // Only names are kept on bodies; any other property reads as unset.
        const property = enumName(definition.field("propertyType"), "PropertyType", "propertyType");
        if (property !== "NAME") return undefined;
        const body = ownerBodies(resolveQuery(ctx, definition.field("entity")))[0]?.body;
        return body?.name;
    });
}

export function transformBody(ctx: FsContext, opId: string, body: FsBody, affine: AffineData): void {
    const attrs = { faces: body.faceAttrs, edges: body.edgeAttrs, vertices: body.vertexAttrs };
    const shape = ctx.track(body.shape.transformedMul(kernelMatrix(affine)));
    body.setShape(shape);
    // A rigid (or mirror) transform keeps the topology and its enumeration order.
    body.faceAttrs = attrs.faces;
    body.edgeAttrs = attrs.edges;
    body.vertexAttrs = attrs.vertices;
    recordMoved(ctx, opId, body);
    Object.assign(body.flags, transformedFlags(body.flags, affine));
}

/** A body's construction plane and mate connector frame moved with it. */
function transformedFlags(flags: FsBody["flags"], affine: AffineData): FsBody["flags"] {
    const direction = (v: Vec3) => vec.normalize(applyLinear(affine.m, v));
    const { plane, mateConnector } = flags;
    return {
        ...flags,
        ...(plane === undefined
            ? {}
            : {
                  plane: {
                      origin: applyAffine(affine, plane.origin),
                      normal: direction(plane.normal),
                      x: direction(plane.x),
                  },
              }),
        ...(mateConnector === undefined
            ? {}
            : {
                  mateConnector: {
                      ...mateConnector,
                      origin: applyAffine(affine, mateConnector.origin),
                      xAxis: direction(mateConnector.xAxis),
                      zAxis: direction(mateConnector.zAxis),
                  },
              }),
    };
}

function patternBodies(
    ctx: FsContext,
    opId: string,
    bodies: FsBody[],
    transforms: AffineData[],
    names: string[],
): void {
    transforms.forEach((affine, i) => {
        const createdBy = `${opId}/${names[i]}`;
        for (const body of bodies) {
            const shape = body.shape.transformedMul(kernelMatrix(affine));
            const copy = ctx.addBody(shape, createdBy, {
                ...transformedFlags(body.flags, affine),
                defaultGeometry: false,
            });
            // Copies keep caps and sketch entity tags, never the host-index link: two
            // entities must not claim the same stable id.
            copy.faceAttrs = body.faceAttrs.map((attr) => ({ ...ctx.freshAttr(createdBy), cap: attr.cap }));
            copy.edgeAttrs = body.edgeAttrs.map((attr) => ({
                ...ctx.freshAttr(createdBy),
                sketchEntity: attr.sketchEntity,
            }));
            recordCopy(ctx, createdBy, copy, body);
        }
    });
}

function mirrorPlaneOf(ctx: FsContext, value: FsValue) {
    if (value instanceof FsMap && value.tag === "Plane") return readPlane(value, "mirrorPlane");
    const refs = resolveQuery(ctx, value);
    const ref = refs.find((r) => r.kind === "FACE") ?? refs.find((r) => r.body.flags.plane !== undefined);
    if (ref === undefined) fail("mirrorPlane must be a Plane or a planar face");
    if (ref.body.flags.plane !== undefined) return ref.body.flags.plane;
    const plane = facePlane(ref.body.faces()[ref.index]);
    if (plane === undefined) fail("mirrorPlane must be planar");
    return { origin: plane.origin, normal: plane.normal, x: vec.perpendicular(plane.normal) };
}

/** A Line from either a Line value or a query naming a linear edge (or a cylindrical face's axis). */
export function axisOf(ctx: FsContext, value: FsValue): LineData {
    if (value instanceof FsMap && value.tag === "Line") return readLine(value, "axis");
    const refs = resolveQuery(ctx, value);
    const edge = refs.find((ref) => ref.kind === "EDGE");
    if (edge !== undefined) {
        const shape = edge.body.edges()[edge.index];
        if (curveTypeOf(shape) !== "LINE") fail("The axis edge must be a straight line");
        const [a, b] = shape.ends();
        const origin: Vec3 = [a.x / MM_PER_METER, a.y / MM_PER_METER, a.z / MM_PER_METER];
        return { origin, direction: vec.normalize([b.x - a.x, b.y - a.y, b.z - a.z]) };
    }
    const face = refs.find((ref) => ref.kind === "FACE");
    if (face !== undefined) {
        const shape = face.body.faces()[face.index];
        const type = surfaceTypeOf(shape);
        if (type === "CYLINDER" || type === "CONE") {
            const surface = shape.surface() as unknown as { location: XYZ; axis: XYZ; dispose(): void };
            try {
                const loc = surface.location;
                const dir = surface.axis;
                return {
                    origin: [loc.x / MM_PER_METER, loc.y / MM_PER_METER, loc.z / MM_PER_METER],
                    direction: vec.normalize([dir.x, dir.y, dir.z]),
                };
            } finally {
                surface.dispose();
            }
        }
    }
    fail("axis must be a Line, a straight edge or a cylindrical face");
}

/** The direction of a Vector, a straight edge, or a planar face's normal. */
export function directionOf(ctx: FsContext, value: FsValue): Vec3 {
    if (value instanceof FsArray) return readDirection(value, "direction");
    const refs = resolveQuery(ctx, value);
    const face = refs.find((ref) => ref.kind === "FACE");
    if (face !== undefined && refs.every((ref) => ref.kind !== "EDGE")) {
        const plane =
            facePlane(face.body.faces()[face.index]) ??
            (face.body.flags.plane !== undefined ? { normal: face.body.flags.plane.normal } : undefined);
        if (plane === undefined) fail("direction face must be planar");
        return plane.normal;
    }
    return axisOf(ctx, value).direction;
}

// ------------------------------------------------------------------ High-level features

function installFeatures(std: StdBuilder): void {
    std.fn("extrude", (args) => {
        const [ctx, id, definition] = definitionOf(args, "extrude");
        const refs = resolveQuery(ctx, definition.field("entities"));
        if (refs.length === 0) fail("Select regions or faces to extrude");
        const extent = featureExtrudeExtent(ctx, definition);
        let direction: Vec3 | undefined;
        const directionValue = definition.field("direction");
        if (directionValue !== undefined) direction = directionOf(ctx, directionValue);
        const flip = definition.field("oppositeDirection") === true;
        const faces = facesOf(refs);
        const created: FsBody[] = [];
        if (faces.length === 0) {
            created.push(
                ...extrudeEntities(
                    ctx,
                    id,
                    refs,
                    direction === undefined ? undefined : flip ? vec.scale(direction, -1) : direction,
                    extent,
                ),
            );
        } else {
            for (const { body, face } of faces) {
                const base = direction ?? profileNormal(body, face);
                created.push(sweepFace(ctx, id, face, flip ? vec.scale(base, -1) : base, extent, body));
            }
            if (created.length > 1) {
                const [first, ...rest] = created;
                booleanInto(ctx, id, first, rest, "UNION", false);
                created.splice(1);
            }
        }
        applyOperationType(ctx, id, definition, created);
        return undefined;
    });
    std.fn("revolve", (args) => {
        const [ctx, id, definition] = definitionOf(args, "revolve");
        const axis = axisOf(ctx, definition.field("axis"));
        const type = optionalEnum(
            definition.field("revolveType"),
            "RevolveType",
            "revolveType",
            definition.field("angle") === undefined ? "FULL" : "ONE_DIRECTION",
        );
        let forward = 360;
        let back = 0;
        if (type === "ONE_DIRECTION") forward = angleDeg(definition.field("angle"), "angle");
        else if (type === "SYMMETRIC") {
            forward = angleDeg(definition.field("angle"), "angle") / 2;
            back = forward;
        } else if (type === "TWO_DIRECTIONS") {
            forward = angleDeg(definition.field("angle"), "angle");
            back = angleDeg(definition.field("angleBack"), "angleBack");
        }
        const direction =
            definition.field("oppositeDirection") === true ? vec.scale(axis.direction, -1) : axis.direction;
        const created = revolveEntities(
            ctx,
            id,
            resolveQuery(ctx, definition.field("entities")),
            { origin: axis.origin, direction },
            forward,
            back,
        );
        applyOperationType(ctx, id, definition, created);
        return undefined;
    });
    std.fn("fillet", (args) => {
        const [ctx, id, definition] = definitionOf(args, "fillet");
        edgeCorner(ctx, id, definition, "fillet", lengthMm(definition.field("radius"), "radius"));
        return undefined;
    });
    std.fn("chamfer", (args) => {
        const [ctx, id, definition] = definitionOf(args, "chamfer");
        const width = definition.field("width") ?? definition.field("width1") ?? definition.field("distance");
        edgeCorner(ctx, id, definition, "chamfer", lengthMm(width, "width"));
        return undefined;
    });
    std.fn("shell", (args) => {
        const [ctx, id, definition] = definitionOf(args, "shell");
        shellOp(ctx, id, definition, "feature");
        return undefined;
    });
    std.fn("booleanBodies", (args) => {
        const [ctx, id, definition] = definitionOf(args, "booleanBodies");
        booleanOp(ctx, id, definition);
        return undefined;
    });
    std.fn("linearPattern", (args) => {
        const [ctx, id, definition] = definitionOf(args, "linearPattern");
        const count = expectNumber(definition.field("instanceCount"), "instanceCount");
        if (!Number.isInteger(count) || count < 1) fail("instanceCount must be a positive integer");
        let direction = directionOf(ctx, definition.field("directionOne") ?? definition.field("direction"));
        if (definition.field("oppositeDirection") === true) direction = vec.scale(direction, -1);
        const distance = expectQuantity(definition.field("distance"), LENGTH, "distance");
        const transforms: AffineData[] = [];
        const names: string[] = [];
        for (let i = 1; i < count; i++) {
            transforms.push({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: vec.scale(direction, distance * i) });
            names.push(`${i}`);
        }
        const bodies = ownerBodies(resolveQuery(ctx, definition.field("entities"))).map((ref) => ref.body);
        patternBodies(ctx, id, bodies, transforms, names);
        mergePatternIfRequested(ctx, id, definition, bodies);
        return undefined;
    });
    std.fn("circularPattern", (args) => {
        const [ctx, id, definition] = definitionOf(args, "circularPattern");
        const count = expectNumber(definition.field("instanceCount"), "instanceCount");
        if (!Number.isInteger(count) || count < 1) fail("instanceCount must be a positive integer");
        const axis = axisOf(ctx, definition.field("axis"));
        const total = expectQuantity(definition.field("angle") ?? undefined, ANGLE, "angle");
        const equalSpace = definition.field("equalSpace") === true;
        const fullTurn = Math.abs(Math.abs(total) - 2 * Math.PI) < 1e-9;
        const step = equalSpace ? total / (fullTurn ? count : Math.max(1, count - 1)) : total;
        const sign = definition.field("oppositeDirection") === true ? -1 : 1;
        const transforms: AffineData[] = [];
        const names: string[] = [];
        for (let i = 1; i < count; i++) {
            transforms.push(rotationAffine(axis.origin, axis.direction, sign * step * i));
            names.push(`${i}`);
        }
        const bodies = ownerBodies(resolveQuery(ctx, definition.field("entities"))).map((ref) => ref.body);
        patternBodies(ctx, id, bodies, transforms, names);
        mergePatternIfRequested(ctx, id, definition, bodies);
        return undefined;
    });
    std.fn("mirror", (args) => {
        const [ctx, id, definition] = definitionOf(args, "mirror");
        const plane = mirrorPlaneOf(ctx, definition.field("mirrorPlane"));
        const bodies = ownerBodies(resolveQuery(ctx, definition.field("entities"))).map((ref) => ref.body);
        patternBodies(ctx, id, bodies, [mirrorAffine(plane)], ["mirror"]);
        mergePatternIfRequested(ctx, id, definition, bodies);
        return undefined;
    });
    std.fn("transformBodies", (args) => {
        const [ctx, id, definition] = definitionOf(args, "transformBodies");
        const affine = readTransform(definition.field("transform"), "transform");
        for (const ref of ownerBodies(resolveQuery(ctx, definition.field("entities"))))
            transformBody(ctx, id, ref.body, affine);
        return undefined;
    });
    std.fn("composeTransforms", (args) => {
        const list = args.length === 1 ? expectArray(args[0], "transforms").items : args;
        return makeTransform(
            list
                .map((t, i) => readTransform(t, `transform ${i}`))
                .reduce((acc, t) => composeAffine(acc, t), { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }),
        );
    });
}

/** `operationType: ADD` on a pattern fuses each copy with its seed (Onshape's "merge"). */
function mergePatternIfRequested(ctx: FsContext, id: string, definition: FsMap, seeds: FsBody[]): void {
    const operation = optionalEnum(
        definition.field("operationType"),
        "NewBodyOperationType",
        "operationType",
        "NEW",
    );
    if (operation !== "ADD") return;
    const copies = ctx.bodies.filter(
        (body) => body.bodyAttr.createdBy.startsWith(`${id}/`) && body.isModelGeometry,
    );
    const [first, ...rest] = seeds.filter((body) => body.kind === "SOLID");
    if (first === undefined) return;
    booleanInto(ctx, id, first, [...rest, ...copies.filter((body) => body.kind === "SOLID")], "UNION", false);
}

function featureExtrudeExtent(ctx: FsContext, definition: FsMap): ExtrudeExtent {
    const bound = optionalEnum(definition.field("endBound"), "BoundingType", "endBound", "BLIND");
    const depthValue = definition.field("depth") ?? definition.field("endDepth");
    if (bound === "SYMMETRIC") {
        const depth = lengthMm(depthValue, "depth");
        return { end: depth / 2, start: depth / 2 };
    }
    const end = boundDistance(ctx, bound, depthValue, "depth");
    let start = 0;
    if (definition.field("hasSecondDirection") === true) {
        const secondBound = optionalEnum(
            definition.field("secondDirectionBound"),
            "BoundingType",
            "secondDirectionBound",
            "BLIND",
        );
        start = boundDistance(
            ctx,
            secondBound,
            definition.field("secondDirectionDepth"),
            "secondDirectionDepth",
        );
    }
    return { end, start };
}
