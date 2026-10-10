// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, type IVertex, ShapeTypes, XYZ } from "@chili3d/core";
import { expectArray, expectMap, expectNumber, type FsMap, type FsValue, fail } from "../lang/values";
import { readDirection, type Vec3, vec } from "../std/geometry";
import { enumName, optionalEnum, type StdBuilder } from "../std/registry";
import { denormalize, faceDomain } from "./faceDomain";
import { entityKey, entityShape, type FsContext, historySource } from "./fsContext";
import { definitionOf, edgeRefsOf, kernel, lengthMm } from "./operations";
import { curveEnds, distinctSketchEdges, orderPaths } from "./paths";
import { curveTypeOf, facePlane, ownerBodies, query, relatedEntities, resolveQuery } from "./queries";

const xyz = (v: Vec3) => new XYZ(v[0], v[1], v[2]);

/**
 * Curves made on faces and wires: edges projected onto faces along a direction or the
 * faces' normals (`opDropCurve`), isoparametric curves (`opCreateCurvesOnFace`), edges
 * offset across planar faces (`opOffsetCurveOnFace`), wire ends trimmed or extended
 * (`opMoveCurveBoundary`), a wire given another curve (`opEditCurve`), and one B-spline
 * through a tangent chain of edges (`opSplineThroughEdges`). Each connected run of
 * result edges becomes one wire body.
 */
export function installFaceCurves(std: StdBuilder): void {
    std.fn("opDropCurve", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opDropCurve");
        const tools = distinctSketchEdges(edgeRefsOf(resolveQuery(ctx, definition.field("tools"))));
        if (tools.length === 0) fail("opDropCurve needs edges to project");
        const targets = targetFaces(ctx, definition.field("targets"));
        if (targets.length === 0) fail("opDropCurve needs target faces");
        const edges = tools.map((ref) => ref.body.edges()[ref.index]);
        const type = enumName(definition.field("projectionType"), "ProjectionType", "projectionType");
        const projected =
            type === "DIRECTION"
                ? directionProjection(
                      ctx,
                      edges,
                      targets,
                      readDirection(definition.field("direction"), "direction"),
                  )
                : normalProjection(ctx, edges, targets);
        if (projected.length === 0) fail("opDropCurve: the curves do not project onto the targets");
        addWireBodies(ctx, id, projected, "opDropCurve");
        return undefined;
    });
    std.fn("opCreateCurvesOnFace", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opCreateCurvesOnFace");
        const normalized = definition.field("useFaceParameter") !== false;
        const trim = definition.field("skipTrim") !== true;
        const groups = expectArray(definition.field("curveDefinition"), "curveDefinition").items;
        if (groups.length === 0) fail("opCreateCurvesOnFace needs curve definitions");
        // Build every curve first: a failing definition must not leave the others behind.
        const curves = groups.flatMap((value, i) =>
            isoCurves(ctx, expectMap(value, `curveDefinition[${i}]`), normalized, trim),
        );
        for (const edges of curves) addWireBodies(ctx, id, edges, "opCreateCurvesOnFace");
        return undefined;
    });
    std.fn("opOffsetCurveOnFace", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opOffsetCurveOnFace");
        offsetCurveOnFace(ctx, id, definition);
        return undefined;
    });
    std.fn("opMoveCurveBoundary", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opMoveCurveBoundary");
        moveCurveBoundary(ctx, id, definition);
        return undefined;
    });
    // The wire body takes the edge's curve (std's approximateResults swaps in its fitted
    // B-spline this way): same body, new geometry.
    std.fn("opEditCurve", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opEditCurve");
        const wires = [...new Set(resolveQuery(ctx, definition.field("wire")).map((ref) => ref.body))];
        if (wires.length !== 1 || wires[0].kind !== "WIRE") fail("opEditCurve needs one wire body");
        const refs = edgeRefsOf(resolveQuery(ctx, definition.field("edge")));
        if (refs.length === 0) fail("opEditCurve needs the edge to match");
        const edges = refs.map((ref) => ref.body.edges()[ref.index]);
        const [chain, ...others] = orderPaths(edges.map(curveEnds));
        if (others.length > 0) fail("opEditCurve: the curve must be one chain");
        const ordered = chain.steps.map((step) => edges[step.edge]);
        const shape =
            ordered.length === 1
                ? ctx.track(ordered[0].clone())
                : ctx.track(kernel(shapeFactory.wire(ordered), "opEditCurve"));
        ctx.rebuildBody(wires[0], shape, [historySource(wires[0])], id);
        return undefined;
    });
    std.fn("opSplineThroughEdges", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opSplineThroughEdges");
        if (shapeFactory.splineThroughEdges === undefined)
            fail("opSplineThroughEdges requires the curve joining kernel");
        const refs = distinctSketchEdges(edgeRefsOf(resolveQuery(ctx, definition.field("edges"))));
        if (refs.length === 0) fail("opSplineThroughEdges needs edges");
        const edges = refs.map((ref) => ref.body.edges()[ref.index]);
        const [chain, ...others] = orderPaths(edges.map(curveEnds));
        if (others.length > 0) fail("opSplineThroughEdges: the edges must form one chain");
        const ordered = chain.steps.map((step) => edges[step.edge]);
        ctx.addBody(ctx.track(kernel(shapeFactory.splineThroughEdges(ordered), "opSplineThroughEdges")), id);
        return undefined;
    });
}

