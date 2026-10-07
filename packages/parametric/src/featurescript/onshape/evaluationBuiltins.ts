// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ICircle, IEdge, IFace } from "@chili3d/core";
import {
    curvatureDerivative,
    curvatureFrame,
    edgeCurve,
    edgeParameter,
    type FaceCurvature,
    faceCurvature,
    faceSide,
    outwardNormal,
    parameterDirection,
    secondFundamentalForm,
    surfaceDerivatives,
    toMeters,
    toVec,
} from "../context/differential";
import {
    denormalize,
    type FaceDomain,
    faceDomain,
    orientedEdges,
    surfaceParameters,
} from "../context/faceDomain";
import { type EntityRef, entityShape, FsContext, MM_PER_METER } from "../context/fsContext";
import { inertiaTensor, massData, symmetricEigen } from "../context/massProperties";
import {
    curveTypeOf,
    relatedEntities,
    resolveQuery,
    surfaceTypeOf,
    transientQuery,
} from "../context/queries";
import {
    clash,
    closestOnEdge,
    closestOnEntity,
    leafEntities,
    offsetPairs,
    raycast,
} from "../context/spatial";
import {
    expectArray,
    expectNumber,
    FsArray,
    FsMap,
    FsQuantity,
    type FsValue,
    fail,
    fsArray,
    fsMap,
    LENGTH,
    type Units,
} from "../lang/values";
import {
    makeCoordSystem,
    makePlane,
    makePlaneData,
    point,
    readCoordSystem,
    readLine,
    readPoint,
    readVector,
    type Vec3,
    vec,
} from "../std/geometry";
import type { StdBridge } from "./bridge";
import type { BuiltinRegistry } from "./registry";

/**
 * The evaluation built-ins (`evaluate.fs`) the kernel layer did not provide: curvatures,
 * tangent planes along faces and edges, edge convexity, planarity, ray casts, mass
 * properties, collisions, deviations, offset faces and body clustering. Arguments arrive
 * as std values and are translated by the bridge; geometry is evaluated in kernel
 * millimetres and returned in meters.
 */

const PER_METER: Units = { meter: -1, radian: 0, kilogram: 0, second: 0 };
const PER_SQUARE_METER: Units = { meter: -2, radian: 0, kilogram: 0, second: 0 };

