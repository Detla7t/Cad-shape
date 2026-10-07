// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, ShapeTypes } from "@chili3d/core";
import { FsMap, type FsValue, fail } from "../lang/values";
import { idString } from "../std/feature";
import { makePlaneData, type PlaneData, readPlane } from "../std/geometry";
import { enumName, optionalEnum, type StdBuilder } from "../std/registry";
import { connectedGroups } from "./connectivity";
import { type EntityKind, type FsBody, type FsContext, historySource, toKernelPlane } from "./fsContext";
import { faceSamples, geometricHistory, separateSerials } from "./geometricHistory";
import { definitionOf, kernel, throughAllDepthMm } from "./operations";
import { entitiesOf, facePlane, ownerBodies, query, registerQueryType, resolveQuery } from "./queries";

/**
 * `opSplitPart`: solid, sheet and wire bodies cut in pieces by a plane (a `Plane`, a
 * construction plane, a planar face taken as its infinite plane, a mate connector's XY
 * plane) — intersecting and subtracting the half-space in front of it — or, for solids,
 * by a sheet body or trimmed face through the kernel's splitter. Every piece is a body:
 * the first keeps the target's identity, the others are created by the operation; each
 * piece's faces and edges derive from the target's by the surface they lie on.
 * `qSplitBy` names the pieces in front of the tool (along its normal) or behind it, and
 * the split pieces of their faces and edges.
 */

export interface SplitSides {
    readonly front: Set<number>;
    readonly back: Set<number>;
}

const splitRecords = new WeakMap<FsContext, Map<string, SplitSides>>();

function recordsOf(ctx: FsContext): Map<string, SplitSides> {
    let records = splitRecords.get(ctx);
    if (records === undefined) {
        records = new Map();
        splitRecords.set(ctx, records);
    }
    return records;
}

/** The entities `qSplitBy(id, ...)` names on each side, recorded by the split operation `id`. */
export function splitSidesOf(ctx: FsContext, id: string): SplitSides {
    const records = recordsOf(ctx);
    let sides = records.get(id);
    if (sides === undefined) {
        sides = { front: new Set(), back: new Set() };
        records.set(id, sides);
    }
    return sides;
}

/** What a split cuts with: an infinite plane (meters), or a bounded sheet. */
interface SplitTool {
    readonly plane?: PlaneData;
    readonly shape?: IShape;
    readonly faces?: readonly IFace[];
    /** The tool's own body, deleted afterwards unless kept (sheet bodies only). */
    readonly body?: FsBody;
}

export function installSplitOperations(std: StdBuilder): void {
    std.fn("opSplitPart", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opSplitPart");
        splitPart(ctx, id, definition);
        return undefined;
    });
    std.fn("qSplitBy", (args) =>
        query("SPLIT", {
            featureId: args[0],
            ...(args[1] === undefined ? {} : { entityType: args[1] }),
            back: args[2] === true,
        }),
    );
    registerQueryType("SPLIT", (ctx, value) => {
        const sides = recordsOf(ctx).get(idString(value.field("featureId")));
        if (sides === undefined) return [];
        const serials = value.field("back") === true ? sides.back : sides.front;
        const type = value.field("entityType");
        const kind =
            type === undefined ? undefined : (enumName(type, "EntityType", "entityType") as EntityKind);
        return ctx.bodies.flatMap((body) =>
            entitiesOf(body, kind).filter((ref) =>
                serials.has(
                    ref.kind === "BODY" ? body.bodyAttr.serial : body.attrs(ref.kind)[ref.index].serial,
                ),
            ),
        );
    });
}

function splitPart(ctx: FsContext, id: string, definition: FsMap): void {
    const tool = splitTool(ctx, definition.field("tool"), definition.field("useTrimmed") === true);
    const targets = ownerBodies(resolveQuery(ctx, definition.field("targets")))
        .map((ref) => ref.body)
        .filter((body) => body.isModelGeometry && body !== tool.body);
    if (targets.length === 0) fail("opSplitPart needs solid, sheet or wire bodies to split");
    const keep = optionalEnum(definition.field("keepType"), "SplitOperationKeepType", "keepType", "KEEP_ALL");
    const sides = splitSidesOf(ctx, id);
    for (const target of targets) {
        const pieces =
            tool.plane !== undefined ? planeSplit(ctx, target, tool.plane) : sheetSplit(ctx, target, tool);
        if (pieces === undefined) continue;
        // The target's identity goes to a piece that is kept.
        if (keep === "KEEP_BACK") pieces.sort((a, b) => Number(b.back) - Number(a.back));
        const bodies = placePieces(ctx, id, target, pieces, sides);
        for (const [body, back] of bodies) {
            if ((keep === "KEEP_FRONT" && back) || (keep === "KEEP_BACK" && !back)) ctx.removeBody(body);
        }
    }
    if (definition.field("keepTools") !== true && tool.body !== undefined) ctx.removeBody(tool.body);
}

