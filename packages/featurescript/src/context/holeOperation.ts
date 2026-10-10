// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, Line, ShapeTypes, XYZ } from "@chili3d/core";
import {
    expectArray,
    expectMap,
    expectQuantity,
    FsMap,
    type FsValue,
    fail,
    fsArray,
    fsMap,
    LENGTH,
    toDisplayString,
} from "../lang/values";
import { createdByMatches, idString } from "../std/feature";
import { type LineData, readLine, type Vec3, vec } from "../std/geometry";
import { enumName, type StdBuilder } from "../std/registry";
import { type EntityAttribute, entityAttr, type FsBody, type FsContext, MM_PER_METER } from "./fsContext";
import { faceSamples, separateSerials } from "./geometricHistory";
import { booleanInto, definitionOf, kernel, throughAllDepthMm } from "./operations";
import { entitiesOf, facePlane, ownerBodies, query, registerQueryType, resolveQuery } from "./queries";

/**
 * `opHole`: std computes a hole's profile — circles of given radii at positions along the
 * drill axis, each relative to a reference (the axis point, where the hole cylinder
 * enters the first or last target, where it leaves the last) — and the operation finds
 * those references by intersecting the hole cylinder with the targets, revolves the
 * profile into a tool and subtracts it. The tool's faces and profile edges carry the hole,
 * its identity and the face or profile name, which `qOpHoleFace` / `qOpHoleProfile` read.
 * Matched profiles (blind in last), UP_TO_NEXT and LAST_TARGET_START_IN_DEPTH references
 * are not computed: such a hole reports `success : false`.
 */

interface Profile {
    readonly reference: string;
    readonly before: boolean;
    readonly matched: boolean;
    /** mm along the axis from the reference. */
    readonly position: number;
    readonly radius: number;
    readonly name?: string;
}

interface HoleTag {
    readonly op: string;
    readonly hole: number;
    readonly identity?: number;
    readonly name?: string;
    readonly profile: boolean;
}

/** Where the hole cylinder runs through a target, mm along the axis from its origin. */
interface DepthExtremes {
    readonly firstEntrance: number;
    readonly fullEntrance: number;
    readonly firstExit: number;
    readonly fullExit: number;
}

interface ReferenceInfo {
    readonly start: number;
    readonly end: number;
    readonly target?: FsBody;
}

/** The position references this operation computes. */
const SUPPORTED_REFERENCES = new Set([
    "AXIS_POINT",
    "TARGET_START",
    "LAST_TARGET_START",
    "LAST_TARGET_END",
    "UP_TO_ENTITY",
]);

const tags = new WeakMap<FsContext, Map<number, HoleTag>>();

function tagsOf(ctx: FsContext): Map<number, HoleTag> {
    let map = tags.get(ctx);
    if (map === undefined) {
        map = new Map();
        tags.set(ctx, map);
    }
    return map;
}

/** The tag of an entity: its own, or the one of the entity it was split from. */
function tagOf(ctx: FsContext, serial: number): HoleTag | undefined {
    const map = tagsOf(ctx);
    let current = serial;
    for (let depth = 0; depth < 8; depth++) {
        const tag = map.get(current);
        if (tag !== undefined) return tag;
        const split = ctx.derivations.findLast((d) => d.out === current && d.kind === "split");
        if (split === undefined) return undefined;
        current = split.inputs[0];
    }
    return undefined;
}

