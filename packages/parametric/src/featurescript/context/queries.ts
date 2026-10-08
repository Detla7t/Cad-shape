// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, type ISolid, ShapeTypes, XYZ } from "@chili3d/core";
import {
    describeValue,
    expectArray,
    expectNumber,
    FsArray,
    type FsEnumValue,
    FsMap,
    FsQuantity,
    type FsValue,
    fail,
    fsMap,
    LENGTH,
    toDisplayString,
    unitsEqual,
} from "../lang/values";
import { createdByMatches, idString } from "../std/feature";
import { readDirection, readPlane, readPoint, type Vec3, vec } from "../std/geometry";
import { enumName, type StdBuilder } from "../std/registry";
import {
    type EntityKind,
    type EntityRef,
    entityAttr,
    entityKey,
    entityShape,
    type FsBody,
    FsContext,
    HOST_ID,
    MM_PER_METER,
} from "./fsContext";

/**
 * Queries are plain `Query`-tagged maps (so code can build, print and pass them around);
 * `resolveQuery` turns one into the entities it currently names. Resolution order is
 * deterministic — body creation order, then sub-shape index — so `qNthElement` and
 * `evaluateQuery` indexes are stable across rebuilds of unchanged geometry.
 */

export function query(queryType: string, fields: Record<string, FsValue> = {}): FsMap {
    return fsMap({ queryType, ...fields }, "Query");
}

export function isQuery(value: FsValue): value is FsMap {
    return value instanceof FsMap && value.tag === "Query";
}

const SUB_KINDS = ["FACE", "EDGE", "VERTEX"] as const;

function optionalKind(value: FsValue): EntityKind | undefined {
    if (value === undefined) return undefined;
    return enumName(value, "EntityType", "entityType") as EntityKind;
}

/** A transient query naming one entity — what `evaluateQuery` hands out. */
export function transientQuery(ref: EntityRef): FsMap {
    return query("TRANSIENT", {
        transientId: `T${entityAttr(ref).serial}`,
        entityKind: ref.kind,
    });
}

// ------------------------------------------------------------------ Resolution

/** Resolvers for query types another layer defines (std attribute filters, ...). */
const extensions = new Map<string, (ctx: FsContext, value: FsMap) => EntityRef[]>();

export function registerQueryType(
    type: string,
    resolve: (ctx: FsContext, value: FsMap) => EntityRef[],
): void {
    extensions.set(type, resolve);
}

const seamsByShape = new WeakMap<IShape, Set<number>>();

/** OCCT's periodic seam is a parameterization artifact, not an Onshape topological edge. */
export function resolveQuery(ctx: FsContext, value: FsValue): EntityRef[] {
    return resolveKernelQuery(ctx, value).filter((ref) => {
        if (ref.kind !== "EDGE" || !ref.body.shape.seamEdges) return true;
        let seams = seamsByShape.get(ref.body.shape);
        if (!seams) {
            seams = new Set(ref.body.shape.seamEdges());
            seamsByShape.set(ref.body.shape, seams);
        }
        return !seams.has(ref.index);
    });
}