// ------------------------------------------------------------------ Tools

function splitTool(ctx: FsContext, value: FsValue, useTrimmed: boolean): SplitTool {
    if (value instanceof FsMap && value.tag === "Plane") return { plane: readPlane(value, "tool") };
    const refs = resolveQuery(ctx, value);
    if (refs.length === 0) fail("opSplitPart: the tool resolves to nothing");
    const bodies = new Set(refs.map((ref) => ref.body));
    if (bodies.size > 1) fail("opSplitPart needs a single tool: one sheet body, construction plane or face");
    const body = refs[0].body;
    const connector = body.flags.mateConnector;
    if (connector !== undefined)
        return { plane: makePlaneData(connector.origin, connector.zAxis, connector.xAxis) };
    if (body.flags.plane !== undefined && body.flags.construction === true)
        return { plane: body.flags.plane };
    const faceRefs = refs.filter((ref) => ref.kind === "FACE");
    const wholeBody = refs.some((ref) => ref.kind === "BODY");
    if (!wholeBody && faceRefs.length === 1 && !useTrimmed) {
        const plane = facePlane(body.faces()[faceRefs[0].index]);
        if (plane !== undefined) return { plane: makePlaneData(plane.origin, plane.normal) };
    }
    const deletable = body.kind === "SHEET" && body.isModelGeometry ? body : undefined;
    if (!wholeBody && faceRefs.length === 1) {
        const face = body.faces()[faceRefs[0].index];
        return { shape: face, faces: [face], body: deletable };
    }
    if (body.kind !== "SHEET")
        fail("opSplitPart's tool must be a sheet body, a construction plane or a face");
    return { shape: body.shape, faces: body.faces(), body: deletable };
}

// ------------------------------------------------------------------ Cutting

interface Piece {
    readonly shape: IShape;
    /** Behind the tool (against its normal). */
    readonly back: boolean;
}

/** The pieces of `target` on both sides of an infinite plane; undefined when the plane misses it. */
function planeSplit(ctx: FsContext, target: FsBody, plane: PlaneData): Piece[] | undefined {
    const size = throughAllDepthMm(ctx);
    const halfSpace = ctx.track(
        kernel(shapeFactory.box(toKernelPlane(plane, -size, -size), 2 * size, 2 * size, size), "opSplitPart"),
    );
    const front = components(
        ctx,
        ctx.track(kernel(shapeFactory.booleanCommon([target.shape], [halfSpace]), "opSplitPart")),
        target,
    );
    const back = components(
        ctx,
        ctx.track(kernel(shapeFactory.booleanCut([target.shape], [halfSpace]), "opSplitPart")),
        target,
    );
    if (front.length === 0 || back.length === 0) return undefined;
    return [
        ...front.map((shape) => ({ shape, back: false })),
        ...back.map((shape) => ({ shape, back: true })),
    ];
}

