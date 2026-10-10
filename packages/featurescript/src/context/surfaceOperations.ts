// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IShape, type IWire, ShapeTypes, type TrackedShape, XYZ } from "@chili3d/core";
import { expectArray, type FsMap, type FsValue, fail, fsArray } from "../lang/values";
import { readDirection, type Vec3, vec } from "../std/geometry";
import { enumName, optionalEnum, type StdBuilder } from "../std/registry";
import { edgeParameter } from "./differential";
import { type EntityRef, type FsBody, type FsContext, historySource } from "./fsContext";
import { profileHistory, recordSweep } from "./history";
import { angleDeg, definitionOf, edgeRefsOf, kernel, lengthMm } from "./operations";
import { curveEnds, distinctSketchEdges, orderPaths } from "./paths";
import { curveTypeOf, facePlane, relatedEntities, resolveQuery } from "./queries";

/**
 * Surface operations of Onshape's std built from existing kernel operations: ruled
 * surfaces aligned with a direction (prisms of the path), boundary surfaces (a ruled
 * loft between two profiles, or the Coons patch of four), and the linear extension of
 * planar sheets across their straight boundary edges. Each refuses the options it does
 * not model instead of ignoring them.
 */
export function installSurfaceOperations(std: StdBuilder): void {
    std.fn("opRuledSurface", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opRuledSurface");
        ruledSurface(ctx, id, definition);
        // The local frames at `manipulatorPositions`: only the angle-from-face type asks for them.
        return fsArray([]);
    });
    std.fn("opBoundarySurface", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opBoundarySurface");
        boundarySurface(ctx, id, definition);
        return undefined;
    });
    std.fn("opExtendSheetBody", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opExtendSheetBody");
        extendSheetBody(ctx, id, definition);
        return undefined;
    });
}

// ------------------------------------------------------------------ Shared

const xyz = (v: Vec3) => new XYZ(v[0], v[1], v[2]);
const PERPENDICULAR_TOLERANCE = 1e-7;

/** The edges of a query (wire bodies give theirs) ordered into connected chains. */
function edgeChains(ctx: FsContext, value: FsValue, what: string): EntityRef[][] {
    const refs = distinctSketchEdges(edgeRefsOf(resolveQuery(ctx, value)));
    if (refs.length === 0) fail(`${what} needs edges`);
    const ends = refs.map((ref) => curveEnds(ref.body.edges()[ref.index]));
    return orderPaths(ends).map((chain) => chain.steps.map((step) => refs[step.edge]));
}

/** One edge as itself, several as a wire. */
function chainShape(ctx: FsContext, chain: readonly EntityRef[], what: string): IEdge | IWire {
    const edges = chain.map((ref) => ref.body.edges()[ref.index]);
    if (edges.length === 1) return edges[0];
    return ctx.track(kernel(shapeFactory.wire(edges), what));
}

/** Unit tangents along an edge at its ends and three inner points. */
function sampledTangents(edge: IEdge): Vec3[] {
    return [0, 0.25, 0.5, 0.75, 1].map((t) => {
        const d = edge.curve.d1(edgeParameter(edge, t, false)).vec;
        return vec.normalize([d.x, d.y, d.z]);
    });
}

// ------------------------------------------------------------------ Ruled surface

/**
 * `ALIGNED_WITH_VECTOR` ruled surfaces: every ruling runs along `ruledDirection` for
 * `width`, so each path chain sweeps straight into one sheet. Paths must run
 * perpendicular to the direction (where every reading of "aligned" agrees); angles,
 * vertex overrides and the face-referenced types are refused.
 */