function resolveKernelQuery(ctx: FsContext, value: FsValue): EntityRef[] {
    if (value instanceof FsArray) return union(value.items.map((item) => resolveQuery(ctx, item)));
    if (!isQuery(value)) {
        const shown = value instanceof FsMap ? ` ${toDisplayString(value).slice(0, 160)}` : "";
        fail(`Expected a Query, got ${describeValue(value)}${shown}`);
    }
    const type = value.field("queryType");
    switch (type) {
        case "NOTHING":
            return [];
        case "EVERYTHING":
            return allEntities(ctx, optionalKind(value.field("entityType"))).filter(
                (ref) => !ref.body.flags.defaultGeometry,
            );
        case "CREATED_BY": {
            const id = idString(value.field("featureId"));
            const kind = optionalKind(value.field("entityType"));
            return allEntities(ctx, kind).filter((ref) => createdByMatches(entityAttr(ref).createdBy, id));
        }
        case "TRANSIENT":
            return resolveTransient(ctx, value);
        case "UNION":
            return union(subqueries(value).map((sub) => resolveQuery(ctx, sub)));
        case "INTERSECTION": {
            const parts = subqueries(value).map((sub) => resolveQuery(ctx, sub));
            if (parts.length === 0) return [];
            const rest = parts.slice(1).map((part) => new Set(part.map(entityKey)));
            return parts[0].filter((ref) => rest.every((set) => set.has(entityKey(ref))));
        }
        case "SUBTRACTION": {
            const removed = new Set(resolveQuery(ctx, value.field("query2")).map(entityKey));
            return resolveQuery(ctx, value.field("query1")).filter((ref) => !removed.has(entityKey(ref)));
        }
        case "NTH_ELEMENT": {
            const refs = resolveQuery(ctx, value.field("query"));
            let n = expectNumber(value.field("n"), "qNthElement index");
            if (n < 0) n += refs.length;
            return refs[n] === undefined ? [] : [refs[n]];
        }
        case "ENTITY_FILTER": {
            const kind = optionalKind(value.field("entityType"));
            return resolveQuery(ctx, value.field("query")).filter(
                (ref) => kind === undefined || ref.kind === kind,
            );
        }
        case "OWNER_BODY":
            return union([ownerBodies(resolveQuery(ctx, value.field("query")))]);
        case "OWNED_BY_BODY": {
            const kind = optionalKind(value.field("entityType"));
            const bodies = ownerBodies(resolveQuery(ctx, value.field("body")));
            return bodies.flatMap((ref) => entitiesOf(ref.body, kind));
        }
        case "BODY_TYPE": {
            const wanted = enumList(value.field("bodyType"), "BodyType");
            return resolveQuery(ctx, value.field("query")).filter((ref) => wanted.has(ref.body.bodyType));
        }
        case "GEOMETRY": {
            const wanted = enumList(value.field("geometryType"), "GeometryType");
            return resolveQuery(ctx, value.field("query")).filter((ref) => {
                const type = geometryTypeOf(ref);
                return type !== undefined && wanted.has(type);
            });
        }
        case "CONSTRUCTION_FILTER": {
            const yes = enumName(value.field("filter"), "ConstructionObject", "constructionFilter") === "YES";
            return resolveQuery(ctx, value.field("query")).filter(
                (ref) => (ref.body.flags.construction === true) === yes,
            );
        }
        case "SKETCH_FILTER": {
            const yes = enumName(value.field("filter"), "SketchObject", "sketchObjectFilter") === "YES";
            return resolveQuery(ctx, value.field("query")).filter(
                (ref) => (ref.body.flags.sketch === true) === yes,
            );
        }
        case "SKETCH_REGION": {
            const id = idString(value.field("featureId"));
            // `filterInnerLoops` keeps only regions not nested inside another region.
            const outerOnly = value.field("filterInnerLoops") === true;
            return ctx.bodies
                .filter(
                    (body) =>
                        body.flags.sketch &&
                        body.kind === "SHEET" &&
                        createdByMatches(body.bodyAttr.createdBy, id),
                )
                .flatMap((body) => entitiesOf(body, "FACE"))
                .filter((ref) => !outerOnly || (entityAttr(ref).regionDepth ?? 0) % 2 === 0);
        }
        case "SKETCH_ENTITY": {
            const id = idString(value.field("featureId"));
            const entity = String(value.field("sketchEntityId"));
            const kind = optionalKind(value.field("entityType")) ?? "EDGE";
            return ctx.bodies
                .filter((body) => body.flags.sketch && createdByMatches(body.bodyAttr.createdBy, id))
                .flatMap((body) => entitiesOf(body, kind))
                .filter((ref) => entityAttr(ref).sketchEntity === entity);
        }
        case "CAP_ENTITY":
        case "NON_CAP_ENTITY":
            return capEntities(ctx, value, type === "CAP_ENTITY");
        case "ADJACENT":
            return adjacent(ctx, value);
        case "LARGEST":
        case "SMALLEST":
            return extremeByMeasure(resolveQuery(ctx, value.field("query")), type === "LARGEST" ? 1 : -1);
        case "CLOSEST_TO":
            return closestTo(
                resolveQuery(ctx, value.field("query")),
                readPoint(value.field("point"), "qClosestTo point"),
            );
        case "FARTHEST_ALONG":
            return farthestAlong(
                resolveQuery(ctx, value.field("query")),
                readDirection(value.field("direction"), "qFarthestAlong direction"),
            );
        case "CONTAINS_POINT":
            return containsPoint(
                resolveQuery(ctx, value.field("query")),
                readPoint(value.field("point"), "qContainsPoint point"),
            );
        case "WITHIN_RADIUS": {
            const center = readPoint(value.field("point"), "qWithinRadius point");
            const radius = lengthValue(value.field("radius"), "qWithinRadius radius");
            return resolveQuery(ctx, value.field("query")).filter(
                (ref) => distanceTo(ref, center) <= radius + 1e-9,
            );
        }
        case "COINCIDES_WITH_PLANE":
            return coincidesWithPlane(resolveQuery(ctx, value.field("query")), value.field("plane"));
        case "PARALLEL_PLANES":
            return parallelPlanes(resolveQuery(ctx, value.field("query")), value);
        case "PARALLEL_EDGES": {
            const direction = readDirection(value.field("direction"), "qParallelEdges direction");
            return resolveQuery(ctx, value.field("query")).filter((ref) => {
                if (ref.kind !== "EDGE") return false;
                const edge = ref.body.edges()[ref.index];
                if (curveTypeOf(edge) !== "LINE") return false;
                const [a, b] = edge.ends();
                const d = vec.normalize([b.x - a.x, b.y - a.y, b.z - a.z]);
                return vec.norm(vec.cross(d, direction)) < 1e-9;
            });
        }
        case "HOST":
            return allEntities(ctx, optionalKind(value.field("entityType"))).filter(
                (ref) => ref.body.bodyAttr.createdBy === HOST_ID,
            );
        default: {
            const extension = typeof type === "string" ? extensions.get(type) : undefined;
            if (extension !== undefined) return extension(ctx, value);
            fail(`Unknown query type ${String(type)}`);
        }
    }
}