export function installEvaluationBuiltins(define: BuiltinRegistry, bridge: StdBridge): void {
    /** The context and the definition map translated to kernel-layer values. */
    const input = (args: FsValue[]): [FsContext, FsMap] => {
        const context = FsContext.of(args[0]);
        const definition = bridge.toLocal(args[1]);
        if (!(definition instanceof FsMap)) fail("Expected an evaluation definition map");
        return [context, definition];
    };
    const resolve = (context: FsContext, query: FsValue) =>
        query === undefined ? [] : resolveQuery(context, query);
    const first = (context: FsContext, query: FsValue, kind: EntityRef["kind"], what: string): EntityRef => {
        const ref = resolve(context, query).find((candidate) => candidate.kind === kind);
        if (ref === undefined)
            fail(`${what} does not resolve to ${kind === "EDGE" ? "an edge" : `a ${kind.toLowerCase()}`}`);
        return ref;
    };
    const define2 = (name: string, impl: (context: FsContext, definition: FsMap) => FsValue) =>
        define(name, (args) => bridge.toStd(impl(...input(args))));

    // ------------------------------------------------------------------ Faces

    define2("evFaceTangentPlanes", (context, definition) => {
        const face = first(context, definition.field("face"), "FACE", "evFaceTangentPlanes face");
        const outsideUndefined = definition.field("returnUndefinedOutsideFace") === true;
        return withDomain(face, (domain) =>
            fsArray(
                parameterList(definition.field("parameters"), 2).map(([s, t]) => {
                    const { u, v } = denormalize(domain, s, t);
                    const d = domain.surface.d1(u, v);
                    if (outsideUndefined && !domain.face.containsPoint(d.point, true, 1e-6)) return undefined;
                    return tangentPlane(domain, toVec(d.point), toVec(d.d1u), toVec(d.d1v));
                }),
            ),
        );
    });
    define2("evFaceTangentPlanesAtEdge", (context, definition) => {
        const edgeRef = first(context, definition.field("edge"), "EDGE", "evFaceTangentPlanesAtEdge edge");
        const faceRef = first(context, definition.field("face"), "FACE", "evFaceTangentPlanesAtEdge face");
        const arcLength = definition.field("arcLengthParameterization") !== false;
        const useFace = definition.field("usingFaceOrientation") === true;
        const edge = entityShape(edgeRef) as IEdge;
        const curve = edgeCurve(edge);
        return withDomain(faceRef, (domain) =>
            fsArray(
                parameterList(definition.field("parameters"), 1).map(([t]) => {
                    const u = edgeParameter(edge, t, arcLength);
                    const d = curve.d1(u);
                    const sign = useFace ? faceSide(edge, domain.face, domain, u) : 1;
                    const uv = surfaceParameters(domain.surface, d.point);
                    const s = domain.surface.d1(uv.u, uv.v);
                    const normal = outwardNormal(domain, toVec(s.d1u), toVec(s.d1v));
                    const tangent = vec.scale(toVec(d.vec), sign);
                    return makePlane(makePlaneData(toMeters(d.point), normal, inPlane(tangent, normal)));
                }),
            ),
        );
    });
    define2("evFaceCurvatures", (context, definition) => {
        const face = first(context, definition.field("face"), "FACE", "evFaceCurvatures face");
        return withDomain(face, (domain) =>
            fsArray(
                parameterList(definition.field("parameters"), 2).map(([s, t]) => {
                    const { u, v } = denormalize(domain, s, t);
                    return curvatureResult(faceCurvature(domain, u, v));
                }),
            ),
        );
    });
    define2("evFaceCurvatureDerivatives", (context, definition) => {
        const face = first(context, definition.field("face"), "FACE", "evFaceCurvatureDerivatives face");
        const parameters = parameterList(definition.field("parameters"), 2);
        const directions = expectArray(definition.field("directions"), "directions").items.map((d) =>
            vec.normalize(readVector(d, "direction").values as Vec3),
        );
        if (directions.length !== parameters.length)
            fail("evFaceCurvatureDerivatives needs one direction per parameter");
        return withDomain(face, (domain) => {
            const box = (entityShape(face) as IFace).boundingBox();
            const size = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
            const step = 1e-4 * Math.max(size, 1e-3);
            return fsArray(
                parameters.map(([s, t], i) => {
                    const { u, v } = denormalize(domain, s, t);
                    const d = surfaceDerivatives(domain.surface, u, v);
                    const [du, dv] = parameterDirection(d.su, d.sv, directions[i]);
                    const at = (k: number) =>
                        secondFundamentalForm(faceCurvature(domain, u + k * step * du, v + k * step * dv));
                    const ahead = at(1);
                    const behind = at(-1);
                    // Per millimetre of travel → per meter.
                    return fsArray(
                        ahead.map((row, r) =>
                            fsArray(
                                row.map((value, c) => ((value - behind[r][c]) / (2 * step)) * MM_PER_METER),
                            ),
                        ),
                    );
                }),
            );
        });
    });
    define2("evFacePeriodicity", (context, definition) => {
        const face = first(context, definition.field("face"), "FACE", "evFacePeriodicity face");
        const trimmed = definition.field("trimmed") !== false;
        return withDomain(face, (domain) =>
            fsArray(trimmed ? [domain.u.closed, domain.v.closed] : [domain.u.periodic, domain.v.periodic]),
        );
    });
    define2("evFilletRadius", (context, definition) => {
        const face = first(context, definition.field("face"), "FACE", "evFilletRadius face");
        return new FsQuantity(filletRadius(face), LENGTH);
    });

    // ------------------------------------------------------------------ Edges

    define2("evEdgeCurvatures", (context, definition) => {
        const edgeRef = first(context, definition.field("edge"), "EDGE", "evEdgeCurvatures edge");
        const edge = entityShape(edgeRef) as IEdge;
        const curve = edgeCurve(edge);
        const arcLength = definition.field("arcLengthParameterization") !== false;
        const faceQuery = definition.field("face");
        const faceRef =
            faceQuery === undefined ? undefined : first(context, faceQuery, "FACE", "evEdgeCurvatures face");
        const frames = (domain?: FaceDomain) =>
            fsArray(
                parameterList(definition.field("parameters"), 1).map(([t]) => {
                    const u = edgeParameter(edge, t, arcLength);
                    const sign = domain === undefined ? 1 : faceSide(edge, domain.face, domain, u);
                    const frame = curvatureFrame(curve, u, sign);
                    return fsMap(
                        {
                            frame: makeCoordSystem({
                                origin: vec.scale(frame.point, 1 / MM_PER_METER),
                                xAxis: frame.normal,
                                zAxis: frame.tangent,
                            }),
                            curvature: new FsQuantity(frame.curvature, PER_METER),
                        },
                        "EdgeCurvatureResult",
                    );
                }),
            );
        return faceRef === undefined ? frames() : withDomain(faceRef, frames);
    });
    define2("evEdgeCurvatureDerivatives", (context, definition) => {
        const edgeRef = first(context, definition.field("edge"), "EDGE", "evEdgeCurvatureDerivatives edge");
        const edge = entityShape(edgeRef) as IEdge;
        const curve = edgeCurve(edge);
        const arcLength = definition.field("arcLengthParameterization") !== false;
        return fsArray(
            parameterList(definition.field("parameters"), 1).map(([t]) => {
                const derivative = curvatureDerivative(curve, edgeParameter(edge, t, arcLength), 1);
                return new FsArray(
                    derivative.map((c) => new FsQuantity(c, PER_SQUARE_METER)),
                    "Vector",
                );
            }),
        );
    });
    define2("evEdgeConvexity", (context, definition) => {
        const edgeRef = first(context, definition.field("edge"), "EDGE", "evEdgeConvexity edge");
        return edgeConvexity(edgeRef);
    });
    define2("evPlanarEdge", (context, definition) => {
        const edge = first(context, definition.field("edge"), "EDGE", "evPlanarEdge edge");
        return commonPlane([edge]);
    });
    define2("evPlanarEdges", (context, definition) => {
        const edges = resolve(context, definition.field("edges")).filter((ref) => ref.kind === "EDGE");
        if (edges.length === 0) fail("evPlanarEdges: the query resolves to no edges");
        return commonPlane(edges);
    });

    // ------------------------------------------------------------------ Whole entities

    define2("evApproximateMassProperties", (context, definition) => {
        const refs = resolve(context, definition.field("entities"));
        if (refs.length === 0) fail("evApproximateMassProperties: the entities query resolves to nothing");
        const data = massData(refs);
        const frameValue = definition.field("referenceFrame");
        let centroid = data.centroid;
        let inertia = inertiaTensor(data.second);
        if (frameValue !== undefined) {
            const frame = readCoordSystem(frameValue, "referenceFrame");
            const axes = [frame.xAxis, vec.cross(frame.zAxis, frame.xAxis), frame.zAxis];
            const offset = vec.sub(data.centroid, frame.origin);
            // About the frame origin (parallel axes), then in the frame's axes.
            const second = data.second.map((row, i) =>
                row.map((s, j) => s + data.measure * offset[i] * offset[j]),
            );
            const world = inertiaTensor(second);
            inertia = axes.map((a) =>
                axes.map((b) => vec.dot(a, world.map((row) => vec.dot(row as Vec3, b)) as Vec3)),
            );
            centroid = axes.map((axis) => vec.dot(axis, offset)) as Vec3;
        }
        const measureKey = ["count", "length", "area", "volume"][data.dimension];
        return fsMap({
            highestDimension: data.dimension,
            [measureKey]: data.measure,
            centroid: fsArray([...centroid]),
            inertia: fsArray(inertia.map((row) => fsArray([...row]))),
        });
    });
    define2("evCollisionDetection", (context, definition) => {
        const tools = resolve(context, definition.field("tools"));
        const targets = resolve(context, definition.field("targets"));
        const owners = definition.field("owners") === true;
        const query = (ref: EntityRef) =>
            transientQuery(owners ? { body: ref.body, kind: "BODY", index: -1 } : ref);
        const bodyQuery = (ref: EntityRef) => transientQuery({ body: ref.body, kind: "BODY", index: -1 });
        const collisions: FsValue[] = [];
        for (const tool of tools) {
            for (const target of targets) {
                if (tool.body === target.body) continue;
                const type = clash(tool, target);
                if (type === undefined) continue;
                collisions.push(
                    fsMap({
                        type: bridge.enumValue("ClashType", type),
                        tool: query(tool),
                        toolBody: bodyQuery(tool),
                        target: query(target),
                        targetBody: bodyQuery(target),
                    }),
                );
            }
        }
        return fsArray(collisions);
    });
    define2("evRaycast", (context, definition) => {
        const refs = resolve(context, definition.field("entities"));
        const ray = readLine(definition.field("ray"), "ray");
        const closest = definition.field("closest") !== false;
        const behind = definition.field("includeIntersectionsBehind") === true;
        if (closest && behind) fail("evRaycast: includeIntersectionsBehind cannot be used with closest");
        const origin = vec.scale(ray.origin, MM_PER_METER);
        let hits = raycast(refs, origin, ray.direction).filter((hit) => behind || hit.t >= -1e-9);
        if (closest) hits = hits.slice(0, 1);
        return fsArray(
            hits.map((hit) =>
                fsMap({
                    entity: transientQuery(hit.ref),
                    entityType: bridge.enumValue("EntityType", hit.ref.kind),
                    parameter: Array.isArray(hit.parameter)
                        ? fsArray(hit.parameter, "Vector")
                        : hit.parameter,
                    intersection: point(vec.scale(hit.point, 1 / MM_PER_METER)),
                    distance: new FsQuantity(Math.abs(hit.t) / MM_PER_METER, LENGTH),
                }),
            ),
        );
    });
    define2("evPointsDeviation", (context, definition) => {
        const points = expectArray(definition.field("points"), "points").items.map((p) =>
            vec.scale(readPoint(p, "point"), MM_PER_METER),
        );
        const refs = resolve(context, definition.field("topologies"));
        if (refs.length === 0) fail("evPointsDeviation: the topologies query resolves to nothing");
        const deviations = points.map((p) => {
            let best = closestOnEntity(refs[0], p);
            for (const ref of refs.slice(1)) {
                const candidate = closestOnEntity(ref, p);
                if (candidate.distance < best.distance) best = candidate;
            }
            return fsMap({
                deviation: new FsQuantity(best.distance / MM_PER_METER, LENGTH),
                pointPoint: point(vec.scale(p, 1 / MM_PER_METER)),
                topologyPoint: point(vec.scale(best.point, 1 / MM_PER_METER)),
            });
        });
        if (definition.field("allDeviations") === true) return fsArray(deviations);
        const worst = deviations.reduce<FsMap | undefined>(
            (best, entry) =>
                best === undefined ||
                (entry.field("deviation") as FsQuantity).value > (best.field("deviation") as FsQuantity).value
                    ? entry
                    : best,
            undefined,
        );
        return fsArray(worst === undefined ? [] : [worst]);
    });
    define2("evMaxPathDeviation", (context, definition) => {
        const side1 = pathEdges(resolve(context, definition.field("side1")));
        const side2 = pathEdges(resolve(context, definition.field("side2")));
        if (side1.length === 0 || side2.length === 0) fail("evMaxPathDeviation: both sides need edges");
        const a = farthest(side1, side2);
        const b = farthest(side2, side1);
        const [p1, p2, d] =
            a.distance >= b.distance ? [a.from, a.to, a.distance] : [b.to, b.from, b.distance];
        return fsMap({
            deviation: new FsQuantity(d / MM_PER_METER, LENGTH),
            side1Point: point(vec.scale(p1, 1 / MM_PER_METER)),
            side2Point: point(vec.scale(p2, 1 / MM_PER_METER)),
        });
    });
    // Mesh geometry is never created here: B-rep faces have no mesh points.
    define2("evMeshPoints", (context, definition) => {
        resolve(context, definition.field("meshes"));
        return fsArray([]);
    });
    define2("evFaults", (context, definition) => {
        const faults: FsValue[] = [];
        for (const ref of resolve(context, definition.field("entities"))) {
            const body = ref.body;
            if (body.shape.checkShape()) continue;
            const faces = body.shape.checkFaces().filter((check) => !check.isValid);
            if (faces.length === 0) {
                faults.push(fsMap({ entity: transientQuery({ body, kind: "BODY", index: -1 }) }));
                continue;
            }
            for (const check of faces) {
                const face = { body, kind: "FACE" as const, index: check.index };
                faults.push(fsMap({ entity: transientQuery(face), status: fsArray([...check.status]) }));
            }
        }
        return fsArray(faults);
    });
    define2("evOffsetDetection", (context, definition) => {
        const tolerance = definition.field("offsetTolerance");
        const tol = (tolerance instanceof FsQuantity ? tolerance.value : 1e-8) * MM_PER_METER;
        const groups: { offset: number; side0: FsValue[]; side1: FsValue[]; low: number; high: number }[] =
            [];
        const bodies = resolve(context, definition.field("bodies")).filter((ref) => ref.kind === "BODY");
        for (const body of bodies) {
            for (const pair of offsetPairs(body.body, Math.max(tol, 1e-9))) {
                let group = groups.find((g) => Math.abs(g.offset - pair.offset) <= Math.max(tol, 1e-9));
                if (group === undefined) {
                    group = {
                        offset: pair.offset,
                        side0: [],
                        side1: [],
                        low: pair.offset,
                        high: pair.offset,
                    };
                    groups.push(group);
                }
                group.side0.push(transientQuery(pair.side0).field("transientId"));
                group.side1.push(transientQuery(pair.side1).field("transientId"));
                group.low = Math.min(group.low, pair.offset);
                group.high = Math.max(group.high, pair.offset);
            }
        }
        return fsArray(
            groups.map((g) =>
                fsMap({
                    side0: fsArray(g.side0),
                    side1: fsArray(g.side1),
                    offsetLow: g.low / MM_PER_METER,
                    offsetHigh: g.high / MM_PER_METER,
                }),
            ),
        );
    });
    define2("clusterBodies", (context, definition) => {
        const bodies = resolve(context, definition.field("bodies")).filter((ref) => ref.kind === "BODY");
        const relative = definition.field("relativeTolerance");
        const tolerance = typeof relative === "number" ? relative : 1e-6;
        const signatures = bodies.map(bodySignature);
        const assigned = new Array<boolean>(bodies.length).fill(false);
        const clusters: FsValue[] = [];
        for (let i = 0; i < bodies.length; i++) {
            if (assigned[i]) continue;
            const cluster = [i];
            assigned[i] = true;
            for (let j = i + 1; j < bodies.length; j++) {
                if (!assigned[j] && sameBody(signatures[i], signatures[j], tolerance)) {
                    cluster.push(j);
                    assigned[j] = true;
                }
            }
            clusters.push(fsArray(cluster));
        }
        return fsArray(clusters);
    });
}