/** The pieces a sheet tool cuts a solid into; undefined when it does not cut through. */
function sheetSplit(ctx: FsContext, target: FsBody, tool: SplitTool): Piece[] | undefined {
    if (target.kind !== "SOLID")
        fail(
            "opSplitPart splits sheet and wire bodies by planes only (a plane, a construction plane or a planar face)",
        );
    const toolShape = tool.shape as IShape;
    let result: IShape;
    try {
        result = ctx.track(target.shape.split([toolShape]));
    } catch (error) {
        fail(`opSplitPart failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const solids = ctx.track(result.findSubShapes(ShapeTypes.solid));
    if (solids.length < 2) return undefined;
    // The pieces share their cut faces; each body gets its own copy.
    return solids.map((solid) => {
        const shape = ctx.track(solid.clone());
        return { shape, back: !inFrontOfSheet(ctx, shape, tool.faces ?? []) };
    });
}

/** A solid piece is in front of the tool when its faces on the tool face against the tool's normal. */
function inFrontOfSheet(ctx: FsContext, piece: IShape, toolFaces: readonly IFace[]): boolean {
    let votes = 0;
    for (const face of ctx.track(piece.findSubShapes(ShapeTypes.face)) as IFace[]) {
        for (const sample of faceSamples(face, 2)) {
            for (const toolFace of toolFaces) {
                const surface = toolFace.surface();
                try {
                    const nearest = surface.nearestPoint(sample.point);
                    if (nearest === undefined || nearest[1] > 1e-5) continue;
                    const uv = surface.parameter(sample.point, 1e-4);
                    if (uv === undefined) continue;
                    const normal = toolFace.normal(uv.u, uv.v)[1];
                    votes += normal.dot(sample.normal) < 0 ? 1 : -1;
                } finally {
                    surface.dispose();
                }
            }
        }
    }
    if (votes === 0) fail("opSplitPart could not tell which side of the tool a piece is on");
    return votes > 0;
}

/** The connected pieces of a boolean result, of the target's dimension. */
function components(ctx: FsContext, shape: IShape, target: FsBody): IShape[] {
    switch (target.kind) {
        case "SOLID":
            return (ctx.track(shape.findSubShapes(ShapeTypes.solid)) as IShape[]).filter(
                (solid) => Math.abs(solid.volume()) > 1e-9,
            );
        case "SHEET":
            return connected(ctx, ctx.track(shape.findSubShapes(ShapeTypes.face)), ShapeTypes.edge).map(
                (faces) =>
                    faces.length === 1
                        ? faces[0]
                        : ctx.track(kernel(shapeFactory.shell(faces as IFace[]), "opSplitPart")),
            );
        case "WIRE":
            return connected(ctx, ctx.track(shape.findSubShapes(ShapeTypes.edge)), ShapeTypes.vertex).map(
                (edges) => {
                    if (edges.length === 1) return edges[0];
                    const wire = shapeFactory.wire(edges as IEdge[]);
                    return ctx.track(
                        wire.isOk ? wire.value : kernel(shapeFactory.combine(edges), "opSplitPart"),
                    );
                },
            );
        default:
            return [];
    }
}

/** Groups shapes that share a sub-shape of type `by` (faces by edges, edges by vertices). */
function connected(
    ctx: FsContext,
    shapes: readonly IShape[],
    by: typeof ShapeTypes.edge | typeof ShapeTypes.vertex,
): IShape[][] {
    const subs = shapes.map((shape) => ctx.track(shape.findSubShapes(by)));
    return connectedGroups(shapes, (i, j) => subs[i].some((a) => subs[j].some((b) => a.isSame(b))));
}

// ------------------------------------------------------------------ Bodies and history

/**
 * Turns the pieces into bodies — the first keeps the target's identity — with entity
 * attributes inherited by surface; returns each body with its side.
 */
function placePieces(
    ctx: FsContext,
    opId: string,
    target: FsBody,
    pieces: readonly Piece[],
    sides: SplitSides,
): [FsBody, boolean][] {
    const sources = [historySource(target)];
    const histories = pieces.map((piece) => geometricHistory(ctx, piece.shape, sources));
    const bodies = histories.map((history, i) => {
        if (i === 0) {
            ctx.rebuildBody(target, history, sources, opId);
            return target;
        }
        return ctx.addDerivedBody(history, sources, opId);
    });
    // Inputs ending up in more than one output entity were split.
    const pieceCount = (kind: "faceMap" | "edgeMap") => {
        const counts = new Map<number, number>();
        for (const history of histories)
            for (const input of history[kind])
                if (input >= 0) counts.set(input, (counts.get(input) ?? 0) + 1);
        return counts;
    };
    const faceCounts = pieceCount("faceMap");
    const edgeCounts = pieceCount("edgeMap");
    separateSerials(ctx, opId, bodies);
    bodies.forEach((body, i) => {
        const side = pieces[i].back ? sides.back : sides.front;
        side.add(body.bodyAttr.serial);
        histories[i].faceMap.forEach((input, k) => {
            if (input >= 0 && (faceCounts.get(input) ?? 0) > 1) side.add(body.faceAttrs[k].serial);
        });
        histories[i].edgeMap.forEach((input, k) => {
            if (input >= 0 && (edgeCounts.get(input) ?? 0) > 1) side.add(body.edgeAttrs[k].serial);
        });
    });
    return bodies.map((body, i) => [body, pieces[i].back]);
}