function ruledSurface(ctx: FsContext, id: string, definition: FsMap): void {
    const type = enumName(definition.field("ruledSurfaceType"), "RuledSurfaceType", "ruledSurfaceType");
    if (type !== "ALIGNED_WITH_VECTOR")
        fail(`opRuledSurface: ${type} ruled surfaces are not supported yet (only ALIGNED_WITH_VECTOR)`);
    const angle = definition.field("angle");
    if (angle !== undefined && Math.abs(angleDeg(angle, "opRuledSurface angle")) > 1e-9)
        fail("opRuledSurface: an angle from the direction is not supported yet");
    const overrides = definition.field("vertexOverrides");
    if (overrides !== undefined && expectArray(overrides, "vertexOverrides").size > 0)
        fail("opRuledSurface: vertex overrides are not supported yet");
    const width = lengthMm(definition.field("width"), "opRuledSurface width");
    if (Math.abs(width) < 1e-9) fail("opRuledSurface needs a nonzero width");
    const direction = readDirection(definition.field("ruledDirection"), "ruledDirection");
    const chains = edgeChains(ctx, definition.field("path"), "opRuledSurface");
    for (const chain of chains) {
        for (const ref of chain) {
            const edge = ref.body.edges()[ref.index];
            if (sampledTangents(edge).some((t) => Math.abs(vec.dot(t, direction)) > PERPENDICULAR_TOLERANCE))
                fail("opRuledSurface: the path must run perpendicular to ruledDirection");
        }
    }
    // Build every sheet first: a failing chain must not leave the others behind.
    const sheets = chains.map((chain) => {
        const profile = chainShape(ctx, chain, "opRuledSurface");
        const vector = xyz(vec.scale(direction, width));
        if (shapeFactory.prismTracked === undefined) {
            return { chain, profile, shape: kernel(shapeFactory.prism(profile, vector), "opRuledSurface") };
        }
        const tracked = kernel(shapeFactory.prismTracked(profile, vector), "opRuledSurface");
        return { chain, profile, shape: tracked.shape, tracked };
    });
    for (const { chain, profile, shape, tracked } of sheets) {
        const body = ctx.addBody(shape, id);
        // A single path edge is the owner's own shape: its rulings derive from it.
        if (chain.length === 1)
            recordSweep(ctx, id, body, tracked, profileHistory(chain[0].body, profile, profile));
    }
}

// ------------------------------------------------------------------ Boundary surface

/**
 * A boundary surface through two u profiles (and no v profiles) interpolates linearly
 * between them — a ruled loft; with two u and two v profiles of one edge each it is the
 * Coons patch of the four. Boundary conditions (derivative info) are refused.
 */
function boundarySurface(ctx: FsContext, id: string, definition: FsMap): void {
    for (const field of ["uDerivativeInfo", "vDerivativeInfo"]) {
        const info = definition.field(field);
        if (info !== undefined && expectArray(info, field).size > 0)
            fail("opBoundarySurface: boundary conditions are not supported yet");
    }
    // Each profile's edges; empty profile slots (an unused array item) do not count.
    const profiles = (field: string) => {
        const value = definition.field(field);
        if (value === undefined) return [];
        return expectArray(value, field)
            .items.map((q) => distinctSketchEdges(edgeRefsOf(resolveQuery(ctx, q))))
            .filter((refs) => refs.length > 0);
    };
    const u = profiles("uProfileSubqueries");
    const v = profiles("vProfileSubqueries");
    let shape: IShape;
    if (u.length === 2 && v.length === 0) {
        const sections = u.map((refs) => chainShape(ctx, refs, "opBoundarySurface"));
        shape = kernel(shapeFactory.loft(sections, false, true, "c0"), "opBoundarySurface");
    } else if (u.length === 2 && v.length === 2 && [...u, ...v].every((refs) => refs.length === 1)) {
        if (shapeFactory.coonsSurface === undefined)
            fail("opBoundarySurface requires the Coons patch kernel");
        const edges = [u[0], v[0], u[1], v[1]].map(([ref]) => ref.body.edges()[ref.index]);
        shape = kernel(shapeFactory.coonsSurface(edges), "opBoundarySurface");
    } else
        fail(
            "opBoundarySurface: only two u profiles, or two u and two v single-edge profiles, are supported yet",
        );
    ctx.addBody(shape, id);
}

// ------------------------------------------------------------------ Extend sheet body

