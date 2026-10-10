// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, ShapeTypes, XYZ } from "@chili3d/core";
import {
    expectArray,
    expectNumber,
    expectQuantity,
    FsMap,
    type FsValue,
    fail,
    LENGTH,
    unitsEqual,
} from "../lang/values";
import { readVector, type Vec3, vec } from "../std/geometry";
import type { StdBuilder } from "../std/registry";
import { type FsBody, type FsContext, MM_PER_METER } from "./fsContext";
import { definitionOf, edgeRefsOf, kernel } from "./operations";
import { ownerBodies, resolveQuery } from "./queries";

/**
 * Wire-body operations: polylines with optional bends, wires extracted from edges, the
 * intersection curves of faces, and B-spline curves — built as exact Bézier segments
 * (one edge per knot span; a single-span spline is a single edge), since the kernel
 * binding builds Bézier edges, not B-spline ones.
 */

export function installCurveOperations(std: StdBuilder): void {
    std.fn("opPolyline", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opPolyline");
        polyline(ctx, id, definition);
        return undefined;
    });
    std.fn("opExtractWires", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opExtractWires");
        extractWires(ctx, id, definition);
        return undefined;
    });
    std.fn("opIntersectFaces", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opIntersectFaces");
        intersectFaces(ctx, id, definition);
        return undefined;
    });
    std.fn("opCreateBSplineCurve", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opCreateBSplineCurve");
        const segments = bezierSegments(readCurve(definition.field("bSplineCurve")));
        const edges = segments.map((segment) =>
            ctx.track(
                kernel(
                    shapeFactory.bezier(
                        segment.points.map(([x, y, z]) => new XYZ(x, y, z)),
                        segment.weights,
                    ),
                    "opCreateBSplineCurve",
                ),
            ),
        );
        const shape =
            edges.length === 1
                ? edges[0]
                : ctx.track(kernel(shapeFactory.wire(edges), "opCreateBSplineCurve"));
        ctx.addBody(shape, id);
        return undefined;
    });
}

// ------------------------------------------------------------------ Polyline

const toMm = (p: Vec3): Vec3 => vec.scale(p, MM_PER_METER);
const xyz = (p: Vec3) => new XYZ(p[0], p[1], p[2]);

function lengthPoint(value: FsValue, what: string): Vec3 {
    const vector = readVector(value, what);
    if (!unitsEqual(vector.units, LENGTH) || vector.values.length !== 3)
        fail(`${what} must be a 3D length vector`);
    return toMm([vector.values[0], vector.values[1], vector.values[2]]);
}

/**
 * Lines through the points, closed when the last point is the first; a positive bend
 * radius rounds its corner with a tangent arc.
 */
function polyline(ctx: FsContext, id: string, definition: FsMap): void {
    const points = expectArray(definition.field("points"), "points").items.map((p, i) =>
        lengthPoint(p, `points[${i}]`),
    );
    if (points.length < 2) fail("opPolyline needs at least two points");
    const closed = points.length > 2 && vec.norm(vec.sub(points[0], points[points.length - 1])) < 1e-6;
    const corners = closed ? points.slice(0, -1) : points;
    const radiiValue = definition.field("bendRadii");
    const radii =
        radiiValue === undefined
            ? []
            : expectArray(radiiValue, "bendRadii").items.map(
                  (r, i) => expectQuantity(r, LENGTH, `bendRadii[${i}]`) * MM_PER_METER,
              );
    const n = corners.length;
    // The bend at corner k: open polylines bend at their inner points (radius k - 1), closed
    // ones at every corner (the closing corner takes the last radius).
    const radiusAt = (k: number) => {
        if (!closed && (k === 0 || k === n - 1)) return 0;
        return radii[closed ? (k + n - 1) % n : k - 1] ?? 0;
    };
    const bends = corners.map((corner, k) =>
        radiusAt(k) > 1e-9
            ? bend(corners[(k + n - 1) % n], corner, corners[(k + 1) % n], radiusAt(k))
            : undefined,
    );
    const edges: IEdge[] = [];
    for (let k = 0; k < (closed ? n : n - 1); k++) {
        const next = (k + 1) % n;
        const from = bends[k]?.end ?? corners[k];
        const to = bends[next]?.start ?? corners[next];
        if (vec.norm(vec.sub(to, from)) > 1e-9) {
            if (vec.dot(vec.sub(to, from), vec.sub(corners[next], corners[k])) < 0)
                fail("opPolyline: the bend radii are too large for the segments between them");
            edges.push(ctx.track(kernel(shapeFactory.line(xyz(from), xyz(to)), "opPolyline")));
        }
        const arc = bends[next];
        if (arc !== undefined) edges.push(arcEdge(ctx, arc));
    }
    if (edges.length === 0) fail("opPolyline needs distinct points");
    ctx.addBody(ctx.track(kernel(shapeFactory.wire(edges), "opPolyline")), id);
}

