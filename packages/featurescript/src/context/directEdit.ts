// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IEdge,
    type IFace,
    type IShape,
    type IVertex,
    ShapeTypes,
    type TrackedShape,
    XYZ,
} from "@chili3d/core";
import { FsMap, type FsValue, fail } from "../lang/values";
import { readPlane, readTransform, type Vec3, vec } from "../std/geometry";
import { enumName, type StdBuilder } from "../std/registry";
import { connectedGroups } from "./connectivity";
import {
    type EntityAttribute,
    type EntityRef,
    type FsBody,
    type FsContext,
    type HistorySource,
    historySource,
    MM_PER_METER,
} from "./fsContext";
import { geometricHistory } from "./geometricHistory";
import { recordMoved } from "./history";
import { definitionOf, groupByBody, kernel, kernelMatrix, lengthMm, optionalLengthMm } from "./operations";
import { facePlane, query, relatedEntities, resolveQuery, subEntities, surfaceTypeOf } from "./queries";
import { edgeConvexity, isFilletFace } from "./queryTypes";

/**
 * Onshape's direct-editing operations on the kernel's own tools: deleting faces heals the
 * hole by extending the neighbours (defeaturing), caps it with a plane, or leaves it open;
 * moving, offsetting and replacing a face are done for planar faces whose neighbours
 * extend along the face normal (planes and cylinders parallel to it, extrusions along it)
 * — a prism of the face fused on or cut away, which is then exact — and refused otherwise.
 * Fillets are removed by defeaturing, or re-radiused by filleting the restored edge again.
 * Extracting copies faces into a sheet body, enclosing sews sheets and faces into solids,
 * flipping reverses sheet bodies. History the kernel does not report is recovered by
 * surface (see `geometricHistory.ts`).
 */

export function installDirectEdits(std: StdBuilder): void {
    std.fn("opDeleteFace", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opDeleteFace");
        deleteFaces(ctx, id, definition);
        return undefined;
    });
    std.fn("opExtractSurface", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opExtractSurface");
        extractSurface(ctx, id, definition);
        return undefined;
    });
    std.fn("opEnclose", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opEnclose");
        enclose(ctx, id, definition);
        return undefined;
    });
    std.fn("opFlipOrientation", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opFlipOrientation");
        const refs = resolveQuery(ctx, definition.field("bodies"));
        const bodies = [...new Set(refs.map((ref) => ref.body))].filter(
            (body) => body.kind === "SHEET" && body.isModelGeometry,
        );
        if (bodies.length === 0) fail("opFlipOrientation needs sheet bodies");
        for (const body of bodies) flipBody(ctx, id, body);
        return undefined;
    });
    std.fn("opOffsetFace", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opOffsetFace");
        const distance = lengthMm(definition.field("offsetDistance"), "offsetDistance");
        offsetFaces(ctx, id, definition.field("moveFaces"), () => distance, "opOffsetFace");
        return undefined;
    });
    std.fn("opMoveFace", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opMoveFace");
        const transform = readTransform(definition.field("transform"), "transform");
        const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        if (transform.m.some((value, i) => Math.abs(value - identity[i]) > 1e-12))
            fail(
                "opMoveFace moves faces by translations only (a rotation needs the face's neighbours re-intersected)",
            );
        const translation = vec.scale(transform.t, MM_PER_METER);
        // A plane translated along itself is the same plane: only the normal component moves it.
        offsetFaces(
            ctx,
            id,
            definition.field("moveFaces"),
            (normal) => vec.dot(translation, normal),
            "opMoveFace",
        );
        return undefined;
    });
    std.fn("opModifyFillet", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opModifyFillet");
        modifyFillets(ctx, id, definition);
        return undefined;
    });
    std.fn("opReplaceFace", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opReplaceFace");
        const template = templatePlane(ctx, definition.field("templateFace"));
        const offset = optionalLengthMm(definition.field("offset"), "offset");
        const target = vec.add(vec.scale(template.origin, MM_PER_METER), vec.scale(template.normal, offset));
        offsetFaces(
            ctx,
            id,
            definition.field("replaceFaces"),
            (normal, origin) => {
                if (Math.abs(Math.abs(vec.dot(normal, template.normal)) - 1) > 1e-9)
                    fail("opReplaceFace replaces planar faces by parallel planar templates only");
                return vec.dot(vec.sub(target, origin), normal);
            },
            "opReplaceFace",
        );
        return undefined;
    });
}