// ------------------------------------------------------------------ Helpers

/** Runs `body` with the face's parameter domain, disposing its surface afterwards. */
function withDomain<T>(ref: EntityRef, body: (domain: FaceDomain) => T): T {
    const domain = faceDomain(entityShape(ref) as IFace);
    try {
        return body(domain);
    } finally {
        domain.dispose();
    }
}

/** An array of parameters: numbers (size 1) or unitless vectors (size 2). */
function parameterList(value: FsValue, size: 1 | 2): number[][] {
    return expectArray(value, "parameters").items.map((item) => {
        if (size === 1) return [expectNumber(item, "An edge parameter")];
        const values = expectArray(item, "A face parameter").items.map((c) =>
            expectNumber(c, "A face parameter component"),
        );
        if (values.length !== 2) fail("A face parameter must be a 2D vector");
        return values;
    });
}

/** `direction` made perpendicular to `normal` (any perpendicular when parallel). */
function inPlane(direction: Vec3, normal: Vec3): Vec3 {
    const projected = vec.sub(direction, vec.scale(normal, vec.dot(direction, normal)));
    return vec.norm(projected) > 1e-12 * Math.max(vec.norm(direction), 1e-300)
        ? vec.normalize(projected)
        : vec.perpendicular(normal);
}

function tangentPlane(domain: FaceDomain, p: Vec3, su: Vec3, sv: Vec3) {
    const normal = outwardNormal(domain, su, sv);
    const x = vec.norm(su) > 1e-300 ? su : sv;
    return makePlane(makePlaneData(vec.scale(p, 1 / MM_PER_METER), normal, inPlane(x, normal)));
}

