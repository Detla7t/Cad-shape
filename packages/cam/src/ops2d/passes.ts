// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ARC_TOLERANCE, fitArcs } from "../geometry2d/arcs";
import { type LeadKind, leadIn, leadOut } from "../geometry2d/leads";
import {
    arcStepAngle,
    type Path2,
    type PathSegment,
    pathLength,
    pathPointAt,
    pathPoints,
    pathTangentAt,
    reverseSegment,
    segmentLength,
    segmentPointAt,
    startClosedPathAt,
    subPath,
} from "../geometry2d/path";
import { pointInPolygon, removeDuplicatePoints, signedArea } from "../geometry2d/polygon";
import type { Interval } from "../geometry2d/tabs";
import { add, cross, dot, normalize, type Point2, perpLeft, rotate, scale, sub } from "../geometry2d/vec";
import type { Feeds, Heights } from "./common";
import { applyTabs, flat, type MoveBuilder, type Piece, ramp } from "./moves";

/**
 * Contour passes shared by the milling operations: a tool-centre path cut at a series of
 * levels, entered by plunging or by ramping along the path, with lead-in/out moves on the
 * free side and tabs lifting stretches of the lowest levels.
 */

export interface LeadSpec {
    readonly inKind: LeadKind;
    readonly inSize: number;
    readonly outKind: LeadKind;
    readonly outSize: number;
    /** The free side of the path: +1 left of travel, −1 right. */
    readonly side: 1 | -1;
}

export interface ContourPassOptions {
    /** Tool-centre path, in the direction of travel. */
    readonly path: Path2;
    /** Cutting levels, top down. */
    readonly levels: readonly number[];
    /** Where material starts (the first ramp starts here). */
    readonly top: number;
    readonly heights: Heights;
    readonly feeds: Feeds;
    readonly lead: LeadSpec;
    readonly entry: "plunge" | "ramp";
    /** Largest ramp angle, degrees. */
    readonly rampAngle: number;
    /** Tabs: path stretches lifted to `top` on levels below it. */
    readonly tabs?: { readonly intervals: readonly Interval[]; readonly top: number };
    /** Closed paths: how far to cut past the start before the lead-out. */
    readonly overlap?: number;
}

const withTabs = (pieces: Piece[], o: ContourPassOptions) =>
    o.tabs !== undefined && o.tabs.intervals.length > 0
        ? applyTabs(pieces, o.tabs.intervals, o.tabs.top)
        : pieces;

/** Shifts pieces measured from `s0` so tab intervals (measured from the path start) line up. */
function tabbedFrom(pieces: Piece[], s0: number, o: ContourPassOptions): Piece[] {
    if (o.tabs === undefined || o.tabs.intervals.length === 0) return pieces;
    const total = pathLength(o.path);
    const shifted: Interval[] = [];
    for (const interval of o.tabs.intervals) {
        for (const k of [-1, 0, 1]) {
            const start = interval.start - s0 + k * total;
            const end = interval.end - s0 + k * total;
            shifted.push({ start, end });
        }
    }
    return applyTabs(pieces, shifted, o.tabs.top);
}

/**
 * A lead (built at `size`, ending on the path) kept on the path's free side: when a sample
 * falls on the wrong side of the closed path (a lead at a corner cutting across the next
 * edge), the lead shrinks, and is dropped when even a quarter of it does not fit.
 */
function freeSideLead(
    path: Path2,
    side: 1 | -1,
    size: number,
    build: (size: number) => PathSegment[],
): PathSegment[] {
    if (!path.closed) return build(size);
    const polygon = pathPoints(path, 0.01);
    // The free side is the inside of the path when it lies left of a counter-clockwise path.
    const freeInside = side > 0 === signedArea(polygon) > 0;
    for (const factor of [1, 0.5, 0.25]) {
        const segments = build(size * factor);
        if (segments.length === 0) return segments;
        const total = segments.reduce((sum, segment) => sum + segmentLength(segment), 0);
        let ok = true;
        let at = 0;
        for (const segment of segments) {
            const length = segmentLength(segment);
            for (let i = 0; i < 8 && ok; i++) {
                const s = (length * i) / 8;
                if (at + s > total * 0.95) break;
                const p = segmentPointAt(segment, s);
                if (pointInPolygon(p, polygon) !== freeInside) ok = false;
            }
            at += length;
        }
        if (ok) return segments;
    }
    return [];
}

