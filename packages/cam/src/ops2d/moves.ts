// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type PathSegment, segmentLength, splitSegment } from "../geometry2d/path";
import type { Interval } from "../geometry2d/tabs";
import type { Point2 } from "../geometry2d/vec";
import type { ToolpathData, ToolpathMove, Vec3 } from "../model/toolpath";

/**
 * Building toolpaths: a cursor over the moves that drops zero-length moves, and 2.5D path
 * pieces (`Piece`: an XY segment whose Z runs linearly from `z0` to `z1` — flat cuts,
 * ramps and helices alike) with the edits contour strategies need: ramps over a length,
 * tabs lifting stretches of a pass.
 */

export interface Piece {
    readonly segment: PathSegment;
    readonly z0: number;
    readonly z1: number;
    /** Feed override for this piece (corner slowdown, small holes, plunges), mm/min. */
    readonly feed?: number;
}

const EPS = 1e-7;

const same = (a: Vec3, b: Vec3) =>
    Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS && Math.abs(a[2] - b[2]) < EPS;

export class MoveBuilder {
    readonly moves: ToolpathMove[] = [];
    position: Vec3 | undefined;

    constructor(start?: Vec3) {
        this.position = start;
    }

    comment(text: string): this {
        this.moves.push({ kind: "comment", text });
        return this;
    }

    rapid(to: Vec3): this {
        if (this.position !== undefined && same(this.position, to)) return this;
        this.moves.push({ kind: "rapid", to });
        this.position = to;
        return this;
    }

    linear(to: Vec3, feed: number): this {
        if (this.position !== undefined && same(this.position, to)) return this;
        this.moves.push({ kind: "linear", to, feed });
        this.position = to;
        return this;
    }

    /** An XY-plane arc (helical when z changes), `ccw` as seen from +Z. */
    arc(to: Vec3, center: Point2, ccw: boolean, feed: number): this {
        if (this.position !== undefined && same(this.position, to)) return this;
        this.moves.push({
            kind: "arc",
            to,
            center: [center[0], center[1], to[2]],
            clockwise: !ccw,
            plane: "XY",
            feed,
        });
        this.position = to;
        return this;
    }

    dwell(seconds: number): this {
        if (seconds > 0) this.moves.push({ kind: "dwell", seconds });
        return this;
    }

    cutterOn(pierceDelay?: number, mode?: "cut" | "mark"): this {
        this.moves.push({
            kind: "cutterOn",
            ...(pierceDelay !== undefined && pierceDelay > 0 ? { pierceDelay } : {}),
            ...(mode === "mark" ? { mode } : {}),
        });
        return this;
    }

    cutterOff(): this {
        this.moves.push({ kind: "cutterOff" });
        return this;
    }

    push(move: ToolpathMove): this {
        this.moves.push(move);
        const end = move.kind === "drill" ? move.at : "to" in move ? (move as { to: Vec3 }).to : undefined;
        if (end !== undefined) this.position = end;
        return this;
    }

    /** Straight up to `z` (when below it). */
    retract(z: number): this {
        const at = this.position;
        if (at !== undefined && at[2] < z - EPS) this.rapid([at[0], at[1], z]);
        return this;
    }

    /** Straight up or down to `z` at the current XY. */
    vertical(z: number): this {
        const at = this.position;
        if (at !== undefined) this.rapid([at[0], at[1], z]);
        return this;
    }

    /** Straight down (or up) to `z` at the current XY, at `feed`. */
    plunge(z: number, feed: number): this {
        const at = this.position;
        if (at !== undefined) this.linear([at[0], at[1], z], feed);
        return this;
    }

    /** Up to `safeZ`, across at that height to above `xy`, then down at rapid to `z`. */
    rapidTo(xy: Point2, z: number, safeZ: number): this {
        const at = this.position;
        if (at !== undefined && Math.abs(at[0] - xy[0]) < EPS && Math.abs(at[1] - xy[1]) < EPS) {
            return this.rapid([xy[0], xy[1], z]);
        }
        const travel = Math.max(safeZ, z, at?.[2] ?? Number.NEGATIVE_INFINITY);
        this.retract(travel);
        this.rapid([xy[0], xy[1], travel]);
        this.rapid([xy[0], xy[1], z]);
        return this;
    }

