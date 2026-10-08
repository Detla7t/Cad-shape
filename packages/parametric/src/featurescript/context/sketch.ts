// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, type IWire, type Plane, type Result, XYZ } from "@chili3d/core";
import {
    groupConnected,
    hasBranchVertex,
    loopContains,
    needsKernelSplit,
    type Polygon,
    sampleLoop,
} from "../../features/profileGeometry";
import {
    expectArray,
    expectMap,
    expectNumber,
    expectQuantity,
    expectString,
    FsMap,
    FsOpaque,
    type FsValue,
    fail,
    LENGTH,
} from "../lang/values";
import { idString } from "../std/feature";
import {
    makePlaneData,
    type PlaneData,
    planeToWorld,
    readDirection,
    readPlane,
    readPoint2d,
    type Vec3,
} from "../std/geometry";
import { arg, type StdBuilder } from "../std/registry";
import { type FsBody, FsContext, MM_PER_METER, toKernelPlane } from "./fsContext";
import { recordSketchRegions } from "./history";
import { facePlane, resolveQuery } from "./queries";
import { solveSketchConstraints } from "./sketchConstraints";

/**
 * In-feature sketches (`newSketch` ... `skSolve`). Explicit entities and supported
 * constraints are solved by the same solver used by the interactive sketch editor.
 * Solved edges retain their FeatureScript entity ids; closed loops become queryable
 * sketch regions. Unsupported constraints report an error instead of being ignored.
 */

interface SketchEntity {
    readonly id: string;
    readonly construction: boolean;
    readonly edges: IEdge[];
}

export class FsSketch {
    readonly entities: SketchEntity[] = [];
    readonly initialGuesses = new Map<string, number[]>();
    readonly constraints: { id: string; definition: FsMap }[] = [];
    readonly points: { id: string; position: Vec3 }[] = [];
    solved = false;
    readonly value: FsOpaque;

    constructor(
        readonly context: FsContext,
        readonly id: string,
        readonly plane: PlaneData,
    ) {
        this.value = new FsOpaque("Sketch", this);
    }

    static of(value: FsValue): FsSketch {
        if (value instanceof FsOpaque && value.payload instanceof FsSketch) return value.payload;
        fail("Expected a Sketch (from newSketch)");
    }

    /** A sketch-plane point (meters) as a kernel world point (mm). */
    world(u: number, v: number): XYZ {
        const p = planeToWorld(this.plane, u, v);
        return new XYZ(p[0] * MM_PER_METER, p[1] * MM_PER_METER, p[2] * MM_PER_METER);
    }

    get normal(): XYZ {
        return new XYZ(this.plane.normal[0], this.plane.normal[1], this.plane.normal[2]);
    }

    add(id: string, construction: boolean, edges: IEdge[]): void {
        if (this.solved) fail(`Sketch already solved; cannot add "${id}"`);
        if (this.entities.some((entity) => entity.id === id) || this.points.some((p) => p.id === id)) {
            fail(`Sketch entity id "${id}" is already used`);
        }
        this.context.track(edges);
        this.entities.push({ id, construction, edges });
    }
}

function kernel<T>(result: Result<T>, what: string): T {
    if (!result.isOk) fail(`${what} failed: ${result.error}`);
    return result.value;
}

function lengthMm(value: FsValue, what: string): number {
    return expectQuantity(value, LENGTH, what) * MM_PER_METER;
}

function isConstruction(definition: FsMap): boolean {
    return definition.field("construction") === true;
}

function lineEdge(sketch: FsSketch, a: [number, number], b: [number, number], what: string): IEdge {
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) fail(`${what} has zero length`);
    return kernel(shapeFactory.line(sketch.world(a[0], a[1]), sketch.world(b[0], b[1])), what);
}

/** Center and radius (plane coords) of the circle through three points. */
function circleThrough(
    a: [number, number],
    b: [number, number],
    c: [number, number],
): { center: [number, number]; radius: number } {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-18) fail("skArc points are collinear");
    const sq = (p: [number, number]) => p[0] * p[0] + p[1] * p[1];
    const ux = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
    const uy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
    return { center: [ux, uy], radius: Math.hypot(a[0] - ux, a[1] - uy) };
}