function approach(
    builder: MoveBuilder,
    xy: Point2,
    aboveZ: number,
    z: number,
    o: ContourPassOptions,
    first: boolean,
) {
    if (first) builder.rapidTo(xy, o.heights.retract, o.heights.clearance);
    else {
        builder.retract(o.heights.retract);
        builder.rapidTo(xy, o.heights.retract, o.heights.retract);
    }
    const down = Math.min(o.heights.retract, aboveZ + 1);
    builder.rapid([xy[0], xy[1], Math.max(down, z)]);
    builder.linear([xy[0], xy[1], z], o.feeds.plunge);
}

/** Cuts a closed path at every level. Ends retracted to the retract height. */
export function emitClosedContour(builder: MoveBuilder, o: ContourPassOptions, first = true): void {
    const path = o.path;
    const total = pathLength(path);
    if (total < 1e-9 || o.levels.length === 0) return;
    const start = pathPointAt(path, 0);
    const startTangent = pathTangentAt(path, 0);
    const overlap = Math.min(Math.max(0, o.overlap ?? 0), total);
    const leadInSegments = freeSideLead(path, o.lead.side, o.lead.inSize, (size) =>
        leadIn(o.lead.inKind, start, startTangent, size, o.lead.side),
    );
    const entryXY = leadInSegments.length > 0 ? leadInSegments[0].from : start;
    const tangentSlope = Math.tan((Math.max(0.1, Math.min(89, o.rampAngle)) * Math.PI) / 180);

    const finish = (z: number, endS: number) => {
        let s = endS;
        if (overlap > 0) {
            builder.follow(
                tabbedFrom(
                    flat(subPath(path, s, s + overlap > total ? (s + overlap) % total : s + overlap), z),
                    s,
                    o,
                ),
                o.feeds.feed,
                o.feeds.plunge,
            );
            s = (s + overlap) % total;
        }
        const end = pathPointAt(path, s);
        const tangent = pathTangentAt(path, s);
        // Checked from its far end, like a lead-in, then turned back round.
        const out = freeSideLead(path, o.lead.side, o.lead.outSize, (size) =>
            leadOut(o.lead.outKind, end, tangent, size, o.lead.side).map(reverseSegment).reverse(),
        )
            .map(reverseSegment)
            .reverse();
        builder.follow(flat(out, z), o.feeds.feed);
        builder.retract(o.heights.retract);
    };

    if (o.entry === "plunge") {
        o.levels.forEach((z, i) => {
            const above = i === 0 ? o.top : o.levels[i - 1];
            approach(builder, entryXY, above, z, o, first && i === 0);
            builder.follow(flat(leadInSegments, z), o.feeds.feed);
            builder.follow(withTabs(flat(path.segments, z), o), o.feeds.feed, o.feeds.plunge);
            finish(z, 0);
        });
        return;
    }

    // Ramp: down along the path from level to level, one continuous helix around the contour.
    approach(builder, entryXY, o.top, o.top, o, first);
    builder.follow(flat(leadInSegments, o.top), o.feeds.feed);
    let previous = o.top;
    let cleanup = 0;
    for (const z of o.levels) {
        const dz = previous - z;
        const needed = dz / tangentSlope;
        if (needed <= total) {
            const pieces = [
                ...ramp(subPath(path, 0, needed), previous, z, o.feeds.ramp),
                ...flat(subPath(path, needed, total), z),
            ];
            builder.follow(withTabs(pieces, o), o.feeds.feed, o.feeds.plunge);
            cleanup = needed;
        } else {
            const turns = Math.ceil(needed / total);
            for (let t = 0; t < turns; t++) {
                const z0 = previous - (dz * t) / turns;
                const z1 = previous - (dz * (t + 1)) / turns;
                builder.follow(
                    withTabs(ramp(path.segments, z0, z1, o.feeds.ramp), o),
                    o.feeds.feed,
                    o.feeds.plunge,
                );
            }
            builder.follow(withTabs(flat(path.segments, z), o), o.feeds.feed, o.feeds.plunge);
            cleanup = 0;
        }
        previous = z;
    }
    const bottom = o.levels[o.levels.length - 1];
    if (cleanup > 1e-9)
        builder.follow(withTabs(flat(subPath(path, 0, cleanup), bottom), o), o.feeds.feed, o.feeds.plunge);
    finish(bottom, cleanup % total);
}