// ------------------------------------------------------------------ Delete face

function deleteFaces(ctx: FsContext, id: string, definition: FsMap): void {
    const refs = resolveQuery(ctx, definition.field("deleteFaces")).filter(
        (ref) => ref.kind === "FACE" && ref.body.isModelGeometry,
    );
    if (refs.length === 0) fail("opDeleteFace needs faces of parts or surfaces to delete");
    for (const [body, indexes] of groupByBody(refs)) {
        const chosen = new Set(indexes);
        if (definition.field("includeFillet") === true) {
            for (const index of indexes) {
                for (const next of adjacentFaces({ body, kind: "FACE", index }))
                    if (!chosen.has(next.index) && isFilletFace(next)) chosen.add(next.index);
            }
        }
        const faces = [...chosen].map((index) => body.faces()[index]);
        if (faces.length === body.faces().length) fail("opDeleteFace cannot delete every face of a body");
        const source = historySource(body);
        let result: IShape | undefined;
        if (body.kind === "SOLID" && definition.field("leaveOpen") !== true) {
            const healed = shapeFactory.removeFeature(body.shape, faces);
            if (healed.isOk && healedSolid(healed.value)) result = ctx.track(healed.value);
            else if (definition.field("capVoid") === true) result = capped(ctx, openShell(ctx, body, faces));
            else fail("opDeleteFace could not heal the faces by extending their neighbours");
        } else {
            result = openShell(ctx, body, faces);
        }
        ctx.rebuildBody(body, geometricHistory(ctx, result, [source]), [source], id);
    }
}

function adjacentFaces(ref: EntityRef): EntityRef[] {
    const seen = new Set<number>([ref.index]);
    const result: EntityRef[] = [];
    for (const edge of subEntities(ref, "EDGE")) {
        for (const face of relatedEntities(edge, "FACE")) {
            if (seen.has(face.index)) continue;
            seen.add(face.index);
            result.push(face);
        }
    }
    return result;
}

function healedSolid(shape: IShape): boolean {
    try {
        return shape.findSubShapes(ShapeTypes.solid).length > 0 && Math.abs(shape.volume()) > 1e-9;
    } catch {
        return false;
    }
}

/** The body's faces without `faces`, as a shell (a sheet), or a compound of shells. */
function openShell(ctx: FsContext, body: FsBody, faces: readonly IFace[]): IShape {
    const removed = ctx.track(kernel(shapeFactory.removeSubShape(body.shape, [...faces]), "opDeleteFace"));
    const shells = ctx.track(removed.findSubShapes(ShapeTypes.shell));
    if (shells.length === 1) return shells[0];
    if (shells.length > 1) return ctx.track(kernel(shapeFactory.combine(shells), "opDeleteFace"));
    return removed;
}

/** Closes the openings of a shell with planar faces; the result is a solid. */
function capped(ctx: FsContext, shell: IShape): IShape {
    const edges = ctx.track(shell.findSubShapes(ShapeTypes.edge)) as IEdge[];
    const free = edges.filter((edge) => {
        const faces = edge.findAncestor(ShapeTypes.face, shell);
        try {
            return faces.length === 1;
        } finally {
            for (const face of faces) face.dispose();
        }
    });
    if (free.length === 0) fail("opDeleteFace found no opening to cap");
    const caps = connectedEdges(free).map((loop) => {
        const wire = ctx.track(kernel(shapeFactory.wire(loop), "opDeleteFace cap"));
        const face = ctx.track(kernel(wire.toFace(), "opDeleteFace cap"));
        if (surfaceTypeOf(face) !== "PLANE") fail("opDeleteFace caps planar openings only");
        return face;
    });
    const solid = ctx.track(kernel(shapeFactory.sewing([shell, ...caps]), "opDeleteFace cap"));
    if (solid.shapeType !== ShapeTypes.solid || !isClosedSolid(solid))
        fail("opDeleteFace could not close the body with planar caps");
    if (solid.volume() < 0) solid.reserve();
    return solid;
}