interface Bend {
    readonly start: Vec3;
    readonly end: Vec3;
    readonly center: Vec3;
    readonly normal: Vec3;
    /** Degrees swept from `start` to `end`. */
    readonly angle: number;
}

/** The tangent arc of `radius` rounding the corner at `corner` between its neighbours. */
function bend(previous: Vec3, corner: Vec3, next: Vec3, radius: number): Bend | undefined {
    const toPrevious = vec.sub(previous, corner);
    const toNext = vec.sub(next, corner);
    if (vec.norm(toPrevious) < 1e-9 || vec.norm(toNext) < 1e-9) return undefined;
    const u = vec.normalize(toPrevious);
    const w = vec.normalize(toNext);
    const cross = vec.cross(u, w);
    // Collinear: no corner to round.
    if (vec.norm(cross) < 1e-9) return undefined;
    const interior = Math.acos(Math.max(-1, Math.min(1, vec.dot(u, w))));
    const tangent = radius / Math.tan(interior / 2);
    if (tangent > vec.norm(toPrevious) + 1e-9 || tangent > vec.norm(toNext) + 1e-9)
        fail("opPolyline: a bend radius is too large for its segments");
    const start = vec.add(corner, vec.scale(u, tangent));
    const end = vec.add(corner, vec.scale(w, tangent));
    const center = vec.add(corner, vec.scale(vec.normalize(vec.add(u, w)), radius / Math.sin(interior / 2)));
    const normal = vec.normalize(vec.cross(vec.sub(start, center), vec.sub(end, center)));
    return { start, end, center, normal, angle: ((Math.PI - interior) * 180) / Math.PI };
}

function arcEdge(ctx: FsContext, b: Bend): IEdge {
    return ctx.track(
        kernel(shapeFactory.arc(xyz(b.normal), xyz(b.center), xyz(b.start), b.angle), "opPolyline"),
    );
}

// ------------------------------------------------------------------ Extract wires

/** Wire bodies copying the edges: one per connected chain; branching chains are refused. */
function extractWires(ctx: FsContext, id: string, definition: FsMap): void {
    const refs = edgeRefsOf(resolveQuery(ctx, definition.field("edges")));
    if (refs.length === 0) fail("opExtractWires needs edges");
    const edges = refs.map((ref) => ref.body.edges()[ref.index]);
    for (const chain of chains(edges)) {
        const ordered = chain.map((i) => edges[i]);
        const original =
            ordered.length === 1
                ? ordered[0]
                : ctx.track(kernel(shapeFactory.wire(ordered), "opExtractWires"));
        const copy = ctx.addBody(ctx.track(original.clone()), id);
        // The copy enumerates like the original: each copied edge is made from its source.
        const sources = ctx.track(original.findSubShapes(ShapeTypes.edge));
        sources.forEach((shape, k) => {
            const source = chain.find((i) => edges[i].isSame(shape));
            const out = copy.edgeAttrs[k];
            if (source !== undefined && out !== undefined)
                ctx.derive(
                    id,
                    out.serial,
                    [refs[source].body.edgeAttrs[refs[source].index].serial],
                    "create",
                );
        });
    }
}

