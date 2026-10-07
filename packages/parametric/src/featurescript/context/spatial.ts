// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IEdge,
    type IFace,
    type IShape,
    type ISolid,
    type IVertex,
    ShapeTypes,
    XYZ,
} from "@chili3d/core";
import { type Vec3, vec } from "../std/geometry";
import { edgeCurve, normalizedEdgeParameter, toVec, toXYZ } from "./differential";
import { denormalize, type FaceDomain, faceDomain, normalize, surfaceParameters } from "./faceDomain";
import { type EntityRef, entityShape, type FsBody } from "./fsContext";
import { entitiesOf } from "./queries";

/**
 * Spatial queries over resolved entities, in kernel millimetres: closest points, ray
 * intersections, collision classes and offset face pairs.
 */

/** The entities of the highest dimension a ref stands for: a body's faces, edges or vertices. */
export function leafEntities(ref: EntityRef): EntityRef[] {
    if (ref.kind !== "BODY") return [ref];
    const kind =
        ref.body.kind === "SOLID" || ref.body.kind === "SHEET"
            ? "FACE"
            : ref.body.kind === "WIRE"
              ? "EDGE"
              : "VERTEX";
    return entitiesOf(ref.body, kind);
}

// ------------------------------------------------------------------ Closest points

export interface ClosestPoint {
    readonly point: Vec3;
    readonly distance: number;
}

/** The point of an edge nearest to `p`. */
export function closestOnEdge(edge: IEdge, p: Vec3): ClosestPoint & { parameter: number } {
    const target = toXYZ(p);
    let best: ClosestPoint & { parameter: number } = {
        point: p,
        distance: Infinity,
        parameter: edge.firstParameter(),
    };
    const consider = (point: XYZ, parameter: number) => {
        const distance = point.distanceTo(target);
        if (distance < best.distance) best = { point: toVec(point), distance, parameter };
    };
    try {
        const nearest = edgeCurve(edge).nearestFromPoint(target);
        consider(nearest.point, nearest.parameter);
    } catch {
        // A degenerate edge: its vertex below.
    }
    consider(edge.pointAt(edge.firstParameter()), edge.firstParameter());
    consider(edge.pointAt(edge.lastParameter()), edge.lastParameter());
    return best;
}

/** The point of a face nearest to `p`: its surface projection when inside, else its boundary's. */
export function closestOnFace(face: IFace, p: Vec3): ClosestPoint {
    const target = toXYZ(p);
    let best: ClosestPoint = { point: p, distance: Infinity };
    const surface = face.surface();
    try {
        const projected = surface.nearestPoint(target);
        if (projected !== undefined && face.containsPoint(projected[0], true, 1e-6)) {
            best = { point: toVec(projected[0]), distance: projected[0].distanceTo(target) };
        }
    } finally {
        surface.dispose();
    }
    const edges = face.findSubShapes(ShapeTypes.edge) as IEdge[];
    try {
        for (const edge of edges) {
            const candidate = closestOnEdge(edge, p);
            if (candidate.distance < best.distance) best = candidate;
        }
    } finally {
        for (const edge of edges) edge.dispose();
    }
    return best;
}

/** The point of an entity (any kind) nearest to `p`. */
export function closestOnEntity(ref: EntityRef, p: Vec3): ClosestPoint {
    let best: ClosestPoint = { point: p, distance: Infinity };
    for (const leaf of leafEntities(ref)) {
        const shape = entityShape(leaf);
        let candidate: ClosestPoint;
        if (leaf.kind === "FACE") candidate = closestOnFace(shape as IFace, p);
        else if (leaf.kind === "EDGE") candidate = closestOnEdge(shape as IEdge, p);
        else {
            const point = toVec(leaf.body.vertices()[leaf.index].point());
            candidate = { point, distance: vec.norm(vec.sub(point, p)) };
        }
        if (candidate.distance < best.distance) best = candidate;
    }
    return best;
}

// ------------------------------------------------------------------ Rays

export interface RayHit {
    readonly ref: EntityRef;
    /** Signed distance along the ray (mm). */
    readonly t: number;
    readonly point: Vec3;
    /** Normalized face parameters, or the normalized (arc length) edge parameter. */
    readonly parameter?: [number, number] | number;
}

