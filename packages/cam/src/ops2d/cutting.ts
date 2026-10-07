// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { fitArcs, fitCircle } from "../geometry2d/arcs";
import { offset, regions } from "../geometry2d/clip";
import { arcLeadIn, arcLeadOut } from "../geometry2d/leads";
import { nestRectangles } from "../geometry2d/nesting";
import { nearestNeighborOrder } from "../geometry2d/order";
import {
    arcRadius,
    arcSegment,
    arcSweep,
    lineSegment,
    nearestArcLength,
    type Path2,
    type PathSegment,
    pathLength,
    pathPointAt,
    pathPoints,
    pathTangentAt,
    reversePath,
    segmentEndTangent,
    segmentLength,
    segmentPointAt,
    segmentStartTangent,
    startClosedPathAt,
    subPath,
} from "../geometry2d/path";
import { bounds, centroid, interiorPoint, oriented, pointInPolygon } from "../geometry2d/polygon";
import { tabCenters, tabIntervals } from "../geometry2d/tabs";
import {
    add,
    distance,
    dot,
    lerp,
    normalize,
    type Point2,
    perpLeft,
    perpRight,
    rotate,
    scale,
    sub,
    turnAngle,
} from "../geometry2d/vec";
import type { MachineKind, MachineProfileData } from "../model/machine";
import type { CamOperationContext, CamOperationHandler, CamParameterSpec } from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolData } from "../model/tool";
import type { ToolpathData } from "../model/toolpath";
import { feedsOf, toolpathOf } from "./common";
import { deepestPoint } from "./entries";
import { selectionGeometry } from "./geometry";
import { flat, MoveBuilder, type Piece, splitPiecesAt } from "./moves";
import { options, ParamReader, when } from "./params";

/**
 * 2D profile cutting for waterjets, plasma tables and lasers: parts (outlines with holes,
 * from sketches, sheet metal flat patterns or flat faces) cut with kerf compensation, holes
 * and inner parts before outlines, pierced on the scrap side with lead-ins at corners (or
 * from the centre of small holes), lead-outs, corner slowdowns or loops, micro-joints,
 * reduced speed in small holes, a marking pass for bend lines and marks, and simple
 * rectangle nesting of copies on the sheet.
 */

/** One part on the sheet: an outline, its holes, marks (bend lines) and open cuts inside it. */
export interface CutPart {
    readonly outer: readonly Point2[];
    readonly holes: readonly (readonly Point2[])[];
    readonly marks: readonly (readonly Point2[])[];
    readonly slits: readonly (readonly Point2[])[];
    /** How many other parts' outlines contain this one (parts inside holes are cut first). */
    readonly depth: number;
}

type Compensation = "computer" | "control" | "none";
type CornerMode = "none" | "slowdown" | "loop";
type LeadType = "arc" | "line";

export interface CuttingSettings {
    readonly kerf: number;
    readonly compensation: Compensation;
    readonly partOnRight: boolean;
    readonly leadType: LeadType;
    readonly leadIn: number;
    readonly leadOut: number;
    readonly overcut: number;
    readonly cornerMode: CornerMode;
    /** Corners turning more than this (radians) get the corner treatment. */
    readonly cornerAngle: number;
    readonly cornerFeedFactor: number;
    readonly cornerDistance: number;
    readonly loopRadius: number;
    readonly smallHole: number;
    readonly smallHoleFeedFactor: number;
    readonly tabCount: number;
    readonly tabWidth: number;
    readonly tabsOnHoles: boolean;
    readonly marks: "etch" | "skip";
    readonly pierceDelay: number;
    readonly top: number;
    readonly pierceZ: number;
    readonly cutZ: number;
    readonly travelZ: number;
    readonly feed: number;
}

// ------------------------------------------------------------------ Parts from the selection

/** Groups the selection's loops into parts: regions with the marks and open cuts inside them. */
export function partsFromSelection(context: CamOperationContext): CutPart[] {
    const geometry = selectionGeometry(context);
    const cutLoops = geometry.closed
        .filter((c) => c.role !== "bend" && c.role !== "mark")
        .map((c) => c.points);
    for (const hole of geometry.holes.filter((h) => h.source === "face")) cutLoops.push(hole.points);
    const markLines = [
        ...geometry.open.filter((o) => o.role === "bend" || o.role === "mark").map((o) => o.points),
        ...geometry.closed
            .filter((c) => c.role === "bend" || c.role === "mark")
            .map((c) => [...c.points, c.points[0]]),
    ];
    const slitLines = geometry.open
        .filter((o) => o.role !== "bend" && o.role !== "mark")
        .map((o) => o.points);
    const found = regions(cutLoops);
    const inside = (polyline: readonly Point2[], outer: readonly Point2[]) => {
        const mid = lerp(polyline[0], polyline[polyline.length - 1], 0.5);
        return pointInPolygon(polyline[0], outer) || pointInPolygon(mid, outer);
    };
    const parts: CutPart[] = found.map((region) => ({
        outer: region.outer,
        holes: region.holes,
        marks: [] as Point2[][],
        slits: [] as Point2[][],
        depth: found.filter((other) => other !== region && pointInPolygon(region.outer[0], other.outer))
            .length,
    }));
    // Marks and slits go with the smallest part that contains them.
    const smallestContaining = (polyline: readonly Point2[]) => {
        let best: CutPart | undefined;
        for (const part of parts) {
            if (!inside(polyline, part.outer)) continue;
            if (best === undefined || Math.abs(polygonArea(part.outer)) < Math.abs(polygonArea(best.outer)))
                best = part;
        }
        return best;
    };
    const loose: CutPart = { outer: [], holes: [], marks: [], slits: [], depth: 0 };
    for (const line of markLines) ((smallestContaining(line) ?? loose).marks as Point2[][]).push([...line]);
    for (const line of slitLines) ((smallestContaining(line) ?? loose).slits as Point2[][]).push([...line]);
    if (loose.marks.length > 0 || loose.slits.length > 0) parts.push(loose);
    return parts;
}