/** Cuts an open path at every level, each level from its start (one-way). */
export function emitOpenContour(builder: MoveBuilder, o: ContourPassOptions, first = true): void {
    const path = o.path;
    const total = pathLength(path);
    if (total < 1e-9 || o.levels.length === 0) return;
    const start = pathPointAt(path, 0);
    const end = pathPointAt(path, total);
    const inSegments =
        o.entry === "ramp"
            ? []
            : leadIn(o.lead.inKind, start, pathTangentAt(path, 0), o.lead.inSize, o.lead.side);
    const outSegments = leadOut(o.lead.outKind, end, pathTangentAt(path, total), o.lead.outSize, o.lead.side);
    const entryXY = inSegments.length > 0 ? inSegments[0].from : start;
    const slope = Math.tan((Math.max(0.1, Math.min(89, o.rampAngle)) * Math.PI) / 180);
    o.levels.forEach((z, i) => {
        const above = i === 0 ? o.top : o.levels[i - 1];
        if (o.entry === "ramp") {
            approach(builder, entryXY, above, above, o, first && i === 0);
            const length = Math.min(total, (above - z) / slope);
            const down = subPath(path, 0, length);
            builder.follow(ramp(down, above, z, o.feeds.ramp), o.feeds.feed);
            builder.follow(flat([...down].reverse().map(reverseSegment), z), o.feeds.feed);
        } else {
            approach(builder, entryXY, above, z, o, first && i === 0);
            builder.follow(flat(inSegments, z), o.feeds.feed);
        }
        builder.follow(flat(path.segments, z), o.feeds.feed);
        builder.follow(flat(outSegments, z), o.feeds.feed);
        builder.retract(o.heights.retract);
    });
}

export function emitContour(builder: MoveBuilder, o: ContourPassOptions, first = true): void {
    if (o.path.closed) emitClosedContour(builder, o, first);
    else emitOpenContour(builder, o, first);
}

/** Where a closed path best starts: the middle of its longest straight run (else its start). */
export function bestStart(path: Path2): Path2 {
    if (!path.closed) return path;
    let at = 0;
    let best = -1;
    let bestLength = 0;
    for (const segment of path.segments) {
        const length = segmentLength(segment);
        if (segment.kind === "line" && length > bestLength + 1e-9) {
            bestLength = length;
            best = at + length / 2;
        }
        at += length;
    }
    return best < 0 ? path : startClosedPathAt(path, best);
}

/**
 * An open polyline offset sideways by `delta` (left of travel when positive), as fitted
 * lines and arcs: each segment moved along its normal, corners on the outer side rounded
 * (centred on the vertex), corners on the inner side mitred to the offset lines' meeting
 * point. Inner corners tighter than the offset are not trimmed further.
 */
export function offsetOpenPolyline(points: readonly Point2[], delta: number): Path2 {
    const pts = removeDuplicatePoints(points, false);
    if (pts.length < 2) return { segments: [], closed: false };
    if (Math.abs(delta) < 1e-9) return fitArcs(pts, false);
    const normals: Point2[] = [];
    for (let i = 0; i + 1 < pts.length; i++)
        normals.push(scale(perpLeft(normalize(sub(pts[i + 1], pts[i]))), delta));
    const out: Point2[] = [add(pts[0], normals[0])];
    for (let i = 1; i + 1 < pts.length; i++) {
        const before = normals[i - 1];
        const after = normals[i];
        const turn = Math.atan2(cross(before, after), dot(before, after));
        if (Math.abs(turn) < 1e-9) {
            out.push(add(pts[i], after));
        } else if (turn * delta < 0) {
            // Outer side: round the corner about the vertex.
            const steps = Math.max(
                1,
                Math.ceil(Math.abs(turn) / arcStepAngle(Math.abs(delta), ARC_TOLERANCE)),
            );
            for (let k = 0; k <= steps; k++) out.push(add(pts[i], rotate(before, (turn * k) / steps)));
        } else {
            // Inner side: where the two offset lines meet.
            out.push(add(pts[i], scale(add(before, after), 1 / (1 + Math.cos(turn)))));
        }
    }
    out.push(add(pts[pts.length - 1], normals[normals.length - 1]));
    return fitArcs(out, false);
}