/** Every intersection of the line `origin + t direction` with the entities (faces, edges, vertices). */
export function raycast(refs: readonly EntityRef[], origin: Vec3, direction: Vec3): RayHit[] {
    const d = vec.normalize(direction);
    const hits: RayHit[] = [];
    for (const ref of refs.flatMap(leafEntities)) {
        if (ref.kind === "FACE") hits.push(...rayFace(ref, origin, d));
        else if (ref.kind === "EDGE") hits.push(...rayEdge(ref, origin, d));
        else if (ref.kind === "VERTEX") {
            const p = toVec(ref.body.vertices()[ref.index].point());
            const t = vec.dot(vec.sub(p, origin), d);
            if (vec.norm(vec.sub(vec.add(origin, vec.scale(d, t)), p)) < 1e-6)
                hits.push({ ref, t, point: p });
        }
    }
    return hits.sort((a, b) => a.t - b.t);
}

function rayFace(ref: EntityRef, origin: Vec3, d: Vec3): RayHit[] {
    const face = entityShape(ref) as IFace;
    const domain = faceDomain(face);
    try {
        const candidates = domain.planar
            ? planeCandidates(domain, origin, d)
            : meshCandidates(domain, origin, d);
        const hits: RayHit[] = [];
        for (const start of candidates) {
            const solved = newtonRay(domain, origin, d, start);
            if (solved === undefined) continue;
            const point = toXYZ(solved.point);
            if (!face.containsPoint(point, true, 1e-6)) continue;
            if (hits.some((hit) => Math.abs(hit.t - solved.t) < 1e-6)) continue;
            hits.push({
                ref,
                t: solved.t,
                point: solved.point,
                parameter: normalize(domain, solved.u, solved.v),
            });
        }
        return hits;
    } finally {
        domain.dispose();
    }
}

interface RayStart {
    readonly u: number;
    readonly v: number;
    readonly t: number;
}

function planeCandidates(domain: FaceDomain, origin: Vec3, d: Vec3): RayStart[] {
    const mid = denormalize(domain, 0.5, 0.5);
    const s = domain.surface.d1(mid.u, mid.v);
    const n = vec.cross(toVec(s.d1u), toVec(s.d1v));
    const along = vec.dot(n, d);
    if (Math.abs(along) < 1e-12 * vec.norm(n)) return [];
    const t = vec.dot(n, vec.sub(toVec(s.point), origin)) / along;
    const uv = surfaceParameters(domain.surface, toXYZ(vec.add(origin, vec.scale(d, t))), 1);
    return [{ u: uv.u, v: uv.v, t }];
}

/** Ray–triangle hits on the face's triangulation, as starting points for the exact solve. */
function meshCandidates(domain: FaceDomain, origin: Vec3, d: Vec3): RayStart[] {
    const mesh = domain.face.mesh.faces;
    if (mesh?.index === undefined || mesh.position === undefined || mesh.uv === undefined) return [];
    const { position, uv, index } = mesh;
    const node = (i: number): Vec3 => [position[3 * i], position[3 * i + 1], position[3 * i + 2]];
    const starts: RayStart[] = [];
    for (let k = 0; k + 2 < index.length; k += 3) {
        const [i0, i1, i2] = [index[k], index[k + 1], index[k + 2]];
        const p0 = node(i0);
        const e1 = vec.sub(node(i1), p0);
        const e2 = vec.sub(node(i2), p0);
        const h = vec.cross(d, e2);
        const det = vec.dot(e1, h);
        if (Math.abs(det) < 1e-14) continue;
        const s = vec.sub(origin, p0);
        const a = vec.dot(s, h) / det;
        const q = vec.cross(s, e1);
        const b = vec.dot(d, q) / det;
        // A little slack: the triangles are chords of the surface.
        if (a < -0.05 || b < -0.05 || a + b > 1.05) continue;
        const t = vec.dot(e2, q) / det;
        const w0 = 1 - a - b;
        const su = w0 * uv[2 * i0] + a * uv[2 * i1] + b * uv[2 * i2];
        const sv = w0 * uv[2 * i0 + 1] + a * uv[2 * i1 + 1] + b * uv[2 * i2 + 1];
        const p = denormalize(domain, su, sv);
        starts.push({ u: p.u, v: p.v, t });
    }
    return starts;
}

