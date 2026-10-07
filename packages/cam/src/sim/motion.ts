// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ToolData } from "../model/tool";
import type { ToolpathData, ToolpathMove, Vec3 } from "../model/toolpath";
import { CHIP_BREAK_RETRACT, PECK_CLEARANCE } from "../posts/millPost";
import { arcPoints, type DrillMove, drillPlanes, isVerticalAxis } from "../posts/motion";

/**
 * A program as the straight moves a machine makes, for the stock simulator: arcs and helices
 * as chords within a tolerance, drill cycles expanded the way the mill post expands them
 * (`at` the hole top, `depth` below it, `retract` the absolute R plane; G83 pecks back to R
 * and re-enters `PECK_CLEARANCE` above the last depth, G73 backs off `CHIP_BREAK_RETRACT`,
 * taps and bores feed out, G98 returns to the starting height), and tool changes as the post
 * makes them — up to the home height with the old tool, across at that height and down with
 * the new one. The first toolpath starts above its first point. Every straight move keeps
 * the toolpath and the toolpath move it comes from.
 */

/** One toolpath of a program with the tool that cuts it. */
export interface SimulationToolpath {
    readonly toolpath: ToolpathData;
    readonly tool: ToolData;
    /** Who the toolpath belongs to (an operation id): handed back with its moves and warnings. */
    readonly id?: string;
    /** A name for it (the operation's). */
    readonly label?: string;
}

/** The straight moves of a program, as parallel arrays (one entry per move). */
export interface SimulationMoves {
    /** Move ends, xyz; the start of the program is `start`. */
    readonly ends: Float64Array;
    readonly start: Vec3;
    /** 1 for a rapid. */
    readonly rapid: Uint8Array;
    /** The index (into the program) of the toolpath a move belongs to. */
    readonly toolpath: Uint32Array;
    /** The index of the move in its toolpath's `moves` it comes from. */
    readonly source: Uint32Array;
    /** Toolpaths left out: tilted (5-axis) moves, which a 3-axis stock cannot cut, and `skip`ped ones. */
    readonly skipped: readonly number[];
    /** The height tool changes go to. */
    readonly homeZ: number;
}

export interface FlattenOptions {
    /** Chord tolerance for arcs, mm. */
    readonly arcTolerance?: number;
    /** The tool change height (default: 10 above everything). */
    readonly homeZ?: number;
    /** The top of the stock (part of the default home height). */
    readonly stockTop?: number;
    /** Toolpaths to leave out (listed in `skipped` with the tilted ones). */
    readonly skip?: (entry: SimulationToolpath, index: number) => boolean;
}

/** The highest point a program reaches (rapids, cuts and drill R planes), or −∞. */
function highestZ(toolpaths: readonly SimulationToolpath[]): number {
    let z = Number.NEGATIVE_INFINITY;
    for (const { toolpath } of toolpaths) {
        for (const move of toolpath.moves) {
            if (move.kind === "drill") z = Math.max(z, drillPlanes(move).r);
            else if ("to" in move) z = Math.max(z, move.to[2]);
        }
    }
    return z;
}

function isTilted(move: ToolpathMove): boolean {
    return (move.kind === "rapid" || move.kind === "linear") && !isVerticalAxis(move.axis);
}

class MoveBuffer {
    ends: number[] = [];
    rapid: number[] = [];
    toolpath: number[] = [];
    source: number[] = [];
    at: Vec3 | undefined;
    start: Vec3 | undefined;
    path = 0;
    move = 0;

    push(to: Vec3, rapid: boolean): void {
        const at = this.at;
        if (at === undefined) {
            this.at = to;
            this.start = to;
            return;
        }
        if (at[0] === to[0] && at[1] === to[1] && at[2] === to[2]) return;
        this.ends.push(to[0], to[1], to[2]);
        this.rapid.push(rapid ? 1 : 0);
        this.toolpath.push(this.path);
        this.source.push(this.move);
        this.at = to;
    }

    /** Straight up or down to `z` (nothing before the first point). */
    z(z: number, rapid: boolean): void {
        const at = this.at;
        if (at !== undefined) this.push([at[0], at[1], z], rapid);
    }
}