function polygonArea(points: readonly Point2[]): number {
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
    }
    return area / 2;
}

// ------------------------------------------------------------------ Nesting

function transformPart(part: CutPart, angle: number, shift: Point2): CutPart {
    const map = (p: Point2) => add(rotate(p, angle), shift);
    return {
        outer: part.outer.map(map),
        holes: part.holes.map((h) => h.map(map)),
        marks: part.marks.map((m) => m.map(map)),
        slits: part.slits.map((m) => m.map(map)),
        depth: part.depth,
    };
}

export interface NestSettings {
    readonly copies: number;
    readonly spacing: number;
    readonly margin: number;
    readonly allowRotation: boolean;
    readonly sheet: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    };
}

/**
 * Places `copies` of every part on the sheet by their bounding rectangles (grown by half the
 * kerf); parts inside other parts' holes travel with their host.
 */
export function nestParts(
    parts: readonly CutPart[],
    kerf: number,
    s: NestSettings,
): { placed: CutPart[]; unplaced: number } {
    const hosts = parts.filter((part) => part.depth === 0 && part.outer.length > 0);
    const guests = parts.filter((part) => part.depth > 0);
    const groups = hosts.map((host) => ({
        host,
        members: [host, ...guests.filter((g) => pointInPolygon(g.outer[0], host.outer))],
    }));
    const items: { id: string; width: number; height: number }[] = [];
    const boxes = groups.map((group) => bounds(group.host.outer));
    groups.forEach((_, g) => {
        const box = boxes[g];
        for (let c = 0; c < s.copies; c++) {
            items.push({
                id: `${g}:${c}`,
                width: box.max[0] - box.min[0] + kerf,
                height: box.max[1] - box.min[1] + kerf,
            });
        }
    });
    const result = nestRectangles(items, {
        sheet: s.sheet,
        spacing: s.spacing,
        margin: s.margin,
        allowRotation: s.allowRotation,
    });
    const placed: CutPart[] = [];
    for (const placement of result.placed) {
        const g = Number(placement.id.split(":")[0]);
        const box = boxes[g];
        const angle = placement.rotated ? Math.PI / 2 : 0;
        // After rotation the box's lower-left corner moves; bring it to the placement (plus half a kerf).
        const corners: Point2[] = [box.min, [box.max[0], box.min[1]], box.max, [box.min[0], box.max[1]]];
        const turned = bounds(corners.map((c) => rotate(c, angle)));
        const shift: Point2 = [
            placement.x + kerf / 2 - turned.min[0],
            placement.y + kerf / 2 - turned.min[1],
        ];
        for (const member of groups[g].members) placed.push(transformPart(member, angle, shift));
    }
    return { placed, unplaced: result.unplaced.length };
}

// ------------------------------------------------------------------ Kerf paths

interface Contour {
    /** Kerf path in cutting direction (closed). */
    readonly path: Path2;
    readonly hole: boolean;
    /** The part geometry loop this path cuts (counter-clockwise), for lead placement. */
    readonly loop: readonly Point2[];
    readonly small: boolean;
    /** Center of a small round hole (center pierce), when it is round. */
    readonly center?: Point2;
}

/** The kerf paths of a part's outline and holes (holes that vanish under the kerf are skipped). */
export function kerfContours(part: CutPart, s: CuttingSettings): { contours: Contour[]; skipped: number } {
    const half = s.compensation === "computer" ? s.kerf / 2 : 0;
    const contours: Contour[] = [];
    let skipped = 0;
    const direct = (path: Path2, hole: boolean) => {
        // Part on the right: the outline runs clockwise, holes counter-clockwise.
        const ccw = hole === s.partOnRight;
        return ccw ? path : reversePath(path);
    };
    for (const hole of part.holes) {
        const ccwHole = oriented(hole, true);
        const loops = half > 0 ? offset([ccwHole], -half) : [ccwHole];
        if (loops.length === 0) {
            skipped++;
            continue;
        }
        const box = bounds(hole);
        const size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]);
        const circle = fitCircle(ccwHole, 0.01);
        for (const loop of loops) {
            contours.push({
                path: direct(fitArcs(loop, true), true),
                hole: true,
                loop: ccwHole,
                small: size < s.smallHole,
                ...(circle !== undefined ? { center: circle.center } : {}),
            });
        }
    }
    if (part.outer.length >= 3) {
        const ccwOuter = oriented(part.outer, true);
        for (const loop of half > 0 ? offset([ccwOuter], half) : [ccwOuter]) {
            contours.push({
                path: direct(fitArcs(loop, true), false),
                hole: false,
                loop: ccwOuter,
                small: false,
            });
        }
    }
    return { contours, skipped };
}

