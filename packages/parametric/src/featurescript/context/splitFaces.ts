// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, type Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { expectArray, expectNumber, FsArray, FsMap, type FsValue, fail, fsMap } from "../lang/values";
import { makePlaneData, type PlaneData, readDirection, readPlane, type Vec3, vec } from "../std/geometry";
import { optionalEnum, type StdBuilder } from "../std/registry";
import { type FsBody, type FsContext, historySource, MM_PER_METER, toKernelPlane } from "./fsContext";
import { faceSamples, geometricHistory } from "./geometricHistory";
import { definitionOf, edgeRefsOf, groupByBody } from "./operations";
import { curveTypeOf, facePlane, resolveQuery, transientQuery } from "./queries";
import { splitSidesOf } from "./splitOperations";

/**
 * Imprinting a body's faces and edges with the kernel's splitter, which divides the faces
 * along edges lying on them and the edges at vertices lying on them while keeping the
 * body whole: `opSplitFace` cuts the target faces where planes, faces and sheets cross
 * them, or along edges projected onto them; `opSplitEdges` cuts edges at parameters
 * (arc length by default) or where a plane or sheet crosses them. Pieces keep their
 * input's identity on the first, fresh ones on the rest (see `geometricHistory.ts`).
 */

interface FaceTool {
    readonly plane?: PlaneData;
    readonly shape?: IShape;
    /** Faces for telling the sides of a split apart (a plane is its own). */
    readonly faces?: readonly IFace[];
}

export function installSplitFaces(std: StdBuilder): void {
    std.fn("opSplitFace", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opSplitFace");
        return splitFaces(ctx, id, definition);
    });
    std.fn("opSplitEdges", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opSplitEdges");
        splitEdges(ctx, id, definition);
        return undefined;
    });
}

// ------------------------------------------------------------------ Faces

function resolve(ctx: FsContext, value: FsValue) {
    return value === undefined ? [] : resolveQuery(ctx, value);
}

/** A plane a tool reference stands for: a construction plane, a mate connector's XY plane, a planar face. */
function planeOf(ref: ReturnType<typeof resolve>[number]): PlaneData | undefined {
    const connector = ref.body.flags.mateConnector;
    if (connector !== undefined) return makePlaneData(connector.origin, connector.zAxis, connector.xAxis);
    if (ref.body.flags.plane !== undefined) return ref.body.flags.plane;
    if (ref.kind !== "FACE") return undefined;
    const plane = facePlane(ref.body.faces()[ref.index]);
    return plane === undefined ? undefined : makePlaneData(plane.origin, plane.normal);
}