/** The drill cycle at the buffer's position, as the mill post expands it. */
function drillCycle(out: MoveBuffer, move: DrillMove): void {
    const { bottom, r } = drillPlanes(move);
    const [x, y] = move.at;
    const z = out.at?.[2] ?? r;
    if (z < r) out.z(r, true);
    const initial = Math.max(z, r);
    out.push([x, y, initial], true);
    out.z(r, true);
    const peck = move.peck !== undefined && move.peck > 0 ? move.peck : Math.abs(move.depth);
    switch (move.cycle) {
        case "peck": {
            let depth = r;
            while (depth > bottom + 1e-9) {
                const next = Math.max(bottom, depth - peck);
                if (depth < r) out.z(depth + PECK_CLEARANCE, true);
                out.z(next, false);
                out.z(r, true);
                depth = next;
            }
            break;
        }
        case "chipBreak": {
            let depth = r;
            while (depth > bottom + 1e-9) {
                depth = Math.max(bottom, depth - peck);
                out.z(depth, false);
                if (depth > bottom + 1e-9) out.z(depth + CHIP_BREAK_RETRACT, true);
            }
            break;
        }
        case "tap":
        case "bore":
            out.z(bottom, false);
            out.z(r, false);
            break;
        default:
            out.z(bottom, false);
            break;
    }
    out.z(Math.max(initial, r), true);
}

/** Flattens a program into straight moves (see the module notes). */
export function flattenToolpaths(
    toolpaths: readonly SimulationToolpath[],
    options: FlattenOptions = {},
): SimulationMoves {
    const homeZ = options.homeZ ?? Math.max(highestZ(toolpaths), options.stockTop ?? 0) + 10;
    const tolerance = options.arcTolerance ?? 0.005;
    const out = new MoveBuffer();
    const skipped: number[] = [];
    let toolId: string | undefined;
    let lost = false;
    toolpaths.forEach((entry, index) => {
        if (options.skip?.(entry, index) || entry.toolpath.moves.some(isTilted)) {
            // Where the skipped toolpath leaves the tool is unknown: start the next one afresh.
            skipped.push(index);
            lost = true;
            return;
        }
        const changed = (toolId !== undefined && entry.tool.id !== toolId) || lost;
        if (changed && out.at !== undefined) {
            // Up to the change height with the old tool, as the end of the toolpath before.
            out.z(homeZ, true);
        }
        out.path = index;
        out.move = 0;
        let positioning = changed || out.at === undefined;
        toolId = entry.tool.id;
        lost = false;
        entry.toolpath.moves.forEach((move, k) => {
            out.move = k;
            switch (move.kind) {
                case "rapid":
                case "linear":
                case "taper":
                case "extrude": {
                    if (out.at === undefined) out.push([move.to[0], move.to[1], homeZ], true);
                    if (positioning && move.kind === "rapid") {
                        // As the post does after a change: across at the home height, then down.
                        out.push([move.to[0], move.to[1], out.at?.[2] ?? homeZ], true);
                    }
                    out.push(move.to, move.kind === "rapid");
                    positioning = false;
                    break;
                }
                case "arc": {
                    if (out.at === undefined) {
                        out.push([move.to[0], move.to[1], homeZ], true);
                        out.push(move.to, false);
                        break;
                    }
                    for (const point of arcPoints(out.at, move, tolerance)) out.push(point, false);
                    positioning = false;
                    break;
                }
                case "drill": {
                    if (out.at === undefined) out.push([move.at[0], move.at[1], homeZ], true);
                    drillCycle(out, move);
                    positioning = false;
                    break;
                }
                default:
                    break;
            }
        });
    });
    // A program that never moves starts and ends at the home height above the origin.
    const start = out.start ?? [0, 0, homeZ];
    return {
        ends: Float64Array.from(out.ends),
        start,
        rapid: Uint8Array.from(out.rapid),
        toolpath: Uint32Array.from(out.toolpath),
        source: Uint32Array.from(out.source),
        skipped,
        homeZ,
    };
}

/** The start of move `index` (the end of the one before it). */
export function moveStart(moves: SimulationMoves, index: number): Vec3 {
    if (index <= 0) return moves.start;
    const k = (index - 1) * 3;
    return [moves.ends[k], moves.ends[k + 1], moves.ends[k + 2]];
}

/** The end of move `index`. */
export function moveEndPoint(moves: SimulationMoves, index: number): Vec3 {
    const k = index * 3;
    return [moves.ends[k], moves.ends[k + 1], moves.ends[k + 2]];
}
