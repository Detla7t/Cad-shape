// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, type ISurface, ShapeTypes, XYZ } from "@chili3d/core";
import {
    ANGLE,
    expectQuantity,
    FsArray,
    FsMap,
    FsQuantity,
    type FsValue,
    fail,
    LENGTH,
    toDisplayString,
} from "../lang/values";
import { createdByMatches, idString, makeId } from "../std/feature";
import {
    type LineData,
    type PlaneData,
    readDirection,
    readLine,
    readPlane,
    type Vec3,
    vec,
} from "../std/geometry";
import { arg, enumName, type StdBuilder } from "../std/registry";
import {
    type EntityKind,
    type EntityRef,
    entityAttr,
    entityKey,
    entityShape,
    FsContext,
    MM_PER_METER,
    toKernelPlane,
} from "./fsContext";
import {
    dependencies,
    directSources,
    lastModifyingOperation,
    type TrackingSpec,
    trackedSerials,
} from "./history";
import {
    curveTypeOf,
    distanceTo,
    entitiesOf,
    facePlane,
    isQuery,
    measureOf,
    query,
    registerQueryType,
    relatedEntities,
    resolveQuery,
    samplePoints,
    subEntities,
    surfaceTypeOf,
    transientQuery,
} from "./queries";

/**
 * The query types past selection basics, as Onshape defines them in std's `query.fs`:
 * topology filters and flood fills (edge topology, tangent / convex / concave chains,
 * loops, shells, holes, fillets, congruent copies), geometric filters (lines, planes,
 * axes, directions, coincidence) and history queries (tracking, dependencies). Both stds
 * reach them: the bridge maps std's `QueryType` maps onto these, the native std builds
 * them with Onshape's constructor names. Query lengths are meters; the kernel is mm.
 */

/** Onshape's `TOLERANCE.zeroLength` (1e-8 m), in kernel mm. */
const LENGTH_TOLERANCE_MM = 1e-5;
/** Normals closer than this (radians) meet smoothly. */
const SMOOTH_ANGLE = 1e-6;
/** Where along an edge its join is sampled (fractions of the parameter range). */
const SAMPLES = [0.25, 0.5, 0.75];
/** Step (mm) into each face when telling how two smoothly joined faces bend. */
const BEND_STEP_MM = 0.01;
const BEND_TOLERANCE_MM = 1e-10;

const toM = (p: XYZ): Vec3 => [p.x / MM_PER_METER, p.y / MM_PER_METER, p.z / MM_PER_METER];
const asVec = (p: XYZ): Vec3 => [p.x, p.y, p.z];

const edgeOf = (ref: EntityRef): IEdge => ref.body.edges()[ref.index];
const faceOf = (ref: EntityRef): IFace => ref.body.faces()[ref.index];
const faceRef = (ref: EntityRef, index: number): EntityRef => ({ body: ref.body, kind: "FACE", index });

function unit(v: Vec3): Vec3 | undefined {
    const n = vec.norm(v);
    return n < 1e-12 ? undefined : vec.scale(v, 1 / n);
}