function splitFaces(ctx: FsContext, id: string, definition: FsMap): FsValue {
    const targets = resolve(ctx, definition.field("faceTargets")).filter(
        (ref) => ref.kind === "FACE" && ref.body.isModelGeometry,
    );
    if (targets.length === 0) fail("opSplitFace needs faces of parts or surfaces to split");
    const tools: FaceTool[] = [];
    for (const ref of resolve(ctx, definition.field("planeTools"))) {
        const plane = planeOf(ref);
        if (plane === undefined) fail("opSplitFace's plane tools must be planes or planar faces");
        tools.push({ plane });
    }
    for (const ref of resolve(ctx, definition.field("faceTools"))) {
        if (ref.kind !== "FACE") continue;
        const face = ref.body.faces()[ref.index];
        tools.push({ shape: face, faces: [face] });
    }
    const bodyTools = [...new Set(resolve(ctx, definition.field("bodyTools")).map((ref) => ref.body))];
    for (const body of bodyTools) {
        if (body.kind === "SHEET") tools.push({ shape: body.shape, faces: body.faces() });
        else if (body.kind !== "WIRE") fail("opSplitFace's body tools must be sheet or wire bodies");
    }
    const edgeTools = [
        ...edgeRefsOf(resolve(ctx, definition.field("edgeTools"))).map((ref) => ref.body.edges()[ref.index]),
        ...bodyTools.filter((body) => body.kind === "WIRE").flatMap((body) => body.edges()),
    ];
    const projection = optionalEnum(
        definition.field("projectionType"),
        "ProjectionType",
        "projectionType",
        "NORMAL_TO_TARGET",
    );
    const direction =
        projection === "DIRECTION" && definition.field("direction") !== undefined
            ? readDirection(definition.field("direction"), "direction")
            : undefined;
    if (projection === "DIRECTION" && edgeTools.length > 0 && direction === undefined)
        fail("opSplitFace needs a direction to project its edge tools along");

    const sides = splitSidesOf(ctx, id);
    const splitting: FsValue[] = [];
    for (const [body, indexes] of groupByBody(targets)) {
        const cuts: IShape[] = [];
        for (const index of indexes) {
            const face = body.faces()[index];
            for (const tool of tools) cuts.push(...sectionEdges(ctx, face, tool));
            for (const edge of edgeTools) cuts.push(...projectedEdges(ctx, face, edge, direction));
        }
        if (cuts.length === 0) continue;
        const source = historySource(body);
        let result: IShape;
        try {
            result = ctx.track(body.shape.split(cuts));
        } catch (error) {
            fail(`opSplitFace failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const before = body.shape.findSubShapes(ShapeTypes.solid).length;
        const after = result.findSubShapes(ShapeTypes.solid).length;
        if (after !== before) fail("opSplitFace would change the body's solids");
        const history = geometricHistory(ctx, result, [source]);
        ctx.rebuildBody(body, history, [source], id);
        recordFaceSides(body, history.faceMap, tools, sides);
        body.edgeAttrs.forEach((attr, i) => {
            if (attr.createdBy === id) splitting.push(transientQuery({ body, kind: "EDGE", index: i }));
        });
    }
    if (definition.field("keepToolSurfaces") === false) for (const body of bodyTools) ctx.removeBody(body);
    return fsMap({ splittingEdges: new FsArray(splitting) });
}

/** Where a tool crosses a face: its section edges, inside the face. */
function sectionEdges(ctx: FsContext, face: IFace, tool: FaceTool): IShape[] {
    let section: IShape;
    try {
        const cutter: IShape | Plane =
            tool.plane !== undefined ? toKernelPlane(tool.plane) : (tool.shape as IShape);
        section = ctx.track(face.section(cutter));
    } catch {
        return [];
    }
    return ctx.track(section.findSubShapes(ShapeTypes.edge));
}

/** An edge projected onto a face: along `direction`, or along a planar face's normal. */
function projectedEdges(ctx: FsContext, face: IFace, edge: IEdge, direction: Vec3 | undefined): IShape[] {
    const along = direction ?? facePlane(face)?.normal;
    if (along === undefined)
        fail("opSplitFace projects edges normal to planar faces only (give a direction)");
    // A line along the projection direction projects to a point: it cuts nothing.
    if (curveTypeOf(edge) === "LINE") {
        const [a, b] = edge.ends();
        const d = b.sub(a);
        if (
            Math.abs(Math.abs(d.dot(new XYZ(along[0], along[1], along[2]))) - d.length()) <
            1e-9 * Math.max(1, d.length())
        )
            return [];
    }
    const projected = shapeFactory.curveProjection(edge, face, new XYZ(along[0], along[1], along[2]));
    if (!projected.isOk) return [];
    ctx.track(projected.value);
    return ctx.track(projected.value.findSubShapes(ShapeTypes.edge));
}

/** Records the pieces of split faces by the side of the tools they lie on (along the tool normal: front). */
function recordFaceSides(
    body: FsBody,
    faceMap: readonly number[],
    tools: readonly FaceTool[],
    sides: { front: Set<number>; back: Set<number> },
): void {
    const counts = new Map<number, number>();
    for (const input of faceMap) if (input >= 0) counts.set(input, (counts.get(input) ?? 0) + 1);
    faceMap.forEach((input, i) => {
        if (input < 0 || (counts.get(input) ?? 0) < 2) return;
        const sample = faceSamples(body.faces()[i], 2)[0];
        if (sample === undefined) return;
        const side = sideOf(sample.point, tools);
        if (side !== undefined) (side > 0 ? sides.front : sides.back).add(body.faceAttrs[i].serial);
    });
}

/** The signed side of a point (mm) to the nearest tool: positive along its normal. */
function sideOf(point: XYZ, tools: readonly FaceTool[]): number | undefined {
    let best: { distance: number; side: number } | undefined;
    for (const tool of tools) {
        if (tool.plane !== undefined) {
            const d =
                vec.dot(
                    vec.sub(
                        [point.x / MM_PER_METER, point.y / MM_PER_METER, point.z / MM_PER_METER],
                        tool.plane.origin,
                    ),
                    tool.plane.normal,
                ) * MM_PER_METER;
            if (best === undefined || Math.abs(d) < best.distance)
                best = { distance: Math.abs(d), side: Math.sign(d) };
            continue;
        }
        for (const face of tool.faces ?? []) {
            const surface = face.surface();
            try {
                const nearest = surface.nearestPoint(point);
                const uv = nearest === undefined ? undefined : surface.parameter(nearest[0], 1e-4);
                if (nearest === undefined || uv === undefined) continue;
                const normal = face.normal(uv.u, uv.v)[1];
                const side = Math.sign(point.sub(nearest[0]).dot(normal));
                if (best === undefined || nearest[1] < best.distance) best = { distance: nearest[1], side };
            } finally {
                surface.dispose();
            }
        }
    }
    return best === undefined || best.side === 0 ? undefined : best.side;
}

// ------------------------------------------------------------------ Edges

function splitEdges(ctx: FsContext, id: string, definition: FsMap): void {
    const refs = edgeRefsOf(resolve(ctx, definition.field("edges"))).filter(
        (ref) => ref.body.isModelGeometry,
    );
    if (refs.length === 0) fail("opSplitEdges needs edges of parts, surfaces or curves");
    const parametersValue = definition.field("parameters");
    const surfaceValue = definition.field("splittingSurface");
    if ((parametersValue === undefined) === (surfaceValue === undefined))
        fail("opSplitEdges needs either parameters or a splitting surface");
    const arcLength = definition.field("arcLengthParameterization") !== false;
    const parameters =
        parametersValue === undefined
            ? undefined
            : expectArray(parametersValue, "parameters").items.map((list, i) =>
                  expectArray(list, `parameters[${i}]`).items.map((u) =>
                      expectNumber(u, "A split parameter"),
                  ),
              );
    if (parameters !== undefined && parameters.length !== refs.length)
        fail("opSplitEdges needs one parameter array per edge");
    const surface = surfaceValue === undefined ? undefined : splittingSurface(ctx, surfaceValue);
    const points = new Map<FsBody, IShape[]>();
    refs.forEach((ref, i) => {
        const edge = ref.body.edges()[ref.index];
        const vertices =
            parameters !== undefined
                ? parameters[i].map((u) => {
                      if (!(u > 0 && u < 1))
                          fail("opSplitEdges parameters must lie strictly between 0 and 1");
                      const t = arcLength
                          ? parameterAtLength(edge, u)
                          : edge.firstParameter() + (edge.lastParameter() - edge.firstParameter()) * u;
                      const point = edge.pointAt(t);
                      const vertex = shapeFactory.point(point);
                      if (!vertex.isOk) fail("opSplitEdges could not place a split point");
                      return ctx.track(vertex.value) as IShape;
                  })
                : crossings(ctx, edge, surface as FaceTool);
        points.set(ref.body, [...(points.get(ref.body) ?? []), ...vertices]);
    });
    for (const [body, vertices] of points) {
        if (vertices.length === 0) continue;
        const source = historySource(body);
        let result: IShape;
        try {
            result = ctx.track(body.shape.split(vertices));
        } catch (error) {
            fail(`opSplitEdges failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        ctx.rebuildBody(body, geometricHistory(ctx, result, [source]), [source], id);
    }
}

function splittingSurface(ctx: FsContext, value: FsValue): FaceTool {
    if (value instanceof FsMap && value.tag === "Plane")
        return { plane: readPlane(value, "splittingSurface") };
    const refs = resolve(ctx, value);
    if (refs.length === 0) fail("opSplitEdges: the splitting surface resolves to nothing");
    const body = refs[0].body;
    if (
        body.flags.mateConnector !== undefined ||
        (body.flags.construction === true && body.flags.plane !== undefined)
    )
        return { plane: planeOf(refs[0]) };
    const faces = refs.flatMap((ref) =>
        ref.kind === "FACE" ? [ref.body.faces()[ref.index]] : ref.kind === "BODY" ? ref.body.faces() : [],
    );
    if (faces.length === 0) fail("opSplitEdges' splitting surface must be a sheet, a face or a plane");
    if (faces.length === 1) return { shape: faces[0], faces };
    const compound = shapeFactory.combine([...faces]);
    if (!compound.isOk) fail("opSplitEdges could not gather the splitting faces");
    return { shape: ctx.track(compound.value), faces };
}

/** Vertices where a plane or sheet crosses an edge. */
function crossings(ctx: FsContext, edge: IEdge, tool: FaceTool): IShape[] {
    let section: IShape;
    try {
        section = ctx.track(
            edge.section(tool.plane !== undefined ? toKernelPlane(tool.plane) : (tool.shape as IShape)),
        );
    } catch {
        return [];
    }
    const [start, end] = edge.ends();
    return (ctx.track(section.findSubShapes(ShapeTypes.vertex)) as IShape[]).filter((vertex) => {
        const point = (vertex as unknown as { point(): XYZ }).point();
        return point.distanceTo(start) > 1e-6 && point.distanceTo(end) > 1e-6;
    });
}

/** The curve parameter at fraction `u` of the edge's length (lines and arcs are uniform already). */
function parameterAtLength(edge: IEdge, u: number): number {
    const first = edge.firstParameter();
    const last = edge.lastParameter();
    const type = curveTypeOf(edge);
    if (type === "LINE" || type === "CIRCLE" || type === "ARC") return first + (last - first) * u;
    const total = edge.length();
    let lo = first;
    let hi = last;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const piece = edge.trim(first, mid);
        const length = piece === undefined ? 0 : piece.length();
        piece?.dispose();
        if (length < u * total) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}
