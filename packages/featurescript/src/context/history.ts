// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IShape, ShapeTypes, type TrackedShape, type XYZ } from "@chili3d/core";
import {
    type Derivation,
    type EntityKind,
    type EntityRef,
    entityAttr,
    type FsBody,
    type FsContext,
} from "./fsContext";
import { entitiesOf, relatedEntities } from "./queries";

/**
 * Entity history beyond attribute inheritance. Operations log how their outputs derive
 * from their inputs (`FsContext.derivations`: a sweep's side face from its profile edge, a
 * pattern copy from its seed, a split piece from the whole); `startTracking` follows that
 * log forward and `qDependency` backward.
 */

const POINT_TOLERANCE_MM = 1e-6;

type SubKind = Exclude<EntityKind, "BODY">;

function serialOf(body: FsBody, kind: SubKind, shape: IShape): number | undefined {
    const index = body.subShapes(kind).findIndex((candidate) => candidate.isSame(shape));
    return index < 0 ? undefined : body.attrs(kind)[index].serial;
}

function pointOf(shape: IShape): XYZ | undefined {
    try {
        return (shape as unknown as { point(): XYZ }).point();
    } catch {
        return undefined;
    }
}

// ------------------------------------------------------------------ Recording

/** A sweep profile's entities, in the profile shape's own `findSubShapes` order. */
export interface ProfileHistory {
    /** What the swept body derives from: the profile face, else the profile edge. */
    readonly main?: number;
    readonly face?: number;
    readonly edges: readonly (number | undefined)[];
    readonly vertices: readonly (number | undefined)[];
    /** Vertex positions (mm) of the profile as swept — after any start offset. */
    readonly points: readonly (XYZ | undefined)[];
}

/**
 * The history of a profile `original` (a face or edge of `owner`) swept as `swept` — the
 * same shape, or a moved copy of it, whose sub-shapes enumerate in the same order.
 */
export function profileHistory(owner: FsBody, original: IShape, swept: IShape): ProfileHistory {
    const ctx = owner.context;
    const edges = ctx.track(original.findSubShapes(ShapeTypes.edge));
    const vertices = ctx.track(original.findSubShapes(ShapeTypes.vertex));
    const sweptVertices = swept === original ? vertices : ctx.track(swept.findSubShapes(ShapeTypes.vertex));
    const face = original.shapeType === ShapeTypes.face ? serialOf(owner, "FACE", original) : undefined;
    const edgeSerials = edges.map((edge) => serialOf(owner, "EDGE", edge));
    return {
        main: face ?? edgeSerials[0],
        face,
        edges: edgeSerials,
        vertices: vertices.map((vertex) => serialOf(owner, "VERTEX", vertex)),
        points: sweptVertices.map(pointOf),
    };
}

function nearIndex(points: readonly (XYZ | undefined)[], at: XYZ | undefined): number {
    if (at === undefined) return -1;
    return points.findIndex((point) => point !== undefined && point.distanceTo(at) < POINT_TOLERANCE_MM);
}

/**
 * Logs what a sweep made from its profile: the body and both caps from the profile face,
 * each side face from the edge it was swept from, the cap edges from the profile edges
 * bounding them, and the lateral edges and far vertices from the profile vertices.
 */
export function recordSweep(
    ctx: FsContext,
    opId: string,
    swept: FsBody,
    tracked: TrackedShape | undefined,
    profile: ProfileHistory,
): void {
    const create = (out: number, input: number | undefined) => {
        if (input !== undefined) ctx.derive(opId, out, [input], "create");
    };
    create(swept.bodyAttr.serial, profile.main);
    const faceMap = tracked?.faceMap ?? [];
    const faceEdgeMap = tracked?.faceEdgeMap ?? [];
    const edgeMap = tracked?.edgeMap ?? [];
    const caps = new Set(tracked?.capFaces ?? []);
    const isCap = (i: number) => (faceMap[i] ?? -1) >= 0 || caps.has(i);
    swept.faceAttrs.forEach((attr, i) => {
        if (isCap(i)) create(attr.serial, profile.face);
        else if ((faceEdgeMap[i] ?? -1) >= 0) create(attr.serial, profile.edges[faceEdgeMap[i]]);
    });
    const lateralFrom = new Map<number, number>();
    swept.edges().forEach((edge, j) => {
        const serial = swept.edgeAttrs[j].serial;
        if ((edgeMap[j] ?? -1) >= 0) {
            create(serial, profile.edges[edgeMap[j]]);
            return;
        }
        const faces = relatedEntities({ body: swept, kind: "EDGE", index: j }, "FACE").map((f) => f.index);
        const generating = faces.map((f) => faceEdgeMap[f] ?? -1).filter((k) => k >= 0);
        if (generating.length > 0 && faces.some(isCap)) {
            create(serial, profile.edges[generating[0]]);
            return;
        }
        const [start, end] = safeEnds(edge);
        const k = Math.max(nearIndex(profile.points, start), nearIndex(profile.points, end));
        if (k >= 0) {
            lateralFrom.set(j, k);
            create(serial, profile.vertices[k]);
        }
    });
    swept.vertices().forEach((vertex, v) => {
        const serial = swept.vertexAttrs[v].serial;
        const k = nearIndex(profile.points, pointOf(vertex));
        if (k >= 0) {
            create(serial, profile.vertices[k]);
            return;
        }
        const lateral = relatedEntities({ body: swept, kind: "VERTEX", index: v }, "EDGE").find((edge) =>
            lateralFrom.has(edge.index),
        );
        if (lateral !== undefined) create(serial, profile.vertices[lateralFrom.get(lateral.index) as number]);
    });
}