/** Counter-clockwise sweep (radians) from `from` to `to` around the plane normal. */
function ccwSweep(from: number, to: number): number {
    let sweep = to - from;
    while (sweep <= 0) sweep += 2 * Math.PI;
    while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
    return sweep;
}

function arcEdge(
    sketch: FsSketch,
    center: [number, number],
    start: [number, number],
    sweepRad: number,
    what: string,
): IEdge {
    return kernel(
        shapeFactory.arc(
            sketch.normal,
            sketch.world(center[0], center[1]),
            sketch.world(start[0], start[1]),
            (sweepRad * 180) / Math.PI,
        ),
        what,
    );
}

export function installSketch(std: StdBuilder): void {
    std.fn("newSketch", (args) => {
        const ctx = FsContext.of(arg(args, 0, "newSketch"));
        const id = idString(arg(args, 1, "newSketch"));
        const definition = expectMap(arg(args, 2, "newSketch"), "newSketch definition");
        return openSketch(ctx, id, planeOfQuery(ctx, definition.field("sketchPlane"))).value;
    });
    std.fn("newSketchOnPlane", (args) => {
        const ctx = FsContext.of(arg(args, 0, "newSketchOnPlane"));
        const id = idString(arg(args, 1, "newSketchOnPlane"));
        const definition = expectMap(arg(args, 2, "newSketchOnPlane"), "newSketchOnPlane definition");
        return openSketch(ctx, id, readPlane(definition.field("sketchPlane"), "sketchPlane")).value;
    });

    std.fn("skLineSegment", (args) => {
        const [sketch, id, definition] = sketchArgs(args, "skLineSegment");
        const start = readPoint2d(definition.field("start"), "skLineSegment start");
        const end = readPoint2d(definition.field("end"), "skLineSegment end");
        sketch.add(id, isConstruction(definition), [lineEdge(sketch, start, end, `skLineSegment "${id}"`)]);
        return undefined;
    });
    std.fn("skCircle", (args) => {
        const [sketch, id, definition] = sketchArgs(args, "skCircle");
        const center = readPoint2d(definition.field("center"), "skCircle center");
        const radius = lengthMm(definition.field("radius"), "skCircle radius");
        if (radius <= 0) fail("skCircle radius must be positive");
        const edge = kernel(
            shapeFactory.circle(sketch.normal, sketch.world(center[0], center[1]), radius),
            `skCircle "${id}"`,
        );
        sketch.add(id, isConstruction(definition), [edge]);
        return undefined;
    });
    std.fn("skEllipse", (args) => {
        const [sketch, id, definition] = sketchArgs(args, "skEllipse");
        const center = readPoint2d(definition.field("center"), "skEllipse center");
        const major = lengthMm(definition.field("majorRadius"), "skEllipse majorRadius");
        const minor = lengthMm(definition.field("minorRadius"), "skEllipse minorRadius");
        const axisValue = definition.field("majorAxis");
        const axis2d = axisValue === undefined ? [1, 0] : readDirection(axisValue, "skEllipse majorAxis");
        const xWorld = planeToWorld({ ...sketch.plane, origin: [0, 0, 0] }, axis2d[0], axis2d[1]);
        const edge = kernel(
            shapeFactory.ellipse(
                sketch.normal,
                sketch.world(center[0], center[1]),
                new XYZ(xWorld[0], xWorld[1], xWorld[2]),
                Math.max(major, minor),
                Math.min(major, minor),
            ),
            `skEllipse "${id}"`,
        );
        sketch.add(id, isConstruction(definition), [edge]);
        return undefined;
    });
    std.fn("skArc", (args) => {
        const [sketch, id, definition] = sketchArgs(args, "skArc");
        const start = readPoint2d(definition.field("start"), "skArc start");
        const mid = readPoint2d(definition.field("mid"), "skArc mid");
        const end = readPoint2d(definition.field("end"), "skArc end");
        const { center } = circleThrough(start, mid, end);
        const angle = (p: [number, number]) => Math.atan2(p[1] - center[1], p[0] - center[0]);
        const a0 = angle(start);
        const sweepToEnd = ccwSweep(a0, angle(end));
        const sweepToMid = ccwSweep(a0, angle(mid));
        // Counter-clockwise when the mid point lies on the CCW path to the end; else go
        // clockwise, which is a CCW arc starting at `end`.
        const edge =
            sweepToMid < sweepToEnd
                ? arcEdge(sketch, center, start, sweepToEnd, `skArc "${id}"`)
                : arcEdge(sketch, center, end, 2 * Math.PI - sweepToEnd, `skArc "${id}"`);
        sketch.add(id, isConstruction(definition), [edge]);
        return undefined;
    });
    std.fn("skRectangle", (args) => {
        const [sketch, id, definition] = sketchArgs(args, "skRectangle");
        const a = readPoint2d(definition.field("firstCorner"), "skRectangle firstCorner");
        const c = readPoint2d(definition.field("secondCorner"), "skRectangle secondCorner");
        if (Math.abs(a[0] - c[0]) < 1e-12 || Math.abs(a[1] - c[1]) < 1e-12)
            fail(`skRectangle "${id}" is degenerate`);
        const [x0, x1] = [Math.min(a[0], c[0]), Math.max(a[0], c[0])];
        const [y0, y1] = [Math.min(a[1], c[1]), Math.max(a[1], c[1])];
        const construction = isConstruction(definition);
        sketch.add(`${id}.bottom`, construction, [lineEdge(sketch, [x0, y0], [x1, y0], "rectangle")]);
        sketch.add(`${id}.right`, construction, [lineEdge(sketch, [x1, y0], [x1, y1], "rectangle")]);
        sketch.add(`${id}.top`, construction, [lineEdge(sketch, [x1, y1], [x0, y1], "rectangle")]);
        sketch.add(`${id}.left`, construction, [lineEdge(sketch, [x0, y1], [x0, y0], "rectangle")]);
        return undefined;
    });
    std.fn("skRegularPolygon", (args) => {
        const [sketch, id, definition] = sketchArgs(args, "skRegularPolygon");
        const center = readPoint2d(definition.field("center"), "skRegularPolygon center");
        const first = readPoint2d(definition.field("firstVertex"), "skRegularPolygon firstVertex");
        const sides = expectNumber(definition.field("sides"), "skRegularPolygon sides");
        if (!Number.isInteger(sides) || sides < 3) fail("skRegularPolygon needs at least 3 sides");
        const radius = Math.hypot(first[0] - center[0], first[1] - center[1]);
        const start = Math.atan2(first[1] - center[1], first[0] - center[0]);
        const vertex = (i: number): [number, number] => [
            center[0] + radius * Math.cos(start + (2 * Math.PI * i) / sides),
            center[1] + radius * Math.sin(start + (2 * Math.PI * i) / sides),
        ];
        for (let i = 0; i < sides; i++) {
            sketch.add(`${id}.${i}`, isConstruction(definition), [
                lineEdge(sketch, vertex(i), vertex(i + 1), "polygon side"),
            ]);
        }
        return undefined;
    });
    std.fn("skPolyline", (args) => {
        const [sketch, id, definition] = sketchArgs(args, "skPolyline");
        const points = expectArray(definition.field("points"), "skPolyline points").items.map((p, i) =>
            readPoint2d(p, `skPolyline point ${i}`),
        );
        if (points.length < 2) fail("skPolyline needs at least two points");
        for (let i = 0; i + 1 < points.length; i++) {
            sketch.add(`${id}.${i}`, isConstruction(definition), [
                lineEdge(sketch, points[i], points[i + 1], "polyline segment"),
            ]);
        }
        return undefined;
    });
    std.fn("skSlot", (args) => {
        const [sketch, id, definition] = sketchArgs(args, "skSlot");
        const a = readPoint2d(definition.field("start"), "skSlot start");
        const b = readPoint2d(definition.field("end"), "skSlot end");
        const half = expectQuantity(definition.field("width"), LENGTH, "skSlot width") / 2;
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length < 1e-12 || half <= 0) fail("skSlot needs distinct ends and a positive width");
        const n: [number, number] = [(-(b[1] - a[1]) / length) * half, ((b[0] - a[0]) / length) * half];
        const construction = isConstruction(definition);
        const a1: [number, number] = [a[0] + n[0], a[1] + n[1]];
        const a2: [number, number] = [a[0] - n[0], a[1] - n[1]];
        const b1: [number, number] = [b[0] + n[0], b[1] + n[1]];
        const b2: [number, number] = [b[0] - n[0], b[1] - n[1]];
        sketch.add(`${id}.side1`, construction, [lineEdge(sketch, a1, b1, "slot side")]);
        sketch.add(`${id}.side2`, construction, [lineEdge(sketch, b2, a2, "slot side")]);
        // Each cap bulges away from the slot: CCW from the right side to the left at `end`,
        // from the left side to the right at `start`.
        sketch.add(`${id}.end1`, construction, [arcEdge(sketch, b, b2, Math.PI, "slot end")]);
        sketch.add(`${id}.end2`, construction, [arcEdge(sketch, a, a1, Math.PI, "slot end")]);
        return undefined;
    });
    std.fn("skBezier", (args) => {
        const [sketch, id, definition] = sketchArgs(args, "skBezier");
        const points = expectArray(definition.field("points"), "skBezier points").items.map((p, i) => {
            const q = readPoint2d(p, `skBezier point ${i}`);
            return sketch.world(q[0], q[1]);
        });
        if (points.length < 2) fail("skBezier needs at least two control points");
        sketch.add(id, isConstruction(definition), [kernel(shapeFactory.bezier(points), `skBezier "${id}"`)]);
        return undefined;
    });
    std.fn("skPoint", (args) => {
        const [sketch, id, definition] = sketchArgs(args, "skPoint");
        const position = readPoint2d(definition.field("position"), "skPoint position");
        sketch.points.push({ id, position: planeToWorld(sketch.plane, position[0], position[1]) });
        return undefined;
    });
    std.fn("skConstraint", (args) => {
        const [sketch, id, definition] = sketchArgs(args, "skConstraint");
        if (sketch.solved) fail("Cannot constrain an already solved sketch");
        if (sketch.constraints.some((c) => c.id === id)) fail(`Sketch constraint id "${id}" is already used`);
        sketch.constraints.push({ id, definition });
        return undefined;
    });
    std.fn("skSetInitialGuess", (args) => {
        const sketch = FsSketch.of(arg(args, 0, "skSetInitialGuess"));
        if (sketch.solved) fail("Cannot seed an already solved sketch");
        const guesses = expectMap(arg(args, 1, "skSetInitialGuess"), "initial guesses");
        for (const [key, value] of guesses.pairs()) {
            sketch.initialGuesses.set(
                expectString(key, "entity id"),
                expectArray(value, "initial guess").items.map((v) => expectNumber(v, "initial guess")),
            );
        }
        return undefined;
    });
    std.fn("skSolve", (args) => {
        solveSketch(FsSketch.of(arg(args, 0, "skSolve")));
        return undefined;
    });
}