// ------------------------------------------------------------------ Leads

interface Entry {
    /** Path started at the lead-in point. */
    readonly path: Path2;
    readonly pierce: Point2;
    readonly leadIn: readonly PathSegment[];
}

/** Whether every point of the lead (but its end on the path) lies on the scrap side. */
function leadInScrap(segments: readonly PathSegment[], contour: Contour): boolean {
    const polygon = pathPoints(contour.path, 0.01);
    const total = segments.reduce((sum, seg) => sum + segmentLength(seg), 0);
    if (total < 1e-9) return true;
    const n = Math.max(8, Math.ceil(total / 0.2));
    let at = 0;
    for (const segment of segments) {
        const length = segmentLength(segment);
        for (let i = 0; i < n; i++) {
            const s = (length * i) / n;
            if (at + s > total * 0.97) break;
            const p = segmentPointAt(segment, s);
            const insideLoop = pointInPolygon(p, polygon);
            if (contour.hole ? !insideLoop : insideLoop) return false;
        }
        at += length;
    }
    return true;
}

/** The free side of a contour: +1 when the scrap is left of travel. */
const scrapSide = (s: CuttingSettings): 1 | -1 => (s.partOnRight ? 1 : -1);

/**
 * A lead onto the path at `sAt`: a tangent arc or a square line from the scrap side, or —
 * at a corner — a straight line from `pierce`. Undefined when it would cross the part.
 */
function leadAt(
    path: Path2,
    sAt: number,
    contour: Contour,
    s: CuttingSettings,
    length: number,
    pierce?: Point2,
): Entry | undefined {
    const started = startClosedPathAt(path, sAt);
    const q = pathPointAt(started, 0);
    const t = pathTangentAt(started, 0);
    const side = scrapSide(s);
    let leadIn: PathSegment[];
    if (pierce !== undefined) leadIn = [lineSegment(pierce, q)];
    else if (s.leadType === "arc") leadIn = [arcLeadIn(q, t, length, side)];
    else leadIn = [lineSegment(add(q, scale(perpLeft(t), side * length)), q)];
    if (!leadInScrap(leadIn, contour)) return undefined;
    return { path: started, pierce: leadIn[0].from, leadIn };
}

/** Corners of the part loop: vertices turning at least 30°, with their scrap-side bisector. */
function loopCorners(loop: readonly Point2[], hole: boolean): { point: Point2; out: Point2 }[] {
    const n = loop.length;
    const out: { point: Point2; out: Point2 }[] = [];
    for (let i = 0; i < n; i++) {
        const prev = loop[(i - 1 + n) % n];
        const p = loop[i];
        const next = loop[(i + 1) % n];
        const d1 = normalize(sub(p, prev));
        const d2 = normalize(sub(next, p));
        const turn = turnAngle(d1, d2);
        if (Math.abs(turn) < Math.PI / 6 || Math.abs(turn) > Math.PI * 0.97) continue;
        // The loop is counter-clockwise: the part's outside is to the right of travel.
        const outward = normalize(add(perpRight(d1), perpRight(d2)));
        out.push({ point: p, out: hole ? scale(outward, -1) : outward });
    }
    return out;
}

/** Where to pierce and lead onto a contour, nearest to `from`. */
function chooseEntry(contour: Contour, s: CuttingSettings, from: Point2): Entry {
    const path = contour.path;
    const length = s.leadIn;
    if (contour.hole && contour.small) {
        const centerPoint =
            contour.center ?? deepestPoint([pathPoints(path, 0.01)])?.point ?? interiorPoint(contour.loop);
        const nearest = nearestArcLength(path, from);
        const started = startClosedPathAt(path, nearest.s);
        const q = pathPointAt(started, 0);
        const t = pathTangentAt(started, 0);
        let leadIn: PathSegment[] = [lineSegment(centerPoint, q)];
        if (s.leadType === "arc" && contour.center !== undefined && distance(centerPoint, q) > 1e-6) {
            // A half circle from the centre, tangent to the hole where it meets it.
            const mid = lerp(centerPoint, q, 0.5);
            const radial = normalize(sub(q, centerPoint));
            const ccw = dot(perpLeft(radial), t) > 0;
            leadIn = [arcSegment(centerPoint, q, mid, ccw)];
        }
        return { path: started, pierce: centerPoint, leadIn };
    }
    // Corners first (nearest to where the head is), then the point nearest to the head.
    const half = s.compensation === "computer" ? s.kerf / 2 : 0;
    const corners = loopCorners(contour.loop, contour.hole).sort(
        (a, b) => distance(a.point, from) - distance(b.point, from),
    );
    for (const scaleFactor of [1, 0.5, 0.25]) {
        for (const corner of corners) {
            // Pierce on the corner's bisector in the scrap and lead straight onto the path
            // (onto the middle of the kerf path's corner round at an outside corner).
            const pierce = add(corner.point, scale(corner.out, half + length * scaleFactor));
            const entry = leadAt(
                path,
                nearestArcLength(path, pierce).s,
                contour,
                s,
                length * scaleFactor,
                pierce,
            );
            if (entry !== undefined) return entry;
        }
        const nearest = nearestArcLength(path, from);
        const entry = leadAt(path, nearest.s, contour, s, length * scaleFactor);
        if (entry !== undefined) return entry;
        // Try the middle of the longest straight run.
        let at = 0;
        let best = -1;
        let bestLength = 0;
        for (const segment of path.segments) {
            const l = segmentLength(segment);
            if (segment.kind === "line" && l > bestLength) {
                bestLength = l;
                best = at + l / 2;
            }
            at += l;
        }
        if (best >= 0) {
            const mid = leadAt(path, best, contour, s, length * scaleFactor);
            if (mid !== undefined) return mid;
        }
    }
    // No room for a lead: pierce on the path itself.
    const nearest = nearestArcLength(path, from);
    const started = startClosedPathAt(path, nearest.s);
    return { path: started, pierce: pathPointAt(started, 0), leadIn: [] };
}

