// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEdge, IFace, XYZ } from "@chili3d/core";
import { ANGLE, expectNumber, expectQuantity, FsMap, type FsValue, fail, LENGTH } from "../lang/values";
import {
    type AffineData,
    applyAffine,
    applyLinear,
    type CoordSystemData,
    makeCoordSystem,
    readCoordSystem,
    readTransform,
    rotationAffine,
    type Vec3,
    vec,
} from "../std/geometry";
import { arg, enumName, optionalEnum, type StdBuilder } from "../std/registry";
import { type EntityRef, FsContext, type MateConnectorData, MM_PER_METER } from "./fsContext";
import { massData } from "./massProperties";
import { definitionOf, kernel } from "./operations";
import {
    curveTypeOf,
    entitiesOf,
    facePlane,
    ownerBodies,
    query,
    registerQueryType,
    relatedEntities,
    resolveQuery,
    surfaceTypeOf,
} from "./queries";

/**
 * Mate connectors: bodies of type MATE_CONNECTOR, each a point (its origin, so distances
 * and closest-entity queries see it) carrying a coordinate system, an owner part and what
 * it follows through transforms. `evMateConnector` reads the coordinate system back — and
 * fails for anything that is not a mate connector, which std's `try silent` probes rely
 * on; `evMateConnectorCoordSystem` infers one from the mate connector feature's picks.
 */

const WORLD: CoordSystemData = { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] };

const toM = (p: XYZ): Vec3 => [p.x / MM_PER_METER, p.y / MM_PER_METER, p.z / MM_PER_METER];

/** The x axis Onshape gives a frame with normal `z`: world X projected (world Y when `z` runs along X). */
export function canonicalX(z: Vec3): Vec3 {
    const helper: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return vec.normalize(vec.sub(helper, vec.scale(z, vec.dot(helper, z))));
}

/** A frame with axis `z` and an x axis as close to `x` as possible (canonical when parallel). */
function frame(origin: Vec3, z: Vec3, x?: Vec3): CoordSystemData {
    const zAxis = vec.normalize(z);
    const projected = x === undefined ? undefined : vec.sub(x, vec.scale(zAxis, vec.dot(x, zAxis)));
    const xAxis =
        projected === undefined || vec.norm(projected) < 1e-9 ? canonicalX(zAxis) : vec.normalize(projected);
    return { origin, xAxis, zAxis };
}

/** A coordinate system moved by an affine map (meters). */
export function transformCoordSystem<T extends CoordSystemData>(cs: T, affine: AffineData): T {
    return {
        ...cs,
        origin: applyAffine(affine, cs.origin),
        xAxis: vec.normalize(applyLinear(affine.m, cs.xAxis)),
        zAxis: vec.normalize(applyLinear(affine.m, cs.zAxis)),
    };
}

export function installMateConnectors(std: StdBuilder): void {
    std.fn("opMateConnector", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opMateConnector");
        const cs = readCoordSystem(definition.field("coordSystem"), "coordSystem");
        const ownerOf = (value: FsValue) =>
            value === undefined ? undefined : ownerBodies(resolveQuery(ctx, value))[0]?.body.bodyAttr.serial;
        const owner = ownerOf(definition.field("owner"));
        const attachedTo = ownerOf(definition.field("attachTo"));
        const data: MateConnectorData = {
            ...cs,
            ...(owner === undefined ? {} : { owner }),
            ...(attachedTo === undefined ? {} : { attachedTo }),
        };
        const vertex = kernel(
            shapeFactory.point({
                x: cs.origin[0] * MM_PER_METER,
                y: cs.origin[1] * MM_PER_METER,
                z: cs.origin[2] * MM_PER_METER,
            }),
            "opMateConnector",
        );
        ctx.addBody(vertex, id, { mateConnector: data });
        return undefined;
    });
    std.fn("evMateConnector", (args) => {
        const ctx = FsContext.of(arg(args, 0, "evMateConnector"));
        const definition = args[1];
        if (!(definition instanceof FsMap)) fail("evMateConnector needs { mateConnector }");
        const ref = resolveQuery(ctx, definition.field("mateConnector") ?? query("NOTHING"))[0];
        const data = ref?.body.flags.mateConnector;
        if (data === undefined) fail("evMateConnector: the query does not resolve to a mate connector");
        return makeCoordSystem(data);
    });
    std.fn("evMateConnectorCoordSystem", (args) => {
        const ctx = FsContext.of(arg(args, 0, "evMateConnectorCoordSystem"));
        const definition = args[1];
        if (!(definition instanceof FsMap))
            fail("evMateConnectorCoordSystem needs the mate connector definition");
        return makeCoordSystem(inferCoordSystem(ctx, definition));
    });
    std.fn("qMateConnectorsOfParts", (args) => query("MATE_CONNECTOR", { query: args[0] }));
    registerQueryType("MATE_CONNECTOR", (ctx, value) => {
        const owners = new Set(
            ownerBodies(resolveQuery(ctx, value.field("query"))).map((ref) => ref.body.bodyAttr.serial),
        );
        return ctx.bodies
            .filter((body) => {
                const owner = body.flags.mateConnector?.owner;
                return owner !== undefined && owners.has(owner);
            })
            .flatMap((body) => entitiesOf(body, "BODY"));
    });
}