/** Is every edge of every shell of the solid shared by two faces (or a seam of one)? */
export function isClosedSolid(solid: IShape): boolean {
    const shells = solid.findSubShapes(ShapeTypes.shell);
    try {
        return (
            shells.length > 0 &&
            shells.every((shell) => {
                const edges = shell.findSubShapes(ShapeTypes.edge) as IEdge[];
                try {
                    return edges.every((edge) => {
                        const faces = edge.findAncestor(ShapeTypes.face, shell);
                        try {
                            return faces.length >= 2 || safeLength(edge) < 1e-9;
                        } finally {
                            for (const face of faces) face.dispose();
                        }
                    });
                } finally {
                    for (const edge of edges) edge.dispose();
                }
            })
        );
    } finally {
        for (const shell of shells) shell.dispose();
    }
}

function safeLength(edge: IEdge): number {
    try {
        return edge.length();
    } catch {
        return 0;
    }
}

/** Edge chains: groups of edges sharing end points. */
function connectedEdges(edges: readonly IEdge[]): IEdge[][] {
    const ends = edges.map((edge) => edge.ends());
    return connectedGroups(edges, (i, j) => ends[i].some((a) => ends[j].some((b) => a.distanceTo(b) < 1e-6)));
}

// ------------------------------------------------------------------ Modify fillet

/**
 * Removes fillets (defeaturing restores the sharp edge they rounded) or changes their
 * radius: removed, then the restored edges filleted again. A changed fillet keeps its
 * identity — it joins the same two faces as before.
 */
function modifyFillets(ctx: FsContext, id: string, definition: FsMap): void {
    const refs = resolveQuery(ctx, definition.field("faces")).filter(
        (ref) => ref.kind === "FACE" && ref.body.kind === "SOLID" && ref.body.isModelGeometry,
    );
    if (refs.length === 0) fail("opModifyFillet needs fillet faces of parts");
    if (refs.some((ref) => !isFilletFace(ref))) fail("opModifyFillet modifies fillet faces only");
    const type = enumName(definition.field("modifyFilletType"), "ModifyFilletType", "modifyFilletType");
    const radius = type === "CHANGE_RADIUS" ? lengthMm(definition.field("radius"), "radius") : 0;
    if (type === "CHANGE_RADIUS" && !(radius > 0)) fail("opModifyFillet needs a positive radius");
    for (const [body, indexes] of groupByBody(refs)) {
        // Each fillet by the serials of the two faces it joins (smoothly, across its edges).
        const joins = indexes.map((index) => ({
            attr: body.faceAttrs[index],
            sides: smoothNeighbours(body, index),
        }));
        const faces = indexes.map((index) => body.faces()[index]);
        const source = historySource(body);
        const removed = shapeFactory.removeFeature(body.shape, faces);
        if (!removed.isOk || !healedSolid(removed.value)) fail("opModifyFillet could not remove the fillets");
        ctx.track(removed.value);
        ctx.rebuildBody(body, geometricHistory(ctx, removed.value, [source]), [source], id);
        if (type === "REMOVE_FILLET") continue;
        // The sharp edge each fillet rounded: the one between the two faces it joined.
        const corners = joins.map((join) =>
            body.edges().findIndex((_, index) => {
                const sides = relatedEntities({ body, kind: "EDGE", index }, "FACE").map(
                    (face) => body.faceAttrs[face.index].serial,
                );
                return (
                    sides.length === 2 &&
                    join.sides.length === 2 &&
                    join.sides.every((serial) => sides.includes(serial))
                );
            }),
        );
        if (corners.some((index) => index < 0) || shapeFactory.filletTracked === undefined)
            fail("opModifyFillet changes the radius of fillets joining two faces only");
        const filleted = kernel(shapeFactory.filletTracked(body.shape, corners, radius), "opModifyFillet");
        ctx.rebuildBody(body, filleted, [historySource(body)], id);
        // The new blend joining the same two faces as an old fillet takes its place.
        body.faceAttrs = body.faceAttrs.map((attr, index) => {
            if (attr.createdBy !== id) return attr;
            const sides = new Set(smoothNeighbours(body, index));
            const old = joins.find(
                (join) => join.sides.length > 0 && join.sides.every((serial) => sides.has(serial)),
            );
            if (old === undefined) return attr;
            ctx.derive(id, old.attr.serial, [old.attr.serial], "modify");
            return old.attr;
        });
    }
}