/** Faces a query names directly, and every face of the solid and sheet bodies it names. */
function targetFaces(ctx: FsContext, value: FsValue): IFace[] {
    const refs = resolveQuery(ctx, value);
    const bodies = new Set(ownerBodies(refs.filter((ref) => ref.kind === "BODY")).map((ref) => ref.body));
    const faces = [...bodies].flatMap((body) => body.faces());
    for (const ref of refs)
        if (ref.kind === "FACE" && !bodies.has(ref.body)) faces.push(ref.body.faces()[ref.index]);
    return faces;
}

/** Points along an edge, mm. */
function samples(edge: IEdge, count = 16): Vec3[] {
    const t0 = edge.firstParameter();
    const t1 = edge.lastParameter();
    return Array.from({ length: count + 1 }, (_, k) => {
        const p = edge.pointAt(t0 + ((t1 - t0) * k) / count);
        return [p.x, p.y, p.z] as Vec3;
    });
}

/**
 * Projections along `direction`: the kernel intersects the faces with the cylinder the
 * curve sweeps both ways; only what lies ahead of the curve is the drop.
 */
function directionProjection(ctx: FsContext, tools: IEdge[], targets: IFace[], direction: Vec3): IEdge[] {
    const result: IEdge[] = [];
    for (const tool of tools) {
        const source = samples(tool, 64);
        for (const face of targets) {
            const projected = shapeFactory.curveProjection(tool, face, new XYZ(...direction));
            if (!projected.isOk) continue;
            const edges = ctx.track(ctx.track(projected.value).findSubShapes(ShapeTypes.edge)) as IEdge[];
            for (const edge of edges) {
                const [mid] = samples(edge, 2).slice(1, 2);
                if (aheadAlong(source, mid, direction) >= -1e-6) result.push(edge);
            }
        }
    }
    return result;
}

/**
 * How far `point` lies along `direction` from the source curve: the signed distance to
 * the source point it was projected from (the one on its line along the direction).
 */
function aheadAlong(source: readonly Vec3[], point: Vec3, direction: Vec3): number {
    let best = { off: Infinity, along: 0 };
    for (const p of source) {
        const d = vec.sub(point, p);
        const along = vec.dot(d, direction);
        const off = vec.norm(vec.sub(d, vec.scale(direction, along)));
        if (off < best.off) best = { off, along };
    }
    return best.along;
}

function normalProjection(ctx: FsContext, tools: IEdge[], targets: IFace[]): IEdge[] {
    if (shapeFactory.normalProjection === undefined)
        fail("opDropCurve requires the normal projection kernel");
    const target = ctx.track(kernel(shapeFactory.combine(targets), "opDropCurve"));
    const projected = ctx.track(kernel(shapeFactory.normalProjection(tools, target), "opDropCurve"));
    return ctx.track(projected.findSubShapes(ShapeTypes.edge)) as IEdge[];
}