// ------------------------------------------------------------------ Corners

interface Corner {
    /** Arc-length span of the corner on the path (equal ends for a sharp vertex). */
    readonly start: number;
    readonly end: number;
    /** Signed turn, radians (positive left). */
    readonly turn: number;
    /** Index of the corner's arc segment, or of the segment after the vertex. */
    readonly index: number;
    readonly kind: "vertex" | "arc";
}

/** Sharp corners of a path: tangent breaks and tight arcs turning more than `angle`. */
export function pathCorners(path: Path2, angle: number, tightRadius: number): Corner[] {
    const corners: Corner[] = [];
    const segments = path.segments;
    let at = 0;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const length = segmentLength(segment);
        if (i > 0 || path.closed) {
            const previous = segments[(i - 1 + segments.length) % segments.length];
            const turn = turnAngle(segmentEndTangent(previous), segmentStartTangent(segment));
            if (Math.abs(turn) >= angle) corners.push({ start: at, end: at, turn, index: i, kind: "vertex" });
        }
        if (segment.kind === "arc" && arcRadius(segment) <= tightRadius && arcSweep(segment) >= angle) {
            corners.push({
                start: at,
                end: at + length,
                turn: (segment.ccw ? 1 : -1) * arcSweep(segment),
                index: i,
                kind: "arc",
            });
        }
        at += length;
    }
    return corners;
}

/**
 * Replaces tight convex corner arcs (and sharp convex vertices) by loops in the scrap: the
 * beam runs on to the sharp corner point, out along the first edge's line, around a circle
 * of `radius` tangent to both edge lines, and back to the corner along the second line.
 */
export function addCornerLoops(
    path: Path2,
    corners: readonly Corner[],
    convexSign: number,
    radius: number,
): Path2 {
    const out: PathSegment[] = [];
    const segments = path.segments;
    const byIndex = new Map(corners.filter((c) => Math.sign(c.turn) === convexSign).map((c) => [c.index, c]));
    for (let i = 0; i < segments.length; i++) {
        const corner = byIndex.get(i);
        const segment = segments[i];
        if (corner === undefined) {
            out.push(segment);
            continue;
        }
        const previous =
            corner.kind === "arc" ? segment : segments[(i - 1 + segments.length) % segments.length];
        const t1 = corner.kind === "arc" ? segmentStartTangent(segment) : segmentEndTangent(previous);
        const t2 = corner.kind === "arc" ? segmentEndTangent(segment) : segmentStartTangent(segment);
        const a = segment.from;
        const b = corner.kind === "arc" ? segment.to : segment.from;
        // The sharp corner point: where the two edge lines meet.
        const denominator = t1[0] * t2[1] - t1[1] * t2[0];
        if (Math.abs(denominator) < 1e-9) {
            out.push(segment);
            continue;
        }
        const u = ((b[0] - a[0]) * t2[1] - (b[1] - a[1]) * t2[0]) / denominator;
        const m = add(a, scale(t1, u));
        const phi = Math.PI - Math.abs(turnAngle(t1, t2));
        const reach = radius / Math.tan(phi / 2);
        const tangent1 = add(m, scale(t1, reach));
        const tangent2 = sub(m, scale(t2, reach));
        const center = add(m, scale(normalize(sub(t1, t2)), radius / Math.sin(phi / 2)));
        if (distance(a, m) > 1e-9) out.push(lineSegment(a, m));
        out.push(lineSegment(m, tangent1));
        // The loop turns against the corner: the long way round.
        out.push(...splitLoopArc(tangent1, tangent2, center, convexSign < 0));
        out.push(lineSegment(tangent2, m));
        if (corner.kind === "arc") {
            if (distance(m, b) > 1e-9) out.push(lineSegment(m, b));
        } else {
            out.push(lineSegment(m, segment.to));
        }
    }
    return { segments: out.filter((seg) => segmentLength(seg) > 1e-9), closed: path.closed };
}

/** A loop arc (over 180°) as two arcs, so no single move sweeps more than half a turn. */
function splitLoopArc(from: Point2, to: Point2, center: Point2, ccw: boolean): PathSegment[] {
    const whole = arcSegment(from, to, center, ccw);
    const length = segmentLength(whole);
    const mid = segmentPointAt(whole, length / 2);
    return [arcSegment(from, mid, center, ccw), arcSegment(mid, to, center, ccw)];
}