// ------------------------------------------------------------------ Inference

/**
 * The mate connector feature's coordinate system: the origin and axes inferred on the
 * origin entity (a face's centroid and normal, a circle's center and axis, a cylinder's
 * axis point, a vertex), optionally between two entities, realigned to picked axes,
 * flipped and reoriented, moved, and carried by the remaining pattern transform.
 */
function inferCoordSystem(ctx: FsContext, definition: FsMap): CoordSystemData {
    const inference =
        definition.field("entityInferenceType") === undefined
            ? undefined
            : enumName(definition.field("entityInferenceType"), "EntityInferenceType", "entityInferenceType");
    const origin = resolve(ctx, definition.field("originQuery"));
    let cs =
        inference === "PART_ORIGIN" || origin.length === 0
            ? WORLD
            : onEntity(origin[0], inference, resolve(ctx, definition.field("secondaryOriginQuery"))[0]);
    if (
        optionalEnum(definition.field("originType"), "OriginCreationType", "originType", "ON_ENTITY") ===
        "BETWEEN_ENTITIES"
    ) {
        const other = resolve(ctx, definition.field("originAdditionalQuery"))[0];
        if (other === undefined) fail("A mate connector between entities needs a second entity");
        const plane = other.kind === "FACE" ? facePlane(other.body.faces()[other.index]) : undefined;
        if (plane === undefined) fail("A mate connector between entities needs a planar second face");
        const gap = vec.dot(vec.sub(plane.origin, cs.origin), plane.normal);
        cs = { ...cs, origin: vec.add(cs.origin, vec.scale(plane.normal, gap / 2)) };
    }
    if (definition.field("realign") === true) {
        const primary = resolve(ctx, definition.field("primaryAxisQuery"))[0];
        const secondary = resolve(ctx, definition.field("secondaryAxisQuery"))[0];
        const z = primary === undefined ? cs.zAxis : axisDirection(primary);
        cs = frame(cs.origin, z, secondary === undefined ? cs.xAxis : axisDirection(secondary));
    }
    if (definition.field("specifyNormal") === true) {
        const normal: Vec3 = ["nx", "ny", "nz"].map((key) =>
            expectNumber(definition.field(key) ?? 0, key),
        ) as Vec3;
        if (vec.norm(normal) > 1e-12) cs = frame(cs.origin, normal, cs.xAxis);
    }
    if (definition.field("flipPrimary") === true) cs = { ...cs, zAxis: vec.scale(cs.zAxis, -1) };
    const y = vec.cross(cs.zAxis, cs.xAxis);
    switch (
        optionalEnum(
            definition.field("secondaryAxisType"),
            "MateConnectorAxisType",
            "secondaryAxisType",
            "PLUS_X",
        )
    ) {
        case "PLUS_Y":
            cs = { ...cs, xAxis: y };
            break;
        case "MINUS_X":
            cs = { ...cs, xAxis: vec.scale(cs.xAxis, -1) };
            break;
        case "MINUS_Y":
            cs = { ...cs, xAxis: vec.scale(y, -1) };
            break;
    }
    if (definition.field("transform") === true) cs = moved(cs, definition);
    const remaining = definition.field("remainingTransform");
    if (remaining !== undefined)
        cs = transformCoordSystem(cs, readTransform(remaining, "remainingTransform"));
    return cs;
}