/** Solves S(u, v) = origin + t d by Newton's method. */
function newtonRay(
    domain: FaceDomain,
    origin: Vec3,
    d: Vec3,
    start: RayStart,
): { u: number; v: number; t: number; point: Vec3 } | undefined {
    let { u, v, t } = start;
    for (let iteration = 0; iteration < 30; iteration++) {
        const s = domain.surface.d1(u, v);
        const p = toVec(s.point);
        const f = vec.sub(p, vec.add(origin, vec.scale(d, t)));
        if (vec.norm(f) < 1e-10) return { u, v, t, point: p };
        // [Su Sv -d] (du, dv, dt) = -f by Cramer's rule.
        const su = toVec(s.d1u);
        const sv = toVec(s.d1v);
        const md = vec.scale(d, -1);
        const det = vec.dot(su, vec.cross(sv, md));
        if (Math.abs(det) < 1e-300) return undefined;
        const r = vec.scale(f, -1);
        u += vec.dot(r, vec.cross(sv, md)) / det;
        v += vec.dot(su, vec.cross(r, md)) / det;
        t += vec.dot(su, vec.cross(sv, r)) / det;
    }
    return undefined;
}

function rayEdge(ref: EntityRef, origin: Vec3, d: Vec3): RayHit[] {
    const edge = entityShape(ref) as IEdge;
    const t0 = edge.firstParameter();
    const t1 = edge.lastParameter();
    const distanceAt = (u: number) => {
        const p = toVec(edge.pointAt(u));
        const along = vec.dot(vec.sub(p, origin), d);
        return { p, along, distance: vec.norm(vec.sub(p, vec.add(origin, vec.scale(d, along)))) };
    };
    const samples = 64;
    const hits: RayHit[] = [];
    let previous = Infinity;
    const values = Array.from(
        { length: samples + 1 },
        (_, i) => distanceAt(t0 + ((t1 - t0) * i) / samples).distance,
    );
    for (let i = 0; i <= samples; i++) {
        const next = i < samples ? values[i + 1] : Infinity;
        if (values[i] <= previous && values[i] <= next) {
            // Refine the local minimum by golden section.
            let a = t0 + ((t1 - t0) * Math.max(0, i - 1)) / samples;
            let b = t0 + ((t1 - t0) * Math.min(samples, i + 1)) / samples;
            for (let k = 0; k < 80; k++) {
                const m1 = b - (b - a) / 1.618033988749895;
                const m2 = a + (b - a) / 1.618033988749895;
                if (distanceAt(m1).distance < distanceAt(m2).distance) b = m2;
                else a = m1;
            }
            const u = (a + b) / 2;
            const best = distanceAt(u);
            if (best.distance < 1e-6 && !hits.some((hit) => Math.abs(hit.t - best.along) < 1e-6))
                hits.push({
                    ref,
                    t: best.along,
                    point: best.p,
                    parameter: normalizedEdgeParameter(edge, u, true),
                });
        }
        previous = values[i];
    }
    return hits;
}

// ------------------------------------------------------------------ Collisions

export type ClashType =
    | "INTERFERE"
    | "EXISTS"
    | "ABUT_NO_CLASS"
    | "ABUT_TOOL_IN_TARGET"
    | "ABUT_TOOL_OUT_TARGET"
    | "TARGET_IN_TOOL"
    | "TOOL_IN_TARGET";

const CONTACT = 1e-6;
const RELATIVE = 1e-6;

function dimensionOf(ref: EntityRef): number {
    if (ref.kind === "VERTEX") return 0;
    if (ref.kind === "EDGE") return 1;
    if (ref.kind === "FACE") return 2;
    return { SOLID: 3, SHEET: 2, WIRE: 1, POINT: 0 }[ref.body.kind];
}

/** How a tool entity and a target entity meet, undefined when they are apart. */
export function clash(tool: EntityRef, target: EntityRef): ClashType | undefined {
    const toolShape = entityShape(tool);
    const targetShape = entityShape(target);
    if (toolShape.extremaDistance(targetShape) > CONTACT) return undefined;
    const dt = dimensionOf(tool);
    const dg = dimensionOf(target);
    if (dt <= 1 && dg <= 1) return "EXISTS";
    if (dt === 3 && dg === 3) return solidClash(tool.body, target.body);
    if (dt === 3 || dg === 3) {
        const [solid, other, otherIsTool] = dt === 3 ? [tool.body, target, false] : [target.body, tool, true];
        const inside = containment(solid, other);
        if (inside === "inside") return otherIsTool ? "TOOL_IN_TARGET" : "TARGET_IN_TOOL";
        return inside === "partly" ? "INTERFERE" : "ABUT_NO_CLASS";
    }
    return crosses(toolShape, targetShape, tool, target) ? "INTERFERE" : "ABUT_NO_CLASS";
}