function subqueries(value: FsMap): FsValue[] {
    return expectArray(value.field("subqueries"), "subqueries").items;
}

function union(parts: EntityRef[][]): EntityRef[] {
    const seen = new Set<string>();
    const result: EntityRef[] = [];
    for (const part of parts) {
        for (const ref of part) {
            const key = entityKey(ref);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(ref);
        }
    }
    return result;
}

function enumList(value: FsValue, type: string): Set<string> {
    if (value instanceof FsArray) return new Set(value.items.map((item) => enumName(item, type, type)));
    return new Set([enumName(value, type, type)]);
}

export function entitiesOf(body: FsBody, kind: EntityKind | undefined): EntityRef[] {
    const result: EntityRef[] = [];
    if (kind === undefined || kind === "BODY") result.push({ body, kind: "BODY", index: -1 });
    for (const sub of SUB_KINDS) {
        if (kind !== undefined && kind !== sub) continue;
        const count = body.attrs(sub).length;
        for (let index = 0; index < count; index++) result.push({ body, kind: sub, index });
    }
    return result;
}

function allEntities(ctx: FsContext, kind: EntityKind | undefined): EntityRef[] {
    return ctx.bodies.flatMap((body) => entitiesOf(body, kind));
}

export function ownerBodies(refs: readonly EntityRef[]): EntityRef[] {
    return union([refs.map((ref) => ({ body: ref.body, kind: "BODY" as const, index: -1 }))]);
}

function resolveTransient(ctx: FsContext, value: FsMap): EntityRef[] {
    const id = String(value.field("transientId"));
    const serial = Number(id.slice(1));
    const kind = value.field("entityKind") as EntityKind | undefined;
    for (const body of ctx.bodies) {
        if ((kind === undefined || kind === "BODY") && body.bodyAttr.serial === serial)
            return [{ body, kind: "BODY", index: -1 }];
        for (const sub of SUB_KINDS) {
            if (kind !== undefined && kind !== sub) continue;
            const index = body.attrs(sub).findIndex((attr) => attr.serial === serial);
            if (index >= 0) return [{ body, kind: sub, index }];
        }
    }
    return [];
}

