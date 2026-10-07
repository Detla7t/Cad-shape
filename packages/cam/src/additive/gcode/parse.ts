// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ToolpathData, ToolpathMove, Vec3 } from "../../model/toolpath";
import { NcReader } from "../../nc/interpreter";
import { arcSweep, planeAxes } from "../../posts/motion";

/**
 * Printer G-code back into moves for previews (a G-code from PrusaSlicer, or the raw
 * blocks of a toolpath) — read by the NC reader, so G0/G1 travel or extrude, G2/G3 arcs,
 * G90/G91, M82/M83 and G92 follow the firmware and every extrusion amount comes out
 * relative — and the statistics slicers write as comments.
 */

export interface GcodeStats {
    /** "estimated printing time (normal mode)" in seconds. */
    readonly seconds?: number;
    readonly filamentMm?: number;
    readonly filamentGrams?: number;
    readonly layers?: number;
}

export interface ParsedGcode {
    readonly moves: ToolpathMove[];
    readonly stats: GcodeStats;
    /** Bounding box of the extrusions. */
    readonly extrusionBounds?: { readonly min: Vec3; readonly max: Vec3 };
}

/** "1d 2h 3m 4s" → seconds. */
export function parseDuration(text: string): number | undefined {
    let seconds = 0;
    let found = false;
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) {
        found = true;
        const value = Number.parseFloat(match[1]);
        seconds += value * { d: 86400, h: 3600, m: 60, s: 1 }[match[2] as "d" | "h" | "m" | "s"];
    }
    return found ? seconds : undefined;
}

interface StatsAccumulator {
    seconds?: number;
    filamentMm?: number;
    filamentGrams?: number;
    layers: number;
}

function readStatComment(comment: string, stats: StatsAccumulator) {
    if (comment === "LAYER_CHANGE") stats.layers++;
    const stat = /^(.+?)\s*=\s*(.+)$/.exec(comment);
    if (!stat) return;
    const key = stat[1];
    if (key.startsWith("estimated printing time") && !key.includes("silent")) {
        stats.seconds = parseDuration(stat[2]) ?? stats.seconds;
    } else if (key === "filament used [mm]") stats.filamentMm = Number.parseFloat(stat[2]);
    else if (key === "filament used [g]") stats.filamentGrams = Number.parseFloat(stat[2]);
    else if (key === "total layers count") stats.layers = Number.parseInt(stat[2], 10) || stats.layers;
}

/** The statistics comments of a G-code, without parsing its moves. */
export function printerGcodeStats(text: string): GcodeStats {
    const stats: StatsAccumulator = { layers: 0 };
    for (const line of text.split(/\r?\n/)) {
        const semicolon = line.indexOf(";");
        if (semicolon >= 0) readStatComment(line.slice(semicolon + 1).trim(), stats);
    }
    return {
        seconds: stats.seconds,
        filamentMm: stats.filamentMm,
        filamentGrams: stats.filamentGrams,
        layers: stats.layers || undefined,
    };
}

/** Where reading starts: the head's position and feed (a raw block continues a toolpath). */
export interface PrinterGcodeStart {
    readonly x?: number;
    readonly y?: number;
    readonly z?: number;
    readonly feed?: number;
}

/**
 * Printer G-code as preview moves — a thin adapter over the NC reader (`nc/`) in its
 * Marlin dialect: travels are rapids with their feed, extrusions `extrude` moves with
 * relative amounts, arcs flattened at ≤ 5° steps (an arc's extrusion shared by length);
 * homing (G28) moves the head without a drawn move.
 */
export function parsePrinterGcode(text: string, initial?: PrinterGcodeStart): ParsedGcode {
    const start: Vec3 = [initial?.x ?? 0, initial?.y ?? 0, initial?.z ?? 0];
    const result = new NcReader(
        text,
        "marlin",
        { start, ...(initial?.feed === undefined ? {} : { feed: initial.feed }) },
        0,
    ).run();
    const moves: ToolpathMove[] = [];
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const extendBounds = (p: Vec3) => {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], p[k]);
            max[k] = Math.max(max[k], p[k]);
        }
    };
    let at = start;
    for (const path of result.toolpaths) {
        path.moves.forEach((move, index) => {
            if (path.homeMoves.has(index)) {
                if ("to" in move) at = move.to;
                return;
            }
            switch (move.kind) {
                case "rapid":
                    moves.push(move);
                    at = move.to;
                    return;
                case "extrude":
                    if (move.extrude > 0 && !samePoint(at, move.to)) {
                        extendBounds(at);
                        extendBounds(move.to);
                    }
                    moves.push(move);
                    at = move.to;
                    return;
                case "arc":
                    for (const point of flattenArc(at, move))
                        moves.push({ kind: "rapid", to: point, feed: move.feed });
                    at = move.to;
                    return;
                default:
                    return;
            }
        });
    }
    const hasBounds = min[0] <= max[0];
    return {
        moves,
        stats: printerGcodeStats(text),
        extrusionBounds: hasBounds ? { min, max } : undefined,
    };
}

const samePoint = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Points along an arc (the normal coordinate linear) at ≤ 5° steps, ending exactly at its end. */
function flattenArc(from: Vec3, arc: Extract<ToolpathMove, { kind: "arc" }>): Vec3[] {
    const [u, v, w] = planeAxes(arc.plane);
    const r = Math.hypot(from[u] - arc.center[u], from[v] - arc.center[v]);
    const a0 = Math.atan2(from[v] - arc.center[v], from[u] - arc.center[u]);
    const sweep = arcSweep(from, arc);
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
    const points: Vec3[] = [];
    for (let i = 1; i < steps; i++) {
        const a = a0 + (sweep * i) / steps;
        const point: [number, number, number] = [0, 0, 0];
        point[u] = arc.center[u] + r * Math.cos(a);
        point[v] = arc.center[v] + r * Math.sin(a);
        point[w] = from[w] + ((arc.to[w] - from[w]) * i) / steps;
        points.push(point);
    }
    points.push(arc.to);
    return points;
}

const previews = new WeakMap<ToolpathData, ToolpathMove[]>();

/**
 * The moves to draw for a printer toolpath: its own moves, with every raw G-code block (a
 * PrusaSlicer program, start G-code) expanded into the motions it contains. Cached per
 * toolpath object.
 */
export function printerPreviewMoves(toolpath: ToolpathData): readonly ToolpathMove[] {
    const cached = previews.get(toolpath);
    if (cached) return cached;
    if (!toolpath.moves.some((move) => move.kind === "raw")) return toolpath.moves;
    const out: ToolpathMove[] = [];
    let at: Vec3 = [0, 0, 0];
    for (const move of toolpath.moves) {
        if (move.kind === "raw") {
            const parsed = parsePrinterGcode(move.code, { x: at[0], y: at[1], z: at[2] });
            for (const m of parsed.moves) {
                out.push(m);
                if (m.kind === "rapid" || m.kind === "extrude") at = m.to;
            }
            continue;
        }
        out.push(move);
        if ("to" in move) at = move.to;
    }
    previews.set(toolpath, out);
    return out;
}