function sketchArgs(args: FsValue[], fn: string): [FsSketch, string, FsMap] {
    const sketch = FsSketch.of(arg(args, 0, fn));
    const id = expectString(arg(args, 1, fn), `${fn} entity id`);
    const definition = args[2] === undefined ? new FsMap() : expectMap(args[2], `${fn} definition`);
    return [sketch, id, definition];
}

function openSketch(ctx: FsContext, id: string, plane: PlaneData): FsSketch {
    if (
        ctx.openSketches.has(id) ||
        ctx.bodies.some((body) => body.flags.sketch && body.bodyAttr.createdBy === id)
    ) {
        fail(`A sketch with id "${id}" already exists`);
    }
    const sketch = new FsSketch(ctx, id, plane);
    ctx.openSketches.set(id, sketch);
    return sketch;
}

/** The plane of a face query: a construction plane's definition, or a planar face's plane. */
export function planeOfQuery(ctx: FsContext, value: FsValue): PlaneData {
    const refs = resolveQuery(ctx, value);
    const ref =
        refs.find((r) => r.kind === "FACE") ??
        refs.find((r) => r.kind === "BODY" && r.body.flags.plane !== undefined);
    if (ref === undefined) fail("sketchPlane must resolve to a planar face or a plane");
    if (ref.body.flags.plane !== undefined) return ref.body.flags.plane;
    const plane = facePlane(ref.body.faces()[ref.index]);
    if (plane === undefined) fail("sketchPlane must be planar");
    return makePlaneData(plane.origin, plane.normal);
}