export function installHoleOperation(std: StdBuilder): void {
    std.fn("opHole", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opHole");
        return hole(ctx, id, definition);
    });
    const holeQuery = (type: string) => (args: FsValue[]) => {
        const filters = args[1] instanceof FsMap ? args[1] : new FsMap();
        return query(type, {
            featureId: args[0],
            name: filters.field("name"),
            identity: filters.field("identity"),
        });
    };
    std.fn("qOpHoleProfile", holeQuery("OP_HOLE_PROFILE"));
    std.fn("qOpHoleFace", holeQuery("OP_HOLE_FACE"));
    for (const type of ["OP_HOLE_PROFILE", "OP_HOLE_FACE"]) {
        registerQueryType(type, (ctx, value) => {
            const op = idString(value.field("featureId"));
            const name = value.field("name");
            const identityQuery = value.field("identity");
            const identities =
                identityQuery === undefined
                    ? undefined
                    : new Set(resolveQuery(ctx, identityQuery).map((ref) => entityAttr(ref).serial));
            const kinds = type === "OP_HOLE_FACE" ? (["FACE"] as const) : (["EDGE", "VERTEX"] as const);
            return ctx.bodies.flatMap((body) =>
                kinds.flatMap((kind) =>
                    entitiesOf(body, kind).filter((ref) => {
                        const tag = tagOf(ctx, entityAttr(ref).serial);
                        return (
                            tag !== undefined &&
                            tag.profile === (type === "OP_HOLE_PROFILE") &&
                            createdByMatches(tag.op, op) &&
                            (name === undefined || tag.name === toDisplayString(name)) &&
                            (identities === undefined ||
                                (tag.identity !== undefined && identities.has(tag.identity)))
                        );
                    }),
                ),
            );
        });
    }
}

function hole(ctx: FsContext, id: string, definition: FsMap): FsValue {
    const holeDefinition = expectMap(definition.field("holeDefinition"), "holeDefinition");
    const profiles = expectArray(holeDefinition.field("profiles"), "profiles").items.map(readProfile);
    if (profiles.length < 2 || profiles[profiles.length - 1].radius !== 0)
        fail("opHole: a hole definition needs at least two profiles, the last of radius 0");
    const namesValue = holeDefinition.field("faceNames");
    const faceNames =
        namesValue === undefined
            ? []
            : expectArray(namesValue, "faceNames").items.map((name) => toDisplayString(name));
    const axes = expectArray(definition.field("axes"), "axes").items.map((axis, i) =>
        readLine(axis, `axes[${i}]`),
    );
    const identitiesValue = definition.field("identities");
    const identities =
        identitiesValue === undefined
            ? []
            : expectArray(identitiesValue, "identities").items.map((q) => {
                  const ref = resolveQuery(ctx, q)[0];
                  return ref === undefined ? undefined : entityAttr(ref).serial;
              });
    const targets =
        definition.field("targets") === undefined
            ? []
            : ownerBodies(resolveQuery(ctx, definition.field("targets")))
                  .map((ref) => ref.body)
                  .filter((body) => body.kind === "SOLID" && body.isModelGeometry);
    const subtract = definition.field("subtractFromTargets") !== false;
    const excluded = new Set(
        definition.field("targetsToExcludeFromSubtraction") === undefined
            ? []
            : ownerBodies(resolveQuery(ctx, definition.field("targetsToExcludeFromSubtraction"))).map(
                  (r) => r.body,
              ),
    );
    const endBound = definition.field("endBoundEntity");

    const tools: FsBody[] = [];
    let reason = "no target is in the way of the holes";
    const results = axes.map((axis, i) => {
        const built = buildHole(ctx, id, i, axis, profiles, faceNames, targets, endBound, identities[i]);
        if (typeof built === "string") {
            reason = built;
            return fsMap({ success: false });
        }
        tools.push(built.tool);
        return built.result;
    });
    if (tools.length === 0) fail(`opHole could not build any hole: ${reason}`);
    if (subtract) {
        const cut = targets.filter((target) => !excluded.has(target));
        for (const target of cut) booleanInto(ctx, id, target, tools, "SUBTRACTION", true);
        separateSerials(ctx, id, cut);
        if (definition.field("keepTools") !== true) for (const tool of tools) ctx.removeBody(tool);
    }
    return fsArray(results);
}