/** Serials of the faces meeting a face smoothly (tangent) along a shared edge. */
function smoothNeighbours(body: FsBody, index: number): number[] {
    const serials = new Set<number>();
    for (const edge of subEntities({ body, kind: "FACE", index }, "EDGE")) {
        if (edgeConvexity(edge) !== "SMOOTH") continue;
        for (const face of relatedEntities(edge, "FACE"))
            if (face.index !== index) serials.add(body.faceAttrs[face.index].serial);
    }
    return [...serials];
}

// ------------------------------------------------------------------ Extract surface

function extractSurface(ctx: FsContext, id: string, definition: FsMap): void {
    let facesQuery = definition.field("faces");
    if (definition.field("tangentPropagation") === true)
        facesQuery = query("TANGENT_CONNECTED_FACES", { query: facesQuery });
    const refs = resolveQuery(ctx, facesQuery).filter((ref) => ref.kind === "FACE");
    if (refs.length === 0) fail("opExtractSurface needs faces");
    const offset = optionalLengthMm(definition.field("offset"), "offset");
    for (const [body, indexes] of groupByBody(refs)) {
        for (const group of faceGroups(body, indexes)) copyFaces(ctx, id, body, group, offset);
    }
}

/** Indexes of a body's faces grouped into edge-connected sets. */
function faceGroups(body: FsBody, indexes: readonly number[]): number[][] {
    const wanted = new Set(indexes);
    const groups: number[][] = [];
    const placed = new Set<number>();
    for (const start of indexes) {
        if (placed.has(start)) continue;
        const group: number[] = [];
        const stack = [start];
        placed.add(start);
        while (stack.length > 0) {
            const index = stack.pop() as number;
            group.push(index);
            for (const next of adjacentFaces({ body, kind: "FACE", index })) {
                if (!wanted.has(next.index) || placed.has(next.index)) continue;
                placed.add(next.index);
                stack.push(next.index);
            }
        }
        groups.push(group.sort((a, b) => a - b));
    }
    return groups;
}

/** A new sheet body: copies of the faces (moved by `offset` mm along a common normal). */
function copyFaces(
    ctx: FsContext,
    id: string,
    body: FsBody,
    indexes: readonly number[],
    offset: number,
): void {
    const faces = indexes.map((index) => body.faces()[index]);
    const original =
        faces.length === 1 ? faces[0] : ctx.track(kernel(shapeFactory.shell(faces), "opExtractSurface"));
    let copy = ctx.track(original.clone());
    if (Math.abs(offset) > 1e-12) {
        const normal = commonNormal(faces);
        if (normal === undefined)
            fail(
                "opExtractSurface offsets planar faces sharing one normal only (curved faces need a surface offset)",
            );
        copy = ctx.track(
            copy.transformedMul(
                kernelMatrix({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: vec.scale(normal, offset / MM_PER_METER) }),
            ),
        );
    }
    const extracted = ctx.addBody(copy, id);
    // The copy enumerates its sub-shapes as the original does: each copied entity is made from its source.
    for (const kind of ["FACE", "EDGE", "VERTEX"] as const) {
        const type =
            kind === "FACE" ? ShapeTypes.face : kind === "EDGE" ? ShapeTypes.edge : ShapeTypes.vertex;
        const sources = ctx.track(original.findSubShapes(type));
        const candidates = body.subShapes(kind);
        sources.forEach((shape, i) => {
            const index = candidates.findIndex((candidate) => candidate.isSame(shape));
            const out = extracted.attrs(kind)[i];
            if (index >= 0 && out !== undefined)
                ctx.derive(id, out.serial, [body.attrs(kind)[index].serial], "create");
        });
    }
}