/**
 * Moves straight boundary edges of single-face planar sheets outward by a distance,
 * in the face's plane and perpendicular to each edge: the face's outline becomes the
 * polygon of its edge lines, the moved ones shifted, meeting their neighbours where the
 * lines cross — the linear extension, which on a plane is also the curvature-keeping one.
 */
function extendSheetBody(ctx: FsContext, id: string, definition: FsMap): void {
    const end = optionalEnum(
        definition.field("endCondition"),
        "ExtendEndType",
        "endCondition",
        "EXTEND_BLIND",
    );
    if (end !== "EXTEND_BLIND") fail("opExtendSheetBody: extending up to a target is not supported yet");
    const distance = lengthMm(definition.field("extendDistance"), "extendDistance");
    if (!(distance > 1e-9)) fail("opExtendSheetBody needs a positive distance");
    const picked = resolveQuery(ctx, definition.field("entities"));
    if (picked.length === 0) fail("opExtendSheetBody needs sheet bodies or boundary edges");
    // Bodies extend along all their boundary edges.
    const edges = picked.flatMap((ref) =>
        ref.kind === "BODY" ? relatedEntities(ref, "EDGE") : ref.kind === "EDGE" ? [ref] : [],
    );
    const laminar = edges.filter((ref) => relatedEntities(ref, "FACE").length === 1);
    if (
        laminar.length === 0 ||
        (picked.every((ref) => ref.kind === "EDGE") && laminar.length !== edges.length)
    )
        fail("opExtendSheetBody: only boundary edges of sheets can move");
    const byBody = new Map<FsBody, Set<number>>();
    for (const ref of laminar) {
        if (ref.body.kind !== "SHEET") fail("opExtendSheetBody extends sheet bodies only");
        byBody.set(ref.body, (byBody.get(ref.body) ?? new Set()).add(ref.index));
    }
    if (definition.field("tangentPropagation") !== false) {
        for (const [body, indexes] of byBody) propagateCollinear(body, indexes);
    }
    // Build every face first: a failing body must not leave the others extended.
    const results = [...byBody].map(([body, indexes]) => {
        if (body.faces().length !== 1) fail("opExtendSheetBody: multi-face sheets are not supported yet");
        return { body, face: extendedFace(ctx, body, indexes, distance) };
    });
    for (const { body, face } of results) ctx.rebuildBody(body, face, [historySource(body)], id);
}

/** Adds the boundary edges that continue a picked one in a straight line (tangent propagation). */
function propagateCollinear(body: FsBody, indexes: Set<number>): void {
    const edges = body.edges();
    const lineOf = (i: number) => {
        const [a, b] = curveEnds(edges[i]);
        return { a: [a.x, a.y, a.z] as Vec3, d: vec.normalize([b.x - a.x, b.y - a.y, b.z - a.z]) };
    };
    for (let grown = true; grown; ) {
        grown = false;
        for (let i = 0; i < edges.length; i++) {
            if (indexes.has(i) || curveTypeOf(edges[i]) !== "LINE") continue;
            const line = lineOf(i);
            const continues = [...indexes].some((j) => {
                if (curveTypeOf(edges[j]) !== "LINE") return false;
                const other = lineOf(j);
                const offset = vec.sub(line.a, other.a);
                return (
                    vec.norm(vec.cross(line.d, other.d)) < 1e-9 &&
                    vec.norm(vec.cross(offset, other.d)) < 1e-6 &&
                    edges[i].ends().some((p) => edges[j].ends().some((q) => p.distanceTo(q) < 1e-6))
                );
            });
            if (continues) {
                indexes.add(i);
                grown = true;
            }
        }
    }
}