function readProfile(value: FsValue, index: number): Profile {
    const map = expectMap(value, `profiles[${index}]`);
    const name = map.field("name");
    return {
        reference: enumName(map.field("positionReference"), "HolePositionReference", "positionReference"),
        before: map.field("beforeReference") === true,
        matched: enumName(map.field("profileType"), "HoleProfileType", "profileType") === "MATCHED",
        position:
            map.field("position") === undefined
                ? 0
                : expectQuantity(map.field("position"), LENGTH, "position") * MM_PER_METER,
        radius: expectQuantity(map.field("radius"), LENGTH, "radius") * MM_PER_METER,
        name: name === undefined ? undefined : toDisplayString(name),
    };
}

/** The hole tool for one axis and its std result map, or why it cannot be built. */
function buildHole(
    ctx: FsContext,
    opId: string,
    index: number,
    axis: LineData,
    profiles: readonly Profile[],
    faceNames: readonly string[],
    targets: readonly FsBody[],
    endBound: FsValue,
    identity: number | undefined,
): { tool: FsBody; result: FsMap } | string {
    if (profiles.some((profile) => profile.matched))
        return "matched profiles (blind in last) are not computed";
    const origin = vec.scale(axis.origin, MM_PER_METER);
    const direction = axis.direction;
    const radius = Math.max(...profiles.map((profile) => profile.radius));
    if (!(radius > 0)) return "the hole profiles have no radius";
    const extremes = new Map<FsBody, DepthExtremes>();
    for (const target of targets) {
        const found = depthExtremes(ctx, target, origin, direction, radius);
        if (found !== undefined) extremes.set(target, found);
    }
    const references = new Map<string, ReferenceInfo>();
    const hits = [...extremes.entries()];
    const pick = (score: (e: DepthExtremes) => number, sign: 1 | -1) =>
        hits.length === 0
            ? undefined
            : hits.reduce((best, entry) => (sign * score(entry[1]) < sign * score(best[1]) ? entry : best));
    for (const profile of profiles) {
        if (references.has(profile.reference)) continue;
        let info: ReferenceInfo | undefined;
        switch (profile.reference) {
            case "AXIS_POINT":
                info = { start: 0, end: 0 };
                break;
            case "TARGET_START": {
                const best = pick((e) => e.firstEntrance, 1);
                if (best !== undefined)
                    info = { start: best[1].firstEntrance, end: best[1].fullEntrance, target: best[0] };
                break;
            }
            case "LAST_TARGET_START": {
                const best = pick((e) => e.firstEntrance, -1);
                if (best !== undefined)
                    info = { start: best[1].firstEntrance, end: best[1].fullEntrance, target: best[0] };
                break;
            }
            case "LAST_TARGET_END": {
                const best = pick((e) => e.fullExit, -1);
                if (best !== undefined)
                    info = { start: best[1].firstExit, end: best[1].fullExit, target: best[0] };
                break;
            }
            case "UP_TO_ENTITY":
                info = boundReference(ctx, endBound, origin, direction, radius);
                if (info === undefined) return "the end bound must be a plane, a planar face or a vertex";
                break;
        }
        if (info === undefined)
            return SUPPORTED_REFERENCES.has(profile.reference)
                ? "no target is in the way of the holes"
                : `${profile.reference} positions are not computed`;
        references.set(profile.reference, info);
    }
    const stations = profiles.map((profile) => {
        const info = references.get(profile.reference) as ReferenceInfo;
        return { t: (profile.before ? info.start : info.end) + profile.position, r: profile.radius, profile };
    });
    if (stations.some((s, i) => i > 0 && s.t < stations[i - 1].t - 1e-9))
        return "the hole profiles run backwards along the axis";
    const tool = revolveProfile(ctx, opId, origin, direction, stations);
    if (tool === undefined) return "the hole profile does not revolve into a tool";
    tagTool(ctx, opId, index, identity, tool, origin, direction, stations, faceNames);

    const start =
        references.get("TARGET_START")?.start ?? pick((e) => e.firstEntrance, 1)?.[1].firstEntrance ?? 0;
    const bound = references.get("UP_TO_ENTITY");
    const meters = (mm: number) => mm / MM_PER_METER;
    const extremesMap = new FsMap();
    for (const [target, e] of extremes) {
        extremesMap.set(
            `T${target.bodyAttr.serial}`,
            fsMap({
                firstEntrance: meters(e.firstEntrance),
                fullEntrance: meters(e.fullEntrance),
                firstExit: meters(e.firstExit),
                fullExit: meters(e.fullExit),
            }),
        );
    }
    const referencesMap = new FsMap();
    for (const [reference, info] of references) {
        referencesMap.set(
            reference,
            fsMap({
                referenceRootStart: meters(info.start),
                referenceRootEnd: meters(info.end),
                target: info.target === undefined ? undefined : `T${info.target.bodyAttr.serial}`,
            }),
        );
    }
    return {
        tool,
        result: fsMap({
            success: true,
            holeDepth: bound === undefined ? 0 : meters(bound.end - start),
            targetToDepthExtremes: extremesMap,
            positionReferenceInfo: referencesMap,
        }),
    };
}