function capEntities(ctx: FsContext, value: FsMap, caps: boolean): EntityRef[] {
    const id = idString(value.field("featureId"));
    const kind = optionalKind(value.field("entityType")) ?? "FACE";
    const capType = caps ? enumName(value.field("capType") ?? "EITHER", "CapType", "capType") : "EITHER";
    const isCap = (ref: EntityRef) => {
        const cap = entityAttr(ref).cap;
        return cap !== undefined && (capType === "EITHER" || cap === capType);
    };
    const faces = allEntities(ctx, "FACE").filter((ref) => createdByMatches(entityAttr(ref).createdBy, id));
    const capFaces = faces.filter(isCap);
    if (kind === "FACE") return caps ? capFaces : faces.filter((ref) => !isCap(ref));
    // Edges/vertices of a cap are those bounding the cap faces.
    const capSubs = union(capFaces.map((ref) => subEntities(ref, kind)));
    if (caps) return capSubs;
    const capKeys = new Set(capSubs.map(entityKey));
    return allEntities(ctx, kind).filter(
        (ref) => createdByMatches(entityAttr(ref).createdBy, id) && !capKeys.has(entityKey(ref)),
    );
}

// ------------------------------------------------------------------ Topology adjacency

/** Index of `shape` among `candidates` by kernel identity. */
function indexOfSame(candidates: readonly IShape[], shape: IShape): number {
    return candidates.findIndex((candidate) => candidate.isSame(shape));
}

/** Lower-dimensional entities bounding `ref` (a face's edges, an edge's vertices, ...). */
export function subEntities(ref: EntityRef, kind: EntityKind): EntityRef[] {
    if (kind === "BODY") return [{ body: ref.body, kind: "BODY", index: -1 }];
    if (ref.kind === "BODY") return entitiesOf(ref.body, kind);
    const shape = entityShape(ref);
    const candidates = ref.body.subShapes(kind);
    const subs = shape.findSubShapes(
        kind === "FACE" ? ShapeTypes.face : kind === "EDGE" ? ShapeTypes.edge : ShapeTypes.vertex,
    );
    const result: EntityRef[] = [];
    try {
        for (const sub of subs) {
            const index = indexOfSame(candidates, sub);
            if (index >= 0 && !result.some((r) => r.index === index))
                result.push({ body: ref.body, kind, index });
        }
    } finally {
        for (const sub of subs) sub.dispose();
    }
    return result;
}

/** Higher-dimensional entities containing `ref` (the faces around an edge, ...). */
function superEntities(ref: EntityRef, kind: EntityKind): EntityRef[] {
    if (ref.kind === "BODY" || kind === "BODY") return [{ body: ref.body, kind: "BODY", index: -1 }];
    const shape = entityShape(ref);
    const candidates = ref.body.subShapes(kind);
    const ancestors = shape.findAncestor(kind === "FACE" ? ShapeTypes.face : ShapeTypes.edge, ref.body.shape);
    const result: EntityRef[] = [];
    try {
        for (const ancestor of ancestors) {
            const index = indexOfSame(candidates, ancestor);
            if (index >= 0 && !result.some((r) => r.index === index))
                result.push({ body: ref.body, kind, index });
        }
    } finally {
        for (const ancestor of ancestors) ancestor.dispose();
    }
    return result;
}

const RANK: Record<EntityKind, number> = { VERTEX: 0, EDGE: 1, FACE: 2, BODY: 3 };

/** Entities of `kind` related to `ref` through topology (contained or containing). */
export function relatedEntities(ref: EntityRef, kind: EntityKind): EntityRef[] {
    if (kind === ref.kind) return [ref];
    return RANK[kind] < RANK[ref.kind] ? subEntities(ref, kind) : superEntities(ref, kind);
}