/**
 * One group of isoparametric curves: for each parameter, the curve of the face's
 * surface at that constant u (`DIR1_ISO`) or v (`DIR2_ISO`), over the face's parameter
 * box, trimmed by the face. With `useFaceParameter` the parameters are normalized over
 * that box, as `evFaceTangentPlane` reads them.
 */
function isoCurves(ctx: FsContext, definition: FsMap, normalized: boolean, trim: boolean): IEdge[][] {
    const faces = resolveQuery(ctx, definition.field("face")).filter((ref) => ref.kind === "FACE");
    if (faces.length !== 1) fail("opCreateCurvesOnFace needs one face per curve definition");
    const face = faces[0].body.faces()[faces[0].index];
    const type = enumName(definition.field("creationType"), "FaceCurveCreationType", "creationType");
    if (type !== "DIR1_ISO" && type !== "DIR2_ISO")
        fail(`opCreateCurvesOnFace: ${type} curves are not supported yet (give the parameters)`);
    const parameters = expectArray(definition.field("parameters"), "parameters").items.map((value, i) =>
        expectNumber(value, `parameters[${i}]`),
    );
    const alongU = type === "DIR1_ISO";
    const domain = faceDomain(face);
    try {
        return parameters.map((value) => {
            if (normalized && !(value >= 0 && value <= 1))
                fail("opCreateCurvesOnFace: normalized parameters must lie between 0 and 1");
            const uv = normalized
                ? denormalize(domain, alongU ? value : 0, alongU ? 0 : value)
                : { u: value, v: value };
            const curve = alongU ? domain.surface.uIso(uv.u) : domain.surface.vIso(uv.v);
            const range = alongU ? domain.v : domain.u;
            const trimmed = curve.trim(range.min, range.max);
            if (trimmed === undefined)
                fail("opCreateCurvesOnFace: the curve leaves the face's parameter range");
            const edge = ctx.track(shapeFactory.edge(trimmed));
            if (!trim) return [edge];
            const clipped: IShape = ctx.track(
                kernel(shapeFactory.booleanCommon([edge], [face]), "opCreateCurvesOnFace"),
            );
            const edges = ctx.track(clipped.findSubShapes(ShapeTypes.edge)) as IEdge[];
            if (edges.length === 0) fail("opCreateCurvesOnFace: the curve misses the face");
            return edges;
        });
    } finally {
        domain.dispose();
    }
}

/** Wire bodies along `edges`: one per connected run. */
function addWireBodies(ctx: FsContext, id: string, edges: IEdge[], what: string): void {
    for (const chain of orderPaths(edges.map(curveEnds))) {
        const ordered = chain.steps.map((step) => edges[step.edge]);
        const shape = ordered.length === 1 ? ordered[0] : ctx.track(kernel(shapeFactory.wire(ordered), what));
        ctx.addBody(ctx.track(shape.clone()), id);
    }
}

// ------------------------------------------------------------------ Offset curves on faces

/**
 * Edges offset across the planar faces they bound: every point moves `distance` into
 * the face, perpendicular to the edge in the face's plane (geodesic and Euclidean
 * distances agree on a plane) — a line stays a parallel line of the same length, an
 * arc a concentric arc of the same angle. Paths must be single edges or
 * tangent-continuous chains (no corners to fill) and stay on their face; with `extend`
 * a single straight edge's offset runs on to the face's boundary. Splitting the faces
 * (`imprint`) is refused.
 */