/** Pieces of a path with the feed lowered within `distance` of each corner. */
function slowCorners(
    pieces: readonly Piece[],
    corners: readonly Corner[],
    distanceAround: number,
    feed: number,
): Piece[] {
    if (corners.length === 0) return [...pieces];
    const total = pieces.reduce((sum, p) => sum + segmentLength(p.segment), 0);
    const zones = corners.map((c) => ({
        start: Math.max(0, c.start - distanceAround),
        end: Math.min(total, c.end + distanceAround),
    }));
    const split = splitPiecesAt(
        pieces,
        zones.flatMap((z) => [z.start, z.end]),
    );
    let at = 0;
    return split.map((piece) => {
        const length = segmentLength(piece.segment);
        const mid = at + length / 2;
        at += length;
        return zones.some((z) => mid > z.start && mid < z.end)
            ? { ...piece, feed: Math.min(piece.feed ?? feed, feed) }
            : piece;
    });
}

// ------------------------------------------------------------------ Emission

function emitContourCut(
    builder: MoveBuilder,
    contour: Contour,
    entry: Entry,
    s: CuttingSettings,
    side: "outer" | "hole",
) {
    let path = entry.path;
    const convexSign = s.partOnRight ? -1 : 1;
    const tight = Math.max(s.kerf, 0.5);
    let corners = pathCorners(path, s.cornerAngle, tight);
    if (s.cornerMode === "loop" && side === "outer") {
        path = addCornerLoops(path, corners, convexSign, s.loopRadius);
        corners = pathCorners(path, s.cornerAngle, tight);
    }
    const total = pathLength(path);
    const feed = contour.small ? s.feed * s.smallHoleFeedFactor : s.feed;
    let pieces: Piece[] = flat(path.segments, s.cutZ);
    if (s.cornerMode === "slowdown")
        pieces = slowCorners(pieces, corners, s.cornerDistance, feed * s.cornerFeedFactor);
    const tabs =
        s.tabCount > 0 && (side === "outer" || s.tabsOnHoles)
            ? tabIntervals(
                  total,
                  tabCenters(total, s.tabCount),
                  s.tabWidth + (s.compensation === "computer" ? s.kerf : 0),
              )
            : [];
    if (tabs.length > 0)
        pieces = splitPiecesAt(
            pieces,
            tabs.flatMap((t) => [t.start, t.end]),
        );

    builder.rapidTo(entry.pierce, s.travelZ, s.travelZ);
    builder.rapid([entry.pierce[0], entry.pierce[1], s.pierceZ]);
    builder.cutterOn(s.pierceDelay);
    builder.linear([entry.pierce[0], entry.pierce[1], s.cutZ], feed);
    builder.follow(flat(entry.leadIn, s.cutZ), feed);
    let at = 0;
    let on = true;
    for (const piece of pieces) {
        const length = segmentLength(piece.segment);
        const mid = at + length / 2;
        at += length;
        const inTab = tabs.some((t) => mid > t.start && mid < t.end);
        if (inTab) {
            if (on) builder.cutterOff();
            on = false;
            builder.rapid([piece.segment.to[0], piece.segment.to[1], s.cutZ]);
            continue;
        }
        if (!on) {
            // Restarting on solid material beyond a micro-joint: pierce again.
            builder.cutterOn(s.pierceDelay);
            on = true;
        }
        builder.follow([piece], feed);
    }
    if (!on) {
        builder.cutterOn(s.pierceDelay);
        on = true;
    }
    // Overcut past the start, then the lead-out on the scrap side.
    let endS = 0;
    if (s.overcut > 1e-9) {
        const over = Math.min(s.overcut, total);
        builder.follow(flat(subPath(path, 0, over), s.cutZ), feed);
        endS = over;
    }
    if (s.leadOut > 1e-9) {
        const end = pathPointAt(path, endS);
        const t = pathTangentAt(path, endS === 0 ? total : endS);
        const scrap = scrapSide(s);
        const out =
            s.leadType === "arc"
                ? arcLeadOut(end, t, s.leadOut, scrap)
                : lineSegment(end, add(end, scale(perpLeft(t), scrap * s.leadOut)));
        if (leadInScrap([reverseLead(out)], contour)) builder.follow(flat([out], s.cutZ), feed);
    }
    builder.cutterOff();
    builder.vertical(s.travelZ);
}

const reverseLead = (segment: PathSegment): PathSegment =>
    segment.kind === "line"
        ? lineSegment(segment.to, segment.from)
        : arcSegment(segment.to, segment.from, segment.center, !segment.ccw);

function emitPolyline(
    builder: MoveBuilder,
    line: readonly Point2[],
    s: CuttingSettings,
    mode: "cut" | "mark",
    feed: number,
) {
    const path = fitArcs(line, false);
    if (path.segments.length === 0) return;
    const start = path.segments[0].from;
    builder.rapidTo(start, s.travelZ, s.travelZ);
    builder.rapid([start[0], start[1], mode === "mark" ? s.cutZ : s.pierceZ]);
    builder.cutterOn(mode === "mark" ? undefined : s.pierceDelay, mode);
    builder.linear([start[0], start[1], s.cutZ], feed);
    builder.follow(flat(path.segments, s.cutZ), feed);
    builder.cutterOff();
    builder.vertical(s.travelZ);
}

