// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import {
    arcThroughPoints,
    type Drawing,
    type DrawingEntity,
    type DrawingLayer,
    degreesOf,
    normalizeDegrees,
} from "../drawing/drawing";
import type { Loop2, Segment2, SheetMetalModel, V2 } from "./model";
import { stripSection } from "./section";

/**
 * The flat pattern of a sheet metal part as pure 2D data — what a duct shop cuts and
 * marks — computed from the flat-first model alone, no kernel involved: the cut contour
 * (the blank with every edge-treatment strip unfolded onto its edge, then the holes), the
 * bend lines (across the blank, clipped to the material, and inside each strip at its
 * developed bend centers) with angle and direction, and the forming marks (crimps, beads).
 * It matches the flattened solid (`buildSheetMetal` with `flat`) by construction: the same
 * strip sections, bend allowances and roll extents. All values are millimetres in the
 * blank's (u, v) plane, viewed from the plane normal ("up" folds toward the viewer).
 */

export interface FlatBendLine {
    readonly a: V2;
    readonly b: V2;
    /** Degrees; positive folds toward the plane normal (up). */
    readonly angle: number;
    /** Inner bend radius, mm. */
    readonly radius: number;
    /** "bend" for a bend line across the blank, "flange" for one inside an edge-treatment strip. */
    readonly source: "bend" | "flange";
}

export interface FlatFormingLine {
    readonly a: V2;
    readonly b: V2;
    readonly label: string;
}

export interface FlatPattern {
    /** The cut contour: outer loop first (blank plus unfolded strips), then the holes. */
    readonly outline: readonly Loop2[];
    readonly bendLines: readonly FlatBendLine[];
    readonly forming: readonly FlatFormingLine[];
    /** Shop notes: thickness, K-factor, roll. */
    readonly notes: readonly string[];
}

const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const scale = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
const length = (a: V2) => Math.hypot(a[0], a[1]);

/** A label number: at most three decimals, no trailing zeros. */
export const labelNumber = (value: number) => String(Number(value.toFixed(3)));

class FlatPatternError extends Error {}

function unit(a: V2): V2 {
    const n = length(a);
    if (n < 1e-12) throw new FlatPatternError("A sheet metal edge has zero length");
    return [a[0] / n, a[1] / n];
}

// ------------------------------------------------------------------ Geometry of the blank

interface ArcGeometry {
    readonly center: V2;
    readonly radius: number;
    readonly start: number;
    /** Signed sweep, radians: positive counter-clockwise. */
    readonly sweep: number;
}

function arcGeometry(segment: Extract<Segment2, { kind: "arc" }>): ArcGeometry {
    const arc = arcThroughPoints("", segment.a, segment.mid, segment.b);
    if (arc === undefined) throw new FlatPatternError("A blank arc is degenerate");
    const angle = (p: V2) => Math.atan2(p[1] - arc.center[1], p[0] - arc.center[0]);
    const ccw = cross(sub(segment.mid, segment.a), sub(segment.b, segment.mid)) > 0;
    const start = angle(segment.a);
    let sweep = angle(segment.b) - start;
    if (ccw && sweep <= 0) sweep += 2 * Math.PI;
    if (!ccw && sweep >= 0) sweep -= 2 * Math.PI;
    return { center: arc.center, radius: arc.radius, start, sweep };
}

/** The loop as a polygon (arcs sampled within 0.1 µm), for inside tests only. */
function loopPolygon(loop: Loop2): V2[] {
    const points: V2[] = [];
    for (const segment of loop) {
        points.push(segment.a);
        if (segment.kind !== "arc") continue;
        const arc = arcGeometry(segment);
        const step = 2 * Math.acos(Math.max(-1, 1 - 1e-4 / arc.radius));
        const n = Math.min(4096, Math.max(8, Math.ceil(Math.abs(arc.sweep) / step)));
        for (let i = 1; i < n; i++) {
            const t = arc.start + (arc.sweep * i) / n;
            points.push([arc.center[0] + arc.radius * Math.cos(t), arc.center[1] + arc.radius * Math.sin(t)]);
        }
    }
    return points;
}