function curvatureResult(curvature: FaceCurvature): FsMap {
    return fsMap(
        {
            minCurvature: new FsQuantity(curvature.minCurvature, PER_METER),
            maxCurvature: new FsQuantity(curvature.maxCurvature, PER_METER),
            minDirection: fsArray([...curvature.minDirection], "Vector"),
            maxDirection: fsArray([...curvature.maxDirection], "Vector"),
        },
        "FaceCurvatureResult",
    );
}

/** The radius of a constant-radius fillet face: its cross-section's curvature radius. */
function filletRadius(ref: EntityRef): number {
    const face = entityShape(ref) as IFace;
    const type = surfaceTypeOf(face);
    const surface = face.surface() as unknown as { radius?: number; minorRadius?: number; dispose(): void };
    try {
        if (type === "TORUS" && surface.minorRadius !== undefined) return surface.minorRadius / MM_PER_METER;
        if ((type === "CYLINDER" || type === "SPHERE") && surface.radius !== undefined)
            return surface.radius / MM_PER_METER;
    } finally {
        surface.dispose();
    }
    if (type === "PLANE") fail("evFilletRadius: the face is not a fillet face");
    return withDomain(ref, (domain) => {
        const radii: number[] = [];
        for (const s of [0.25, 0.5, 0.75])
            for (const t of [0.25, 0.5, 0.75]) {
                const { u, v } = denormalize(domain, s, t);
                const c = faceCurvature(domain, u, v);
                const k = Math.max(Math.abs(c.minCurvature), Math.abs(c.maxCurvature));
                if (k > 0) radii.push(1 / k);
            }
        if (radii.length === 0) fail("evFilletRadius: the face is not a fillet face");
        const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
        if (radii.some((r) => Math.abs(r - mean) > 1e-6 * mean))
            fail("evFilletRadius: the face has no constant radius");
        return mean;
    });
}