/** A face, plane or vertex bounding the hole: where the hole cylinder meets it along the axis. */
function boundReference(
    ctx: FsContext,
    value: FsValue,
    origin: Vec3,
    direction: Vec3,
    radius: number,
): ReferenceInfo | undefined {
    if (value === undefined) return undefined;
    const ref = resolveQuery(ctx, value)[0];
    if (ref === undefined) return undefined;
    if (ref.kind === "VERTEX") {
        const p = ref.body.vertices()[ref.index].point();
        const t = vec.dot(vec.sub([p.x, p.y, p.z], origin), direction);
        return { start: t, end: t };
    }
    const plane =
        ref.kind === "FACE"
            ? facePlane(ref.body.faces()[ref.index])
            : ref.body.flags.plane === undefined
              ? undefined
              : { origin: ref.body.flags.plane.origin, normal: ref.body.flags.plane.normal };
    if (plane === undefined) return undefined;
    const range = planeRange(vec.scale(plane.origin, MM_PER_METER), plane.normal, origin, direction, radius);
    return range === undefined ? undefined : { start: range[0], end: range[1] };
}

/** The axial range (mm) over which a plane cuts the cylinder of `radius` around the axis. */
function planeRange(
    point: Vec3,
    normal: Vec3,
    origin: Vec3,
    direction: Vec3,
    radius: number,
): [number, number] | undefined {
    const along = vec.dot(normal, direction);
    if (Math.abs(along) < 1e-9) return undefined;
    const t = vec.dot(normal, vec.sub(point, origin)) / along;
    const half = (radius * Math.sqrt(Math.max(0, 1 - along * along))) / Math.abs(along);
    return [t - half, t + half];
}

/**
 * Where the hole cylinder enters and leaves a target: the cylinder (`radius` around the
 * axis line) intersected with the target; entry faces face against the axis direction,
 * exit faces along it. Pieces wholly behind the axis point are ignored.
 */
