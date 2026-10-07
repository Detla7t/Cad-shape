// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEdge, IFace, XYZ } from "@chili3d/core";
import {
    AREA,
    expectMap,
    FsArray,
    type FsMap,
    FsQuantity,
    type FsValue,
    fail,
    fsMap,
    LENGTH,
    VOLUME,
} from "../lang/values";
import {
    makeCoordSystem,
    makeLine,
    makePlane,
    makePlaneData,
    point,
    readPoint,
    readVector,
    type Vec3,
    vec,
} from "../std/geometry";
import { arg, type StdBuilder } from "../std/registry";
import { type EntityRef, entityShape, FsContext, MM_PER_METER } from "./fsContext";
import { curveTypeOf, facePlane, measureOf, resolveQuery, samplePoints, surfaceTypeOf } from "./queries";

/**
 * The `ev*` evaluation functions: measurements and geometry read off resolved entities,
 * converted from kernel millimetres into FeatureScript values with units.
 */

const toM = (p: XYZ): Vec3 => [p.x / MM_PER_METER, p.y / MM_PER_METER, p.z / MM_PER_METER];

function single(ctx: FsContext, value: FsValue, kind: EntityRef["kind"], what: string): EntityRef {
    const refs = resolveQuery(ctx, value).filter((ref) => ref.kind === kind);
    if (refs.length === 0) fail(`${what} resolved to no ${kind.toLowerCase()}`);
    return refs[0];
}

function definitionOf(args: FsValue[], fn: string): [FsContext, FsMap] {
    return [FsContext.of(arg(args, 0, fn)), expectMap(arg(args, 1, fn), `${fn} definition`)];
}

/** Normalized edge parameter (0..1) → kernel parameter. */
function edgeParameter(edge: IEdge, t: number): number {
    return edge.firstParameter() + (edge.lastParameter() - edge.firstParameter()) * t;
}

function tangentAt(edge: IEdge, u: number): Vec3 {
    const span = edge.lastParameter() - edge.firstParameter();
    const h = Math.max(1e-7, Math.abs(span) * 1e-5);
    const a = edge.pointAt(Math.max(edge.firstParameter(), u - h));
    const b = edge.pointAt(Math.min(edge.lastParameter(), u + h));
    return vec.normalize([b.x - a.x, b.y - a.y, b.z - a.z]);
}