const at2 = (builder: MoveBuilder, fallback: Point2): Point2 =>
    builder.position !== undefined ? [builder.position[0], builder.position[1]] : fallback;

/** Cuts the parts: per part marks, open cuts, holes (nearest first), then the outline. */
export function emitParts(
    builder: MoveBuilder,
    parts: readonly CutPart[],
    s: CuttingSettings,
    origin: Point2,
): { skippedHoles: number } {
    let skippedHoles = 0;
    const maxDepth = Math.max(0, ...parts.map((p) => p.depth));
    let here = origin;
    for (let depth = maxDepth; depth >= 0; depth--) {
        const level = parts.filter((p) => p.depth === depth);
        const ordered = nearestNeighborOrder(level, here, (part) =>
            part.outer.length > 0 ? centroid(part.outer) : (part.marks[0]?.[0] ?? part.slits[0]?.[0] ?? here),
        );
        for (const part of ordered) {
            if (s.marks === "etch" && part.marks.length > 0) {
                const marks = nearestNeighborOrder(part.marks, at2(builder, here), (m) => m[0]);
                for (const mark of marks) emitPolyline(builder, mark, s, "mark", s.feed);
            }
            for (const slit of nearestNeighborOrder(part.slits, at2(builder, here), (m) => m[0])) {
                emitPolyline(builder, slit, s, "cut", s.feed);
            }
            const { contours, skipped } = kerfContours(part, s);
            skippedHoles += skipped;
            const holes = contours.filter((c) => c.hole);
            let remaining = [...holes];
            while (remaining.length > 0) {
                const from = at2(builder, here);
                const entries = remaining.map((c) => ({ c, e: chooseEntry(c, s, from) }));
                entries.sort((a, b) => distance(a.e.pierce, from) - distance(b.e.pierce, from));
                const next = entries[0];
                emitContourCut(builder, next.c, next.e, s, "hole");
                remaining = remaining.filter((c) => c !== next.c);
            }
            for (const outer of contours.filter((c) => !c.hole)) {
                emitContourCut(builder, outer, chooseEntry(outer, s, at2(builder, here)), s, "outer");
            }
            here = at2(builder, here);
        }
    }
    return { skippedHoles };
}

// ------------------------------------------------------------------ The operation

interface KindDefaults {
    readonly pierce: number;
    readonly cut: number;
    readonly lead: number;
    readonly corner: CornerMode;
    readonly marks: "etch" | "skip";
    readonly travel: number;
}

const PLASMA_DEFAULTS: KindDefaults = {
    pierce: 3.8,
    cut: 1.5,
    lead: 5,
    corner: "none",
    marks: "etch",
    travel: 10,
};

/** Pierce/cut heights (above the sheet), lead length, corner and marking defaults per machine kind. */
const KIND_DEFAULTS: Partial<Record<MachineKind, KindDefaults>> = {
    plasma: PLASMA_DEFAULTS,
    laser: { pierce: 1.5, cut: 1, lead: 2, corner: "none", marks: "etch", travel: 5 },
    waterjet: { pierce: 3, cut: 2, lead: 3, corner: "slowdown", marks: "skip", travel: 10 },
};

const kindDefaults = (kind: MachineKind): KindDefaults => KIND_DEFAULTS[kind] ?? PLASMA_DEFAULTS;

export function sheetThickness(context: CamOperationContext): number {
    const stock = context.setup.stock;
    return stock.kind === "sheet"
        ? stock.thickness
        : Math.max(0, context.stock.max[2] - context.stock.min[2]);
}

export function cuttingSettings(p: ParamReader, context: CamOperationContext): CuttingSettings {
    const machine = context.machine;
    const d = kindDefaults(machine.kind);
    const kerf = Math.max(0, p.num("kerf", machine.cutting?.kerf ?? context.tool.diameter));
    const leadIn = Math.max(0, p.num("leadIn", d.lead));
    const top = context.stock.max[2];
    const thickness = sheetThickness(context);
    const feeds = feedsOf(p, context.tool, machine);
    return {
        kerf,
        compensation: p.pick("compensation", ["computer", "control", "none"] as const, "computer"),
        partOnRight:
            p.pick("direction", ["partOnRight", "partOnLeft"] as const, "partOnRight") === "partOnRight",
        leadType: p.pick("leadType", ["arc", "line"] as const, "line"),
        leadIn,
        leadOut: Math.max(0, p.num("leadOut", leadIn / 2)),
        overcut: Math.max(0, p.num("overcut", 0)),
        cornerMode: p.pick("cornerMode", ["none", "slowdown", "loop"] as const, d.corner),
        cornerAngle: (Math.max(1, Math.min(179, p.num("cornerAngle", 60))) * Math.PI) / 180,
        cornerFeedFactor: Math.max(0.05, Math.min(1, p.num("cornerFeed", 50) / 100)),
        cornerDistance: Math.max(0, p.num("cornerDistance", 2)),
        loopRadius: Math.max(0.05, p.num("loopRadius", Math.max(1, kerf))),
        smallHole: Math.max(0, p.num("smallHoleDiameter", Math.max(2.5 * thickness, 5))),
        smallHoleFeedFactor: Math.max(0.05, Math.min(1, p.num("smallHoleFeed", 60) / 100)),
        tabCount: Math.max(0, p.int("tabCount", 0)),
        tabWidth: Math.max(0, p.num("tabWidth", 0.5)),
        tabsOnHoles: p.bool("tabsOnHoles", false),
        marks: p.pick("marks", ["etch", "skip"] as const, d.marks),
        pierceDelay: Math.max(0, p.num("pierceDelay", machine.cutting?.pierceDelay ?? 0)),
        top,
        pierceZ: top + Math.max(0, p.num("pierceHeight", machine.cutting?.pierceHeight ?? d.pierce)),
        cutZ: top + Math.max(0, p.num("cutHeight", machine.cutting?.cutHeight ?? d.cut)),
        travelZ: top + Math.max(0, p.num("travelHeight", d.travel)),
        feed: feeds.feed,
    };
}