function resolve(ctx: FsContext, value: FsValue): EntityRef[] {
    return value === undefined ? [] : resolveQuery(ctx, value);
}

/** The "Move" step: a translation along the connector's own axes, then a turn about one of them. */
function moved(cs: CoordSystemData, definition: FsMap): CoordSystemData {
    const length = (key: string) =>
        definition.field(key) === undefined ? 0 : expectQuantity(definition.field(key), LENGTH, key);
    const y = vec.cross(cs.zAxis, cs.xAxis);
    const shift = vec.add(
        vec.add(vec.scale(cs.xAxis, length("translationX")), vec.scale(y, length("translationY"))),
        vec.scale(cs.zAxis, length("translationZ")),
    );
    const shifted = { ...cs, origin: vec.add(cs.origin, shift) };
    const angle =
        definition.field("rotation") === undefined
            ? 0
            : expectQuantity(definition.field("rotation"), ANGLE, "rotation");
    if (Math.abs(angle) < 1e-15) return shifted;
    const axis = { ABOUT_X: shifted.xAxis, ABOUT_Y: y, ABOUT_Z: shifted.zAxis }[
        optionalEnum(definition.field("rotationType"), "RotationType", "rotationType", "ABOUT_Z") as
            | "ABOUT_X"
            | "ABOUT_Y"
            | "ABOUT_Z"
    ];
    return transformCoordSystem(shifted, rotationAffine(shifted.origin, axis, angle));
}

/** The frame a mate connector placed on an entity gets. */
function onEntity(ref: EntityRef, inference: string | undefined, secondary?: EntityRef): CoordSystemData {
    const sketchPlane = ref.body.flags.sketch === true ? ref.body.flags.plane : undefined;
    if (ref.body.flags.mateConnector !== undefined) return ref.body.flags.mateConnector;
    switch (ref.kind) {
        case "VERTEX": {
            const point = toM(ref.body.vertices()[ref.index].point());
            return sketchPlane === undefined
                ? { ...WORLD, origin: point }
                : frame(point, sketchPlane.normal, sketchPlane.x);
        }
        case "EDGE":
            return onEdge(ref, ref.body.edges()[ref.index], inference, secondary, sketchPlane?.normal);
        case "FACE":
            return onFace(ref, ref.body.faces()[ref.index], inference);
        default:
            fail("A mate connector is placed on a vertex, an edge or a face");
    }
}

function onEdge(
    ref: EntityRef,
    edge: IEdge,
    inference: string | undefined,
    secondary: EntityRef | undefined,
    sketchNormal: Vec3 | undefined,
): CoordSystemData {
    const type = curveTypeOf(edge);
    const [start, end] = edge.ends().map(toM);
    const middle = toM(edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2));
    // A face around the edge orients it; a sketch edge takes its sketch plane.
    const faceNormal = (): Vec3 | undefined => {
        for (const face of relatedEntities(ref, "FACE")) {
            const plane = facePlane(face.body.faces()[face.index]);
            if (plane !== undefined) return plane.normal;
        }
        return undefined;
    };
    if (type === "CIRCLE" || type === "ARC") {
        const circle = edge.curve as unknown as {
            center?: XYZ;
            axis?: XYZ;
            basisCurve?: { center: XYZ; axis: XYZ };
        };
        const basis = circle.basisCurve ?? circle;
        if (basis.center === undefined || basis.axis === undefined) fail("The circle has no center");
        let axis: Vec3 = vec.normalize([basis.axis.x, basis.axis.y, basis.axis.z]);
        const reference = sketchNormal ?? faceNormal();
        if (reference !== undefined && vec.dot(axis, reference) < 0) axis = vec.scale(axis, -1);
        const origin =
            inference === "MID_POINT"
                ? middle
                : inference === "POINT"
                  ? (secondaryPoint(secondary) ?? start)
                  : toM(basis.center);
        return frame(origin, axis);
    }
    const origin =
        inference === "POINT"
            ? (secondaryPoint(secondary) ?? start)
            : inference === "CENTER"
              ? middle
              : middle;
    const along = vec.sub(end, start);
    const z =
        sketchNormal ??
        faceNormal() ??
        (vec.norm(along) > 1e-15 ? vec.perpendicular(vec.normalize(along)) : WORLD.zAxis);
    return frame(origin, z, vec.norm(along) > 1e-15 ? along : undefined);
}