/** CONVEX / CONCAVE / SMOOTH / VARIABLE from the turn between the two faces along the edge. */
function edgeConvexity(edgeRef: EntityRef): string {
    const edge = entityShape(edgeRef) as IEdge;
    const faces = relatedEntities(edgeRef, "FACE");
    if (faces.length === 1) {
        // A seam (the face meets itself) is smooth; a free edge has no convexity.
        const { edges, shapes } = orientedEdges(entityShape(faces[0]) as IFace);
        const seam = edges.some((entry) => entry.seam && entry.edge.isSame(edge));
        for (const shape of shapes) shape.dispose();
        if (seam) return "SMOOTH";
    }
    if (faces.length !== 2) fail("evEdgeConvexity: the edge does not join two faces");
    const curve = edgeCurve(edge);
    const domains = faces.map((face) => faceDomain(entityShape(face) as IFace));
    try {
        const kinds = new Set<string>();
        for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            const u = edgeParameter(edge, t, false);
            const d = curve.d1(u);
            const normals = domains.map((domain) => {
                const uv = surfaceParameters(domain.surface, d.point);
                const s = domain.surface.d1(uv.u, uv.v);
                return outwardNormal(domain, toVec(s.d1u), toVec(s.d1v));
            });
            const turn = vec.cross(normals[0], normals[1]);
            if (vec.norm(turn) < 1e-7 && vec.dot(normals[0], normals[1]) > 0) {
                kinds.add("SMOOTH");
                continue;
            }
            // With the first face on the left, a convex edge turns its normal toward the second's.
            const sign = faceSide(edge, domains[0].face, domains[0], u);
            const tangent = vec.scale(toVec(d.vec), sign);
            kinds.add(vec.dot(turn, tangent) >= 0 ? "CONVEX" : "CONCAVE");
        }
        return kinds.size === 1 ? [...kinds][0] : "VARIABLE";
    } finally {
        for (const domain of domains) domain.dispose();
    }
}