function commonNormal(faces: readonly IFace[]): Vec3 | undefined {
    let normal: Vec3 | undefined;
    for (const face of faces) {
        const plane = facePlane(face);
        if (plane === undefined) return undefined;
        if (normal === undefined) normal = plane.normal;
        else if (vec.dot(normal, plane.normal) < 1 - 1e-9) return undefined;
    }
    return normal;
}

// ------------------------------------------------------------------ Enclose

/**
 * Solids bounded by sheets and faces. The faces are split where they cross, pieces with
 * an edge no other piece shares (overhangs past the enclosed region) are dropped until
 * none is left, and what remains is sewn into closed shells.
 */
function enclose(ctx: FsContext, id: string, definition: FsMap): void {
    const refs = resolveQuery(ctx, definition.field("entities"));
    const faces: IFace[] = [];
    const sources: HistorySource[] = [];
    for (const [body, indexes] of groupByBody(
        refs.filter((ref) => ref.kind === "FACE" || ref.kind === "BODY"),
    )) {
        if (body.flags.mateConnector !== undefined || body.flags.composite !== undefined) continue;
        const all = indexes.includes(-1);
        const picked = all ? body.faces() : indexes.map((index) => body.faces()[index]);
        faces.push(...picked);
        if (picked.length > 0) sources.push(historySource(body));
    }
    if (faces.length < 2) fail("opEnclose needs sheets or faces bounding a region");
    const pieces = pruneOpen(ctx, splitAgainstEachOther(ctx, faces));
    if (pieces.length === 0) fail("opEnclose found no enclosed region");
    const sewn = ctx.track(kernel(shapeFactory.sewing(pieces), "opEnclose"));
    const solids = ctx.track(sewn.findSubShapes(ShapeTypes.solid));
    if (solids.length === 0 || solids.some((solid) => !isClosedSolid(solid)))
        fail("opEnclose found no closed region: the sheets must meet edge to edge or cross each other");
    const merge = definition.field("mergeResults") === true;
    const outputs = merge || solids.length === 1 ? [solids.length === 1 ? solids[0] : sewn] : solids;
    const inputFaces = sources.flatMap((source) => source.faceAttrs);
    const inputEdges = sources.flatMap((source) => source.edgeAttrs);
    for (const output of outputs) {
        let shape = output;
        if (shape.volume() < 0) {
            shape = ctx.track(shape.clone());
            shape.reserve();
        }
        // A new part, its faces and edges made from the sheet faces and edges they lie on.
        const solid = ctx.addBody(shape, id);
        const history = geometricHistory(ctx, shape, sources);
        history.faceMap.forEach((input, i) => {
            if (input >= 0) ctx.derive(id, solid.faceAttrs[i].serial, [inputFaces[input].serial], "create");
        });
        history.edgeMap.forEach((input, i) => {
            if (input >= 0) ctx.derive(id, solid.edgeAttrs[i].serial, [inputEdges[input].serial], "create");
        });
    }
}

/** Each face split by every other one. */
function splitAgainstEachOther(ctx: FsContext, faces: readonly IFace[]): IFace[] {
    const pieces: IFace[] = [];
    faces.forEach((face, i) => {
        const others = faces.filter((_, j) => j !== i);
        let split: IShape;
        try {
            split = ctx.track(face.split(others));
        } catch {
            split = face;
        }
        const parts = ctx.track(split.findSubShapes(ShapeTypes.face)) as IFace[];
        pieces.push(...(parts.length > 0 ? parts : [face]));
    });
    return pieces;
}

/** Drops pieces with an edge no other piece runs along, until every edge is shared. */
function pruneOpen(ctx: FsContext, pieces: readonly IFace[]): IFace[] {
    const edges = pieces.map((piece) =>
        (ctx.track(piece.findSubShapes(ShapeTypes.edge)) as IEdge[]).map(edgeKey),
    );
    let alive = pieces.map(() => true);
    for (let changed = true; changed; ) {
        changed = false;
        const next = [...alive];
        pieces.forEach((_, i) => {
            if (!alive[i]) return;
            const open = edges[i].some(
                (key) =>
                    key !== undefined &&
                    !edges.some(
                        (other, j) =>
                            j !== i && alive[j] && other.some((k) => k !== undefined && sameEdge(k, key)),
                    ),
            );
            if (open) {
                next[i] = false;
                changed = true;
            }
        });
        alive = next;
    }
    return pieces.filter((_, i) => alive[i]);
}