function solveSketch(sketch: FsSketch): void {
    if (sketch.solved) return;
    solveSketchConstraints(sketch);
    sketch.solved = true;
    const ctx = sketch.context;
    ctx.openSketches.delete(sketch.id);

    const drawn = sketch.entities.filter((entity) => !entity.construction);
    const construction = sketch.entities.filter((entity) => entity.construction);
    const wires = addWireBody(ctx, sketch, drawn, false);
    addWireBody(ctx, sketch, construction, true);

    const edges = drawn.flatMap((entity) => entity.edges);
    if (edges.length > 0) {
        const regions = sketchRegions(ctx, edges, toKernelPlane(sketch.plane));
        if (regions.faces.length > 0) {
            const compound = kernel(shapeFactory.combine(regions.faces), "sketch regions");
            const body = ctx.addBody(
                compound,
                sketch.id,
                { sketch: true, plane: sketch.plane },
                { faceExtra: (i) => ({ regionDepth: regions.depth[i] }) },
            );
            if (wires !== undefined) recordSketchRegions(ctx, sketch.id, wires, body);
        }
    }
    for (const point of sketch.points) {
        const vertex = shapeFactory.point({
            x: point.position[0] * MM_PER_METER,
            y: point.position[1] * MM_PER_METER,
            z: point.position[2] * MM_PER_METER,
        });
        if (!vertex.isOk) continue;
        const body = ctx.addBody(vertex.value, sketch.id, { sketch: true, plane: sketch.plane });
        body.vertexAttrs = body.vertexAttrs.map((attr) => ({ ...attr, sketchEntity: point.id }));
    }
}