function safeEnds(edge: IEdge): [XYZ | undefined, XYZ | undefined] {
    try {
        return edge.ends();
    } catch {
        return [undefined, undefined];
    }
}

/** Logs a pattern copy as made from its seed, entity by entity (a moved copy enumerates alike). */
export function recordCopy(ctx: FsContext, opId: string, copy: FsBody, seed: FsBody): void {
    ctx.derive(opId, copy.bodyAttr.serial, [seed.bodyAttr.serial], "create");
    for (const kind of ["FACE", "EDGE", "VERTEX"] as const) {
        const seedAttrs = seed.attrs(kind);
        copy.attrs(kind).forEach((attr, i) => {
            if (seedAttrs[i] !== undefined) ctx.derive(opId, attr.serial, [seedAttrs[i].serial], "create");
        });
    }
}

/**
 * Logs the faces, edges and vertices a fillet or chamfer made (serials from `mark` on) as
 * made from the corner edge they replace — the nearest one when several were blended.
 */
export function recordBlends(
    ctx: FsContext,
    opId: string,
    body: FsBody,
    corners: readonly { shape: IShape; serial: number }[],
    mark: number,
): void {
    if (corners.length === 0) return;
    for (const kind of ["FACE", "EDGE", "VERTEX"] as const) {
        const shapes = body.subShapes(kind);
        body.attrs(kind).forEach((attr, i) => {
            // New and made by this operation (a split piece also gets a new serial, but keeps its creator).
            if (attr.serial < mark || attr.createdBy !== opId) return;
            let best = corners[0];
            if (corners.length > 1) {
                let distance = Number.POSITIVE_INFINITY;
                for (const corner of corners) {
                    let d = Number.POSITIVE_INFINITY;
                    try {
                        d = shapes[i].extremaDistance(corner.shape);
                    } catch {
                        // An unmeasurable pair is never the nearest.
                    }
                    if (d < distance) {
                        distance = d;
                        best = corner;
                    }
                }
            }
            ctx.derive(opId, attr.serial, [best.serial], "create");
        });
    }
}

/** Logs every entity of a moved body as modified. */
export function recordMoved(ctx: FsContext, opId: string, body: FsBody): void {
    for (const ref of entitiesOf(body, undefined)) {
        const serial = entityAttr(ref).serial;
        ctx.derive(opId, serial, [serial], "modify");
    }
}

/**
 * Logs a sketch's regions as made from its curves: each region edge from the sketch edge
 * it lies on (the same edge, or a piece of one split at a crossing), each region vertex
 * from the sketch vertex at its position, each region face from the curves bounding it.
 */
export function recordSketchRegions(ctx: FsContext, opId: string, wires: FsBody, regions: FsBody): void {
    ctx.derive(opId, regions.bodyAttr.serial, [wires.bodyAttr.serial], "create");
    const wireEdges = wires.edges();
    const sourceOfEdge = regions.edges().map((edge) => {
        let index = wireEdges.findIndex((wire) => wire.isSame(edge));
        if (index < 0) index = wireEdges.findIndex((wire) => liesOn(edge, wire));
        return index < 0 ? undefined : wires.edgeAttrs[index].serial;
    });
    sourceOfEdge.forEach((source, i) => {
        if (source !== undefined) ctx.derive(opId, regions.edgeAttrs[i].serial, [source], "create");
    });
    const wirePoints = wires.vertices().map(pointOf);
    regions.vertices().forEach((vertex, i) => {
        const k = nearIndex(wirePoints, pointOf(vertex));
        if (k >= 0) ctx.derive(opId, regions.vertexAttrs[i].serial, [wires.vertexAttrs[k].serial], "create");
    });
    regions.faceAttrs.forEach((attr, i) => {
        const sources = new Set<number>();
        for (const edge of relatedEntities({ body: regions, kind: "FACE", index: i }, "EDGE")) {
            const source = sourceOfEdge[edge.index];
            if (source !== undefined) sources.add(source);
        }
        ctx.derive(opId, attr.serial, [...sources], "create");
    });
}