function offsetCurveOnFace(ctx: FsContext, id: string, definition: FsMap): void {
    if (definition.field("imprint") === true)
        fail("opOffsetCurveOnFace: splitting the faces is not supported yet");
    const distance = lengthMm(definition.field("distance"), "distance");
    if (!(distance > 1e-9)) fail("opOffsetCurveOnFace needs a positive distance");
    const flip = definition.field("oppositeDirection") === true ? -1 : 1;
    const extend = definition.field("extend") === true;
    const targetKeys = new Set(
        resolveQuery(ctx, definition.field("targets") ?? query("NOTHING"))
            .filter((ref) => ref.kind === "FACE")
            .map(entityKey),
    );
    const refs = distinctSketchEdges(edgeRefsOf(resolveQuery(ctx, definition.field("edges"))));
    if (refs.length === 0) fail("opOffsetCurveOnFace needs edges");
    const chains = orderPaths(refs.map((ref) => curveEnds(ref.body.edges()[ref.index])));
    // Build every curve first: a failing path must not leave the others behind.
    const results = chains.map((chain) => {
        const steps = chain.steps.map((step) => {
            const ref = refs[step.edge];
            // The face the edge offsets across: a target bounded by it, else its only face.
            const faces = relatedEntities(ref, "FACE");
            const candidates =
                targetKeys.size > 0 ? faces.filter((f) => targetKeys.has(entityKey(f))) : faces;
            if (candidates.length !== 1)
                fail("opOffsetCurveOnFace: each edge must bound exactly one target face");
            const face = candidates[0].body.faces()[candidates[0].index];
            const plane = facePlane(face);
            if (plane === undefined) fail("opOffsetCurveOnFace: only planar faces are supported yet");
            return { edge: ref.body.edges()[ref.index], face, normal: plane.normal };
        });
        for (let k = 1; k < steps.length; k++) {
            const before = tangentAt(steps[k - 1].edge, chain.steps[k - 1].flipped, true);
            const after = tangentAt(steps[k].edge, chain.steps[k].flipped, false);
            if (vec.norm(vec.cross(before, after)) > 1e-6 || vec.dot(before, after) < 0)
                fail("opOffsetCurveOnFace: offsetting corners between edges is not supported yet");
        }
        if (extend && (steps.length !== 1 || curveTypeOf(steps[0].edge) !== "LINE"))
            fail("opOffsetCurveOnFace: extending is supported for single straight edges only");
        return steps.map(({ edge, face, normal }) => {
            // An extended offset is clipped to the face afterwards; a plain one must stay on it.
            const offset = offsetEdge(ctx, edge, face, normal, distance * flip, !extend);
            return extend ? extendAcross(ctx, offset, face) : offset;
        });
    });
    for (const edges of results) addWireBodies(ctx, id, edges, "opOffsetCurveOnFace");
}

/** The unit tangent at an edge's start or end, in the direction a path runs it. */
function tangentAt(edge: IEdge, flipped: boolean, atEnd: boolean): Vec3 {
    const u = atEnd !== flipped ? edge.lastParameter() : edge.firstParameter();
    const d = edge.curve.d1(u).vec;
    return vec.scale(vec.normalize([d.x, d.y, d.z]), flipped ? -1 : 1);
}

/** The edge moved `distance` into `face` (negative: away from it), perpendicular to itself in the face's plane. */
function offsetEdge(
    ctx: FsContext,
    edge: IEdge,
    face: IFace,
    normal: Vec3,
    distance: number,
    onFace: boolean,
): IEdge {
    const t0 = edge.firstParameter();
    const t1 = edge.lastParameter();
    const at = (t: number) => {
        const d = edge.curve.d1(t);
        const across = vec.normalize(vec.cross(normal, [d.vec.x, d.vec.y, d.vec.z]));
        return { point: [d.point.x, d.point.y, d.point.z] as Vec3, across };
    };
    const middle = at((t0 + t1) / 2);
    // Which side of the edge the face lies on.
    const probe = vec.add(middle.point, vec.scale(middle.across, 1e-3));
    const side = face.containsPoint(xyz(probe), false, 1e-7) ? 1 : -1;
    const moved = (t: number) => {
        const { point, across } = at(t);
        return vec.add(point, vec.scale(across, side * distance));
    };
    const type = curveTypeOf(edge);
    let result: IEdge;
    if (type === "LINE")
        result = kernel(shapeFactory.line(xyz(moved(t0)), xyz(moved(t1))), "opOffsetCurveOnFace");
    else if (type === "CIRCLE" || type === "ARC") result = concentricArc(edge, normal, moved);
    else fail("opOffsetCurveOnFace: only straight and circular edges are supported yet");
    ctx.track(result);
    // The offset must stay on the face (an offset leaving it would need trimming rules).
    for (let k = 0; onFace && k <= 8; k++) {
        const p = moved(t0 + ((t1 - t0) * k) / 8);
        if (!face.containsPoint(xyz(p), true, 1e-6))
            fail("opOffsetCurveOnFace: the offset curve leaves the face");
    }
    return result;
}