function depthExtremes(
    ctx: FsContext,
    target: FsBody,
    origin: Vec3,
    direction: Vec3,
    radius: number,
): DepthExtremes | undefined {
    const length = throughAllDepthMm(ctx);
    const base = vec.sub(origin, vec.scale(direction, length));
    const cylinder = ctx.track(
        kernel(
            shapeFactory.cylinder(
                { x: direction[0], y: direction[1], z: direction[2] },
                { x: base[0], y: base[1], z: base[2] },
                radius,
                2 * length,
            ),
            "opHole",
        ),
    );
    const common = shapeFactory.booleanCommon([target.shape], [cylinder]);
    if (!common.isOk) return undefined;
    ctx.track(common.value);
    const pieces: { entry: [number, number]; exit: [number, number] }[] = [];
    for (const solid of ctx.track(common.value.findSubShapes(ShapeTypes.solid))) {
        let entry: [number, number] | undefined;
        let exit: [number, number] | undefined;
        for (const face of ctx.track(solid.findSubShapes(ShapeTypes.face)) as IFace[]) {
            const sample = faceSamples(face, 2)[0];
            if (sample === undefined) continue;
            const facing =
                sample.normal.x * direction[0] +
                sample.normal.y * direction[1] +
                sample.normal.z * direction[2];
            if (Math.abs(facing) < 1e-9) continue;
            const range = faceRange(ctx, face, origin, direction, radius);
            if (range === undefined) continue;
            const merge = (a: [number, number] | undefined): [number, number] =>
                a === undefined ? range : [Math.min(a[0], range[0]), Math.max(a[1], range[1])];
            if (facing < 0) entry = merge(entry);
            else exit = merge(exit);
        }
        if (entry !== undefined && exit !== undefined && exit[1] > 1e-9) pieces.push({ entry, exit });
    }
    if (pieces.length === 0) return undefined;
    pieces.sort((a, b) => a.entry[0] - b.entry[0]);
    const first = pieces[0];
    const last = pieces.reduce((best, piece) => (piece.exit[1] > best.exit[1] ? piece : best));
    return {
        firstEntrance: first.entry[0],
        fullEntrance: first.entry[1],
        firstExit: last.exit[0],
        fullExit: last.exit[1],
    };
}

/** A face's axial range: exact for a plane cutting the whole cylinder, else from its boundary. */
function faceRange(
    ctx: FsContext,
    face: IFace,
    origin: Vec3,
    direction: Vec3,
    radius: number,
): [number, number] | undefined {
    // A plane cutting the whole hole cylinder: its ellipse spans an exact range.
    const plane = facePlane(face);
    if (plane !== undefined) {
        const along = Math.abs(vec.dot(plane.normal, direction));
        const ellipse = (Math.PI * radius * radius) / Math.max(along, 1e-12);
        if (Math.abs(face.area() - ellipse) <= 1e-9 * ellipse)
            return planeRange(vec.scale(plane.origin, MM_PER_METER), plane.normal, origin, direction, radius);
    }
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const edge of ctx.track(face.findSubShapes(ShapeTypes.edge)) as IEdge[]) {
        try {
            const first = edge.firstParameter();
            const last = edge.lastParameter();
            for (let i = 0; i <= 64; i++) {
                const p = edge.pointAt(first + ((last - first) * i) / 64);
                const t = vec.dot(vec.sub([p.x, p.y, p.z], origin), direction);
                lo = Math.min(lo, t);
                hi = Math.max(hi, t);
            }
        } catch {
            // A degenerate edge adds nothing.
        }
    }
    return Number.isFinite(lo) ? [lo, hi] : undefined;
}

interface Station {
    readonly t: number;
    readonly r: number;
    readonly profile: Profile;
}

/** The axis frame: a point at axial `t`, radial `r` (mm). */
function frameOf(origin: Vec3, direction: Vec3) {
    const u = vec.perpendicular(direction);
    return {
        at: (t: number, r: number): Vec3 =>
            vec.add(origin, vec.add(vec.scale(direction, t), vec.scale(u, r))),
        coordinates: (p: XYZ): [number, number] => {
            const d = vec.sub([p.x, p.y, p.z], origin);
            const t = vec.dot(d, direction);
            return [t, vec.norm(vec.sub(d, vec.scale(direction, t)))];
        },
    };
}