/** True when `edge` lies along `on`: its ends and midpoint are on `on`'s curve, inside its range. */
function liesOn(edge: IEdge, on: IEdge): boolean {
    try {
        const first = edge.firstParameter();
        const last = edge.lastParameter();
        const curve = on.curve;
        const lo = Math.min(on.firstParameter(), on.lastParameter());
        const hi = Math.max(on.firstParameter(), on.lastParameter());
        const periodic = curve.isPeriodic();
        return [first, (first + last) / 2, last].every((t) => {
            const u = curve.parameter(edge.pointAt(t), POINT_TOLERANCE_MM);
            return u !== undefined && (periodic || (u >= lo - 1e-9 && u <= hi + 1e-9));
        });
    } catch {
        return false;
    }
}

// ------------------------------------------------------------------ Walking

/** Every current entity by serial (later bodies win — serials are unique per entity anyway). */
export function entitiesBySerial(ctx: FsContext): Map<number, EntityRef> {
    const map = new Map<number, EntityRef>();
    for (const body of ctx.bodies) {
        for (const ref of entitiesOf(body, undefined)) map.set(entityAttr(ref).serial, ref);
    }
    return map;
}

export interface TrackingSpec {
    /** Serials of the tracked entities. */
    readonly tracked: ReadonlySet<number>;
    /** With a second set, only entities derived from both sets match. */
    readonly secondary?: ReadonlySet<number>;
    /** Only operations after this log index count. */
    readonly after: number;
    /** Also match entities only partly derived from the tracked ones (a merge with others). */
    readonly partial: boolean;
    /** Follow only identity-keeping steps (modifications; splits and merges with `followSplitMerge`). */
    readonly identityOnly: boolean;
    readonly followSplitMerge: boolean;
}

/** Serials of the entities derived from the tracked ones by the operations after `after`. */
export function trackedSerials(ctx: FsContext, spec: TrackingSpec): Set<number> {
    const follows = (d: Derivation) =>
        !spec.identityOnly || d.kind === "modify" || (spec.followSplitMerge && d.kind !== "create");
    const walk = (seeds: ReadonlySet<number>, partial: boolean) => {
        const reachable = new Set(seeds);
        const found = new Set<number>();
        for (const d of ctx.derivations) {
            if (d.op <= spec.after || !follows(d)) continue;
            const hits = d.inputs.filter((input) => reachable.has(input)).length;
            if (hits === 0 || (!partial && hits < d.inputs.length)) continue;
            reachable.add(d.out);
            found.add(d.out);
        }
        return found;
    };
    if (spec.secondary === undefined) return walk(spec.tracked, spec.partial);
    const first = walk(spec.tracked, true);
    const second = walk(spec.secondary, true);
    return new Set([...first].filter((serial) => second.has(serial)));
}

/** What `serial` was most recently made from (modifications skipped); empty when it was made from nothing. */
export function directSources(ctx: FsContext, serial: number): readonly number[] {
    for (let i = ctx.derivations.length - 1; i >= 0; i--) {
        const d = ctx.derivations[i];
        if (d.out === serial && d.kind !== "modify") return d.inputs;
    }
    return [];
}

/**
 * The entities `ref` was made from that still exist, walking back past ones that no longer
 * exist or that `skip` says to see through (a sketch region stands for its sketch curves).
 * With `accept`, the walk continues past existing sources until accepted ones are found.
 */
export function dependencies(
    ctx: FsContext,
    ref: EntityRef,
    options: { skip?: (ref: EntityRef) => boolean; accept?: (ref: EntityRef) => boolean } = {},
): EntityRef[] {
    const current = entitiesBySerial(ctx);
    const result: EntityRef[] = [];
    const seen = new Set<number>([entityAttr(ref).serial]);
    let frontier = [...directSources(ctx, entityAttr(ref).serial)];
    for (let depth = 0; depth < 64 && frontier.length > 0; depth++) {
        const next: number[] = [];
        for (const serial of frontier) {
            if (seen.has(serial)) continue;
            seen.add(serial);
            const found = current.get(serial);
            const through =
                found === undefined ||
                options.skip?.(found) === true ||
                (options.accept !== undefined && !options.accept(found));
            if (!through && found !== undefined) {
                result.push(found);
                continue;
            }
            const sources = directSources(ctx, serial);
            if (found !== undefined && options.accept === undefined && sources.length === 0)
                result.push(found);
            next.push(...sources);
        }
        frontier = next;
    }
    return result;
}

/** The id of the operation that created or last modified `ref`. */
export function lastModifyingOperation(ctx: FsContext, ref: EntityRef): string {
    const serial = entityAttr(ref).serial;
    for (let i = ctx.derivations.length - 1; i >= 0; i--) {
        const d = ctx.derivations[i];
        if (d.out === serial) return ctx.operations[d.op];
    }
    return entityAttr(ref).createdBy;
}