/** The arc through the moved points, about the same center. */
function concentricArc(edge: IEdge, normal: Vec3, moved: (t: number) => Vec3): IEdge {
    const t0 = edge.firstParameter();
    const t1 = edge.lastParameter();
    const [a, m, b] = [moved(t0), moved((t0 + t1) / 2), moved(t1)];
    // A full circle's ends coincide: its center comes from three distinct points.
    const center = circumcenter(a, moved(t0 + (t1 - t0) / 3), moved(t0 + (2 * (t1 - t0)) / 3));
    if (center === undefined) fail("opOffsetCurveOnFace: the offset collapses the arc");
    const radius = vec.norm(vec.sub(a, center));
    if (radius < 1e-6) fail("opOffsetCurveOnFace: the offset collapses the arc");
    if (vec.norm(vec.sub(a, b)) < 1e-7)
        return kernel(shapeFactory.circle(xyz(normal), xyz(center), radius), "opOffsetCurveOnFace");
    // The sweep from a through m to b about the face normal.
    const angleTo = (p: Vec3) => {
        const u = vec.sub(a, center);
        const v = vec.sub(p, center);
        const angle = Math.atan2(vec.dot(vec.cross(u, v), normal), vec.dot(u, v));
        return angle < 0 ? angle + 2 * Math.PI : angle;
    };
    const toEnd = angleTo(b);
    const sweep = angleTo(m) < toEnd ? toEnd : toEnd - 2 * Math.PI;
    return kernel(
        shapeFactory.arc(xyz(normal), xyz(center), xyz(a), (sweep * 180) / Math.PI),
        "opOffsetCurveOnFace",
    );
}

function circumcenter(a: Vec3, b: Vec3, c: Vec3): Vec3 | undefined {
    const ab = vec.sub(b, a);
    const ac = vec.sub(c, a);
    const n = vec.cross(ab, ac);
    const denominator = 2 * vec.dot(n, n);
    if (denominator < 1e-18) return undefined;
    const term = vec.add(
        vec.scale(vec.cross(n, ab), vec.dot(ac, ac)),
        vec.scale(vec.cross(ac, n), vec.dot(ab, ab)),
    );
    return vec.add(a, vec.scale(term, 1 / denominator));
}

/** A straight offset run on in both directions to the face's boundary. */
function extendAcross(ctx: FsContext, edge: IEdge, face: IFace): IEdge {
    const [a, b] = curveEnds(edge);
    const d = vec.normalize([b.x - a.x, b.y - a.y, b.z - a.z]);
    const box = face.boundingBox();
    const reach =
        Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) + a.distanceTo(b);
    const from = vec.sub([a.x, a.y, a.z], vec.scale(d, reach));
    const to = vec.add([b.x, b.y, b.z], vec.scale(d, reach));
    const line = ctx.track(kernel(shapeFactory.line(xyz(from), xyz(to)), "opOffsetCurveOnFace"));
    const clipped = ctx.track(kernel(shapeFactory.booleanCommon([line], [face]), "opOffsetCurveOnFace"));
    const pieces = ctx.track(clipped.findSubShapes(ShapeTypes.edge)) as IEdge[];
    // The piece holding the offset itself (its midpoint).
    const mid = xyz(vec.scale(vec.add([a.x, a.y, a.z], [b.x, b.y, b.z]), 0.5));
    const piece = pieces.find((candidate) =>
        candidate.curve.project(mid).some((p) => p.distanceTo(mid) < 1e-6),
    );
    if (piece === undefined) fail("opOffsetCurveOnFace: the extended offset leaves the face");
    return piece;
}