function adjacent(ctx: FsContext, value: FsMap): EntityRef[] {
    const inputs = resolveQuery(ctx, value.field("query"));
    const through = enumName(value.field("adjacencyType") ?? "EDGE", "AdjacencyType", "adjacencyType") as
        | "EDGE"
        | "VERTEX";
    const kind = optionalKind(value.field("entityType"));
    const inputKeys = new Set(inputs.map(entityKey));
    const result: EntityRef[][] = [];
    for (const ref of inputs) {
        const wanted = kind ?? ref.kind;
        // Same-kind adjacency goes through the shared boundary entity; a different
        // kind is plain containment (a face's edges, an edge's faces).
        if (wanted !== ref.kind) {
            result.push(relatedEntities(ref, wanted));
            continue;
        }
        const shared = RANK[through] < RANK[ref.kind] ? subEntities(ref, through) : [ref];
        result.push(
            shared
                .flatMap((sub) => relatedEntities(sub, wanted))
                .filter((other) => !inputKeys.has(entityKey(other))),
        );
    }
    return union(result);
}

// ------------------------------------------------------------------ Geometry

/** The GeometryType name of a face or edge; undefined for bodies and vertices. */
export function geometryTypeOf(ref: EntityRef): string | undefined {
    if (ref.kind === "FACE") return surfaceTypeOf(entityShape(ref) as IFace);
    if (ref.kind === "EDGE") return curveTypeOf(entityShape(ref) as IEdge);
    return undefined;
}

export function surfaceTypeOf(face: IFace): string {
    let surface: ReturnType<IFace["surface"]> | undefined;
    try {
        surface = face.surface();
        if (surface.isPlanar()) return "PLANE";
        // The core surface interface has no type tag; the elementary kinds are told
        // apart by the members only they carry.
        const s = surface as unknown as {
            majorRadius?: number;
            apex?: unknown;
            radius?: number;
            axis?: unknown;
        };
        if ("majorRadius" in s) return "TORUS";
        if (typeof s.apex === "function") return "CONE";
        if ("radius" in s && "axis" in s) {
            const bounds = surface.bounds();
            return Math.abs(bounds.v2 - bounds.v1) < 10 ? "SPHERE" : "CYLINDER";
        }
        return "OTHER_SURFACE";
    } catch {
        return "OTHER_SURFACE";
    } finally {
        surface?.dispose();
    }
}

export function curveTypeOf(edge: IEdge): string {
    try {
        const curve = edge.curve;
        const basis = (curve as unknown as { basisCurve?: { curveType: string } }).basisCurve ?? curve;
        switch (basis.curveType) {
            case "line":
                return "LINE";
            case "circle": {
                const span = edge.lastParameter() - edge.firstParameter();
                return Math.abs(span - 2 * Math.PI) < 1e-6 ? "CIRCLE" : "ARC";
            }
            default:
                return "OTHER_CURVE";
        }
    } catch {
        return "OTHER_CURVE";
    }
}

/** Length/area/volume of an entity, in kernel units (for largest/smallest). */
export function measureOf(ref: EntityRef): number {
    const shape = entityShape(ref);
    try {
        switch (ref.kind) {
            case "EDGE":
                return (shape as IEdge).length();
            case "FACE":
                return (shape as IFace).area();
            case "BODY":
                if (ref.body.kind === "SOLID") return shape.volume();
                if (ref.body.kind === "SHEET")
                    return ref.body.faces().reduce((sum, face) => sum + face.area(), 0);
                if (ref.body.kind === "WIRE")
                    return ref.body.edges().reduce((sum, edge) => sum + edge.length(), 0);
                return 0;
            default:
                return 0;
        }
    } catch {
        return 0;
    }
}

function extremeByMeasure(refs: EntityRef[], sign: 1 | -1): EntityRef[] {
    if (refs.length === 0) return [];
    const measures = refs.map(measureOf);
    const best = sign > 0 ? Math.max(...measures) : Math.min(...measures);
    const tolerance = 1e-9 * Math.max(1, Math.abs(best));
    return refs.filter((_, i) => Math.abs(measures[i] - best) <= tolerance);
}