/**
 * Every minimal region the drawn edges enclose, with its nesting depth (0 = outermost).
 * Simple loops go through endpoint connectivity — each loop becomes a face with its
 * direct children as holes, so a circle inside a rectangle yields the ring AND the
 * disc, as Onshape's sketch regions do. Crossing or T-junction edges need the kernel's
 * splitter (`facesFromEdges`), whose regions are all depth 0.
 */
function sketchRegions(ctx: FsContext, edges: IEdge[], plane: Plane): { faces: IFace[]; depth: number[] } {
    if (needsKernelSplit(edges) || groupConnected(edges).some(hasBranchVertex)) {
        const split = shapeFactory.facesFromEdges(edges, plane);
        if (!split.isOk) return { faces: [], depth: [] };
        ctx.track(split.value.faces);
        return { faces: split.value.faces, depth: split.value.faces.map(() => 0) };
    }
    const loops: { wire: IWire; polygon: Polygon }[] = [];
    for (const group of groupConnected(edges)) {
        const wire = shapeFactory.wire(group);
        if (!wire.isOk) continue;
        ctx.track(wire.value);
        if (!wire.value.isClosed()) continue;
        loops.push({ wire: wire.value, polygon: sampleLoop(group, plane) });
    }
    const containedIn = loops.map((loop, i) =>
        loops.map((other, j) => i !== j && loopContains(other.polygon, loop.polygon)),
    );
    const depth = containedIn.map((row) => row.filter(Boolean).length);
    const faces: IFace[] = [];
    const faceDepth: number[] = [];
    loops.forEach((loop, i) => {
        const holes = loops.flatMap((other, j) =>
            depth[j] === depth[i] + 1 && containedIn[j][i] ? [other.wire] : [],
        );
        const face = shapeFactory.face([loop.wire, ...holes]);
        if (!face.isOk) return;
        ctx.track(face.value);
        faces.push(face.value);
        faceDepth.push(depth[i]);
    });
    return { faces, depth: faceDepth };
}

function addWireBody(
    ctx: FsContext,
    sketch: FsSketch,
    entities: SketchEntity[],
    construction: boolean,
): FsBody | undefined {
    const edges = entities.flatMap((entity) => entity.edges);
    if (edges.length === 0) return undefined;
    const compound: IShape = kernel(shapeFactory.combine(edges), "sketch edges");
    const body = ctx.addBody(compound, sketch.id, { sketch: true, construction, plane: sketch.plane });
    const owners = entities.flatMap((entity) => entity.edges.map((edge) => ({ edge, id: entity.id })));
    body.edgeAttrs = body.edges().map((edge, i) => {
        const owner = owners[i]?.edge.isSame(edge)
            ? owners[i]
            : owners.find((candidate) => candidate.edge.isSame(edge));
        return { ...body.edgeAttrs[i], sketchEntity: owner?.id };
    });
    return body;
}