/** The plane the edges share: a conic's own plane, else a least-squares plane through samples. */
function commonPlane(edges: readonly EntityRef[]): FsMap {
    const samples: Vec3[] = [];
    let conic: { center: Vec3; axis: Vec3; x: Vec3 } | undefined;
    for (const ref of edges) {
        const edge = entityShape(ref) as IEdge;
        const type = curveTypeOf(edge);
        const count = type === "LINE" ? 1 : 16;
        const t0 = edge.firstParameter();
        const t1 = edge.lastParameter();
        for (let i = 0; i <= count; i++) samples.push(toVec(edge.pointAt(t0 + ((t1 - t0) * i) / count)));
        if (edges.length === 1 && (type === "CIRCLE" || type === "ARC")) {
            const circle = edgeCurve(edge).basisCurve as ICircle;
            conic = { center: toVec(circle.center), axis: toVec(circle.axis), x: toVec(circle.xAxis) };
        }
    }
    if (conic !== undefined)
        return makePlane(makePlaneData(vec.scale(conic.center, 1 / MM_PER_METER), conic.axis, conic.x));
    const center = vec.scale(
        samples.reduce((acc, p) => vec.add(acc, p), [0, 0, 0] as Vec3),
        1 / samples.length,
    );
    const covariance = [0, 1, 2].map((i) =>
        [0, 1, 2].map((j) => samples.reduce((sum, p) => sum + (p[i] - center[i]) * (p[j] - center[j]), 0)),
    );
    const { values, vectors } = symmetricEigen(covariance);
    const scale = Math.max(values[2], 1e-300);
    if (values[1] <= 1e-18 * scale || values[1] < 1e-20)
        fail("evPlanarEdge: the edges are straight and do not fix a plane");
    let normal = vectors[0];
    const spread = Math.max(...samples.map((p) => Math.abs(vec.dot(vec.sub(p, center), normal))));
    if (spread > 1e-4) fail("evPlanarEdge: the edges do not lie in one plane");
    // Orient a closed loop counterclockwise about the normal (Newell's method).
    const newell = samples.reduce(
        (acc, p, i) => vec.add(acc, vec.cross(p, samples[(i + 1) % samples.length])),
        [0, 0, 0] as Vec3,
    );
    if (vec.dot(newell, normal) < 0) normal = vec.scale(normal, -1);
    return makePlane(makePlaneData(vec.scale(center, 1 / MM_PER_METER), normal));
}