export function installEvaluation(std: StdBuilder): void {
    std.fn("evVertexPoint", (args) => {
        const [ctx, definition] = definitionOf(args, "evVertexPoint");
        const ref = single(ctx, definition.field("vertex"), "VERTEX", "evVertexPoint vertex");
        return point(toM(ref.body.vertices()[ref.index].point()));
    });
    std.fn("evPlane", (args) => {
        const [ctx, definition] = definitionOf(args, "evPlane");
        const refs = resolveQuery(ctx, definition.field("face"));
        const ref = refs.find((r) => r.kind === "FACE") ?? refs.find((r) => r.body.flags.plane !== undefined);
        if (ref === undefined) fail("evPlane needs a planar face");
        if (ref.body.flags.plane !== undefined) return makePlane(ref.body.flags.plane);
        const face = ref.body.faces()[ref.index];
        const plane = facePlane(face);
        if (plane === undefined) fail("evPlane face is not planar");
        const center = faceCenter(face) ?? plane.origin;
        return makePlane(makePlaneData(center, plane.normal));
    });
    std.fn("evFaceTangentPlane", (args) => {
        const [ctx, definition] = definitionOf(args, "evFaceTangentPlane");
        const ref = single(ctx, definition.field("face"), "FACE", "evFaceTangentPlane face");
        const face = ref.body.faces()[ref.index];
        const parameter = definition.field("parameter");
        const uv = parameter === undefined ? [0.5, 0.5] : readVector(parameter, "parameter").values;
        const surface = face.surface();
        try {
            const bounds = surface.bounds();
            const u = bounds.u1 + (bounds.u2 - bounds.u1) * (uv[0] ?? 0.5);
            const v = bounds.v1 + (bounds.v2 - bounds.v1) * (uv[1] ?? 0.5);
            const [p, n] = face.normal(u, v);
            return makePlane(makePlaneData(toM(p), [n.x, n.y, n.z]));
        } finally {
            surface.dispose();
        }
    });
    std.fn("evEdgeTangentLine", (args) => {
        const [ctx, definition] = definitionOf(args, "evEdgeTangentLine");
        const ref = single(ctx, definition.field("edge"), "EDGE", "evEdgeTangentLine edge");
        const edge = ref.body.edges()[ref.index];
        const t = numberOr(definition.field("parameter"), 0);
        const u = edgeParameter(edge, t);
        return makeLine({ origin: toM(edge.pointAt(u)), direction: tangentAt(edge, u) });
    });
    std.fn("evEdgeTangentLines", (args) => {
        const [ctx, definition] = definitionOf(args, "evEdgeTangentLines");
        const ref = single(ctx, definition.field("edge"), "EDGE", "evEdgeTangentLines edge");
        const edge = ref.body.edges()[ref.index];
        const parameters = definition.field("parameters");
        const ts = parameters instanceof FsArray ? parameters.items.map((p) => numberOr(p, 0)) : [0];
        return new FsArray(
            ts.map((t) => {
                const u = edgeParameter(edge, t);
                return makeLine({ origin: toM(edge.pointAt(u)), direction: tangentAt(edge, u) });
            }),
        );
    });
    std.fn("evLine", (args) => {
        const [ctx, definition] = definitionOf(args, "evLine");
        const ref = single(ctx, definition.field("edge"), "EDGE", "evLine edge");
        const edge = ref.body.edges()[ref.index];
        if (curveTypeOf(edge) !== "LINE") fail("evLine edge is not a straight line");
        const [a, b] = edge.ends();
        return makeLine({ origin: toM(a), direction: vec.normalize([b.x - a.x, b.y - a.y, b.z - a.z]) });
    });
    std.fn("evAxis", (args) => {
        const [ctx, definition] = definitionOf(args, "evAxis");
        const refs = resolveQuery(ctx, definition.field("axis"));
        const ref = refs[0];
        if (ref === undefined) fail("evAxis resolved to nothing");
        return makeLine(axisOfEntity(ref));
    });
    std.fn("evLength", (args) => {
        const [ctx, definition] = definitionOf(args, "evLength");
        const refs = resolveQuery(ctx, definition.field("entities")).filter(
            (ref) => ref.kind === "EDGE" || (ref.kind === "BODY" && ref.body.kind === "WIRE"),
        );
        return new FsQuantity(refs.reduce((sum, ref) => sum + measureOf(ref), 0) / MM_PER_METER, LENGTH);
    });
    std.fn("evArea", (args) => {
        const [ctx, definition] = definitionOf(args, "evArea");
        const refs = resolveQuery(ctx, definition.field("entities")).filter(
            (ref) => ref.kind === "FACE" || (ref.kind === "BODY" && ref.body.kind === "SHEET"),
        );
        return new FsQuantity(refs.reduce((sum, ref) => sum + measureOf(ref), 0) / MM_PER_METER ** 2, AREA);
    });
    std.fn("evVolume", (args) => {
        const [ctx, definition] = definitionOf(args, "evVolume");
        const refs = resolveQuery(ctx, definition.field("entities")).filter(
            (ref) => ref.kind === "BODY" && ref.body.kind === "SOLID",
        );
        return new FsQuantity(refs.reduce((sum, ref) => sum + measureOf(ref), 0) / MM_PER_METER ** 3, VOLUME);
    });
    std.fn("evBox3d", (args) => {
        const [ctx, definition] = definitionOf(args, "evBox3d");
        const refs = resolveQuery(ctx, definition.field("topology"));
        if (refs.length === 0) fail("evBox3d resolved to nothing");
        const min: Vec3 = [Infinity, Infinity, Infinity];
        const max: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (const ref of refs) {
            const box = entityShape(ref).boundingBox();
            min[0] = Math.min(min[0], box.min.x);
            min[1] = Math.min(min[1], box.min.y);
            min[2] = Math.min(min[2], box.min.z);
            max[0] = Math.max(max[0], box.max.x);
            max[1] = Math.max(max[1], box.max.y);
            max[2] = Math.max(max[2], box.max.z);
        }
        return fsMap(
            {
                minCorner: point(vec.scale(min, 1 / MM_PER_METER)),
                maxCorner: point(vec.scale(max, 1 / MM_PER_METER)),
            },
            "Box3d",
        );
    });
    std.fn("evApproximateCentroid", (args) => {
        const [ctx, definition] = definitionOf(args, "evApproximateCentroid");
        const refs = resolveQuery(ctx, definition.field("entities"));
        const points = refs
            .flatMap((ref) =>
                ref.kind === "FACE" ? [faceCenter(ref.body.faces()[ref.index])] : samplePoints(ref).map(toM),
            )
            .filter((p): p is Vec3 => p !== undefined);
        if (points.length === 0) fail("evApproximateCentroid resolved to nothing");
        const sum = points.reduce((acc, p) => vec.add(acc, p), [0, 0, 0] as Vec3);
        return point(vec.scale(sum, 1 / points.length));
    });
    std.fn("evDistance", (args) => {
        const [ctx, definition] = definitionOf(args, "evDistance");
        const a = definition.field("side0");
        const b = definition.field("side1");
        const shapeA = sideShape(ctx, a);
        const shapeB = sideShape(ctx, b);
        try {
            return fsMap({
                distance: new FsQuantity(shapeA.shape.extremaDistance(shapeB.shape) / MM_PER_METER, LENGTH),
            });
        } finally {
            if (shapeA.owned) shapeA.shape.dispose();
            if (shapeB.owned) shapeB.shape.dispose();
        }
    });
    std.fn("evCurveDefinition", (args) => {
        const [ctx, definition] = definitionOf(args, "evCurveDefinition");
        const ref = single(ctx, definition.field("edge"), "EDGE", "evCurveDefinition edge");
        const edge = ref.body.edges()[ref.index];
        const type = curveTypeOf(edge);
        if (type === "LINE") {
            const [a, b] = edge.ends();
            return makeLine({ origin: toM(a), direction: vec.normalize([b.x - a.x, b.y - a.y, b.z - a.z]) });
        }
        if (type === "CIRCLE" || type === "ARC") {
            const basis = circleOf(edge);
            return fsMap(
                {
                    coordSystem: makeCoordSystem({
                        origin: basis.center,
                        xAxis: vec.perpendicular(basis.axis),
                        zAxis: basis.axis,
                    }),
                    radius: new FsQuantity(basis.radius, LENGTH),
                },
                "Circle",
            );
        }
        return fsMap({ curveType: type });
    });
    std.fn("evSurfaceDefinition", (args) => {
        const [ctx, definition] = definitionOf(args, "evSurfaceDefinition");
        const ref = single(ctx, definition.field("face"), "FACE", "evSurfaceDefinition face");
        const face = ref.body.faces()[ref.index];
        const type = surfaceTypeOf(face);
        if (type === "PLANE") {
            const plane = facePlane(face);
            if (plane !== undefined)
                return makePlane(makePlaneData(faceCenter(face) ?? plane.origin, plane.normal));
        }
        const surface = face.surface() as unknown as {
            location?: XYZ;
            axis?: XYZ;
            radius?: number;
            majorRadius?: number;
            minorRadius?: number;
            dispose(): void;
        };
        try {
            const cs =
                surface.location !== undefined && surface.axis !== undefined
                    ? makeCoordSystem({
                          origin: toM(surface.location),
                          xAxis: vec.perpendicular([surface.axis.x, surface.axis.y, surface.axis.z]),
                          zAxis: vec.normalize([surface.axis.x, surface.axis.y, surface.axis.z]),
                      })
                    : undefined;
            if (type === "CYLINDER" || type === "SPHERE") {
                return fsMap(
                    { coordSystem: cs, radius: new FsQuantity((surface.radius ?? 0) / MM_PER_METER, LENGTH) },
                    type === "CYLINDER" ? "Cylinder" : "Sphere",
                );
            }
            if (type === "TORUS") {
                return fsMap(
                    {
                        coordSystem: cs,
                        radius: new FsQuantity((surface.majorRadius ?? 0) / MM_PER_METER, LENGTH),
                        minorRadius: new FsQuantity((surface.minorRadius ?? 0) / MM_PER_METER, LENGTH),
                    },
                    "Torus",
                );
            }
            return fsMap({ surfaceType: type, coordSystem: cs }, type === "CONE" ? "Cone" : undefined);
        } finally {
            surface.dispose();
        }
    });
    std.fn("evOwnerSketchPlane", (args) => {
        const [ctx, definition] = definitionOf(args, "evOwnerSketchPlane");
        const ref = resolveQuery(ctx, definition.field("entity"))[0];
        if (ref?.body.flags.sketch !== true || ref.body.flags.plane === undefined)
            fail("evOwnerSketchPlane needs a sketch entity");
        return makePlane(ref.body.flags.plane);
    });
}