    /**
     * Cuts the pieces in order. A piece that starts elsewhere (a tab's end, a new level) is
     * joined by a straight move; one that goes down runs at `plungeFeed`.
     */
    follow(pieces: readonly Piece[], feed: number, plungeFeed = feed): this {
        for (const piece of pieces) {
            const f = piece.feed ?? feed;
            const s = piece.segment;
            const start: Vec3 = [s.from[0], s.from[1], piece.z0];
            const at = this.position;
            if (at !== undefined && !same(at, start))
                this.linear(start, start[2] < at[2] - EPS ? Math.min(f, plungeFeed) : f);
            const to: Vec3 = [s.to[0], s.to[1], piece.z1];
            if (s.kind === "line") this.linear(to, f);
            else this.arc(to, s.center, s.ccw, f);
        }
        return this;
    }

    build(data: Omit<ToolpathData, "moves">): ToolpathData {
        return { ...data, moves: this.moves };
    }
}

/** Pieces of segments at one height. */
export function flat(segments: readonly PathSegment[], z: number, feed?: number): Piece[] {
    return segments.map((segment) => ({ segment, z0: z, z1: z, ...(feed !== undefined ? { feed } : {}) }));
}

/** Pieces of segments with Z running linearly by length from `z0` to `z1`. */
export function ramp(segments: readonly PathSegment[], z0: number, z1: number, feed?: number): Piece[] {
    const total = segments.reduce((sum, s) => sum + segmentLength(s), 0);
    const out: Piece[] = [];
    let at = 0;
    for (const segment of segments) {
        const length = segmentLength(segment);
        const a = total > 0 ? z0 + ((z1 - z0) * at) / total : z1;
        at += length;
        const b = total > 0 ? z0 + ((z1 - z0) * at) / total : z1;
        out.push({ segment, z0: a, z1: b, ...(feed !== undefined ? { feed } : {}) });
    }
    return out;
}

function splitPiece(piece: Piece, s: number): [Piece, Piece] {
    const length = segmentLength(piece.segment);
    const [a, b] = splitSegment(piece.segment, s);
    const zm = length > 0 ? piece.z0 + ((piece.z1 - piece.z0) * s) / length : piece.z1;
    const feed = piece.feed !== undefined ? { feed: piece.feed } : {};
    return [
        { segment: a, z0: piece.z0, z1: zm, ...feed },
        { segment: b, z0: zm, z1: piece.z1, ...feed },
    ];
}

/** Splits pieces at the given arc lengths (measured along the whole chain). */
export function splitPiecesAt(pieces: readonly Piece[], cuts: readonly number[]): Piece[] {
    const sorted = [...cuts].sort((a, b) => a - b);
    const out: Piece[] = [];
    let at = 0;
    let c = 0;
    for (const original of pieces) {
        let piece = original;
        let start = at;
        const end = at + segmentLength(original.segment);
        while (c < sorted.length && sorted[c] <= start + EPS) c++;
        while (c < sorted.length && sorted[c] < end - EPS) {
            const [a, b] = splitPiece(piece, sorted[c] - start);
            out.push(a);
            piece = b;
            start = sorted[c];
            c++;
        }
        out.push(piece);
        at = end;
    }
    return out;
}

/**
 * Lifts the pass over the tab stretches: inside an interval no piece goes below `tabTop`;
 * the tool climbs and drops vertically at the interval ends.
 */
export function applyTabs(pieces: readonly Piece[], intervals: readonly Interval[], tabTop: number): Piece[] {
    if (intervals.length === 0) return [...pieces];
    const cuts = intervals.flatMap((interval) => [interval.start, interval.end]);
    const split = splitPiecesAt(pieces, cuts);
    const out: Piece[] = [];
    let at = 0;
    for (const piece of split) {
        const length = segmentLength(piece.segment);
        const mid = at + length / 2;
        at += length;
        const inside = intervals.some((interval) => mid > interval.start && mid < interval.end);
        if (!inside || (piece.z0 >= tabTop && piece.z1 >= tabTop)) {
            out.push(piece);
            continue;
        }
        out.push({ ...piece, z0: Math.max(piece.z0, tabTop), z1: Math.max(piece.z1, tabTop) });
    }
    return out;
}