/** Sample points (mm) of an entity — vertices plus points along curved edges. */
export function samplePoints(ref: EntityRef): XYZ[] {
    if (ref.kind === "VERTEX") return [ref.body.vertices()[ref.index].point()];
    const edges =
        ref.kind === "EDGE"
            ? [ref.body.edges()[ref.index]]
            : subEntities(ref, "EDGE").map((edge) => ref.body.edges()[edge.index]);
    const points: XYZ[] = [];
    for (const edge of edges) {
        try {
            const first = edge.firstParameter();
            const last = edge.lastParameter();
            const steps = curveTypeOf(edge) === "LINE" ? 1 : 16;
            for (let i = 0; i <= steps; i++) points.push(edge.pointAt(first + ((last - first) * i) / steps));
        } catch {
            // A degenerate edge contributes no samples.
        }
    }
    if (points.length === 0 && ref.kind !== "EDGE") {
        for (const vertex of ref.kind === "BODY" ? ref.body.vertices() : []) points.push(vertex.point());
    }
    return points;
}

/**
 * The entities reaching farthest along `direction`. Ties on the far extent (a box's top
 * face and its four side faces all reach the top) go to the entities lying farthest
 * as a whole — the top face — by comparing their near extent too.
 */
function farthestAlong(refs: EntityRef[], direction: Vec3): EntityRef[] {
    if (refs.length === 0) return [];
    const extents = refs.map((ref) => {
        const projections = samplePoints(ref).map(
            (p) => p.x * direction[0] + p.y * direction[1] + p.z * direction[2],
        );
        return projections.length === 0
            ? { far: Number.NEGATIVE_INFINITY, near: Number.NEGATIVE_INFINITY }
            : { far: Math.max(...projections), near: Math.min(...projections) };
    });
    const far = Math.max(...extents.map((e) => e.far));
    const tied = refs.map((_, i) => i).filter((i) => Math.abs(extents[i].far - far) < 1e-6);
    const near = Math.max(...tied.map((i) => extents[i].near));
    return tied.filter((i) => Math.abs(extents[i].near - near) < 1e-6).map((i) => refs[i]);
}

/** Distance (meters) from an entity to a point (meters). */
export function distanceTo(ref: EntityRef, point: Vec3): number {
    const vertex = shapeFactory.point({
        x: point[0] * MM_PER_METER,
        y: point[1] * MM_PER_METER,
        z: point[2] * MM_PER_METER,
    });
    if (!vertex.isOk) return Number.POSITIVE_INFINITY;
    try {
        return entityShape(ref).extremaDistance(vertex.value) / MM_PER_METER;
    } catch {
        return Number.POSITIVE_INFINITY;
    } finally {
        vertex.value.dispose();
    }
}

function closestTo(refs: EntityRef[], point: Vec3): EntityRef[] {
    if (refs.length === 0) return [];
    const distances = refs.map((ref) => distanceTo(ref, point));
    const best = Math.min(...distances);
    return refs.filter((_, i) => distances[i] - best < 1e-9);
}

function containsPoint(refs: EntityRef[], point: Vec3): EntityRef[] {
    const p = new XYZ(point[0] * MM_PER_METER, point[1] * MM_PER_METER, point[2] * MM_PER_METER);
    return refs.filter((ref) => {
        try {
            if (ref.kind === "BODY" && ref.body.kind === "SOLID") {
                const solids =
                    ref.body.shape.shapeType === ShapeTypes.solid
                        ? [ref.body.shape as ISolid]
                        : (ref.body.shape.findSubShapes(ShapeTypes.solid) as ISolid[]);
                return solids.some((solid) => solid.containsPoint(p, true, 1e-6));
            }
            if (ref.kind === "FACE") return (entityShape(ref) as IFace).containsPoint(p, true, 1e-6);
            return distanceTo(ref, point) < 1e-8;
        } catch {
            return false;
        }
    });
}