/** Edges ordered into connected chains (by coincident end points); a branch point fails. */
function chains(edges: readonly IEdge[]): number[][] {
    const ends = edges.map((edge) => edge.ends());
    const near = (a: XYZ, b: XYZ) => a.distanceTo(b) < 1e-6;
    const neighbours = edges.map((_, i) =>
        edges.map((_, j) => j).filter((j) => j !== i && ends[i].some((a) => ends[j].some((b) => near(a, b)))),
    );
    for (let i = 0; i < edges.length; i++) {
        for (const point of ends[i]) {
            const meeting = edges.filter((_, j) => ends[j].some((p) => near(p, point))).length;
            if (meeting > 2) fail("opExtractWires: more than two edges meet at a point");
        }
    }
    const used = new Set<number>();
    const result: number[][] = [];
    for (let seed = 0; seed < edges.length; seed++) {
        if (used.has(seed)) continue;
        // Walk back to an end of the chain (or around a loop), then forward.
        let start = seed;
        const visited = new Set([seed]);
        for (let previous = -1; ; ) {
            const back = neighbours[start].find((j) => j !== previous && !visited.has(j));
            if (back === undefined) break;
            visited.add(back);
            previous = start;
            start = back;
        }
        const chain = [start];
        used.add(start);
        for (let current = start; ; ) {
            const next = neighbours[current].find((j) => !used.has(j));
            if (next === undefined) break;
            chain.push(next);
            used.add(next);
            current = next;
        }
        result.push(chain);
    }
    return result;
}

// ------------------------------------------------------------------ Intersect faces