/** The edges of a path side: edges as given, a body's edges. */
function pathEdges(refs: readonly EntityRef[]): IEdge[] {
    return refs
        .flatMap(leafEntities)
        .flatMap((ref) => (ref.kind === "EDGE" ? [entityShape(ref) as IEdge] : []));
}

/** The point of `from` farthest from `to`, by sampling and golden-section refinement. */
function farthest(from: readonly IEdge[], to: readonly IEdge[]): { from: Vec3; to: Vec3; distance: number } {
    const nearest = (p: Vec3) => {
        let best = closestOnEdge(to[0], p);
        for (const edge of to.slice(1)) {
            const candidate = closestOnEdge(edge, p);
            if (candidate.distance < best.distance) best = candidate;
        }
        return best;
    };
    let result = { from: [0, 0, 0] as Vec3, to: [0, 0, 0] as Vec3, distance: -1 };
    for (const edge of from) {
        const t0 = edge.firstParameter();
        const t1 = edge.lastParameter();
        const samples = curveTypeOf(edge) === "LINE" ? 8 : 32;
        const at = (u: number) => {
            const p = toVec(edge.pointAt(u));
            const q = nearest(p);
            return { from: p, to: q.point, distance: q.distance };
        };
        const values = Array.from({ length: samples + 1 }, (_, i) => at(t0 + ((t1 - t0) * i) / samples));
        let k = 0;
        values.forEach((value, i) => {
            if (value.distance > values[k].distance) k = i;
        });
        let a = t0 + ((t1 - t0) * Math.max(0, k - 1)) / samples;
        let b = t0 + ((t1 - t0) * Math.min(samples, k + 1)) / samples;
        for (let i = 0; i < 60; i++) {
            const m1 = b - (b - a) / 1.618033988749895;
            const m2 = a + (b - a) / 1.618033988749895;
            if (at(m1).distance > at(m2).distance) b = m2;
            else a = m1;
        }
        const refined = at((a + b) / 2);
        const best = refined.distance > values[k].distance ? refined : values[k];
        if (best.distance > result.distance) result = best;
    }
    return result;
}