export const CUTTING_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "kerf", label: "Kerf width", kind: "length", min: 0 },
    {
        key: "compensation",
        label: "Kerf compensation",
        kind: "enum",
        options: options({ computer: "In computer", control: "In control (G41/G42)", none: "None" }),
    },
    {
        key: "direction",
        label: "Cut direction",
        kind: "enum",
        options: options({
            partOnRight: "Part on the right (outline clockwise)",
            partOnLeft: "Part on the left",
        }),
    },
    { key: "leadType", label: "Lead-in", kind: "enum", options: options({ line: "Line", arc: "Arc" }) },
    { key: "leadIn", label: "Lead-in length", kind: "length", min: 0 },
    { key: "leadOut", label: "Lead-out length", kind: "length", min: 0 },
    { key: "overcut", label: "Overcut", kind: "length", min: 0 },
    { key: "pierceDelay", label: "Pierce delay", kind: "number", min: 0, description: "Seconds" },
    { key: "pierceHeight", label: "Pierce height", kind: "length", min: 0 },
    { key: "cutHeight", label: "Cut height", kind: "length", min: 0 },
    { key: "travelHeight", label: "Travel height", kind: "length", min: 0 },
    {
        key: "cornerMode",
        label: "Sharp corners",
        kind: "enum",
        options: options({ none: "As is", slowdown: "Slow down", loop: "Loops (outside corners)" }),
    },
    {
        key: "cornerAngle",
        label: "Corner angle",
        kind: "angle",
        min: 1,
        max: 179,
        visibleWhen: when("cornerMode", "slowdown", "loop"),
    },
    {
        key: "cornerFeed",
        label: "Corner feed",
        kind: "number",
        min: 5,
        max: 100,
        description: "% of the feed",
        visibleWhen: when("cornerMode", "slowdown"),
    },
    {
        key: "cornerDistance",
        label: "Slow-down distance",
        kind: "length",
        min: 0,
        visibleWhen: when("cornerMode", "slowdown"),
    },
    {
        key: "loopRadius",
        label: "Loop radius",
        kind: "length",
        min: 0,
        visibleWhen: when("cornerMode", "loop"),
    },
    { key: "smallHoleDiameter", label: "Small hole size", kind: "length", min: 0 },
    {
        key: "smallHoleFeed",
        label: "Small hole feed",
        kind: "number",
        min: 5,
        max: 100,
        description: "% of the feed",
    },
    { key: "tabCount", label: "Micro-joints per outline", kind: "integer", min: 0 },
    { key: "tabWidth", label: "Micro-joint width", kind: "length", min: 0 },
    { key: "tabsOnHoles", label: "Micro-joints on holes", kind: "boolean" },
    {
        key: "marks",
        label: "Bend lines and marks",
        kind: "enum",
        options: options({ etch: "Etch (marking pass)", skip: "Skip" }),
    },
    { key: "nest", label: "Nest on the sheet", kind: "boolean" },
    { key: "copies", label: "Copies", kind: "integer", min: 1, visibleWhen: when("nest", true) },
    { key: "partSpacing", label: "Part spacing", kind: "length", min: 0, visibleWhen: when("nest", true) },
    { key: "sheetMargin", label: "Sheet margin", kind: "length", min: 0, visibleWhen: when("nest", true) },
    { key: "allowRotation", label: "Allow 90° rotation", kind: "boolean", visibleWhen: when("nest", true) },
    { key: "feed", label: "Cutting feed", kind: "number", min: 0, description: "mm/min" },
];