/** Wire bodies along the intersections of the tool faces with the target faces. */
function intersectFaces(ctx: FsContext, id: string, definition: FsMap): void {
    const tools = facesNamed(ctx, definition.field("tools"));
    const targets = facesNamed(ctx, definition.field("targets"));
    if (tools.length === 0 || targets.length === 0) fail("opIntersectFaces needs tool and target faces");
    const toolShape = ctx.track(kernel(shapeFactory.combine(tools), "opIntersectFaces"));
    const targetShape = ctx.track(kernel(shapeFactory.combine(targets), "opIntersectFaces"));
    let section: IShape;
    try {
        section = ctx.track(toolShape.section(targetShape));
    } catch (error) {
        fail(`opIntersectFaces failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const edges = ctx.track(section.findSubShapes(ShapeTypes.edge)) as IEdge[];
    if (edges.length === 0) fail("opIntersectFaces: the faces do not intersect");
    for (const chain of chains(edges)) {
        const ordered = chain.map((i) => edges[i]);
        const wire =
            ordered.length === 1 ? ordered[0] : kernel(shapeFactory.wire(ordered), "opIntersectFaces");
        ctx.addBody(ctx.track(wire.clone()), id);
    }
}

/** Faces a query names directly, and every face of the bodies it names. */
function facesNamed(ctx: FsContext, value: FsValue): IFace[] {
    const refs = resolveQuery(ctx, value);
    const faces: IFace[] = [];
    const bodies = new Set<FsBody>(
        ownerBodies(refs.filter((ref) => ref.kind === "BODY")).map((ref) => ref.body),
    );
    for (const body of bodies) faces.push(...body.faces());
    for (const ref of refs)
        if (ref.kind === "FACE" && !bodies.has(ref.body)) faces.push(ref.body.faces()[ref.index]);
    return faces;
}

// ------------------------------------------------------------------ B-spline curves

interface Curve {
    readonly degree: number;
    readonly knots: number[];
    /** Homogeneous control points (w·x, w·y, w·z, w), mm. */
    readonly points: number[][];
    readonly rational: boolean;
}

/** OCCT's largest Bézier degree. */
const MAX_DEGREE = 25;

function readCurve(value: FsValue): Curve {
    if (!(value instanceof FsMap)) fail("opCreateBSplineCurve needs a BSplineCurve");
    const degree = expectNumber(value.field("degree"), "degree");
    if (!Number.isInteger(degree) || degree < 1 || degree > MAX_DEGREE)
        fail(`opCreateBSplineCurve: the degree must be an integer from 1 to ${MAX_DEGREE}`);
    const points = expectArray(value.field("controlPoints"), "controlPoints").items.map((p, i) =>
        lengthPoint(p, `controlPoints[${i}]`),
    );
    const knots = expectArray(value.field("knots"), "knots").items.map((k) => expectNumber(k, "A knot"));
    const rational = value.field("isRational") === true;
    const weights = rational
        ? expectArray(value.field("weights"), "weights").items.map((w) => expectNumber(w, "A weight"))
        : points.map(() => 1);
    if (
        points.length <= degree ||
        knots.length !== points.length + degree + 1 ||
        weights.length !== points.length
    )
        fail("opCreateBSplineCurve: the knots and weights do not match the control points");
    if (weights.some((w) => !(w > 1e-9))) fail("opCreateBSplineCurve: weights must be positive");
    if (knots.some((k, i) => i > 0 && k < knots[i - 1]))
        fail("opCreateBSplineCurve: knots must not decrease");
    if (!(knots[points.length] > knots[degree])) fail("opCreateBSplineCurve: the spline has an empty domain");
    return {
        degree,
        knots,
        points: points.map((p, i) => [p[0] * weights[i], p[1] * weights[i], p[2] * weights[i], weights[i]]),
        rational,
    };
}

/** Inserts knot `u` once (Boehm's algorithm, The NURBS Book A5.1). */
function insertKnot(curve: Curve, u: number): Curve {
    const { degree: p, knots, points } = curve;
    // The knot span holding u: knots[k] <= u < knots[k + 1].
    let k = -1;
    for (let i = 0; i + 1 < knots.length; i++) if (knots[i] <= u && u < knots[i + 1]) k = i;
    if (k < p) fail("opCreateBSplineCurve: a knot lies outside the spline's domain");
    const s = knots.filter((knot) => knot === u).length;
    const next: number[][] = [];
    for (let i = 0; i <= points.length; i++) {
        if (i <= k - p) next.push(points[i]);
        else if (i >= k - s + 1) next.push(points[i - 1]);
        else {
            const alpha = (u - knots[i]) / (knots[i + p] - knots[i]);
            next.push(points[i].map((c, j) => alpha * c + (1 - alpha) * points[i - 1][j]));
        }
    }
    return { ...curve, knots: [...knots.slice(0, k + 1), u, ...knots.slice(k + 1)], points: next };
}

/** The spline's knot spans over its domain as Bézier segments (points in mm, weights when rational). */
function bezierSegments(input: Curve): { points: Vec3[]; weights?: number[] }[] {
    let curve = input;
    const p = curve.degree;
    const a = curve.knots[p];
    const b = curve.knots[curve.points.length];
    const values = [...new Set(curve.knots.filter((u) => u >= a && u <= b))];
    for (const u of values) {
        while (curve.knots.filter((knot) => knot === u).length < p) curve = insertKnot(curve, u);
    }
    const segments: { points: Vec3[]; weights?: number[] }[] = [];
    for (let i = p; i < curve.points.length; i++) {
        const [lo, hi] = [curve.knots[i], curve.knots[i + 1]];
        if (!(hi > lo) || lo < a || hi > b) continue;
        const homogeneous = curve.points.slice(i - p, i + 1);
        const first = homogeneous[0];
        if (
            homogeneous.every(
                (h) =>
                    Math.hypot(
                        h[0] / h[3] - first[0] / first[3],
                        h[1] / h[3] - first[1] / first[3],
                        h[2] / h[3] - first[2] / first[3],
                    ) < 1e-9,
            )
        )
            fail("opCreateBSplineCurve: a span of the spline collapses to a point");
        segments.push({
            points: homogeneous.map(([x, y, z, w]) => [x / w, y / w, z / w]),
            ...(curve.rational ? { weights: homogeneous.map((h) => h[3]) } : {}),
        });
    }
    if (segments.length === 0) fail("opCreateBSplineCurve: the spline has no span");
    return segments;
}