function solidClash(tool: FsBody, target: FsBody): ClashType {
    const common = shapeFactory.booleanCommon([tool.shape], [target.shape]);
    const shared = common.isOk ? common.value.volume() : 0;
    if (common.isOk) common.value.dispose();
    const toolVolume = tool.shape.volume();
    const targetVolume = target.shape.volume();
    if (shared <= RELATIVE * Math.min(toolVolume, targetVolume)) return "ABUT_TOOL_OUT_TARGET";
    if (Math.abs(shared - targetVolume) <= RELATIVE * targetVolume) return "TARGET_IN_TOOL";
    if (Math.abs(shared - toolVolume) <= RELATIVE * toolVolume) {
        const touches = target.faces().some((face) => face.extremaDistance(tool.shape) <= CONTACT);
        return touches ? "ABUT_TOOL_IN_TARGET" : "TOOL_IN_TARGET";
    }
    return "INTERFERE";
}

/** Whether a lower-dimensional entity lies inside a solid, partly, or only touches it. */
function containment(solid: FsBody, ref: EntityRef): "inside" | "partly" | "touching" {
    const shape = entityShape(ref);
    const measure = (s: IShape) => {
        const d = dimensionOf(ref);
        if (d === 0) return 1;
        const subs = s.findSubShapes(d === 2 ? ShapeTypes.face : ShapeTypes.edge);
        try {
            return subs.reduce(
                (sum, sub) => sum + (d === 2 ? (sub as IFace).area() : (sub as IEdge).length()),
                0,
            );
        } finally {
            for (const sub of subs) sub.dispose();
        }
    };
    const solids = solidsOf(solid);
    try {
        const interior = interiorPoint(ref);
        const strictlyInside = solids.some((s) => s.containsPoint(toXYZ(interior), false, 1e-6));
        if (dimensionOf(ref) === 0) return strictlyInside ? "inside" : "touching";
        const common = shapeFactory.booleanCommon([shape], [solid.shape]);
        const shared = common.isOk ? measure(common.value) : 0;
        if (common.isOk) common.value.dispose();
        const total = measure(shape);
        if (shared >= total * (1 - RELATIVE)) return strictlyInside ? "inside" : "touching";
        return shared > total * RELATIVE ? "partly" : "touching";
    } finally {
        for (const s of solids) if (s !== solid.shape) s.dispose();
    }
}

function solidsOf(body: FsBody): ISolid[] {
    if (body.shape.shapeType === ShapeTypes.solid) return [body.shape as ISolid];
    return body.shape.findSubShapes(ShapeTypes.solid) as ISolid[];
}

/** A point inside an entity, away from its boundary: a face's or an edge's middle. */
function interiorPoint(ref: EntityRef): Vec3 {
    if (ref.kind === "VERTEX") return toVec(ref.body.vertices()[ref.index].point());
    const leaf = leafEntities(ref)[0];
    const shape = entityShape(leaf);
    if (leaf.kind === "EDGE") {
        const edge = shape as IEdge;
        return toVec(edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2));
    }
    if (leaf.kind === "FACE") {
        const domain = faceDomain(shape as IFace);
        try {
            const mid = denormalize(domain, 0.5, 0.5);
            return toVec(domain.surface.value(mid.u, mid.v));
        } finally {
            domain.dispose();
        }
    }
    return toVec(leaf.body.vertices()[0]?.point() ?? new XYZ(0, 0, 0));
}

/** Whether two touching lower-dimensional entities cross (meet inside both) rather than abut. */
function crosses(a: IShape, b: IShape, refA: EntityRef, refB: EntityRef): boolean {
    const section = a.section(b);
    try {
        const points = [
            ...(section.findSubShapes(ShapeTypes.edge) as IEdge[]).map((edge) => {
                const p = edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2);
                edge.dispose();
                return p;
            }),
        ];
        for (const vertex of section.findSubShapes(ShapeTypes.vertex) as IVertex[]) {
            points.push(vertex.point());
            vertex.dispose();
        }
        return points.some((p) => interiorTo(refA, p) && interiorTo(refB, p));
    } finally {
        section.dispose();
    }
}

