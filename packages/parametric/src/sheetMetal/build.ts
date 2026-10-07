// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IShape, Line, Result, ShapeTypes, type XYZ } from "@chili3d/core";
import {
    Arena,
    faceFromLoops,
    fuseAll,
    kernel,
    type PlaneFrame,
    placed,
    polygonFace,
    prism,
    SheetError,
    type Vec3,
    vec,
    xyz,
} from "./frame";
import { bendGeometry, type FoldLayout, type Layout, layoutOf, motionAt, type RollLayout } from "./layout";
import type { SheetBead, SheetFlange, SheetMetalModel, V2 } from "./model";
import {
    annulusSector,
    beadSection,
    halfBeadSection,
    type LocalFrame,
    sectionFace,
    stripSection,
} from "./section";

/**
 * Builds the solid of a sheet metal model: folded (facets, bend sectors, edge-treatment
 * strips, beads), rolled (cylinder shell with crimps and ring beads), or — after a Flatten
 * feature — the flat pattern with its bend lines marked on the top face.
 */
export function buildSheetMetal(model: SheetMetalModel): Result<IShape> {
    const arena = new Arena();
    try {
        const shape = model.flat ? buildFlat(arena, model) : buildFormed(arena, model);
        arena.dispose(shape);
        return Result.ok(shape);
    } catch (error) {
        arena.dispose();
        if (error instanceof SheetError) return Result.err(error.message);
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const scale2 = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];

function unit2(a: V2): V2 {
    const n = Math.hypot(a[0], a[1]);
    if (n < 1e-12) throw new SheetError("A sheet metal edge has zero length");
    return [a[0] / n, a[1] / n];
}

// ------------------------------------------------------------------ Formed

function buildFormed(arena: Arena, model: SheetMetalModel): IShape {
    const layout = layoutOf(arena, model);
    const solids =
        layout.kind === "fold" ? foldedSolids(arena, model, layout) : rolledSolids(arena, model, layout);
    for (const flange of model.flanges) solids.push(flangeSolid(arena, model, layout, flange));
    if (solids.length === 1) return solids[0];
    const fused = shapeFactory.booleanFuse([solids[0]], solids.slice(1), true);
    if (fused.isOk) return arena.track(fused.value);
    // A union the kernel cannot resolve still shows the part, as a compound.
    return arena.track(kernel(shapeFactory.combine(solids), "sheet compound"));
}

function foldedSolids(arena: Arena, model: SheetMetalModel, layout: FoldLayout): IShape[] {
    const t = model.thickness;
    const frame = layout.frame;
    const solids: IShape[] = [];
    const beadsByFacet = new Map<FoldLayout["facets"][number], SheetBead[]>();
    for (const bead of model.beads) {
        if (bead.kind !== "line") throw new SheetError("A ring bead needs a rolled sheet");
        const motion = motionAt(layout, bead.a);
        const facet = layout.facets.find((candidate) => candidate.transform === motion);
        if (facet === undefined || motionAt(layout, bead.b) !== motion) {
            throw new SheetError("A bead must lie on one flat region of the sheet, clear of bend zones");
        }
        beadsByFacet.set(facet, [...(beadsByFacet.get(facet) ?? []), bead]);
    }
    for (const facet of layout.facets) {
        let face: IShape = facet.face;
        for (const bead of beadsByFacet.get(facet) ?? []) {
            if (bead.kind !== "line") continue;
            const footprint = beadFootprint(arena, frame, bead, model.thickness);
            face = arena.track(kernel(shapeFactory.booleanCut([face], [footprint]), "bead footprint"));
            solids.push(placed(arena, lineBeadSolid(arena, frame, bead, t), facet.transform));
        }
        solids.push(placed(arena, prism(arena, face, vec.scale(frame.n, t)), facet.transform));
    }
    for (const piece of layout.pieces) {
        const { s, e, start2, theta, up } = bendGeometry(model, frame, piece);
        const r = piece.zone.bend.radius;
        const origin2 = add2(start2, scale2(piece.zone.e, piece.emin));
        const section: LocalFrame = { origin: frame.point(origin2[0], origin2[1]), s, z: frame.n };
        const pieces = up
            ? annulusSector([0, t + r], r, r + t, -Math.PI / 2, theta)
            : annulusSector([0, -r], r, r + t, Math.PI / 2, theta);
        const face = sectionFace(arena, section, pieces);
        const solid = prism(arena, face, vec.scale(e, piece.emax - piece.emin));
        solids.push(placed(arena, solid, piece.parent.transform));
    }
    return solids;
}

/** The cross-section frame of a flange: origin at the edge start, s pointing away from the material. */
function flangeFrame(
    layout: Layout,
    flange: SheetFlange,
): { frame: LocalFrame; along: Vec3; length: number; outward: V2 } {
    const plane = layout.frame;
    const e2 = unit2(sub2(flange.b, flange.a));
    const left: V2 = [-e2[1], e2[0]];
    const mid = scale2(add2(flange.a, flange.b), 0.5);
    const probe = add2(mid, scale2(left, 1e-3));
    const inside = layout.blank.containsPoint(xyz(plane.point(probe[0], probe[1])), false, 1e-7);
    const outward = inside ? scale2(left, -1) : left;
    return {
        frame: {
            origin: plane.point(flange.a[0], flange.a[1]),
            s: plane.dir(outward[0], outward[1]),
            z: plane.n,
        },
        along: plane.dir(e2[0], e2[1]),
        length: Math.hypot(flange.b[0] - flange.a[0], flange.b[1] - flange.a[1]),
        outward,
    };
}

function flangeSolid(arena: Arena, model: SheetMetalModel, layout: Layout, flange: SheetFlange): IShape {
    const mid = scale2(add2(flange.a, flange.b), 0.5);
    const motion = motionAt(layout, mid);
    if (motion === undefined) {
        throw new SheetError(
            layout.kind === "roll"
                ? "On a rolled sheet, edge treatments go on the edges parallel to the roll axis"
                : "An edge treatment must sit on a straight edge of a flat region",
        );
    }
    if (layout.kind === "fold") {
        // The whole edge must ride one facet: a strip cannot follow the sheet around a bend.
        const e2 = unit2(sub2(flange.b, flange.a));
        const inset = 1e-3 * Math.hypot(flange.b[0] - flange.a[0], flange.b[1] - flange.a[1]);
        const ends = [add2(flange.a, scale2(e2, inset)), add2(flange.b, scale2(e2, -inset))];
        if (ends.some((point) => motionAt(layout, point) !== motion)) {
            throw new SheetError("An edge treatment cannot run across a bend line");
        }
    }
    const { frame, along, length } = flangeFrame(layout, flange);
    const section = stripSection(flange.elements, model.thickness, model.kFactor);
    const face = sectionFace(arena, frame, section.pieces);
    return placed(arena, prism(arena, face, vec.scale(along, length)), motion);
}

// ------------------------------------------------------------------ Beads

function beadFrame(frame: PlaneFrame, bead: Extract<SheetBead, { kind: "line" }>) {
    const e2 = unit2(sub2(bead.b, bead.a));
    const left: V2 = [-e2[1], e2[0]];
    return {
        e2,
        left,
        length: Math.hypot(bead.b[0] - bead.a[0], bead.b[1] - bead.a[1]),
        e: frame.dir(e2[0], e2[1]),
        l: frame.dir(left[0], left[1]),
    };
}

function beadFootprint(
    arena: Arena,
    frame: PlaneFrame,
    bead: Extract<SheetBead, { kind: "line" }>,
    t: number,
): IFace {
    const { footprint } = beadSection(bead.width, bead.height, t, bead.direction);
    const { e2, left } = beadFrame(frame, bead);
    const f = footprint / 2;
    const p = (base: V2, along: number, across: number): V2 =>
        add2(base, add2(scale2(e2, along), scale2(left, across)));
    return faceFromLoops(arena, frame, [
        [
            { kind: "line", a: p(bead.a, 0, f), b: p(bead.b, 0, f) },
            { kind: "arc", a: p(bead.b, 0, f), mid: p(bead.b, f, 0), b: p(bead.b, 0, -f) },
            { kind: "line", a: p(bead.b, 0, -f), b: p(bead.a, 0, -f) },
            { kind: "arc", a: p(bead.a, 0, -f), mid: p(bead.a, -f, 0), b: p(bead.a, 0, f) },
        ],
    ]);
}

function lineBeadSolid(
    arena: Arena,
    frame: PlaneFrame,
    bead: Extract<SheetBead, { kind: "line" }>,
    t: number,
): IShape {
    const { length, e, l } = beadFrame(frame, bead);
    const start = frame.point(bead.a[0], bead.a[1]);
    const end = frame.point(bead.b[0], bead.b[1]);
    const section = beadSection(bead.width, bead.height, t, bead.direction);
    const ridge = prism(
        arena,
        sectionFace(arena, { origin: start, s: l, z: frame.n }, section.pieces),
        vec.scale(e, length),
    );
    const half = halfBeadSection(bead.width, bead.height, t, bead.direction);
    // Domes: the half section swept 180° about the sheet normal at each end, outward.
    const dome = (origin: Vec3, axis: Vec3) => {
        const face = sectionFace(arena, { origin, s: l, z: frame.n }, half);
        return arena.track(
            kernel(
                shapeFactory.revolve(face, new Line({ point: xyz(origin), direction: xyz(axis) }), 180),
                "bead end",
            ),
        );
    };
    return fuseAll(arena, [ridge, dome(start, frame.n), dome(end, vec.scale(frame.n, -1))]);
}

// ------------------------------------------------------------------ Rolled

function perpendicularBasis(axis: Vec3, radial: Vec3): [Vec3, Vec3] {
    const u = vec.normalize(vec.sub(radial, vec.scale(axis, vec.dot(radial, axis))));
    return [u, vec.cross(axis, u)];
}

function rolledSolids(arena: Arena, model: SheetMetalModel, layout: RollLayout): IShape[] {
    const t = model.thickness;
    const frame = layout.frame;
    const ri = layout.innerRadius;
    const start2 = add2(scale2(layout.c, layout.c0), scale2(layout.x, layout.x0));
    const startPoint = frame.point(start2[0], start2[1]);
    const radial = vec.normalize(vec.sub(startPoint, layout.axisPoint));
    const axial = (offset: number) => vec.add(layout.axisPoint, vec.scale(layout.axisDirection, offset));
    const length = layout.x1 - layout.x0;

    const startCrimp = model.crimps.find((crimp) => crimp.end === "start");
    const endCrimp = model.crimps.find((crimp) => crimp.end === "end");
    if ((startCrimp !== undefined || endCrimp !== undefined) && !layout.full) {
        throw new SheetError("A crimp needs a fully closed roll");
    }
    // A crimped end steps in one thickness through a short swage, so it slips into the next duct.
    const swage = 2 * t;
    const from = startCrimp === undefined ? 0 : startCrimp.length + swage;
    const to = length - (endCrimp === undefined ? 0 : endCrimp.length + swage);
    if (to - from <= 1e-6) throw new SheetError("The crimps are longer than the duct");

    const plainSection = (offset: number): IShape => {
        if (layout.full) return annulusFace(arena, axial(offset), layout.axisDirection, ri, ri + t);
        const section: LocalFrame = {
            origin: vec.add(startPoint, vec.scale(layout.axisDirection, offset)),
            s: frame.dir(layout.c[0], layout.c[1]),
            z: frame.n,
        };
        const pieces =
            layout.direction > 0
                ? annulusSector([0, t + ri], ri, ri + t, -Math.PI / 2, layout.angle)
                : annulusSector([0, -ri], ri, ri + t, Math.PI / 2, -layout.angle);
        return sectionFace(arena, section, pieces);
    };
    let shell = prism(arena, plainSection(from), vec.scale(layout.axisDirection, to - from));
    const parts: IShape[] = [];
    const [u, w] = perpendicularBasis(layout.axisDirection, radial);
    for (const crimp of [startCrimp, endCrimp]) {
        if (crimp === undefined) continue;
        if (crimp.depth <= 0 || crimp.depth >= ri)
            throw new SheetError("The crimp depth must be positive and smaller than the radius");
        if (!Number.isInteger(crimp.count) || crimp.count < 3)
            throw new SheetError("A crimp needs at least 3 corrugations");
        const offset = crimp.end === "start" ? 0 : to + swage;
        // The flutes' crests sit at the bore: the crimped end's outside is the duct's inside.
        const face = corrugatedFace(arena, axial(offset), u, w, ri, t, crimp.depth, crimp.count);
        parts.push(prism(arena, face, vec.scale(layout.axisDirection, crimp.length)));
        const plain = crimp.end === "start" ? swage : 0;
        const reduced = swage - plain;
        const swageFace = sectionFace(
            arena,
            { origin: axial(crimp.end === "start" ? crimp.length : to), s: layout.axisDirection, z: radial },
            [
                { kind: "line", a: [plain, ri], b: [plain, ri + t] },
                { kind: "line", a: [plain, ri + t], b: [reduced, ri] },
                { kind: "line", a: [reduced, ri], b: [reduced, ri - t] },
                { kind: "line", a: [reduced, ri - t], b: [plain, ri] },
            ],
        );
        const axis = new Line({ point: xyz(layout.axisPoint), direction: xyz(layout.axisDirection) });
        parts.push(arena.track(kernel(shapeFactory.revolve(swageFace, axis, 360), "crimp swage")));
    }
    for (const bead of model.beads) {
        if (bead.kind !== "ring") throw new SheetError("Line beads go on a flat sheet, before rolling");
        if (!layout.full) throw new SheetError("A ring bead needs a fully closed roll");
        const position = bead.from === "start" ? bead.offset : length - bead.offset;
        const section = beadSection(bead.width, bead.height, t, bead.direction);
        const half = section.footprint / 2;
        if (position - half < from - 1e-6 || position + half > to + 1e-6) {
            throw new SheetError(
                "A ring bead must sit on the plain part of the duct, clear of the ends and crimps",
            );
        }
        const band = prism(
            arena,
            annulusFace(arena, axial(position - half), layout.axisDirection, ri - 1, ri + t + 1),
            vec.scale(layout.axisDirection, 2 * half),
        );
        shell = arena.track(kernel(shapeFactory.booleanCut([shell], [band]), "bead band"));
        const origin = vec.add(axial(position), vec.scale(radial, ri));
        const face = sectionFace(arena, { origin, s: layout.axisDirection, z: radial }, section.pieces);
        const axis = new Line({ point: xyz(axial(position)), direction: xyz(layout.axisDirection) });
        parts.push(arena.track(kernel(shapeFactory.revolve(face, axis, 360), "ring bead")));
    }
    return [shell, ...parts];
}

function annulusFace(arena: Arena, center: Vec3, axis: Vec3, inner: number, outer: number): IFace {
    const circle = (radius: number) => {
        const edge = arena.track(kernel(shapeFactory.circle(xyz(axis), xyz(center), radius), "roll circle"));
        return arena.track(kernel(shapeFactory.wire([edge]), "roll circle wire"));
    };
    return arena.track(kernel(shapeFactory.face([circle(outer), circle(inner)]), "roll section"));
}

/** A closed corrugated ring: `count` flutes pull the outer radius in by up to `depth`. */
function corrugatedFace(
    arena: Arena,
    center: Vec3,
    u: Vec3,
    w: Vec3,
    outer: number,
    t: number,
    depth: number,
    count: number,
): IFace {
    const samples = Math.max(64, count * 8);
    const ring = (offset: number) => {
        const points: XYZ[] = [];
        for (let i = 0; i <= samples; i++) {
            const phi = (2 * Math.PI * (i % samples)) / samples;
            const radius = outer - (depth * (1 - Math.cos(count * phi))) / 2 - offset;
            points.push(
                xyz(
                    vec.add(
                        center,
                        vec.add(vec.scale(u, radius * Math.cos(phi)), vec.scale(w, radius * Math.sin(phi))),
                    ),
                ),
            );
        }
        return arena.track(kernel(shapeFactory.polygon(points), "crimp outline"));
    };
    return arena.track(kernel(shapeFactory.face([ring(0), ring(t)]), "crimp section"));
}

// ------------------------------------------------------------------ Flat pattern

function buildFlat(arena: Arena, model: SheetMetalModel): IShape {
    const layout = layoutOf(arena, { ...model, flat: false, bends: [], roll: model.roll });
    const frame = layout.frame;
    const t = model.thickness;
    const solids: IShape[] = [prism(arena, layout.blank, vec.scale(frame.n, t))];
    const marks: IEdge[] = [];
    const mark = (a: V2, b: V2) => {
        marks.push(
            arena.track(
                kernel(
                    shapeFactory.line(xyz(frame.point(a[0], a[1], t)), xyz(frame.point(b[0], b[1], t))),
                    "bend mark",
                ),
            ),
        );
    };

    for (const flange of model.flanges) {
        const { outward } = flangeFrame(layout, flange);
        const section = stripSection(flange.elements, t, model.kFactor);
        const far = scale2(outward, section.flatLength);
        const corners = [flange.a, flange.b, add2(flange.b, far), add2(flange.a, far)].map((p) =>
            frame.point(p[0], p[1]),
        );
        solids.push(prism(arena, polygonFace(arena, corners), vec.scale(frame.n, t)));
        for (const center of section.bendCenters) {
            mark(add2(flange.a, scale2(outward, center)), add2(flange.b, scale2(outward, center)));
        }
    }
    // Bend lines run across the blank: clip each to the material it crosses.
    for (const bend of model.bends) {
        for (const [a, b] of clipToBlank(arena, layout, bend.a, bend.b)) mark(a, b);
    }
    if (model.roll !== undefined && layout.kind === "roll") {
        const across = (axialOffset: number) => {
            const x = layout.x0 + axialOffset;
            mark(
                add2(scale2(layout.c, layout.c0), scale2(layout.x, x)),
                add2(scale2(layout.c, layout.c1), scale2(layout.x, x)),
            );
        };
        const length = layout.x1 - layout.x0;
        for (const crimp of model.crimps)
            across(crimp.end === "start" ? crimp.length : length - crimp.length);
        for (const bead of model.beads) {
            if (bead.kind === "ring") across(bead.from === "start" ? bead.offset : length - bead.offset);
        }
    }
    for (const bead of model.beads) if (bead.kind === "line") mark(bead.a, bead.b);

    const body = fuseAll(arena, solids);
    if (marks.length === 0) return body;
    return arena.track(kernel(shapeFactory.combine([body, ...marks]), "flat pattern"));
}

/** The pieces of the infinite line through `a`, `b` that lie inside the blank. */
function clipToBlank(arena: Arena, layout: Layout, a: V2, b: V2): [V2, V2][] {
    const frame = layout.frame;
    const e = unit2(sub2(b, a));
    const box = layout.blank.boundingBox();
    const reach = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) * 2 + 10;
    const p0 = add2(a, scale2(e, -reach));
    const p1 = add2(a, scale2(e, reach));
    const line = arena.track(
        kernel(
            shapeFactory.line(xyz(frame.point(p0[0], p0[1])), xyz(frame.point(p1[0], p1[1]))),
            "bend line",
        ),
    );
    const inside = arena.track(kernel(shapeFactory.booleanCommon([line], [layout.blank]), "bend line clip"));
    const edges = arena.trackAll(inside.findSubShapes(ShapeTypes.edge) as IEdge[]);
    return edges.map((edge) => {
        const [s, f] = edge.ends();
        return [frame.local([s.x, s.y, s.z]), frame.local([f.x, f.y, f.z])];
    });
}