export function cuttingDefaults(machine: MachineProfileData, tool?: ToolData): Record<string, unknown> {
    const d = kindDefaults(machine.kind);
    const kerf = machine.cutting?.kerf ?? tool?.diameter ?? 1.5;
    return {
        kerf,
        compensation: "computer",
        direction: "partOnRight",
        leadType: "line",
        leadIn: d.lead,
        leadOut: d.lead / 2,
        overcut: 0,
        pierceDelay: machine.cutting?.pierceDelay ?? 0,
        pierceHeight: machine.cutting?.pierceHeight ?? d.pierce,
        cutHeight: machine.cutting?.cutHeight ?? d.cut,
        travelHeight: d.travel,
        cornerMode: d.corner,
        cornerAngle: 60,
        cornerFeed: 50,
        cornerDistance: 2,
        loopRadius: Math.max(1, kerf),
        smallHoleFeed: 60,
        tabCount: 0,
        tabWidth: 0.5,
        tabsOnHoles: false,
        marks: d.marks,
        nest: false,
        copies: 1,
        partSpacing: d.lead + kerf + 2,
        sheetMargin: 10,
        allowRotation: true,
        ...(tool !== undefined ? { feed: tool.cutting.feed } : {}),
    };
}

export function generateCutting(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const s = cuttingSettings(p, context);
    let parts = partsFromSelection(context);
    if (parts.length === 0) return Result.err("Select a sketch, a flat pattern or a flat face to cut");
    const builder = new MoveBuilder();
    builder.comment(`${operation.name}: ${context.machine.kind} cut, kerf ${s.kerf}`);
    if (s.compensation === "control")
        builder.comment(`Kerf compensation in the control: ${s.partOnRight ? "G41 (left)" : "G42 (right)"}`);
    builder.comment(
        `Pierce height ${(s.pierceZ - s.top).toFixed(2)}, cut height ${(s.cutZ - s.top).toFixed(2)}`,
    );
    if (p.bool("nest", false)) {
        const sheet = {
            x: context.stock.min[0],
            y: context.stock.min[1],
            width: context.stock.max[0] - context.stock.min[0],
            height: context.stock.max[1] - context.stock.min[1],
        };
        const nested = nestParts(parts, s.kerf, {
            copies: Math.max(1, p.int("copies", 1)),
            spacing: Math.max(0, p.num("partSpacing", s.leadIn + s.kerf + 2)),
            margin: Math.max(0, p.num("sheetMargin", 10)),
            allowRotation: p.bool("allowRotation", true),
            sheet,
        });
        if (nested.placed.length === 0) return Result.err("No part fits on the sheet");
        if (nested.unplaced > 0) builder.comment(`${nested.unplaced} part(s) did not fit on the sheet`);
        // Marks outside every part have no place on a nested sheet.
        if (parts.some((part) => part.outer.length === 0))
            builder.comment("Marks outside the parts are not nested");
        parts = nested.placed;
    }
    const { skippedHoles } = emitParts(builder, parts, s, [context.stock.min[0], context.stock.min[1]]);
    if (skippedHoles > 0) builder.comment(`${skippedHoles} hole(s) smaller than the kerf were not cut`);
    return Result.ok(toolpathOf(builder, operation, context));
}

export const profileCutOperation: CamOperationHandler = {
    type: "profileCut",
    label: "Profile cut",
    category: "cutting",
    machineKinds: ["waterjet", "plasma", "laser"],
    selects: ["sketch", "flatPattern", "face"],
    defaults: cuttingDefaults,
    parameters: () => CUTTING_PARAMETERS,
    generate: generateCutting,
};

// ------------------------------------------------------------------ Marking only

export function generateMarking(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const s = cuttingSettings(p, context);
    const geometry = selectionGeometry(context);
    const roles = p.pick("markWhat", ["bends", "all"] as const, "bends");
    const lines: Point2[][] = [
        ...geometry.open
            .filter((o) => roles === "all" || o.role === "bend" || o.role === "mark")
            .map((o) => [...o.points]),
        ...geometry.closed
            .filter((c) => roles === "all" || c.role === "bend" || c.role === "mark")
            .map((c) => [...c.points, c.points[0]]),
    ];
    if (lines.length === 0)
        return Result.err("Nothing to mark: select a flat pattern with bend lines or marks");
    const builder = new MoveBuilder();
    builder.comment(`${operation.name}: marking pass (low power)`);
    let here: Point2 = [context.stock.min[0], context.stock.min[1]];
    const feed = p.num("feed", s.feed);
    for (const line of nearestNeighborOrder(lines, here, (l) => l[0])) {
        emitPolyline(builder, line, s, "mark", feed);
        here = line[line.length - 1];
    }
    return Result.ok(toolpathOf(builder, operation, context));
}

export const markOperation: CamOperationHandler = {
    type: "mark",
    label: "Mark / etch",
    category: "cutting",
    machineKinds: ["plasma", "laser", "waterjet"],
    selects: ["sketch", "flatPattern"],
    defaults: (machine, tool) => ({
        markWhat: "bends",
        cutHeight: machine.cutting?.cutHeight ?? kindDefaults(machine.kind).cut,
        travelHeight: kindDefaults(machine.kind).travel,
        ...(tool !== undefined ? { feed: tool.cutting.feed } : {}),
    }),
    parameters: () => [
        {
            key: "markWhat",
            label: "Mark",
            kind: "enum",
            options: options({ bends: "Bend lines and marks", all: "Every selected line" }),
        },
        { key: "cutHeight", label: "Marking height", kind: "length", min: 0 },
        { key: "travelHeight", label: "Travel height", kind: "length", min: 0 },
        { key: "feed", label: "Marking feed", kind: "number", min: 0, description: "mm/min" },
    ],
    generate: generateMarking,
};