function interiorTo(ref: EntityRef, p: XYZ): boolean {
    for (const leaf of leafEntities(ref)) {
        const shape = entityShape(leaf);
        if (leaf.kind === "FACE" && (shape as IFace).containsPoint(p, false, 1e-6)) return true;
        if (leaf.kind === "EDGE") {
            const edge = shape as IEdge;
            const [start, end] = edge.ends();
            if (
                start.distanceTo(p) > CONTACT &&
                end.distanceTo(p) > CONTACT &&
                closestOnEdge(edge, toVec(p)).distance <= CONTACT
            )
                return true;
        }
    }
    return false;
}

// ------------------------------------------------------------------ Offset faces

export interface OffsetPair {
    readonly side0: EntityRef;
    readonly side1: EntityRef;
    /** Offset distance (mm). */
    readonly offset: number;
}

/**
 * Pairs of faces of one body that are offsets of each other through the material:
 * parallel planes facing apart, or coaxial cylinders, a constant distance apart.
 */
export function offsetPairs(body: FsBody, tolerance: number): OffsetPair[] {
    const faces = entitiesOf(body, "FACE");
    const info = faces.map((ref) => describeFace(entityShape(ref) as IFace));
    const pairs: OffsetPair[] = [];
    for (let i = 0; i < faces.length; i++) {
        for (let j = i + 1; j < faces.length; j++) {
            const a = info[i];
            const b = info[j];
            if (a === undefined || b === undefined) continue;
            let offset: number | undefined;
            if (a.kind === "plane" && b.kind === "plane") {
                if (vec.dot(a.normal, b.normal) > -1 + 1e-9) continue;
                // b lies behind a, inside the material.
                const gap = vec.dot(vec.sub(a.origin, b.origin), a.normal);
                if (gap > tolerance && overlaps(faces[i], faces[j], a.normal, gap)) offset = gap;
            } else if (a.kind === "cylinder" && b.kind === "cylinder") {
                if (vec.norm(vec.cross(a.axis, b.axis)) > 1e-9) continue;
                const toAxis = vec.sub(b.origin, a.origin);
                if (vec.norm(vec.cross(toAxis, a.axis)) > tolerance) continue;
                if (a.convex === b.convex) continue;
                const gap = Math.abs(a.radius - b.radius);
                const outer = a.radius > b.radius ? a : b;
                if (gap > tolerance && outer.convex) offset = gap;
            }
            if (offset !== undefined) pairs.push({ side0: faces[i], side1: faces[j], offset });
        }
    }
    return pairs;
}

type FaceInfo =
    | { kind: "plane"; origin: Vec3; normal: Vec3 }
    | { kind: "cylinder"; origin: Vec3; axis: Vec3; radius: number; convex: boolean };

function describeFace(face: IFace): FaceInfo | undefined {
    const domain = faceDomain(face);
    try {
        const mid = denormalize(domain, 0.5, 0.5);
        const s = domain.surface.d1(mid.u, mid.v);
        const normal = vec.scale(
            vec.normalize(vec.cross(toVec(s.d1u), toVec(s.d1v))),
            domain.reversed ? -1 : 1,
        );
        if (domain.planar) return { kind: "plane", origin: toVec(s.point), normal };
        const cylinder = domain.surface as unknown as { radius?: number; axis?: XYZ; location?: XYZ };
        if (
            typeof cylinder.radius === "number" &&
            cylinder.axis !== undefined &&
            cylinder.location !== undefined
        ) {
            const origin = toVec(cylinder.location);
            const axis = vec.normalize(toVec(cylinder.axis));
            const radial = vec.sub(toVec(s.point), origin);
            const outward = vec.sub(radial, vec.scale(axis, vec.dot(radial, axis)));
            return {
                kind: "cylinder",
                origin,
                axis,
                radius: cylinder.radius,
                convex: vec.dot(outward, normal) > 0,
            };
        }
        return undefined;
    } finally {
        domain.dispose();
    }
}

/** Whether face b, moved by `gap` along `normal`, lands on face a (their projections overlap). */
function overlaps(a: EntityRef, b: EntityRef, normal: Vec3, gap: number): boolean {
    const faceA = entityShape(a) as IFace;
    const center = interiorPoint(b);
    return faceA.containsPoint(toXYZ(vec.add(center, vec.scale(normal, gap))), true, 1e-6);
}
