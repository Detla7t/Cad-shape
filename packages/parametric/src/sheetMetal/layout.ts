// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, type IShape, ShapeTypes, type XYZ } from "@chili3d/core";
import {
    type AffineData,
    type Arena,
    applyAffine,
    composeAffine,
    faceFromLoops,
    IDENTITY,
    kernel,
    PlaneFrame,
    polygonFace,
    rotationAffine,
    SheetError,
    translation,
    type Vec3,
    v3,
    vec,
    xyz,
} from "./frame";
import { bendAllowance, type SheetBend, type SheetMetalModel, type V2 } from "./model";

/**
 * Where every piece of the flat blank goes when the part is formed.
 *
 * Folding: the bend zones (one strip per bend line, as wide as the bend allowance and
 * centered on the line) cut the blank into facets. The largest facet stays put; every other
 * facet is reached through the bend pieces between them, each contributing a rigid motion —
 * slide back by the allowance, then rotate about the bend axis (above the top surface for an
 * up bend, below the bottom for a down bend). Bend lines may not cross inside the blank.
 *
 * Rolling: the blank (a rectangle aligned with the sketch axes) wraps onto a cylinder whose
 * neutral layer has the blank's width as its arc length; the start edge stays put.
 */

const ADJACENT = 1e-6;

export interface Zone {
    readonly bend: SheetBend;
    readonly a: V2;
    readonly e: V2;
    readonly left: V2;
    readonly width: number;
}

export interface Facet {
    readonly face: IFace;
    readonly area: number;
    transform: AffineData;
    placed: boolean;
}

export interface BendPiece {
    readonly zone: Zone;
    readonly face: IFace;
    readonly parent: Facet;
    readonly child: Facet;
    /** +1 when the child lies on the zone's left side. */
    readonly sigma: 1 | -1;
    /** Extent of the piece along the bend line, measured from `zone.a`. */
    readonly emin: number;
    readonly emax: number;
}

export interface FoldLayout {
    readonly kind: "fold";
    readonly frame: PlaneFrame;
    readonly blank: IFace;
    readonly facets: Facet[];
    readonly pieces: BendPiece[];
}

export interface RollLayout {
    readonly kind: "roll";
    readonly frame: PlaneFrame;
    readonly blank: IFace;
    /** Blank extents: circumferential (c) and axial (x) directions in the plane, and their ranges. */
    readonly c: V2;
    readonly x: V2;
    readonly c0: number;
    readonly c1: number;
    readonly x0: number;
    readonly x1: number;
    readonly innerRadius: number;
    /** Swept angle (radians), at most 2π. */
    readonly angle: number;
    readonly full: boolean;
    readonly direction: 1 | -1;
    /** Cylinder axis point (at axial 0 of the start corner) and direction, body-local. */
    readonly axisPoint: Vec3;
    readonly axisDirection: Vec3;
    /** Rigid motion carrying the flat end edge (c = c1) onto the rolled end. */
    readonly endTransform: AffineData;
}

export type Layout = FoldLayout | RollLayout;

const dot2 = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const scale2 = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];

function unit2(a: V2): V2 {
    const n = Math.hypot(a[0], a[1]);
    if (n < 1e-12) throw new SheetError("A bend line has zero length");
    return [a[0] / n, a[1] / n];
}

/** 2D points of a face's vertices in the blank plane. */
export function facePoints(face: IShape, frame: PlaneFrame): V2[] {
    const vertices = face.findSubShapes(ShapeTypes.vertex);
    try {
        return vertices.map((vertex) => frame.local(v3((vertex as unknown as { point(): XYZ }).point())));
    } finally {
        for (const vertex of vertices) vertex.dispose();
    }
}

function facesOf(arena: Arena, shape: IShape): IFace[] {
    return arena.trackAll(shape.findSubShapes(ShapeTypes.face) as IFace[]);
}

export function layoutOf(arena: Arena, model: SheetMetalModel): Layout {
    const frame = new PlaneFrame(model.plane);
    const blank = faceFromLoops(arena, frame, model.blank);
    if (model.roll !== undefined) return rollLayout(model, frame, blank);
    return foldLayout(arena, model, frame, blank);
}

function zoneOf(bend: SheetBend, model: SheetMetalModel): Zone {
    const e = unit2(sub2(bend.b, bend.a));
    return {
        bend,
        a: bend.a,
        e,
        left: [-e[1], e[0]],
        width: bendAllowance(bend.angle, bend.radius, model.thickness, model.kFactor),
    };
}