interface EdgeKey {
    readonly a: XYZ;
    readonly b: XYZ;
    readonly mid: XYZ;
}

function edgeKey(edge: IEdge): EdgeKey | undefined {
    try {
        const [a, b] = edge.ends();
        return { a, b, mid: edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2) };
    } catch {
        return undefined;
    }
}

function sameEdge(p: EdgeKey, q: EdgeKey): boolean {
    const near = (x: XYZ, y: XYZ) => x.distanceTo(y) < 1e-5;
    return near(p.mid, q.mid) && ((near(p.a, q.a) && near(p.b, q.b)) || (near(p.a, q.b) && near(p.b, q.a)));
}

// ------------------------------------------------------------------ Flip orientation

function flipBody(ctx: FsContext, id: string, body: FsBody): void {
    const attrs = { faces: body.faceAttrs, edges: body.edgeAttrs, vertices: body.vertexAttrs };
    const flipped = ctx.track(body.shape.clone());
    flipped.reserve();
    body.setShape(flipped);
    // A copy enumerates its sub-shapes in the same order.
    body.faceAttrs = attrs.faces;
    body.edgeAttrs = attrs.edges;
    body.vertexAttrs = attrs.vertices;
    recordMoved(ctx, id, body);
}

// ------------------------------------------------------------------ Move, offset and replace faces

/** A planar template: a `Plane`, or a planar face (its outward normal). */
function templatePlane(ctx: FsContext, value: FsValue): { origin: Vec3; normal: Vec3 } {
    if (value instanceof FsMap && value.tag === "Plane") return readPlane(value, "templateFace");
    const face = resolveQuery(ctx, value).find((ref) => ref.kind === "FACE");
    if (face === undefined) fail("opReplaceFace needs a template face");
    const plane = facePlane(face.body.faces()[face.index]);
    if (plane === undefined) fail("opReplaceFace replaces planar faces by parallel planar templates only");
    return plane;
}

/**
 * Moves each planar face along its outward normal by `distanceOf(normal, origin)` mm (the
 * face plane's unit normal and a point on it, mm), one face at a time.
 */
function offsetFaces(
    ctx: FsContext,
    opId: string,
    value: FsValue,
    distanceOf: (normal: Vec3, origin: Vec3) => number,
    what: string,
): void {
    const refs = resolveQuery(ctx, value).filter((ref) => ref.kind === "FACE" && ref.body.isModelGeometry);
    if (refs.length === 0) fail(`${what} needs faces of parts`);
    // Faces are followed by serial: each move rebuilds the body.
    const targets = refs.map((ref) => ({ body: ref.body, serial: ref.body.faceAttrs[ref.index].serial }));
    for (const { body, serial } of targets) {
        if (body.kind !== "SOLID") fail(`${what} moves faces of solid parts only`);
        const index = body.faceAttrs.findIndex((attr) => attr.serial === serial);
        if (index < 0) continue;
        const face = body.faces()[index];
        const plane = facePlane(face);
        if (plane === undefined) fail(`${what} moves planar faces only`);
        const distance = distanceOf(plane.normal, vec.scale(plane.origin, MM_PER_METER));
        if (Math.abs(distance) < 1e-9) continue;
        for (const neighbour of adjacentFaces({ body, kind: "FACE", index })) {
            if (!extendsAlong(body.faces()[neighbour.index], plane.normal))
                fail(
                    `${what} needs the neighbours of a moved face to extend along its normal (planes and cylinders parallel to it)`,
                );
        }
        offsetPlanarFace(ctx, opId, body, index, plane.normal, distance, what);
    }
}