// ------------------------------------------------------------------ Trim / extend wire ends

/**
 * Moves one end of each wire body along its straight end edge: by a distance (`EXTEND`,
 * `BLIND`), up to an entity (`EXTEND`, `UP_TO_ENTITY`) or back to where the wire meets
 * an entity (`TRIM`). The end that moves is the one nearest the help point, else the
 * one nearest the bounding entity — the other one with `flipHeuristics` — as std's own
 * `findExtendOrigin` reads it. Curved end edges and trimming to points are refused.
 */
function moveCurveBoundary(ctx: FsContext, id: string, definition: FsMap): void {
    const type = optionalEnum(
        definition.field("moveBoundaryType"),
        "MoveCurveBoundaryType",
        "moveBoundaryType",
        "TRIM",
    );
    if (definition.field("trimToPoints") !== undefined || definition.field("helpPointPosition") !== undefined)
        fail("opMoveCurveBoundary: trimming to points is not supported yet");
    const blind =
        type === "EXTEND" &&
        optionalEnum(
            definition.field("endCondition"),
            "CurveExtensionEndCondition",
            "endCondition",
            "BLIND",
        ) === "BLIND";
    const bound = blind
        ? []
        : resolveQuery(ctx, definition.field(type === "TRIM" ? "trimTo" : "extendTo") ?? query("NOTHING"));
    if (!blind && bound.length === 0)
        fail(`opMoveCurveBoundary needs an entity to ${type === "TRIM" ? "trim" : "extend"} to`);
    const helpRefs = resolveQuery(ctx, definition.field("helpPoint") ?? query("NOTHING")).filter(
        (ref) => ref.kind === "VERTEX",
    );
    const help = helpRefs.length > 0 ? helpRefs[0].body.vertices()[helpRefs[0].index].point() : undefined;
    if (blind && help === undefined) fail("opMoveCurveBoundary: a blind extension needs a help point");
    const flip = definition.field("flipHeuristics") === true;
    const bodies = [...new Set(resolveQuery(ctx, definition.field("wires")).map((ref) => ref.body))].filter(
        (body) => body.kind === "WIRE",
    );
    if (bodies.length === 0) fail("opMoveCurveBoundary needs wire bodies");
    const boundShapes = bound.map(entityShape);
    // Build every wire first: a failing one must not leave the others moved.
    const results = bodies.map((body) => {
        const edges = body.edges();
        const [chain, ...others] = orderPaths(edges.map(curveEnds));
        if (others.length > 0 || chain === undefined || chain.closed)
            fail("opMoveCurveBoundary needs open wires of one chain");
        const ends = [
            { step: chain.steps[0], atEnd: chain.steps[0].flipped },
            {
                step: chain.steps[chain.steps.length - 1],
                atEnd: !chain.steps[chain.steps.length - 1].flipped,
            },
        ].map(({ step, atEnd }) => {
            const [a, b] = curveEnds(edges[step.edge]);
            return { edge: step.edge, moving: atEnd ? b : a, fixed: atEnd ? a : b };
        });
        const distanceTo = (p: XYZ) =>
            help !== undefined
                ? p.distanceTo(help)
                : Math.min(...boundShapes.map((shape) => pointShapeDistance(ctx, p, shape)));
        const nearest = distanceTo(ends[0].moving) <= distanceTo(ends[1].moving) ? 0 : 1;
        const end = ends[flip ? 1 - nearest : nearest];
        if (curveTypeOf(edges[end.edge]) !== "LINE")
            fail("opMoveCurveBoundary: only straight wire ends can move yet");
        const from: Vec3 = [end.fixed.x, end.fixed.y, end.fixed.z];
        const to: Vec3 = [end.moving.x, end.moving.y, end.moving.z];
        const span = vec.norm(vec.sub(to, from));
        const direction = vec.normalize(vec.sub(to, from));
        let target: Vec3;
        if (blind) {
            const distance = lengthMm(definition.field("extensionDistance"), "extensionDistance");
            if (!(distance > 1e-9)) fail("opMoveCurveBoundary needs a positive extension distance");
            target = vec.add(to, vec.scale(direction, distance));
        } else {
            // Where the end edge's line meets the entity, measured from the moving end outward.
            const hits = lineHits(ctx, from, direction, span, boundShapes).map((t) => t - span);
            const wanted =
                type === "TRIM"
                    ? hits.filter((t) => t < -1e-7 && t > -span + 1e-7)
                    : hits.filter((t) => t > 1e-7);
            if (wanted.length === 0)
                fail(
                    type === "TRIM"
                        ? "opMoveCurveBoundary: the entity does not cross the wire's end edge"
                        : "opMoveCurveBoundary: the entity does not lie ahead of the wire's end",
                );
            const t = type === "TRIM" ? Math.max(...wanted) : Math.min(...wanted);
            target = vec.add(to, vec.scale(direction, t));
        }
        const moved = ctx.track(kernel(shapeFactory.line(xyz(from), xyz(target)), "opMoveCurveBoundary"));
        const kept = edges.filter((_, i) => i !== end.edge);
        const shape: IShape =
            kept.length === 0
                ? moved
                : ctx.track(kernel(shapeFactory.wire([...kept, moved]), "opMoveCurveBoundary"));
        // Each output edge is its input edge: the kept ones by their ends, the moved one by elimination.
        const outputs = ctx.track(shape.findSubShapes(ShapeTypes.edge)) as IEdge[];
        const edgeMap = outputs.map((edge) => {
            const keptIndex = edges.findIndex((input, i) => i !== end.edge && sameEnds(input, edge));
            return keptIndex >= 0 ? keptIndex : end.edge;
        });
        return { body, tracked: { shape, faceMap: [], edgeMap } };
    });
    for (const { body, tracked } of results) ctx.rebuildBody(body, tracked, [historySource(body)], id);
}