function foldLayout(arena: Arena, model: SheetMetalModel, frame: PlaneFrame, blank: IFace): FoldLayout {
    if (model.bends.length === 0) {
        return {
            kind: "fold",
            frame,
            blank,
            facets: [{ face: blank, area: blank.area(), transform: IDENTITY, placed: true }],
            pieces: [],
        };
    }
    const zones = model.bends.map((bend) => zoneOf(bend, model));
    const box = blank.boundingBox();
    const reach = 2 * Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) + 10;
    const strips = zones.map((zone) => {
        const half = zone.width / 2;
        const corner = (along: number, across: number) => {
            const p = add2(zone.a, add2(scale2(zone.e, along), scale2(zone.left, across)));
            return frame.point(p[0], p[1]);
        };
        return polygonFace(arena, [
            corner(-reach, -half),
            corner(reach, -half),
            corner(reach, half),
            corner(-reach, half),
        ]);
    });
    const zonesInBlank = strips.map((strip) =>
        arena.track(kernel(shapeFactory.booleanCommon([blank], [strip]), "bend zone")),
    );
    for (let i = 0; i < strips.length; i++) {
        for (let j = i + 1; j < strips.length; j++) {
            const overlap = arena.track(
                kernel(shapeFactory.booleanCommon([zonesInBlank[i]], [strips[j]]), "bend check"),
            );
            const area = facesOf(arena, overlap).reduce((sum, face) => sum + face.area(), 0);
            if (area > 1e-6) throw new SheetError("Bend lines must not cross or overlap inside the sheet");
        }
    }
    const cut = arena.track(kernel(shapeFactory.booleanCut([blank], strips), "bend zones"));
    const facets: Facet[] = facesOf(arena, cut).map((face) => ({
        face,
        area: face.area(),
        transform: IDENTITY,
        placed: false,
    }));
    if (facets.length === 0) throw new SheetError("The bend zones consume the whole sheet");

    const pieces: BendPiece[] = [];
    zones.forEach((zone, i) => {
        for (const face of facesOf(arena, zonesInBlank[i])) {
            const touching = facets.filter((facet) => facet.face.extremaDistance(face) < ADJACENT);
            if (touching.length !== 2) {
                throw new SheetError(
                    "Each bend line must run fully across the sheet, with material on both sides",
                );
            }
            const side = (facet: Facet) => {
                const points = facePoints(facet.face, frame);
                const mean = points.reduce((acc, p) => add2(acc, p), [0, 0] as V2);
                return dot2(sub2(scale2(mean, 1 / points.length), zone.a), zone.left) >= 0 ? 1 : -1;
            };
            const along = facePoints(face, frame).map((p) => dot2(sub2(p, zone.a), zone.e));
            pieces.push({
                zone,
                face,
                parent: touching[0],
                child: touching[1],
                sigma: side(touching[1]) as 1 | -1,
                emin: Math.min(...along),
                emax: Math.max(...along),
            });
        }
    });

    // The largest facet stays put; the rest follow through the bend pieces.
    const root = facets.reduce((best, facet) => (facet.area > best.area ? facet : best));
    root.placed = true;
    const queue: Facet[] = [root];
    const resolved: BendPiece[] = [];
    while (queue.length > 0) {
        const current = queue.shift() as Facet;
        for (const piece of pieces) {
            const other =
                piece.parent === current ? piece.child : piece.child === current ? piece.parent : undefined;
            if (other === undefined || other.placed) continue;
            // Orient the piece from the placed facet to the new one.
            const oriented: BendPiece =
                piece.parent === current
                    ? piece
                    : { ...piece, parent: current, child: other, sigma: -piece.sigma as 1 | -1 };
            other.transform = composeAffine(current.transform, bendMotion(model, frame, oriented));
            other.placed = true;
            resolved.push(oriented);
            queue.push(other);
        }
    }
    if (facets.some((facet) => !facet.placed))
        throw new SheetError("Part of the sheet is not connected to the rest");
    return { kind: "fold", frame, blank, facets, pieces: resolved };
}

/** Section-frame data of a bend piece, in the parent's flat frame. */
export function bendGeometry(model: SheetMetalModel, frame: PlaneFrame, piece: BendPiece) {
    const zone = piece.zone;
    const s2 = scale2(zone.left, piece.sigma);
    const start2 = add2(zone.a, scale2(s2, -zone.width / 2));
    const s = frame.dir(s2[0], s2[1]);
    const e = frame.dir(zone.e[0], zone.e[1]);
    const theta = (zone.bend.angle * Math.PI) / 180;
    const up = theta > 0;
    const axisPoint = vec.add(
        frame.point(start2[0], start2[1]),
        vec.scale(frame.n, up ? model.thickness + zone.bend.radius : -zone.bend.radius),
    );
    return { s, e, start2, theta, up, axisPoint };
}