/** Does the face's surface contain every line along `direction` through it (so extending it along `direction` keeps it)? */
function extendsAlong(face: IFace, direction: Vec3): boolean {
    const type = surfaceTypeOf(face);
    if (type === "PLANE") {
        const plane = facePlane(face);
        return plane !== undefined && Math.abs(vec.dot(plane.normal, direction)) < 1e-9;
    }
    const surface = face.surface() as unknown as {
        axis?: XYZ;
        direction?: () => XYZ;
        dispose(): void;
    };
    try {
        let along: XYZ | undefined;
        if (type === "CYLINDER") along = surface.axis;
        else if (typeof surface.direction === "function") along = surface.direction();
        if (along === undefined) return false;
        const d = vec.normalize([along.x, along.y, along.z]);
        return vec.norm(vec.cross(d, direction)) < 1e-9;
    } catch {
        return false;
    } finally {
        surface.dispose();
    }
}

/**
 * Offsets one planar face by `distance` mm along its outward normal: the prism of the
 * face fused on (outward) or cut away (inward). The moved face keeps its identity — it is
 * the prism's far cap — and so do its edges.
 */
function offsetPlanarFace(
    ctx: FsContext,
    opId: string,
    body: FsBody,
    index: number,
    normal: Vec3,
    distance: number,
    what: string,
): void {
    const face = body.faces()[index];
    // A copy: the prism must not share the face with the body (the boolean's input would merge them).
    const profile = ctx.track(face.clone()) as IFace;
    const vector = new XYZ(normal[0] * distance, normal[1] * distance, normal[2] * distance);
    if (shapeFactory.prismTracked === undefined) fail(`${what} needs the tracked prism`);
    const prism = kernel(shapeFactory.prismTracked(profile, vector), what);
    ctx.track(prism.shape);
    const tool = toolSource(ctx, opId, body, index, prism, vector);
    const sources = [historySource(body), tool];
    const boolean = distance > 0 ? shapeFactory.booleanFuseTracked : shapeFactory.booleanCutTracked;
    if (boolean === undefined) fail(`${what} needs the tracked booleans`);
    const result = kernel(boolean.call(shapeFactory, [body.shape], [prism.shape]), what);
    const solids = result.shape.findSubShapes(ShapeTypes.solid);
    for (const solid of solids) solid.dispose();
    if (solids.length !== 1)
        fail(`${what}: the offset would ${solids.length === 0 ? "consume" : "break up"} the part`);
    ctx.rebuildBody(body, result, sources, opId);
}

/** The prism tool's history: its far cap (and the cap's edges) stand for the moved face. */
function toolSource(
    ctx: FsContext,
    opId: string,
    body: FsBody,
    index: number,
    prism: TrackedShape,
    vector: XYZ,
): HistorySource {
    const faces = ctx.track(prism.shape.findSubShapes(ShapeTypes.face)) as IFace[];
    const edges = ctx.track(prism.shape.findSubShapes(ShapeTypes.edge)) as IEdge[];
    const vertices = ctx.track(prism.shape.findSubShapes(ShapeTypes.vertex)) as IVertex[];
    const caps = new Set(prism.capFaces ?? []);
    const faceAttr = body.faceAttrs[index];
    const faceAttrs: EntityAttribute[] = faces.map((_, i) => (caps.has(i) ? faceAttr : ctx.freshAttr(opId)));
    // Each boundary edge of the face, moved: its translate inherits its attribute.
    const boundary = subEntities({ body, kind: "FACE", index }, "EDGE").map((ref) => ({
        attr: body.edgeAttrs[ref.index],
        mid: midpoint(body.edges()[ref.index]),
    }));
    const edgeAttrs = edges.map((edge) => {
        const mid = midpoint(edge);
        const moved = mid === undefined ? undefined : mid.sub(vector);
        const match = boundary.find(
            (candidate) =>
                moved !== undefined && candidate.mid !== undefined && candidate.mid.distanceTo(moved) < 1e-6,
        );
        return match?.attr ?? ctx.freshAttr(opId);
    });
    return {
        faces,
        edges,
        vertices,
        faceAttrs,
        edgeAttrs,
        vertexAttrs: vertices.map(() => ctx.freshAttr(opId)),
    };
}

function midpoint(edge: IEdge): XYZ | undefined {
    try {
        return edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2);
    } catch {
        return undefined;
    }
}