function dedupe(refs: readonly EntityRef[]): EntityRef[] {
    const seen = new Set<string>();
    return refs.filter((ref) => {
        const key = entityKey(ref);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function onlyKind(refs: readonly EntityRef[], kind: EntityKind): EntityRef[] {
    return refs.filter((ref) => ref.kind === kind);
}

// ------------------------------------------------------------------ Edge topology

/** The faces around an edge; `seam` when one face bounds it on both sides (a periodic face's seam). */
function edgeSides(ref: EntityRef): { faces: EntityRef[]; seam: boolean } {
    if (ref.kind !== "EDGE") return { faces: [], seam: false };
    const ancestors = edgeOf(ref).findAncestor(ShapeTypes.face, ref.body.shape);
    try {
        const faces = ref.body.faces();
        const indexes: number[] = [];
        for (const ancestor of ancestors) {
            const index = faces.findIndex((face) => face.isSame(ancestor));
            if (index >= 0) indexes.push(index);
        }
        const unique = [...new Set(indexes)];
        return {
            faces: unique.map((index) => faceRef(ref, index)),
            seam: unique.length === 1 && indexes.length > 1,
        };
    } finally {
        for (const ancestor of ancestors) ancestor.dispose();
    }
}

type EdgeTopology = "WIRE" | "ONE_SIDED" | "TWO_SIDED";

export function edgeTopologyOf(ref: EntityRef): EdgeTopology {
    const { faces, seam } = edgeSides(ref);
    if (faces.length === 0) return "WIRE";
    return faces.length === 1 && !seam ? "ONE_SIDED" : "TWO_SIDED";
}

function parameterAt(edge: IEdge, t: number): number {
    return edge.firstParameter() + (edge.lastParameter() - edge.firstParameter()) * t;
}

function tangentAt(edge: IEdge, u: number): Vec3 | undefined {
    try {
        return unit(asVec(edge.curve.d1(u).vec));
    } catch {
        return undefined;
    }
}

// ------------------------------------------------------------------ How two faces join along an edge

type JoinKind = "CONVEX" | "CONCAVE" | "SMOOTH_CONVEX" | "SMOOTH_CONCAVE" | "SMOOTH_FLAT" | "SMOOTH_MIXED";

interface Join {
    /** Per sample point: the join type there. */
    readonly kinds: readonly JoinKind[];
    /** Per sample point: the angle (radians) between the two face normals. */
    readonly angles: readonly number[];
}

/** +1 / -1 when the face runs along / against the edge's curve, 0 when it cannot tell. */
function orientationIn(face: IFace, edge: IEdge): 1 | -1 | 0 {
    const subs = face.findSubShapes(ShapeTypes.edge);
    try {
        const matches = subs.filter((sub) => sub.isSame(edge));
        if (matches.length !== 1) return 0;
        return matches[0].orientation() === "reversed" ? -1 : 1;
    } finally {
        for (const sub of subs) sub.dispose();
    }
}

/** The face's outward unit normal at a point on it (mm). */
function normalOn(face: IFace, surface: ISurface, p: XYZ): Vec3 | undefined {
    try {
        const uv = surface.parameter(p, 1e-3);
        if (uv === undefined) return undefined;
        return unit(asVec(face.normal(uv.u, uv.v)[1]));
    } catch {
        return undefined;
    }
}

function projected(surface: ISurface, p: XYZ): XYZ | undefined {
    try {
        return surface.nearestPoint(p)?.[0];
    } catch {
        return undefined;
    }
}

/**
 * How the two faces of a manifold edge meet at sample points along it. A face's boundary
 * runs with the face on its left (seen from the outward normal), so `n × t` points into
 * the face; the join is convex where the second face heads below the first face's tangent
 * plane. Where the normals agree (a smooth join) one small step into each face tells
 * whether the faces bend away (an exterior fillet: convex) or towards each other.
 */
function edgeJoin(ref: EntityRef): Join | undefined {
    const { faces, seam } = edgeSides(ref);
    if (seam) return { kinds: SAMPLES.map(() => "SMOOTH_FLAT"), angles: SAMPLES.map(() => 0) };
    if (faces.length !== 2) return undefined;
    const edge = edgeOf(ref);
    const [f1, f2] = faces.map(faceOf);
    const o1 = orientationIn(f1, edge);
    const o2 = orientationIn(f2, edge);
    if (o1 === 0 || o2 === 0) return undefined;
    let s1: ISurface | undefined;
    let s2: ISurface | undefined;
    try {
        s1 = f1.surface();
        s2 = f2.surface();
        const kinds: JoinKind[] = [];
        const angles: number[] = [];
        for (const t of SAMPLES) {
            const u = parameterAt(edge, t);
            const p = edge.pointAt(u);
            const tangent = tangentAt(edge, u);
            const n1 = normalOn(f1, s1, p);
            const n2 = normalOn(f2, s2, p);
            if (tangent === undefined || n1 === undefined || n2 === undefined) return undefined;
            const b1 = vec.cross(n1, vec.scale(tangent, o1));
            const b2 = vec.cross(n2, vec.scale(tangent, o2));
            const angle = Math.atan2(vec.norm(vec.cross(n1, n2)), vec.dot(n1, n2));
            angles.push(angle);
            if (angle > SMOOTH_ANGLE) {
                kinds.push((vec.dot(b2, n1) + vec.dot(b1, n2)) / 2 < 0 ? "CONVEX" : "CONCAVE");
                continue;
            }
            const bend = (surface: ISurface, into: Vec3, normal: Vec3) => {
                const q = projected(surface, p.add(new XYZ(...vec.scale(into, BEND_STEP_MM))));
                return q === undefined ? 0 : vec.dot(asVec(q.sub(p)), normal);
            };
            const d1 = bend(s1, b1, n2);
            const d2 = bend(s2, b2, n1);
            const down = d1 < -BEND_TOLERANCE_MM || d2 < -BEND_TOLERANCE_MM;
            const up = d1 > BEND_TOLERANCE_MM || d2 > BEND_TOLERANCE_MM;
            kinds.push(
                down && up ? "SMOOTH_MIXED" : down ? "SMOOTH_CONVEX" : up ? "SMOOTH_CONCAVE" : "SMOOTH_FLAT",
            );
        }
        return { kinds, angles };
    } catch {
        return undefined;
    } finally {
        s1?.dispose();
        s2?.dispose();
    }
}

class JoinCache {
    private readonly joins = new Map<string, Join | undefined>();

    of(ref: EntityRef): Join | undefined {
        const key = entityKey(ref);
        if (!this.joins.has(key)) this.joins.set(key, edgeJoin(ref));
        return this.joins.get(key);
    }
}

const isConvexJoin = (join: Join | undefined): boolean =>
    join?.kinds.every((k) => k === "CONVEX" || k === "SMOOTH_CONVEX") === true;
const isConcaveJoin = (join: Join | undefined): boolean =>
    join?.kinds.every((k) => k === "CONCAVE" || k === "SMOOTH_CONCAVE") === true;
const isTangentJoin = (join: Join | undefined, tolerance = SMOOTH_ANGLE): boolean =>
    join?.angles.every((angle) => angle <= tolerance) === true;

/** Onshape's `EdgeConvexityType` of an edge between two faces; undefined for other edges. */
export function edgeConvexity(ref: EntityRef): "CONVEX" | "CONCAVE" | "SMOOTH" | "VARIABLE" | undefined {
    const join = edgeJoin(ref);
    if (join === undefined) return undefined;
    if (join.kinds.every((k) => k === "CONVEX")) return "CONVEX";
    if (join.kinds.every((k) => k === "CONCAVE")) return "CONCAVE";
    if (join.kinds.every((k) => k.startsWith("SMOOTH"))) return "SMOOTH";
    return "VARIABLE";
}

// ------------------------------------------------------------------ Flood fills

/** Faces reachable from `seeds` across edges `cross` allows, never entering a `blocked` face. */
function floodFaces(
    seeds: readonly EntityRef[],
    cross: (edge: EntityRef) => boolean,
    blocked: (face: EntityRef) => boolean = () => false,
    steps = Number.POSITIVE_INFINITY,
): EntityRef[] {
    const result = dedupe(onlyKind(seeds, "FACE"));
    const seen = new Set(result.map(entityKey));
    let frontier = [...result];
    for (let step = 0; step < steps && frontier.length > 0; step++) {
        const next: EntityRef[] = [];
        for (const face of frontier) {
            for (const edge of subEntities(face, "EDGE")) {
                if (!cross(edge)) continue;
                for (const other of edgeSides(edge).faces) {
                    const key = entityKey(other);
                    if (seen.has(key) || blocked(other)) continue;
                    seen.add(key);
                    result.push(other);
                    next.push(other);
                }
            }
        }
        frontier = next;
    }
    return result;
}

/** Unit directions leaving the point `at` (mm) along the edge — two for a closed edge's vertex. */
function leaving(edge: IEdge, at: XYZ): Vec3[] {
    const result: Vec3[] = [];
    try {
        const first = edge.firstParameter();
        const last = edge.lastParameter();
        if (edge.pointAt(first).distanceTo(at) < LENGTH_TOLERANCE_MM) {
            const t = tangentAt(edge, first);
            if (t !== undefined) result.push(t);
        }
        if (edge.pointAt(last).distanceTo(at) < LENGTH_TOLERANCE_MM) {
            const t = tangentAt(edge, last);
            if (t !== undefined) result.push(vec.scale(t, -1));
        }
    } catch {
        // A degenerate edge leaves in no direction.
    }
    return result;
}

/** Edges joined to `seeds` through vertices where they continue tangentially (one step, or a whole chain). */
function floodEdges(seeds: readonly EntityRef[], steps = Number.POSITIVE_INFINITY): EntityRef[] {
    const result = dedupe(onlyKind(seeds, "EDGE"));
    const seen = new Set(result.map(entityKey));
    let frontier = [...result];
    for (let step = 0; step < steps && frontier.length > 0; step++) {
        const next: EntityRef[] = [];
        for (const edge of frontier) {
            for (const vertex of subEntities(edge, "VERTEX")) {
                const at = vertex.body.vertices()[vertex.index].point();
                const out = leaving(edgeOf(edge), at);
                for (const other of relatedEntities(vertex, "EDGE")) {
                    const key = entityKey(other);
                    if (seen.has(key)) continue;
                    const back = leaving(edgeOf(other), at);
                    if (!out.some((d1) => back.some((d2) => vec.norm(vec.add(d1, d2)) < 1e-6))) continue;
                    seen.add(key);
                    result.push(other);
                    next.push(other);
                }
            }
        }
        frontier = next;
    }
    return result;
}

// ------------------------------------------------------------------ Loops and shells

/** A face's boundary loops, as edge refs (outer and inner). */
function faceLoops(ref: EntityRef): EntityRef[][] {
    const wires = faceOf(ref).findSubShapes(ShapeTypes.wire);
    try {
        return wires.map((wire) => edgesAmong(ref, wire));
    } finally {
        for (const wire of wires) wire.dispose();
    }
}

/** The body's edges that are edges of `shape`. */
function edgesAmong(ref: EntityRef, shape: IShape): EntityRef[] {
    const subs = shape.findSubShapes(ShapeTypes.edge);
    try {
        const edges = ref.body.edges();
        const result: EntityRef[] = [];
        for (const sub of subs) {
            const index = edges.findIndex((edge) => edge.isSame(sub));
            if (index >= 0) result.push({ body: ref.body, kind: "EDGE", index });
        }
        return dedupe(result);
    } finally {
        for (const sub of subs) sub.dispose();
    }
}

function outerLoop(ref: EntityRef): EntityRef[] {
    let wire: IShape | undefined;
    try {
        wire = faceOf(ref).outerWire();
        return edgesAmong(ref, wire);
    } catch {
        return [];
    } finally {
        wire?.dispose();
    }
}

/** The faces of the shell containing a face (the face alone when its body has no shell). */
function shellFaces(ref: EntityRef): EntityRef[] {
    const face = faceOf(ref);
    const shells = ref.body.shape.findSubShapes(ShapeTypes.shell);
    try {
        for (const shell of shells) {
            const faces = shell.findSubShapes(ShapeTypes.face);
            try {
                if (!faces.some((candidate) => candidate.isSame(face))) continue;
                const all = ref.body.faces();
                const indexes = faces.map((f) => all.findIndex((candidate) => candidate.isSame(f)));
                return indexes
                    .filter((index) => index >= 0)
                    .sort((a, b) => a - b)
                    .map((index) => faceRef(ref, index));
            } finally {
                for (const f of faces) f.dispose();
            }
        }
        return [ref];
    } finally {
        for (const shell of shells) shell.dispose();
    }
}

/** `qLoopBoundedFaces`: the faces on the far side of the face's loop through the edge, up to the face. */
function loopBoundedFaces(refs: readonly EntityRef[]): EntityRef[] {
    const face = refs.find((ref) => ref.kind === "FACE");
    const edge = refs.find((ref) => ref.kind === "EDGE");
    if (face === undefined || edge === undefined) return [];
    const loop = faceLoops(face).find((edges) => edges.some((e) => entityKey(e) === entityKey(edge)));
    if (loop === undefined) return [];
    const boundary = entityKey(face);
    const seeds = dedupe(loop.flatMap((e) => edgeSides(e).faces)).filter((f) => entityKey(f) !== boundary);
    return floodFaces(
        seeds,
        () => true,
        (f) => entityKey(f) === boundary,
    );
}

/** `qFaceOrEdgeBoundedFaces`: faces reached from the first (seed) face without crossing the bounding faces or edges. */
function boundedFaces(refs: readonly EntityRef[]): EntityRef[] {
    const [seed, ...bounds] = refs;
    if (seed === undefined || seed.kind !== "FACE") return [];
    const faces = new Set(onlyKind(bounds, "FACE").map(entityKey));
    const edges = new Set(onlyKind(bounds, "EDGE").map(entityKey));
    return floodFaces(
        [seed],
        (edge) => !edges.has(entityKey(edge)),
        (face) => faces.has(entityKey(face)),
    );
}

// ------------------------------------------------------------------ Axes, circles, radii

interface Axis {
    /** Meters. */
    readonly origin: Vec3;
    readonly direction: Vec3;
}

function circleOf(edge: IEdge): { center: Vec3; axis: Vec3; radius: number } | undefined {
    try {
        const curve = edge.curve as unknown as {
            basisCurve?: { center?: XYZ; axis?: XYZ; radius?: number };
            center?: XYZ;
            axis?: XYZ;
            radius?: number;
        };
        const circle = curve.basisCurve ?? curve;
        if (circle.center === undefined || circle.axis === undefined || circle.radius === undefined)
            return undefined;
        const axis = unit(asVec(circle.axis));
        if (axis === undefined) return undefined;
        return { center: toM(circle.center), axis, radius: circle.radius / MM_PER_METER };
    } catch {
        return undefined;
    }
}

type SurfaceProbe = {
    location?: XYZ;
    axis?: XYZ;
    radius?: number;
    minorRadius?: number;
    majorRadius?: number;
    direction?: () => XYZ;
    basisCurve?: () => unknown;
    referencePlane?: () => unknown;
    dispose(): void;
};

function withSurface<T>(face: IFace, read: (surface: SurfaceProbe, type: string) => T): T | undefined {
    let surface: SurfaceProbe | undefined;
    try {
        const type = surfaceTypeOf(face);
        surface = face.surface() as unknown as SurfaceProbe;
        return read(surface, type);
    } catch {
        return undefined;
    } finally {
        surface?.dispose();
    }
}

/** The axis of an axis-symmetric edge or face (line, circle, cylinder, cone, torus, revolved surface). */
function entityAxis(ref: EntityRef): Axis | undefined {
    if (ref.kind === "EDGE") {
        const edge = edgeOf(ref);
        const type = curveTypeOf(edge);
        if (type === "LINE") {
            try {
                const [a, b] = edge.ends();
                const direction = unit(asVec(b.sub(a)));
                return direction === undefined ? undefined : { origin: toM(a), direction };
            } catch {
                return undefined;
            }
        }
        if (type === "CIRCLE" || type === "ARC") {
            const circle = circleOf(edge);
            return circle === undefined ? undefined : { origin: circle.center, direction: circle.axis };
        }
        return undefined;
    }
    if (ref.kind !== "FACE") return undefined;
    return withSurface(faceOf(ref), (surface, type) => {
        if (
            (type === "CYLINDER" || type === "CONE" || type === "TORUS") &&
            surface.location &&
            surface.axis
        ) {
            const direction = unit(asVec(surface.axis));
            return direction === undefined ? undefined : { origin: toM(surface.location), direction };
        }
        if (typeof surface.referencePlane === "function" && typeof surface.direction === "function") {
            const direction = unit(asVec(surface.direction()));
            const location = surface.location;
            return direction === undefined || location === undefined
                ? undefined
                : { origin: toM(location), direction };
        }
        return undefined;
    });
}

function onLine(point: Vec3, axis: Axis): boolean {
    const offset = vec.sub(point, axis.origin);
    const along = vec.scale(axis.direction, vec.dot(offset, axis.direction));
    return vec.norm(vec.sub(offset, along)) * MM_PER_METER < LENGTH_TOLERANCE_MM;
}

function sameAxis(a: Axis, b: Axis): boolean {
    return vec.norm(vec.cross(a.direction, b.direction)) < 1e-9 && onLine(a.origin, b);
}

/** The blend radius (mm) of a cylinder, torus (minor) or sphere face. */
function blendRadius(ref: EntityRef): number | undefined {
    return withSurface(faceOf(ref), (surface, type) => {
        if (type === "CYLINDER" || type === "SPHERE") return surface.radius;
        if (type === "TORUS") return surface.minorRadius;
        return undefined;
    });
}

/**
 * The fillet radius (mm) of a face that is a blend — a cylinder, torus or sphere joining
 * at least two neighbouring faces smoothly; undefined for any other face.
 */
function filletRadius(ref: EntityRef, joins: JoinCache): number | undefined {
    if (ref.kind !== "FACE") return undefined;
    const radius = blendRadius(ref);
    if (radius === undefined) return undefined;
    const smooth = new Set<string>();
    for (const edge of subEntities(ref, "EDGE")) {
        if (!isTangentJoin(joins.of(edge))) continue;
        for (const other of edgeSides(edge).faces)
            if (entityKey(other) !== entityKey(ref)) smooth.add(entityKey(other));
    }
    return smooth.size >= 2 ? radius : undefined;
}

/** The common axis of a planar face bounded only by coaxial circles (a hole floor, a counterbore step). */
function discAxis(ref: EntityRef): Axis | undefined {
    const plane = facePlane(faceOf(ref));
    if (plane === undefined) return undefined;
    let axis: Axis | undefined;
    for (const edge of subEntities(ref, "EDGE")) {
        const circle = circleOf(edgeOf(edge));
        if (circle === undefined) return undefined;
        const own = { origin: circle.center, direction: circle.axis };
        if (axis === undefined) axis = own;
        else if (!sameAxis(own, axis)) return undefined;
    }
    return axis !== undefined && vec.norm(vec.cross(plane.normal, axis.direction)) < 1e-9 ? axis : undefined;
}

/** `qHoleFaces`: from a face inside a hole, the connected faces coaxial with it (walls, cone tips, floors). */
function holeFaces(seed: EntityRef): EntityRef[] {
    const type = surfaceTypeOf(faceOf(seed));
    const axis =
        type === "CYLINDER" || type === "CONE"
            ? entityAxis(seed)
            : type === "PLANE"
              ? discAxis(seed)
              : undefined;
    if (axis === undefined) return [];
    const belongs = (face: EntityRef) => {
        const faceType = surfaceTypeOf(faceOf(face));
        if (faceType === "PLANE") {
            const own = discAxis(face);
            return own !== undefined && sameAxis(own, axis);
        }
        if (faceType === "SPHERE") {
            const center = withSurface(faceOf(face), (surface) => surface.location);
            return center !== undefined && onLine(toM(center), axis);
        }
        const other = entityAxis(face);
        return other !== undefined && sameAxis(other, axis);
    };
    return floodFaces(
        [seed],
        () => true,
        (face) => !belongs(face),
    );
}

// ------------------------------------------------------------------ Geometric filters

/** Bounding sphere (mm) of an entity. */
function boundsOf(ref: EntityRef): { center: Vec3; radius: number } {
    const box = entityShape(ref).boundingBox();
    const min = [box.min.x, box.min.y, box.min.z];
    const max = [box.max.x, box.max.y, box.max.z];
    const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    return { center, radius: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 };
}

function vertexPoint(ref: EntityRef): XYZ {
    return ref.body.vertices()[ref.index].point();
}

/** Distance (mm) from an entity to an infinite line (meters), through a segment spanning the entity. */
function lineDistance(ref: EntityRef, line: LineData): number {
    const direction = vec.normalize(line.direction);
    const origin = vec.scale(line.origin, MM_PER_METER);
    if (ref.kind === "VERTEX") {
        const offset = vec.sub(asVec(vertexPoint(ref)), origin);
        return vec.norm(vec.sub(offset, vec.scale(direction, vec.dot(offset, direction))));
    }
    const { center, radius } = boundsOf(ref);
    const foot = vec.add(origin, vec.scale(direction, vec.dot(vec.sub(center, origin), direction)));
    const reach = vec.norm(vec.sub(center, foot)) + radius + 10;
    const segment = shapeFactory.line(
        new XYZ(...vec.sub(foot, vec.scale(direction, reach))),
        new XYZ(...vec.add(foot, vec.scale(direction, reach))),
    );
    if (!segment.isOk) fail("Could not build the line to intersect");
    try {
        return entityShape(ref).extremaDistance(segment.value);
    } finally {
        segment.value.dispose();
    }
}

/** Distance (mm) from an entity to an infinite plane (meters) shifted `offset` mm along its normal. */
function planeDistance(ref: EntityRef, plane: PlaneData, offset = 0): number {
    const normal = vec.normalize(plane.normal);
    const origin = vec.add(vec.scale(plane.origin, MM_PER_METER), vec.scale(normal, offset));
    if (ref.kind === "VERTEX") return Math.abs(vec.dot(vec.sub(asVec(vertexPoint(ref)), origin), normal));
    const { center, radius } = boundsOf(ref);
    const height = vec.dot(vec.sub(center, origin), normal);
    const foot = vec.sub(center, vec.scale(normal, height));
    const size = 2 * (Math.abs(height) + radius) + 10;
    const sheet = shapeFactory.rect(
        toKernelPlane(
            { origin: vec.scale(foot, 1 / MM_PER_METER), normal, x: vec.perpendicular(normal) },
            -size / 2,
            -size / 2,
        ),
        size,
        size,
    );
    if (!sheet.isOk) fail("Could not build the plane to intersect");
    try {
        return entityShape(ref).extremaDistance(sheet.value);
    } finally {
        sheet.value.dispose();
    }
}

/** `qInFrontOfPlane`: on the normal's side of the plane or in it — touching allowed, crossing not. */
function inFrontOf(ref: EntityRef, plane: PlaneData): boolean {
    const normal = vec.normalize(plane.normal);
    const origin = vec.scale(plane.origin, MM_PER_METER);
    const height = (p: XYZ) => vec.dot(vec.sub(asVec(p), origin), normal);
    if (ref.kind === "VERTEX") return height(vertexPoint(ref)) >= -LENGTH_TOLERANCE_MM;
    if (planeDistance(ref, plane) > LENGTH_TOLERANCE_MM) {
        const probe = samplePoints(ref)[0] ?? new XYZ(...boundsOf(ref).center);
        return height(probe) > 0;
    }
    // Touching: in front unless it also reaches a hair behind the plane.
    return planeDistance(ref, plane, -100 * LENGTH_TOLERANCE_MM) > LENGTH_TOLERANCE_MM;
}

function facesParallelTo(ref: EntityRef, direction: Vec3, planesOnly: boolean): boolean {
    if (ref.kind !== "FACE") return false;
    const face = faceOf(ref);
    const plane = facePlane(face);
    if (plane !== undefined) return Math.abs(vec.dot(plane.normal, direction)) < 1e-9;
    if (planesOnly) return false;
    return (
        withSurface(face, (surface, type) => {
            let along: Vec3 | undefined;
            if (type === "CYLINDER" && surface.axis !== undefined) along = unit(asVec(surface.axis));
            else if (
                typeof surface.direction === "function" &&
                typeof surface.basisCurve === "function" &&
                typeof surface.referencePlane !== "function"
            )
                along = unit(asVec(surface.direction()));
            return along !== undefined && vec.norm(vec.cross(along, direction)) < 1e-9;
        }) ?? false
    );
}

function coincident(a: EntityRef, b: EntityRef): boolean {
    if (a.kind !== b.kind) return false;
    if (entityKey(a) === entityKey(b)) return true;
    if (a.kind === "VERTEX") return vertexPoint(a).distanceTo(vertexPoint(b)) < LENGTH_TOLERANCE_MM;
    const ma = measureOf(a);
    const mb = measureOf(b);
    if (Math.abs(ma - mb) > 1e-6 * Math.max(1, Math.abs(ma))) return false;
    const within = (points: XYZ[], other: EntityRef) =>
        points.length > 0 &&
        points.every((p) => distanceTo(other, toM(p)) * MM_PER_METER < LENGTH_TOLERANCE_MM);
    return within(samplePoints(a), b) && within(samplePoints(b), a);
}

/** A size-and-shape fingerprint: equal for congruent faces or edges (`qMatching`). */
function fingerprint(ref: EntityRef): number[] | undefined {
    if (ref.kind === "EDGE") {
        const edge = edgeOf(ref);
        const type = curveTypeOf(edge);
        return [
            ["LINE", "CIRCLE", "ARC", "OTHER_CURVE"].indexOf(type),
            measureOf(ref),
            circleOf(edge)?.radius ?? 0,
        ];
    }
    if (ref.kind !== "FACE") return undefined;
    const types = ["PLANE", "CYLINDER", "CONE", "SPHERE", "TORUS", "OTHER_SURFACE"];
    const lengths = subEntities(ref, "EDGE")
        .map(measureOf)
        .sort((x, y) => x - y);
    const radius = blendRadius(ref) ?? 0;
    return [types.indexOf(surfaceTypeOf(faceOf(ref))), measureOf(ref), radius, lengths.length, ...lengths];
}

function sameFingerprint(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1e-6 * Math.max(1, Math.abs(x)));
}

function matching(refs: readonly EntityRef[]): EntityRef[] {
    const result: EntityRef[] = [];
    for (const ref of refs) {
        const print = fingerprint(ref);
        if (print === undefined) continue;
        for (const candidate of entitiesOf(ref.body, ref.kind)) {
            const other = fingerprint(candidate);
            if (other !== undefined && sameFingerprint(print, other)) result.push(candidate);
        }
    }
    return dedupe(result);
}

function compare(value: number, reference: number, type: string): boolean {
    const tolerance = LENGTH_TOLERANCE_MM;
    switch (type) {
        case "LESS":
            return value < reference - tolerance;
        case "LESS_EQUAL":
            return value <= reference + tolerance;
        case "GREATER":
            return value > reference + tolerance;
        case "GREATER_EQUAL":
            return value >= reference - tolerance;
        default:
            return Math.abs(value - reference) <= tolerance;
    }
}

function filletFaces(refs: readonly EntityRef[], compareType: string): EntityRef[] {
    const joins = new JoinCache();
    const result: EntityRef[] = [];
    for (const ref of refs) {
        const radius = filletRadius(ref, joins);
        if (radius === undefined) continue;
        for (const candidate of entitiesOf(ref.body, "FACE")) {
            const other = filletRadius(candidate, joins);
            if (other !== undefined && compare(other, radius, compareType)) result.push(candidate);
        }
    }
    return dedupe(result);
}

function edgeVertex(ref: EntityRef, atStart: boolean): EntityRef | undefined {
    const edge = edgeOf(ref);
    let target: XYZ;
    try {
        target = edge.pointAt(atStart ? edge.firstParameter() : edge.lastParameter());
    } catch {
        return undefined;
    }
    let best: EntityRef | undefined;
    let bestDistance = LENGTH_TOLERANCE_MM;
    for (const vertex of subEntities(ref, "VERTEX")) {
        const distance = vertexPoint(vertex).distanceTo(target);
        if (distance <= bestDistance) {
            best = vertex;
            bestDistance = distance;
        }
    }
    return best;
}

function uniqueVertices(refs: readonly EntityRef[]): EntityRef[] {
    const kept: XYZ[] = [];
    return refs.filter((ref) => {
        if (ref.kind !== "VERTEX") return true;
        const p = vertexPoint(ref);
        if (kept.some((q) => q.distanceTo(p) < LENGTH_TOLERANCE_MM)) return false;
        kept.push(p);
        return true;
    });
}

// ------------------------------------------------------------------ History queries

/** Serials a query names. Transient queries name theirs even when the entity no longer exists. */
function serialsOf(ctx: FsContext, value: FsValue): Set<number> {
    const serials = new Set<number>();
    const visit = (item: FsValue) => {
        if (item instanceof FsArray) {
            for (const sub of item.items) visit(sub);
            return;
        }
        if (isQuery(item) && item.field("queryType") === "TRANSIENT") {
            const serial = Number(String(item.field("transientId")).slice(1));
            if (Number.isFinite(serial)) serials.add(serial);
            return;
        }
        for (const ref of resolveQuery(ctx, item)) serials.add(entityAttr(ref).serial);
    };
    visit(value);
    return serials;
}

function inOrder(ctx: FsContext, serials: ReadonlySet<number>, kind?: EntityKind): EntityRef[] {
    return ctx.bodies
        .flatMap((body) => entitiesOf(body, kind))
        .filter((ref) => serials.has(entityAttr(ref).serial));
}

function tracking(ctx: FsContext, value: FsMap): EntityRef[] {
    const last = value.field("lastOperationId");
    const spec: TrackingSpec = {
        tracked: serialsOf(ctx, value.field("tracked")),
        secondary:
            value.field("secondary") === undefined ? undefined : serialsOf(ctx, value.field("secondary")),
        after: last instanceof FsArray ? ctx.operations.lastIndexOf(idString(last)) : -1,
        partial: value.field("partial") === true,
        identityOnly: value.field("identityOnly") === true,
        followSplitMerge: value.field("followSplitMerge") === true,
    };
    return inOrder(ctx, trackedSerials(ctx, spec), optionalKind(value.field("entityType")));
}

const isSketchRegion = (ref: EntityRef) => ref.body.flags.sketch === true && ref.body.kind === "SHEET";

function trueDependencies(ctx: FsContext, refs: readonly EntityRef[]): EntityRef[] {
    return dedupe(refs.flatMap((ref) => dependencies(ctx, ref, { skip: isSketchRegion })));
}

function laminarDependencies(ctx: FsContext, refs: readonly EntityRef[]): EntityRef[] {
    const laminar = (ref: EntityRef) => ref.kind === "EDGE" && edgeTopologyOf(ref) === "ONE_SIDED";
    return dedupe(refs.flatMap((ref) => dependencies(ctx, ref, { accept: laminar })));
}

/** `IMPRINT` with `derivedFrom`: what an operation made purely from the given entities. */
function imprint(ctx: FsContext, value: FsMap): EntityRef[] {
    const id = idString(value.field("featureId"));
    const sources = serialsOf(ctx, value.field("derivedFrom"));
    const kind = optionalKind(value.field("entityType"));
    return ctx.bodies
        .flatMap((body) => entitiesOf(body, kind))
        .filter((ref) => {
            if (!createdByMatches(entityAttr(ref).createdBy, id)) return false;
            const inputs = directSources(ctx, entityAttr(ref).serial);
            return inputs.length > 0 && inputs.every((input) => sources.has(input));
        });
}

function optionalKind(value: FsValue): EntityKind | undefined {
    return value === undefined ? undefined : (enumName(value, "EntityType", "entityType") as EntityKind);
}

// ------------------------------------------------------------------ Resolvers

function sub(ctx: FsContext, value: FsMap, field = "query"): EntityRef[] {
    return resolveQuery(ctx, value.field(field));
}

const RESOLVERS: Record<string, (ctx: FsContext, value: FsMap) => EntityRef[]> = {
    EDGE_TOPOLOGY_FILTER: (ctx, value) => {
        const wanted = enumName(value.field("edgeTopology"), "EdgeTopology", "edgeTopologyType");
        const topology = wanted === "LAMINAR" ? "ONE_SIDED" : wanted;
        return onlyKind(sub(ctx, value), "EDGE").filter((ref) => edgeTopologyOf(ref) === topology);
    },
    EDGE_VERTEX: (ctx, value) =>
        dedupe(
            onlyKind(sub(ctx, value), "EDGE").flatMap((ref) => {
                const vertex = edgeVertex(ref, value.field("atStart") !== false);
                return vertex === undefined ? [] : [vertex];
            }),
        ),
    TANGENT_CONNECTED_EDGES: (ctx, value) => floodEdges(sub(ctx, value)),
    TANGENT_EDGES: (ctx, value) => floodEdges(sub(ctx, value), 1),
    TANGENT_CONNECTED_FACES: (ctx, value) => {
        const joins = new JoinCache();
        const tolerance = value.field("angleTolerance");
        const limit = typeof tolerance === "number" ? tolerance : SMOOTH_ANGLE;
        return floodFaces(sub(ctx, value), (edge) => isTangentJoin(joins.of(edge), limit));
    },
    TANGENT_FACES: (ctx, value) => {
        const joins = new JoinCache();
        return floodFaces(sub(ctx, value), (edge) => isTangentJoin(joins.of(edge)), undefined, 1);
    },
    CONVEX_CONNECTED_FACES: (ctx, value) => {
        const joins = new JoinCache();
        return floodFaces(sub(ctx, value), (edge) => isConvexJoin(joins.of(edge)));
    },
    CONCAVE_CONNECTED_FACES: (ctx, value) => {
        const joins = new JoinCache();
        return floodFaces(sub(ctx, value), (edge) => isConcaveJoin(joins.of(edge)));
    },
    EDGE_CONVEXITY_FILTER: (ctx, value) => {
        const wanted = enumName(value.field("convexityType"), "EdgeConvexityType", "convexityType");
        return onlyKind(sub(ctx, value), "EDGE").filter((ref) => edgeConvexity(ref) === wanted);
    },
    LOOP_BOUNDED_FACES: (ctx, value) => loopBoundedFaces(sub(ctx, value)),
    FACE_OR_EDGE_BOUNDED_FACES: (ctx, value) => boundedFaces(sub(ctx, value)),
    LOOP_AROUND_FACE: (ctx, value) => dedupe(onlyKind(sub(ctx, value), "FACE").flatMap(outerLoop)),
    SHELL_CONTAINING_FACE: (ctx, value) => dedupe(onlyKind(sub(ctx, value), "FACE").flatMap(shellFaces)),
    HOLE_FACES: (ctx, value) => {
        const seed = sub(ctx, value).find((ref) => ref.kind === "FACE");
        return seed === undefined ? [] : holeFaces(seed);
    },
    FILLET_FACES: (ctx, value) =>
        filletFaces(
            sub(ctx, value),
            enumName(value.field("compareType") ?? "EQUAL", "CompareType", "compareType"),
        ),
    MATCHING: (ctx, value) => matching(sub(ctx, value)),
    PATTERN_INSTANCES: (ctx, value) => {
        const id = idString(value.field("featureId"));
        const names = value.field("instanceNames");
        const list = names instanceof FsArray ? names.items : [names];
        const kind = optionalKind(value.field("entityType"));
        const all = ctx.bodies.flatMap((body) => entitiesOf(body, kind));
        return dedupe(
            list.flatMap((name) => {
                const instance = `${id}/${toDisplayString(name)}`;
                return all.filter((ref) => createdByMatches(entityAttr(ref).createdBy, instance));
            }),
        );
    },
    DEPENDENCY: (ctx, value) => trueDependencies(ctx, sub(ctx, value)),
    LAMINAR_DEPENDENCY: (ctx, value) => laminarDependencies(ctx, sub(ctx, value)),
    TRACKING: tracking,
    IMPRINT: imprint,
    INTERSECTS_LINE: (ctx, value) => {
        const line = readLine(value.field("line"), "qIntersectsLine line");
        return sub(ctx, value).filter((ref) => lineDistance(ref, line) < LENGTH_TOLERANCE_MM);
    },
    INTERSECTS_PLANE: (ctx, value) => {
        const plane = readPlane(value.field("plane"), "qIntersectsPlane plane");
        return sub(ctx, value).filter((ref) => planeDistance(ref, plane) < LENGTH_TOLERANCE_MM);
    },
    IN_FRONT_OF_PLANE: (ctx, value) => {
        const plane = readPlane(value.field("plane"), "qInFrontOfPlane plane");
        return sub(ctx, value).filter((ref) => inFrontOf(ref, plane));
    },
    PLANE_PARALLEL_DIRECTION: (ctx, value) => {
        const direction = readDirection(value.field("direction"), "qPlanesParallelToDirection direction");
        return sub(ctx, value).filter((ref) => facesParallelTo(ref, direction, true));
    },
    FACE_PARALLEL_DIRECTION: (ctx, value) => {
        const direction = readDirection(value.field("direction"), "qFacesParallelToDirection direction");
        return sub(ctx, value).filter((ref) => facesParallelTo(ref, direction, false));
    },
    UNIQUE_VERTICES: (ctx, value) => uniqueVertices(sub(ctx, value)),
    COINCIDENT: (ctx, value) => {
        const targets = sub(ctx, value, "target");
        return sub(ctx, value).filter((ref) => targets.some((target) => coincident(ref, target)));
    },
    COEDGE: (ctx, value) => {
        const faces = onlyKind(sub(ctx, value, "face"), "FACE");
        const bounding = new Set(faces.flatMap((face) => subEntities(face, "EDGE")).map(entityKey));
        return onlyKind(sub(ctx, value, "edge"), "EDGE").filter((edge) => bounding.has(entityKey(edge)));
    },
    AXIS: (ctx, value) => {
        const line = readLine(value.field("axis"), "qAxis axis");
        const axis: Axis = { origin: line.origin, direction: vec.normalize(line.direction) };
        return sub(ctx, value).filter((ref) => {
            const own = entityAxis(ref);
            return own !== undefined && sameAxis(own, axis);
        });
    },
};

// ------------------------------------------------------------------ Native std

/** Registers the resolvers and Onshape's constructors (and the evaluations built on them) in the native std. */
export function installQueryTypes(std: StdBuilder): void {
    for (const [type, resolve] of Object.entries(RESOLVERS)) registerQueryType(type, resolve);
    std.enumType("EdgeTopology", ["WIRE", "ONE_SIDED", "TWO_SIDED", "LAMINAR"]);
    std.enumType("CompareType", ["EQUAL", "LESS", "LESS_EQUAL", "GREATER", "GREATER_EQUAL"]);
    std.enumType("Consumed", ["YES", "NO"]);
    const convexity = std.enumType("EdgeConvexityType", ["CONVEX", "CONCAVE", "SMOOTH", "VARIABLE"]);
    const kind = (value: FsValue) => (value === undefined ? {} : { entityType: value });
    const unary = (name: string, type: string) => std.fn(name, (args) => query(type, { query: args[0] }));

    std.fn("qEdgeTopologyFilter", (args) =>
        query("EDGE_TOPOLOGY_FILTER", { query: args[0], edgeTopology: args[1] }),
    );
    std.fn("qEdgeVertex", (args) => query("EDGE_VERTEX", { query: args[0], atStart: args[1] }));
    unary("qTangentConnectedEdges", "TANGENT_CONNECTED_EDGES");
    std.fn("qTangentConnectedFaces", (args) =>
        query("TANGENT_CONNECTED_FACES", {
            query: args[0],
            angleTolerance:
                args[1] === undefined ? undefined : expectQuantity(args[1], ANGLE, "angleTolerance"),
        }),
    );
    unary("qConvexConnectedFaces", "CONVEX_CONNECTED_FACES");
    unary("qConcaveConnectedFaces", "CONCAVE_CONNECTED_FACES");
    std.fn("qEdgeConvexityTypeFilter", (args) =>
        query("EDGE_CONVEXITY_FILTER", { query: args[0], convexityType: args[1] }),
    );
    unary("qLoopBoundedFaces", "LOOP_BOUNDED_FACES");
    unary("qFaceOrEdgeBoundedFaces", "FACE_OR_EDGE_BOUNDED_FACES");
    unary("qHoleFaces", "HOLE_FACES");
    std.fn("qFilletFaces", (args) => query("FILLET_FACES", { query: args[0], compareType: args[1] }));
    unary("qMatching", "MATCHING");
    std.fn("qPatternInstances", (args) =>
        query("PATTERN_INSTANCES", { featureId: args[0], instanceNames: args[1], ...kind(args[2]) }),
    );
    unary("qDependency", "DEPENDENCY");
    unary("qLaminarDependency", "LAMINAR_DEPENDENCY");
    std.fn("qIntersectsLine", (args) => query("INTERSECTS_LINE", { query: args[0], line: args[1] }));
    std.fn("qIntersectsPlane", (args) => query("INTERSECTS_PLANE", { query: args[0], plane: args[1] }));
    std.fn("qInFrontOfPlane", (args) => query("IN_FRONT_OF_PLANE", { query: args[0], plane: args[1] }));
    std.fn("qPlanesParallelToDirection", (args) =>
        query("PLANE_PARALLEL_DIRECTION", { query: args[0], direction: args[1] }),
    );
    std.fn("qFacesParallelToDirection", (args) =>
        query("FACE_PARALLEL_DIRECTION", { query: args[0], direction: args[1] }),
    );
    unary("qUniqueVertices", "UNIQUE_VERTICES");
    std.fn("qCoincidentFilter", (args) => query("COINCIDENT", { query: args[0], target: args[1] }));
    std.fn("qCoEdge", (args) => query("COEDGE", { face: args[0], edge: args[1] }));
    std.fn("qAxis", (args) => query("AXIS", { query: args[0], axis: args[1] }));
    // Nothing here is a mesh, a composite part, a flat pattern or an opHole result.
    std.fn("qConsumed", (args) =>
        enumName(args[1], "Consumed", "consumed") === "YES" ? query("NOTHING") : (args[0] as FsMap),
    );
    for (const name of [
        "qSourceMesh",
        "qCorrespondingInFlat",
        "qPartsAttachedTo",
        "qOpHoleProfile",
        "qOpHoleFace",
    ])
        std.fn(name, () => query("NOTHING"));
    std.fn("qToleranceFilter", () => query("NOTHING"));

    std.fn("startTracking", (args) => startTracking(args, false));
    std.fn("startTrackingIdentity", (args) => startTracking([args[0], args[1]], true));
    std.fn("makeRobustQuery", (args) => {
        const ctx = FsContext.of(arg(args, 0, "makeRobustQuery"));
        const evaluated = resolveQuery(ctx, args[1]).map(transientQuery);
        return query("UNION", {
            subqueries: new FsArray([...evaluated, startTracking([args[0], args[1]], true)]),
        });
    });
    std.fn("lastModifyingOperationId", (args) =>
        lastModifyingOperationIdOf(FsContext.of(arg(args, 0, "lastModifyingOperationId")), args[1]),
    );
    std.fn("evEdgeConvexity", (args) => {
        const [ctx, edge] = definitionArgs(args, "evEdgeConvexity", "edge");
        const ref = onlyKind(resolveQuery(ctx, edge), "EDGE")[0];
        if (ref === undefined) fail("evEdgeConvexity: the edge query resolves to no edge");
        const type = edgeConvexity(ref);
        if (type === undefined) fail("evEdgeConvexity needs an edge between two faces");
        return convexity.member(type);
    });
    std.fn("evFilletRadius", (args) => {
        const [ctx, face] = definitionArgs(args, "evFilletRadius", "face");
        const ref = onlyKind(resolveQuery(ctx, face), "FACE")[0];
        const radius = ref === undefined ? undefined : filletRadius(ref, new JoinCache());
        if (radius === undefined) fail("evFilletRadius needs a fillet face");
        return new FsQuantity(radius / MM_PER_METER, LENGTH);
    });
}

function definitionArgs(args: FsValue[], fn: string, field: string): [FsContext, FsValue] {
    const ctx = FsContext.of(arg(args, 0, fn));
    const definition = args[1];
    if (!(definition instanceof FsMap)) fail(`${fn} expects a definition map`);
    return [ctx, definition.field(field)];
}

/** Native `startTracking(context, query | map | sketchId, entityId?)`; identity tracking with `identityOnly`. */
function startTracking(args: FsValue[], identityOnly: boolean): FsMap {
    const ctx = FsContext.of(arg(args, 0, "startTracking"));
    let spec: FsMap;
    if (args.length >= 3) {
        const entity = query("SKETCH_ENTITY", { featureId: args[1], sketchEntityId: args[2] });
        const derived = query("IMPRINT", { featureId: args[1], derivedFrom: entity });
        spec = new FsMap([["subquery", query("UNION", { subqueries: new FsArray([entity, derived]) })]]);
    } else if (isQuery(args[1])) {
        spec = new FsMap([["subquery", args[1]]]);
    } else if (args[1] instanceof FsMap) {
        spec = args[1];
    } else {
        fail("startTracking needs a query or a definition map");
    }
    const evaluate = (value: FsValue) =>
        value === undefined ? undefined : new FsArray(resolveQuery(ctx, value).map(transientQuery));
    return query("TRACKING", {
        tracked: evaluate(spec.field("subquery")),
        secondary: evaluate(spec.field("secondarySubquery")),
        partial: spec.field("trackPartialDependency") === true,
        lastOperationId: spec.field("lastOperationId") ?? lastOperationIdOf(ctx),
        identityOnly,
        followSplitMerge: false,
    });
}

/** `@lastOperationId`: the latest geometry-changing operation's Id (empty before any). */
export function lastOperationIdOf(ctx: FsContext): FsArray {
    const last = ctx.operations[ctx.operations.length - 1];
    return makeId(last === undefined ? [] : last.split("/"));
}

/** `@lastModifyingOperationId`. */
export function lastModifyingOperationIdOf(ctx: FsContext, value: FsValue): FsArray {
    const ref = resolveQuery(ctx, value)[0];
    if (ref === undefined) fail("lastModifyingOperationId: the query resolves to nothing");
    return makeId(lastModifyingOperation(ctx, ref).split("/"));
}