/** The rigid motion of a bend's child: slide back by the allowance, then rotate about the bend axis. */
function bendMotion(model: SheetMetalModel, frame: PlaneFrame, piece: BendPiece): AffineData {
    const { s, theta, axisPoint } = bendGeometry(model, frame, piece);
    const slide = translation(vec.scale(s, -piece.zone.width));
    const rotate = rotationAffine(axisPoint, vec.cross(s, frame.n), theta);
    return composeAffine(rotate, slide);
}

function rollLayout(model: SheetMetalModel, frame: PlaneFrame, blank: IFace): RollLayout {
    const roll = model.roll;
    if (roll === undefined) throw new SheetError("Not a rolled part");
    if (model.bends.length > 0) throw new SheetError("A rolled sheet cannot also have bend lines");
    const outer = model.blank[0];
    if (model.blank.length > 1 || outer.length !== 4 || outer.some((segment) => segment.kind !== "line")) {
        throw new SheetError("Rolling needs a rectangular blank (four straight edges, no holes)");
    }
    const c: V2 = roll.axis === "v" ? [1, 0] : [0, 1];
    const x: V2 = roll.axis === "v" ? [0, 1] : [1, 0];
    const points = outer.map((segment) => segment.a);
    const cs = points.map((p) => dot2(p, c));
    const xs = points.map((p) => dot2(p, x));
    const [c0, c1, x0, x1] = [Math.min(...cs), Math.max(...cs), Math.min(...xs), Math.max(...xs)];
    const width = c1 - c0;
    const length = x1 - x0;
    if (Math.abs(blank.area() - width * length) > 1e-6 * width * length + 1e-6) {
        throw new SheetError("Rolling needs a rectangle aligned with the sketch axes");
    }
    const t = model.thickness;
    const k = model.kFactor;
    const innerRadius = roll.radius ?? width / (2 * Math.PI) - k * t;
    if (innerRadius <= 0) throw new SheetError("The roll radius must be positive");
    const angle = width / (innerRadius + k * t);
    if (angle > 2 * Math.PI + 1e-6) throw new SheetError("The blank is wider than the roll's circumference");
    const full = Math.abs(angle - 2 * Math.PI) < 1e-6;
    const direction = roll.direction;
    const start2 = add2(scale2(c, c0), scale2(x, x0));
    const s = frame.dir(c[0], c[1]);
    const axisPoint = vec.add(
        frame.point(start2[0], start2[1]),
        vec.scale(frame.n, direction > 0 ? t + innerRadius : -innerRadius),
    );
    const endTransform = composeAffine(
        rotationAffine(axisPoint, vec.cross(s, frame.n), direction * Math.min(angle, 2 * Math.PI)),
        translation(vec.scale(s, -width)),
    );
    return {
        kind: "roll",
        frame,
        blank,
        c,
        x,
        c0,
        c1,
        x0,
        x1,
        innerRadius,
        angle: Math.min(angle, 2 * Math.PI),
        full,
        direction,
        axisPoint,
        axisDirection: frame.dir(x[0], x[1]),
        endTransform,
    };
}

/**
 * The rigid motion of the blank region around a flat point — the facet holding it when
 * folded, the start/end edge frame when rolled. Undefined for points inside a bend zone or
 * on a rolled sheet's curved interior.
 */
export function motionAt(layout: Layout, point: V2): AffineData | undefined {
    if (layout.kind === "roll") {
        const along = dot2(point, layout.c);
        if (Math.abs(along - layout.c0) < 1e-6) return IDENTITY;
        if (Math.abs(along - layout.c1) < 1e-6) return layout.endTransform;
        return undefined;
    }
    const probe = shapeFactory.point(xyz(layout.frame.point(point[0], point[1])));
    if (!probe.isOk) return undefined;
    try {
        const facet = layout.facets.find(
            (candidate) => candidate.face.extremaDistance(probe.value) < ADJACENT,
        );
        return facet?.transform;
    } finally {
        probe.value.dispose();
    }
}

/** Where a flat point (at height z through the sheet) ends up, when it moves rigidly. */
export function mapPoint(layout: Layout, point: V2, z: number): Vec3 | undefined {
    const motion = motionAt(layout, point);
    return motion === undefined ? undefined : applyAffine(motion, layout.frame.point(point[0], point[1], z));
}