function insidePolygon(p: V2, polygon: readonly V2[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** Whether `p` lies in the material: inside the outer loop and outside every hole. */
function insideMaterial(p: V2, polygons: readonly V2[][]): boolean {
    if (polygons.length === 0 || !insidePolygon(p, polygons[0])) return false;
    return polygons.slice(1).every((hole) => !insidePolygon(p, hole));
}

/** Parameters `s` where the line `p + s·e` (e a unit vector) crosses a segment. */
function crossings(p: V2, e: V2, segment: Segment2): number[] {
    if (segment.kind === "line") {
        const d = sub(segment.b, segment.a);
        const denominator = cross(e, d);
        if (Math.abs(denominator) < 1e-12 * Math.max(1, length(d))) return [];
        const w = sub(segment.a, p);
        const s = cross(w, d) / denominator;
        const u = cross(w, e) / denominator;
        return u >= -1e-9 && u <= 1 + 1e-9 ? [s] : [];
    }
    const arc = arcGeometry(segment);
    const w = sub(p, arc.center);
    const half = dot(e, w);
    const discriminant = half * half - (dot(w, w) - arc.radius * arc.radius);
    if (discriminant < 0) return [];
    const root = Math.sqrt(discriminant);
    return [-half - root, -half + root].filter((s) => {
        const q = add(p, scale(e, s));
        let offset = Math.atan2(q[1] - arc.center[1], q[0] - arc.center[0]) - arc.start;
        if (arc.sweep < 0) offset = -offset;
        offset = ((offset % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        return offset <= Math.abs(arc.sweep) + 1e-9 || offset >= 2 * Math.PI - 1e-9;
    });
}

/** The pieces of the infinite line through `a`, `b` that lie in the material of `blank`. */
export function clipLineToBlank(a: V2, b: V2, blank: readonly Loop2[]): [V2, V2][] {
    const e = unit(sub(b, a));
    const polygons = blank.map(loopPolygon);
    const params = blank
        .flatMap((loop) => loop.flatMap((segment) => crossings(a, e, segment)))
        .sort((x, y) => x - y)
        .filter((s, i, all) => i === 0 || s - all[i - 1] > 1e-7);
    const pieces: [number, number][] = [];
    for (let i = 0; i + 1 < params.length; i++) {
        const mid = add(a, scale(e, (params[i] + params[i + 1]) / 2));
        if (!insideMaterial(mid, polygons)) continue;
        const last = pieces[pieces.length - 1];
        if (last !== undefined && Math.abs(last[1] - params[i]) < 1e-12) last[1] = params[i + 1];
        else pieces.push([params[i], params[i + 1]]);
    }
    return pieces.map(([s0, s1]) => [add(a, scale(e, s0)), add(a, scale(e, s1))]);
}

// ------------------------------------------------------------------ Edge-treatment strips

interface StripCut {
    readonly loop: number;
    readonly segment: number;
    readonly s0: number;
    readonly s1: number;
    readonly far: V2;
}

/** The blank's straight segment holding the edge a–b, with a and b as distances along it. */
function hostSegment(blank: readonly Loop2[], a: V2, b: V2) {
    for (let li = 0; li < blank.length; li++) {
        for (let si = 0; si < blank[li].length; si++) {
            const segment = blank[li][si];
            if (segment.kind !== "line") continue;
            const d = sub(segment.b, segment.a);
            const size = length(d);
            if (size < 1e-12) continue;
            const e = scale(d, 1 / size);
            const tolerance = 1e-6 * Math.max(1, size);
            const onLine = (p: V2) => Math.abs(cross(e, sub(p, segment.a))) <= tolerance;
            const along = (p: V2) => dot(e, sub(p, segment.a));
            const sa = along(a);
            const sb = along(b);
            const within = (s: number) => s >= -tolerance && s <= size + tolerance;
            if (onLine(a) && onLine(b) && within(sa) && within(sb)) {
                const clamp = (s: number) => Math.min(size, Math.max(0, s));
                return {
                    loop: li,
                    segment: si,
                    s0: clamp(Math.min(sa, sb)),
                    s1: clamp(Math.max(sa, sb)),
                    size,
                };
            }
        }
    }
    return undefined;
}

function withStrips(blank: readonly Loop2[], cuts: readonly StripCut[]): Loop2[] {
    return blank.map((loop, li) =>
        loop.flatMap((segment, si): Segment2[] => {
            const strips = cuts
                .filter((cut) => cut.loop === li && cut.segment === si)
                .sort((x, y) => x.s0 - y.s0);
            if (strips.length === 0 || segment.kind !== "line") return [segment];
            const size = length(sub(segment.b, segment.a));
            const e = unit(sub(segment.b, segment.a));
            const tolerance = 1e-6 * Math.max(1, size);
            const at = (s: number): V2 =>
                s <= tolerance ? segment.a : size - s <= tolerance ? segment.b : add(segment.a, scale(e, s));
            const path: Segment2[] = [];
            let cursor = segment.a;
            let cursorS = 0;
            for (const strip of strips) {
                if (strip.s0 < cursorS - tolerance)
                    throw new FlatPatternError("Two edge treatments overlap on one edge");
                const start = strip.s0 - cursorS > tolerance ? at(strip.s0) : cursor;
                if (start !== cursor) path.push({ kind: "line", a: cursor, b: start });
                const end = at(strip.s1);
                const startOut = add(start, strip.far);
                const endOut = add(end, strip.far);
                path.push(
                    { kind: "line", a: start, b: startOut },
                    { kind: "line", a: startOut, b: endOut },
                    { kind: "line", a: endOut, b: end },
                );
                cursor = end;
                cursorS = strip.s1;
            }
            if (cursor !== segment.b) path.push({ kind: "line", a: cursor, b: segment.b });
            return path;
        }),
    );
}

// ------------------------------------------------------------------ The pattern

function directionWord(sign: number, up = "UP", down = "DOWN") {
    return sign >= 0 ? up : down;
}

function computeFlatPattern(model: SheetMetalModel): FlatPattern {
    if (model.blank.length === 0) throw new FlatPatternError("The sheet metal part has no blank");
    const t = model.thickness;
    const polygons = model.blank.map(loopPolygon);
    const bendLines: FlatBendLine[] = [];
    const forming: FlatFormingLine[] = [];
    const cuts: StripCut[] = [];

    for (const flange of model.flanges) {
        const section = stripSection(flange.elements, t, model.kFactor);
        const e = unit(sub(flange.b, flange.a));
        const left: V2 = [-e[1], e[0]];
        const probe = add(scale(add(flange.a, flange.b), 0.5), scale(left, 1e-3));
        const outward = insideMaterial(probe, polygons) ? scale(left, -1) : left;
        const host = hostSegment(model.blank, flange.a, flange.b);
        if (host === undefined) {
            throw new FlatPatternError("An edge treatment does not sit on a straight edge of the blank");
        }
        cuts.push({ ...host, far: scale(outward, section.flatLength) });
        const bends = flange.elements.filter(
            (element) => element.kind === "bend" && Math.abs((element.angle * Math.PI) / 180) >= 1e-9,
        );
        section.bendCenters.forEach((center, i) => {
            const bend = bends[i];
            if (bend?.kind !== "bend") return;
            bendLines.push({
                a: add(flange.a, scale(outward, center)),
                b: add(flange.b, scale(outward, center)),
                angle: bend.angle,
                radius: bend.radius,
                source: "flange",
            });
        });
    }

    for (const bend of model.bends) {
        for (const [a, b] of clipLineToBlank(bend.a, bend.b, model.blank)) {
            bendLines.push({ a, b, angle: bend.angle, radius: bend.radius, source: "bend" });
        }
    }

    const notes = [
        `FLAT PATTERN  T ${labelNumber(t)}  K ${labelNumber(model.kFactor)}  R ${labelNumber(model.radius)}  (mm)`,
    ];
    if (model.roll !== undefined) {
        const outer = model.blank[0];
        if (
            model.blank.length > 1 ||
            outer.length !== 4 ||
            outer.some((segment) => segment.kind !== "line")
        ) {
            throw new FlatPatternError("Rolling needs a rectangular blank (four straight edges, no holes)");
        }
        const c: V2 = model.roll.axis === "v" ? [1, 0] : [0, 1];
        const x: V2 = model.roll.axis === "v" ? [0, 1] : [1, 0];
        const cs = outer.map((segment) => dot(segment.a, c));
        const xs = outer.map((segment) => dot(segment.a, x));
        const [c0, c1, x0, x1] = [Math.min(...cs), Math.max(...cs), Math.min(...xs), Math.max(...xs)];
        const across = (axialOffset: number, label: string) => {
            const position = x0 + axialOffset;
            forming.push({
                a: add(scale(c, c0), scale(x, position)),
                b: add(scale(c, c1), scale(x, position)),
                label,
            });
        };
        const ductLength = x1 - x0;
        for (const crimp of model.crimps) {
            across(
                crimp.end === "start" ? crimp.length : ductLength - crimp.length,
                `CRIMP ${labelNumber(crimp.length)} x ${labelNumber(crimp.depth)} (${crimp.count})`,
            );
        }
        for (const bead of model.beads) {
            if (bead.kind !== "ring") continue;
            across(
                bead.from === "start" ? bead.offset : ductLength - bead.offset,
                `BEAD W${labelNumber(bead.width)} H${labelNumber(bead.height)} ${directionWord(bead.direction, "OUT", "IN")}`,
            );
        }
        const innerRadius = model.roll.radius ?? (c1 - c0) / (2 * Math.PI) - model.kFactor * t;
        notes.push(
            `ROLL ABOUT ${model.roll.axis.toUpperCase()}  INNER R ${labelNumber(innerRadius)}  ${directionWord(model.roll.direction)}`,
        );
    }
    for (const bead of model.beads) {
        if (bead.kind !== "line") continue;
        forming.push({
            a: bead.a,
            b: bead.b,
            label: `BEAD W${labelNumber(bead.width)} H${labelNumber(bead.height)} ${directionWord(bead.direction)}`,
        });
    }

    return { outline: withStrips(model.blank, cuts), bendLines, forming, notes };
}

export function flatPatternOf(model: SheetMetalModel): Result<FlatPattern> {
    try {
        return Result.ok(computeFlatPattern(model));
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

/** Area enclosed by the cut contour (outer loop minus holes), arcs exact. */
export function flatPatternArea(pattern: FlatPattern): number {
    const loopArea = (loop: Loop2) => {
        let area = 0;
        for (const segment of loop) {
            area += cross(segment.a, segment.b) / 2;
            if (segment.kind === "arc") {
                // The circular segment between the chord and the arc, signed with the sweep.
                const arc = arcGeometry(segment);
                const theta = Math.abs(arc.sweep);
                area += (Math.sign(arc.sweep) * arc.radius * arc.radius * (theta - Math.sin(theta))) / 2;
            }
        }
        return Math.abs(area);
    };
    const [outer, ...holes] = pattern.outline;
    return outer === undefined ? 0 : loopArea(outer) - holes.reduce((sum, hole) => sum + loopArea(hole), 0);
}

// ------------------------------------------------------------------ As a drawing

export const FLAT_PATTERN_LAYERS = {
    outline: { name: "OUTLINE", aci: 7, color: "#000000" },
    bendUp: { name: "BEND_UP", aci: 3, color: "#008000", dashed: true },
    bendDown: { name: "BEND_DOWN", aci: 1, color: "#d00000", dashed: true },
    forming: { name: "FORMING", aci: 5, color: "#0050d0", dashed: true },
    annotation: { name: "ANNOTATION", aci: 8, color: "#606060" },
} as const satisfies Record<string, DrawingLayer>;

export interface FlatPatternDrawingOptions {
    /** Angle/direction labels on bend lines, forming labels and shop notes (default true). */
    readonly labels?: boolean;
    /** Text height, mm; defaults to a size readable at the part's scale. */
    readonly textHeight?: number;
}

function loopEntities(loop: Loop2, layer: string): DrawingEntity[] {
    const arcs = loop.every((segment) => segment.kind === "arc") ? loop.map(arcGeometry) : [];
    if (arcs.length > 0) {
        const [first] = arcs;
        const sameCircle = arcs.every(
            (arc) =>
                length(sub(arc.center, first.center)) < 1e-7 && Math.abs(arc.radius - first.radius) < 1e-7,
        );
        const sweep = arcs.reduce((sum, arc) => sum + arc.sweep, 0);
        if (sameCircle && Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-6) {
            return [{ kind: "circle", layer, center: first.center, radius: first.radius }];
        }
    }
    return loop.flatMap((segment): DrawingEntity[] => {
        if (segment.kind === "line") return [{ kind: "line", layer, a: segment.a, b: segment.b }];
        const arc = arcThroughPoints(layer, segment.a, segment.mid, segment.b);
        return arc === undefined ? [{ kind: "line", layer, a: segment.a, b: segment.b }] : [arc];
    });
}

/** Text along a line, centered beside it (on its left), reading upright. */
function lineLabel(a: V2, b: V2, text: string, height: number, layer: string): DrawingEntity {
    const e = unit(sub(b, a));
    let rotation = normalizeDegrees(degreesOf(Math.atan2(e[1], e[0])));
    let side: V2 = [-e[1], e[0]];
    if (rotation > 90 && rotation <= 270) {
        rotation = normalizeDegrees(rotation - 180);
        side = scale(side, -1);
    }
    const position = add(scale(add(a, b), 0.5), scale(side, height * 0.9));
    return { kind: "text", layer, position, height, rotation: Number(rotation.toFixed(9)), text };
}

export function bendLabel(line: FlatBendLine): string {
    return `${directionWord(line.angle)} ${labelNumber(Math.abs(line.angle))}° R${labelNumber(line.radius)}`;
}

export function flatPatternDrawing(pattern: FlatPattern, options: FlatPatternDrawingOptions = {}): Drawing {
    const layers = FLAT_PATTERN_LAYERS;
    const entities: DrawingEntity[] = pattern.outline.flatMap((loop) =>
        loopEntities(loop, layers.outline.name),
    );
    const points = pattern.outline.flatMap((loop) => loop.map((segment) => segment.a));
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const extent =
        points.length === 0
            ? 0
            : Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const height = options.textHeight ?? Math.min(10, Math.max(2.5, Math.round((extent / 80) * 2) / 2));
    const labels = options.labels !== false;

    for (const line of pattern.bendLines) {
        const layer = line.angle >= 0 ? layers.bendUp.name : layers.bendDown.name;
        entities.push({ kind: "line", layer, a: line.a, b: line.b });
        if (labels) entities.push(lineLabel(line.a, line.b, bendLabel(line), height, layers.annotation.name));
    }
    for (const line of pattern.forming) {
        entities.push({ kind: "line", layer: layers.forming.name, a: line.a, b: line.b });
        if (labels) entities.push(lineLabel(line.a, line.b, line.label, height, layers.annotation.name));
    }
    if (labels && points.length > 0) {
        const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
        pattern.notes.forEach((note, i) => {
            entities.push({
                kind: "text",
                layer: layers.annotation.name,
                position: [centerX, Math.min(...ys) - height * (2 + 1.6 * i)],
                height,
                rotation: 0,
                text: note,
            });
        });
    }
    return { layers: Object.values(layers), entities };
}