/** The solid of revolution of the profile polygon (axis, stations, back along the axis). */
function revolveProfile(
    ctx: FsContext,
    opId: string,
    origin: Vec3,
    direction: Vec3,
    stations: readonly Station[],
): FsBody | undefined {
    const frame = frameOf(origin, direction);
    const outline: [number, number][] = [
        [stations[0].t, 0],
        ...stations.map((s): [number, number] => [s.t, s.r]),
    ];
    const points = outline.filter(
        (p, i) => i === 0 || Math.hypot(p[0] - outline[i - 1][0], p[1] - outline[i - 1][1]) > 1e-9,
    );
    if (points.length < 3) return undefined;
    const xyz = (p: [number, number]) => {
        const [x, y, z] = frame.at(p[0], p[1]);
        return { x, y, z };
    };
    const edges: IEdge[] = [];
    for (let i = 0; i < points.length; i++) {
        const next = points[(i + 1) % points.length];
        const line = shapeFactory.line(xyz(points[i]), xyz(next));
        if (!line.isOk) return undefined;
        edges.push(ctx.track(line.value));
    }
    const wire = shapeFactory.wire(edges);
    if (!wire.isOk) return undefined;
    const face = wire.value.toFace();
    ctx.track(wire.value);
    if (!face.isOk) return undefined;
    ctx.track(face.value);
    const axis = new Line({
        point: new XYZ(origin[0], origin[1], origin[2]),
        direction: new XYZ(direction[0], direction[1], direction[2]),
    });
    const solid = shapeFactory.revolve(face.value, axis, 360);
    if (!solid.isOk) return undefined;
    return ctx.addBody(solid.value, opId);
}

/** Tags the tool's faces with their face names and its profile circles and tip with profile names. */
function tagTool(
    ctx: FsContext,
    opId: string,
    hole: number,
    identity: number | undefined,
    tool: FsBody,
    origin: Vec3,
    direction: Vec3,
    stations: readonly Station[],
    faceNames: readonly string[],
): void {
    const frame = frameOf(origin, direction);
    const map = tagsOf(ctx);
    const tag = (attr: EntityAttribute, name: string | undefined, profile: boolean) =>
        map.set(attr.serial, { op: opId, hole, identity, name, profile });
    // The face swept by segment k (station k - 1 to k) carries face name k; the disc at station 0 name 0.
    const segments = stations.map((station, k) =>
        k === 0
            ? { from: [station.t, 0], to: [station.t, station.r] }
            : { from: [stations[k - 1].t, stations[k - 1].r], to: [station.t, station.r] },
    );
    tool.faces().forEach((face, i) => {
        const sample = faceSamples(face, 2)[0];
        if (sample === undefined) return;
        const [t, r] = frame.coordinates(sample.point);
        const k = segments.findIndex(({ from, to }) =>
            onSegment([t, r], from as [number, number], to as [number, number]),
        );
        tag(tool.faceAttrs[i], k < 0 ? undefined : faceNames[k], false);
    });
    tool.edges().forEach((edge, i) => {
        const points = [0.1, 0.6].map((f) =>
            edge.pointAt(edge.firstParameter() + (edge.lastParameter() - edge.firstParameter()) * f),
        );
        const coords = points.map((p) => frame.coordinates(p));
        const station = stations.find((s) =>
            coords.every(([t, r]) => Math.abs(t - s.t) < 1e-6 && Math.abs(r - s.r) < 1e-6),
        );
        if (station !== undefined) tag(tool.edgeAttrs[i], station.profile.name, true);
    });
    tool.vertices().forEach((vertex, i) => {
        const [t, r] = frame.coordinates(vertex.point());
        const station = stations.find((s) => s.r === 0 && Math.abs(t - s.t) < 1e-6 && r < 1e-6);
        if (station !== undefined) tag(tool.vertexAttrs[i], station.profile.name, true);
    });
}

function onSegment(p: [number, number], a: [number, number], b: [number, number]): boolean {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const length = Math.hypot(dx, dy);
    if (length < 1e-12) return false;
    const s = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (length * length);
    if (s < -1e-9 || s > 1 + 1e-9) return false;
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length < 1e-6;
}