/** Area-weighted-ish center of a face (mean of its boundary samples), in meters. */
function faceCenter(face: IFace): Vec3 | undefined {
    try {
        const box = face.boundingBox();
        const center: Vec3 = [
            (box.min.x + box.max.x) / 2,
            (box.min.y + box.max.y) / 2,
            (box.min.z + box.max.z) / 2,
        ];
        const plane = facePlane(face);
        if (plane === undefined) return vec.scale(center, 1 / MM_PER_METER);
        // Project the box center onto the plane so the origin lies on the face's plane.
        const c = vec.scale(center, 1 / MM_PER_METER);
        return vec.sub(c, vec.scale(plane.normal, vec.dot(vec.sub(c, plane.origin), plane.normal)));
    } catch {
        return undefined;
    }
}

function circleOf(edge: IEdge): { center: Vec3; axis: Vec3; radius: number } {
    const curve = edge.curve as unknown as {
        basisCurve?: { center: XYZ; axis: XYZ; radius: number };
        center?: XYZ;
        axis?: XYZ;
        radius?: number;
    };
    const circle = curve.basisCurve ?? (curve as { center: XYZ; axis: XYZ; radius: number });
    return {
        center: toM(circle.center),
        axis: vec.normalize([circle.axis.x, circle.axis.y, circle.axis.z]),
        radius: circle.radius / MM_PER_METER,
    };
}