function sameEnds(a: IEdge, b: IEdge): boolean {
    const [a0, a1] = curveEnds(a);
    const [b0, b1] = curveEnds(b);
    const near = (p: XYZ, q: XYZ) => p.distanceTo(q) < 1e-6;
    return (near(a0, b0) && near(a1, b1)) || (near(a0, b1) && near(a1, b0));
}

function pointShapeDistance(ctx: FsContext, p: XYZ, shape: IShape): number {
    const vertex = ctx.track(kernel(shapeFactory.point(p), "opMoveCurveBoundary"));
    return vertex.extremaDistance(shape);
}

/** Parameters (mm from `origin` along `direction`) where the infinite line meets the shapes. */
function lineHits(
    ctx: FsContext,
    origin: Vec3,
    direction: Vec3,
    span: number,
    shapes: readonly IShape[],
): number[] {
    const hits: number[] = [];
    for (const shape of shapes) {
        const box = shape.boundingBox();
        const corner = (p: { x: number; y: number; z: number }) => vec.norm(vec.sub([p.x, p.y, p.z], origin));
        const reach = span + corner(box.min) + corner(box.max) + 1;
        const line = ctx.track(
            kernel(
                shapeFactory.line(
                    xyz(vec.sub(origin, vec.scale(direction, reach))),
                    xyz(vec.add(origin, vec.scale(direction, reach))),
                ),
                "opMoveCurveBoundary",
            ),
        );
        if (shape.shapeType === ShapeTypes.vertex) {
            const p = (shape as IVertex).point();
            const t = vec.dot(vec.sub([p.x, p.y, p.z], origin), direction);
            const off = vec.norm(vec.sub(vec.sub([p.x, p.y, p.z], origin), vec.scale(direction, t)));
            if (off < 1e-6) hits.push(t);
            continue;
        }
        const section = ctx.track(line.section(shape));
        for (const vertex of ctx.track(section.findSubShapes(ShapeTypes.vertex)) as IVertex[]) {
            const p = vertex.point();
            hits.push(vec.dot(vec.sub([p.x, p.y, p.z], origin), direction));
        }
    }
    return hits;
}