function lengthValue(value: FsValue, what: string): number {
    if (value instanceof FsQuantity && unitsEqual(value.units, LENGTH)) return value.value;
    fail(`${what} must be a length`);
}

/** Plane (meters) of a planar face, oriented by the face's outward normal; undefined otherwise. */
export function facePlane(face: IFace): { origin: Vec3; normal: Vec3 } | undefined {
    if (surfaceTypeOf(face) !== "PLANE") return undefined;
    const [point, normal] = face.normal(0, 0);
    return {
        origin: [point.x / MM_PER_METER, point.y / MM_PER_METER, point.z / MM_PER_METER],
        normal: vec.normalize([normal.x, normal.y, normal.z]),
    };
}

function coincidesWithPlane(refs: EntityRef[], planeValue: FsValue): EntityRef[] {
    const plane = readPlane(planeValue, "qCoincidesWithPlane plane");
    const onPlane = (p: XYZ) =>
        Math.abs(
            vec.dot(
                vec.sub([p.x / MM_PER_METER, p.y / MM_PER_METER, p.z / MM_PER_METER], plane.origin),
                plane.normal,
            ),
        ) < 1e-8;
    return refs.filter((ref) => {
        if (ref.kind === "BODY") return false;
        if (ref.kind === "FACE") {
            const face = facePlane(entityShape(ref) as IFace);
            if (face === undefined || vec.norm(vec.cross(face.normal, plane.normal)) > 1e-9) return false;
        }
        const points = samplePoints(ref);
        return points.length > 0 && points.every(onPlane);
    });
}

function parallelPlanes(refs: EntityRef[], value: FsMap): EntityRef[] {
    const reference = value.field("normal");
    const normal =
        reference instanceof FsMap
            ? readPlane(reference, "qParallelPlanes plane").normal
            : readDirection(reference, "qParallelPlanes normal");
    const allowAnti = value.field("allowAntiparallel") !== false;
    return refs.filter((ref) => {
        if (ref.kind !== "FACE") return false;
        const plane = facePlane(entityShape(ref) as IFace);
        if (plane === undefined) return false;
        const dot = vec.dot(plane.normal, normal);
        return allowAnti ? Math.abs(Math.abs(dot) - 1) < 1e-9 : Math.abs(dot - 1) < 1e-9;
    });
}

// ------------------------------------------------------------------ Std registration