function extendedFace(
    ctx: FsContext,
    body: FsBody,
    moved: ReadonlySet<number>,
    distance: number,
): TrackedShape {
    const face = body.faces()[0];
    const plane = facePlane(face);
    if (plane === undefined) fail("opExtendSheetBody: only planar sheets are supported yet");
    const outer = ctx.track(face.outerWire());
    const loopEdges = ctx.track(outer.findSubShapes(ShapeTypes.edge)) as IEdge[];
    const bodyEdges = body.edges();
    const indexOf = loopEdges.map((edge) => bodyEdges.findIndex((candidate) => candidate.isSame(edge)));
    if (indexOf.some((i) => i < 0)) fail("opExtendSheetBody: the sheet's outline is not its own");
    const innerMoved = [...moved].filter((i) => !indexOf.includes(i));
    if (innerMoved.length > 0) fail("opExtendSheetBody: only outer boundary edges can move yet");
    if (loopEdges.some((edge) => curveTypeOf(edge) !== "LINE"))
        fail("opExtendSheetBody: only sheets bounded by straight edges are supported yet");
    const [loop] = orderPaths(loopEdges.map(curveEnds));
    if (loop === undefined || !loop.closed || loop.steps.length !== loopEdges.length)
        fail("opExtendSheetBody: the sheet's outline is not one loop");
    // The loop's corners in order, then its turning sense about the face normal.
    const corners = loop.steps.map((step) => {
        const [a, b] = curveEnds(loopEdges[step.edge]);
        const p = step.flipped ? b : a;
        return [p.x, p.y, p.z] as Vec3;
    });
    const n = corners.length;
    let area: Vec3 = [0, 0, 0];
    for (let k = 0; k < n; k++) area = vec.add(area, vec.cross(corners[k], corners[(k + 1) % n]));
    const sense = Math.sign(vec.dot(area, plane.normal));
    // Each side's line, shifted outward (left of travel is inside for a counterclockwise loop).
    const lines = loop.steps.map((step, k) => {
        const from = corners[k];
        const to = corners[(k + 1) % n];
        const d = vec.normalize(vec.sub(to, from));
        const outward = vec.scale(vec.cross(d, plane.normal), sense);
        const shift = moved.has(indexOf[step.edge]) ? distance : 0;
        return { p: vec.add(from, vec.scale(outward, shift)), d };
    });
    const vertices = lines.map((line, k) => {
        const previous = lines[(k + n - 1) % n];
        // previous.p + s previous.d = line.p + t line.d, solved in the plane.
        const cross = vec.cross(previous.d, line.d);
        const denominator = vec.dot(cross, cross);
        if (denominator < 1e-18) fail("opExtendSheetBody: collinear neighbouring edges cannot move apart");
        const s = vec.dot(vec.cross(vec.sub(line.p, previous.p), line.d), cross) / denominator;
        return vec.add(previous.p, vec.scale(previous.d, s));
    });
    const polygon = ctx.track(
        kernel(shapeFactory.polygon([...vertices, vertices[0]].map(xyz)), "opExtendSheetBody"),
    );
    const holes = ctx
        .track(face.findSubShapes(ShapeTypes.wire))
        .filter((wire) => !wire.isSame(outer)) as IWire[];
    const result = ctx.track(kernel(shapeFactory.face([polygon, ...holes]), "opExtendSheetBody"));
    // Keep the face's side: the kernel orients a new planar face by its outline.
    const resultPlane = facePlane(result);
    if (resultPlane !== undefined && vec.dot(resultPlane.normal, plane.normal) < 0) result.reserve();
    // The history the rebuild inherits along: the face from the face, each outline side from
    // the edge whose line it lies on (moved or lengthened), hole edges from themselves.
    const holeEdges = holes.flatMap((wire) => ctx.track(wire.findSubShapes(ShapeTypes.edge)) as IEdge[]);
    const edgeMap = (ctx.track(result.findSubShapes(ShapeTypes.edge)) as IEdge[]).map((edge) => {
        const hole = holeEdges.find((candidate) => candidate.isSame(edge));
        if (hole !== undefined) return bodyEdges.findIndex((candidate) => candidate.isSame(hole));
        const [a, b] = curveEnds(edge);
        const mid: Vec3 = [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2];
        const k = lines.findIndex((line) => {
            const offset = vec.sub(mid, line.p);
            return vec.norm(vec.sub(offset, vec.scale(line.d, vec.dot(offset, line.d)))) < 1e-6;
        });
        return k < 0 ? -1 : indexOf[loop.steps[k].edge];
    });
    return { shape: result, faceMap: [0], edgeMap };
}