interface BodySignature {
    readonly counts: readonly number[];
    readonly measure: number;
    readonly moments: readonly number[];
    /** Sign of the principal-frame skewness product: what tells a body from its mirror image (0 = symmetric). */
    readonly handedness: number;
}

function bodySignature(ref: EntityRef): BodySignature {
    const body = ref.body;
    const counts = [body.faces().length, body.edges().length, body.vertices().length];
    const data = massData([ref]);
    const { values, vectors } = symmetricEigen(data.second);
    let handedness = 0;
    const distinct = values[1] - values[0] > 1e-6 * values[2] && values[2] - values[1] > 1e-6 * values[2];
    if (distinct && data.measure > 0) {
        const skew = vectors.map(
            (e, i) => data.third(e, e, e) / (data.measure * (values[i] / data.measure) ** 1.5),
        );
        if (skew.every((s) => Math.abs(s) > 1e-4)) handedness = Math.sign(skew[0] * skew[1] * skew[2]);
    }
    return { counts, measure: data.measure, moments: values, handedness };
}

function sameBody(a: BodySignature, b: BodySignature, tolerance: number): boolean {
    if (a.counts.some((count, i) => count !== b.counts[i])) return false;
    const close = (x: number, y: number) =>
        Math.abs(x - y) <= tolerance * Math.max(Math.abs(x), Math.abs(y), 1e-300);
    if (!close(a.measure, b.measure)) return false;
    if (a.moments.some((m, i) => !close(m, b.moments[i]))) return false;
    return a.handedness === 0 || b.handedness === 0 || a.handedness === b.handedness;
}