export function installQueries(std: StdBuilder): void {
    std.tagType("Query");
    const kindField = (value: FsValue) => (value === undefined ? {} : { entityType: value });

    std.fn("qNothing", () => query("NOTHING"));
    std.fn("qEverything", (args) => query("EVERYTHING", kindField(args[0])));
    std.fn("qAllModifiableSolidBodies", () =>
        query("CONSTRUCTION_FILTER", {
            query: query("BODY_TYPE", {
                query: query("EVERYTHING", { entityType: entityTypeValue(std, "BODY") }),
                bodyType: enumValue(std, "BodyType", "SOLID"),
            }),
            filter: enumValue(std, "ConstructionObject", "NO"),
        }),
    );
    std.fn("qHostBody", (args) => query("HOST", kindField(args[0])));
    std.fn("qCreatedBy", (args) => query("CREATED_BY", { featureId: args[0], ...kindField(args[1]) }));
    std.fn("qUnion", (args) =>
        query("UNION", {
            subqueries: args.length === 1 && args[0] instanceof FsArray ? args[0] : new FsArray(args),
        }),
    );
    std.fn("qIntersection", (args) =>
        query("INTERSECTION", {
            subqueries: args.length === 1 && args[0] instanceof FsArray ? args[0] : new FsArray(args),
        }),
    );
    std.fn("qSubtraction", (args) => query("SUBTRACTION", { query1: args[0], query2: args[1] }));
    std.fn("qNthElement", (args) => query("NTH_ELEMENT", { query: args[0], n: args[1] }));
    std.fn("qEntityFilter", (args) => query("ENTITY_FILTER", { query: args[0], entityType: args[1] }));
    std.fn("qOwnerBody", (args) => query("OWNER_BODY", { query: args[0] }));
    std.fn("qOwnedByBody", (args) => query("OWNED_BY_BODY", { body: args[0], ...kindField(args[1]) }));
    std.fn("qBodyType", (args) => query("BODY_TYPE", { query: args[0], bodyType: args[1] }));
    std.fn("qGeometry", (args) => query("GEOMETRY", { query: args[0], geometryType: args[1] }));
    std.fn("qConstructionFilter", (args) =>
        query("CONSTRUCTION_FILTER", { query: args[0], filter: args[1] }),
    );
    std.fn("qSketchFilter", (args) => query("SKETCH_FILTER", { query: args[0], filter: args[1] }));
    std.fn("qSketchRegion", (args) =>
        query("SKETCH_REGION", { featureId: args[0], filterInnerLoops: args[1] ?? false }),
    );
    std.fn("sketchEntityQuery", (args) =>
        query("SKETCH_ENTITY", { featureId: args[0], entityType: args[1], sketchEntityId: args[2] }),
    );
    std.fn("qCapEntity", (args) =>
        query("CAP_ENTITY", { featureId: args[0], capType: args[1], ...kindField(args[2]) }),
    );
    std.fn("qNonCapEntity", (args) => query("NON_CAP_ENTITY", { featureId: args[0], ...kindField(args[1]) }));
    std.fn("qAdjacent", (args) =>
        query("ADJACENT", { query: args[0], adjacencyType: args[1], ...kindField(args[2]) }),
    );
    std.fn("qEdgeAdjacent", (args) =>
        query("ADJACENT", {
            query: args[0],
            adjacencyType: enumValue(std, "AdjacencyType", "EDGE"),
            ...kindField(args[1]),
        }),
    );
    std.fn("qVertexAdjacent", (args) =>
        query("ADJACENT", {
            query: args[0],
            adjacencyType: enumValue(std, "AdjacencyType", "VERTEX"),
            ...kindField(args[1]),
        }),
    );
    std.fn("qLoopEdges", (args) => query("LOOP_EDGES", { query: args[0] }));
    std.fn("qLargest", (args) => query("LARGEST", { query: args[0] }));
    std.fn("qSmallest", (args) => query("SMALLEST", { query: args[0] }));
    std.fn("qClosestTo", (args) => query("CLOSEST_TO", { query: args[0], point: args[1] }));
    std.fn("qFarthestAlong", (args) => query("FARTHEST_ALONG", { query: args[0], direction: args[1] }));
    std.fn("qContainsPoint", (args) => query("CONTAINS_POINT", { query: args[0], point: args[1] }));
    std.fn("qWithinRadius", (args) =>
        query("WITHIN_RADIUS", { query: args[0], point: args[1], radius: args[2] }),
    );
    std.fn("qCoincidesWithPlane", (args) =>
        query("COINCIDES_WITH_PLANE", { query: args[0], plane: args[1] }),
    );
    std.fn("qParallelEdges", (args) => query("PARALLEL_EDGES", { query: args[0], direction: args[1] }));
    std.fn("qParallelPlanes", (args) =>
        query("PARALLEL_PLANES", { query: args[0], normal: args[1], allowAntiparallel: args[2] ?? true }),
    );

    std.fn("evaluateQuery", (args) => {
        const ctx = FsContext.of(args[0]);
        return new FsArray(resolveQuery(ctx, args[1]).map(transientQuery));
    });
    std.fn("isQueryEmpty", (args) => resolveQuery(FsContext.of(args[0]), args[1]).length === 0);
}

function enumValue(std: StdBuilder, type: string, member: string): FsValue {
    const value = std.interpreter.std.lookup(type)?.value as
        | { member(name: string): FsEnumValue | undefined }
        | undefined;
    const result = value?.member(member);
    if (result === undefined) fail(`Unknown enum value ${type}.${member}`);
    return result;
}

function entityTypeValue(std: StdBuilder, member: string): FsValue {
    return enumValue(std, "EntityType", member);
}