function axisOfEntity(ref: EntityRef): { origin: Vec3; direction: Vec3 } {
    if (ref.kind === "EDGE") {
        const edge = ref.body.edges()[ref.index];
        const type = curveTypeOf(edge);
        if (type === "LINE") {
            const [a, b] = edge.ends();
            return { origin: toM(a), direction: vec.normalize([b.x - a.x, b.y - a.y, b.z - a.z]) };
        }
        if (type === "CIRCLE" || type === "ARC") {
            const circle = circleOf(edge);
            return { origin: circle.center, direction: circle.axis };
        }
    }
    if (ref.kind === "FACE") {
        const face = ref.body.faces()[ref.index];
        const type = surfaceTypeOf(face);
        if (type === "CYLINDER" || type === "CONE" || type === "TORUS") {
            const surface = face.surface() as unknown as { location: XYZ; axis: XYZ; dispose(): void };
            try {
                return {
                    origin: toM(surface.location),
                    direction: vec.normalize([surface.axis.x, surface.axis.y, surface.axis.z]),
                };
            } finally {
                surface.dispose();
            }
        }
    }
    fail("evAxis needs a straight or circular edge, or a cylindrical/conical face");
}

/** A distance side: a query (first resolved entity) or a point Vector. */
function sideShape(ctx: FsContext, value: FsValue) {
    if (value instanceof FsArray) {
        const p = readPoint(value, "evDistance point");
        const vertex = shapeFactory.point({
            x: p[0] * MM_PER_METER,
            y: p[1] * MM_PER_METER,
            z: p[2] * MM_PER_METER,
        });
        if (!vertex.isOk) fail("evDistance point is invalid");
        return { shape: vertex.value, owned: true };
    }
    const ref = resolveQuery(ctx, value)[0];
    if (ref === undefined) fail("evDistance side resolved to nothing");
    return { shape: entityShape(ref), owned: false };
}

function numberOr(value: FsValue, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number") fail("An edge parameter must be a number between 0 and 1");
    return value;
}