function secondaryPoint(ref: EntityRef | undefined): Vec3 | undefined {
    return ref?.kind === "VERTEX" ? toM(ref.body.vertices()[ref.index].point()) : undefined;
}

function onFace(ref: EntityRef, face: IFace, inference: string | undefined): CoordSystemData {
    const type = surfaceTypeOf(face);
    if (type === "PLANE") {
        const plane = ref.body.flags.plane ?? facePlane(face);
        if (plane === undefined) fail("The face has no plane");
        const centroid = massData([ref]).centroid;
        return frame(centroid, plane.normal, ref.body.flags.plane?.x);
    }
    const surface = face.surface() as unknown as { location?: XYZ; axis?: XYZ; dispose(): void };
    try {
        if (surface.location === undefined)
            fail("A mate connector on a curved face needs a cylinder, cone or sphere");
        const center = toM(surface.location);
        if (type === "SPHERE" || surface.axis === undefined) return { ...WORLD, origin: center };
        const axis = vec.normalize([surface.axis.x, surface.axis.y, surface.axis.z]);
        // The face's extent along its axis places the axis point.
        const box = face.boundingBox();
        const corners: Vec3[] = [];
        for (const x of [box.min.x, box.max.x])
            for (const y of [box.min.y, box.max.y])
                for (const z of [box.min.z, box.max.z])
                    corners.push([x / MM_PER_METER, y / MM_PER_METER, z / MM_PER_METER]);
        const along = corners.map((p) => vec.dot(vec.sub(p, center), axis));
        const extent = (pick: number) => vec.add(center, vec.scale(axis, pick));
        const [lo, hi] = [Math.min(...along), Math.max(...along)];
        const origin =
            inference === "TOP_AXIS_POINT"
                ? extent(hi)
                : inference === "BOTTOM_AXIS_POINT"
                  ? extent(lo)
                  : extent((lo + hi) / 2);
        return frame(origin, axis);
    } finally {
        surface.dispose();
    }
}

/** The direction an axis pick stands for: a planar face's normal, a line's direction, a circle's or cylinder's axis. */
function axisDirection(ref: EntityRef): Vec3 {
    if (ref.kind === "FACE") {
        const face = ref.body.faces()[ref.index];
        const plane = facePlane(face);
        if (plane !== undefined) return plane.normal;
        const surface = face.surface() as unknown as { axis?: XYZ; dispose(): void };
        try {
            if (surface.axis !== undefined)
                return vec.normalize([surface.axis.x, surface.axis.y, surface.axis.z]);
        } finally {
            surface.dispose();
        }
    }
    if (ref.kind === "EDGE") {
        const edge = ref.body.edges()[ref.index];
        if (curveTypeOf(edge) === "LINE") {
            const [a, b] = edge.ends().map(toM);
            return vec.normalize(vec.sub(b, a));
        }
        const circle = edge.curve as unknown as { axis?: XYZ; basisCurve?: { axis: XYZ } };
        const axis = circle.basisCurve?.axis ?? circle.axis;
        if (axis !== undefined) return vec.normalize([axis.x, axis.y, axis.z]);
    }
    fail("An axis pick must be a planar face, a straight edge, a circle or a cylinder");
}
