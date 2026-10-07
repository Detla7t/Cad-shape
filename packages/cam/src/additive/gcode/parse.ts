// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ToolpathData, ToolpathMove, Vec3 } from "../../model/toolpath";

/**
 * Reads printer G-code back into moves for previews (a G-code from PrusaSlicer, or the raw
 * blocks of a toolpath): G0/G1 travel or extrude, G2/G3 arcs flattened into segments, G90/G91,
 * M82/M83 and G92 tracked, so every extrusion amount comes out relative. Also picks up the
 * statistics slicers write as comments.
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

interface ParserState {
    x: number;
    y: number;
    z: number;
    e: number;
    feed: number;
    absolute: boolean;
    absoluteE: boolean;
}

const WORD = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;

function words(code: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const match of code.toUpperCase().matchAll(WORD)) out.set(match[1], Number.parseFloat(match[2]));
    return out;
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

export function parsePrinterGcode(text: string, initial?: Partial<ParserState>): ParsedGcode {
    const state: ParserState = {
        x: 0,
        y: 0,
        z: 0,
        e: 0,
        feed: 3000,
        absolute: true,
        absoluteE: false,
        ...initial,
    };
    const moves: ToolpathMove[] = [];
    const stats: StatsAccumulator = { layers: 0 };
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const extendBounds = (p: Vec3) => {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], p[k]);
            max[k] = Math.max(max[k], p[k]);
        }
    };
    const push = (to: Vec3, extrude: number) => {
        const moved = to[0] !== state.x || to[1] !== state.y || to[2] !== state.z;
        if (!moved && extrude === 0) return;
        if (extrude > 0 && (to[0] !== state.x || to[1] !== state.y || to[2] !== state.z)) {
            extendBounds([state.x, state.y, state.z]);
            extendBounds(to);
        }
        if (extrude !== 0) moves.push({ kind: "extrude", to, extrude, feed: state.feed });
        else moves.push({ kind: "rapid", to, feed: state.feed });
    };
    for (const rawLine of text.split(/\r?\n/)) {
        const semicolon = rawLine.indexOf(";");
        const comment = semicolon >= 0 ? rawLine.slice(semicolon + 1).trim() : "";
        const code = (semicolon >= 0 ? rawLine.slice(0, semicolon) : rawLine).trim();
        if (comment) readStatComment(comment, stats);
        if (code === "") continue;
        const command = /^([GM])(\d+)/i.exec(code);
        if (!command) continue;
        const letter = command[1].toUpperCase();
        const number = Number.parseInt(command[2], 10);
        const w = words(code.slice(command[0].length));
        if (letter === "M") {
            if (number === 82) state.absoluteE = true;
            else if (number === 83) state.absoluteE = false;
            continue;
        }
        if (number === 90) state.absolute = true;
        else if (number === 91) state.absolute = false;
        else if (number === 92) {
            if (w.has("X")) state.x = w.get("X") as number;
            if (w.has("Y")) state.y = w.get("Y") as number;
            if (w.has("Z")) state.z = w.get("Z") as number;
            if (w.has("E")) state.e = w.get("E") as number;
        } else if (number === 28) {
            const all = !w.has("X") && !w.has("Y") && !w.has("Z");
            if (all || w.has("X")) state.x = 0;
            if (all || w.has("Y")) state.y = 0;
            if (all || w.has("Z")) state.z = 0;
        } else if (number === 0 || number === 1 || number === 2 || number === 3) {
            if (w.has("F")) state.feed = w.get("F") as number;
            const axis = (key: "X" | "Y" | "Z", current: number) => {
                const value = w.get(key);
                if (value === undefined) return current;
                return state.absolute ? value : current + value;
            };
            const to: Vec3 = [axis("X", state.x), axis("Y", state.y), axis("Z", state.z)];
            let extrude = 0;
            const e = w.get("E");
            if (e !== undefined) {
                extrude = state.absoluteE ? e - state.e : e;
                state.e = state.absoluteE ? e : state.e + e;
            }
            if (number <= 1) push(to, extrude);
            else {
                const clockwise = number === 2;
                const cx = state.x + (w.get("I") ?? 0);
                const cy = state.y + (w.get("J") ?? 0);
                const points = flattenArc([state.x, state.y, state.z], to, [cx, cy], clockwise);
                let previous: Vec3 = [state.x, state.y, state.z];
                const total = points.reduce((sum, p) => {
                    const d = Math.hypot(p[0] - previous[0], p[1] - previous[1]);
                    previous = p;
                    return sum + d;
                }, 0);
                previous = [state.x, state.y, state.z];
                for (const p of points) {
                    const d = Math.hypot(p[0] - previous[0], p[1] - previous[1]);
                    push(p, total > 0 ? (extrude * d) / total : 0);
                    state.x = p[0];
                    state.y = p[1];
                    state.z = p[2];
                    previous = p;
                }
            }
            state.x = to[0];
            state.y = to[1];
            state.z = to[2];
        }
    }
    const hasBounds = min[0] <= max[0];
    return {
        moves,
        stats: {
            seconds: stats.seconds,
            filamentMm: stats.filamentMm,
            filamentGrams: stats.filamentGrams,
            layers: stats.layers || undefined,
        },
        extrusionBounds: hasBounds ? { min, max } : undefined,
    };
}

/** Points along an XY arc (with a linear Z) at ≤ 5° steps, ending exactly at `to`. */
function flattenArc(from: Vec3, to: Vec3, center: readonly [number, number], clockwise: boolean): Vec3[] {
    const r = Math.hypot(from[0] - center[0], from[1] - center[1]);
    const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
    let a1 = Math.atan2(to[1] - center[1], to[0] - center[0]);
    if (clockwise && a1 >= a0) a1 -= 2 * Math.PI;
    if (!clockwise && a1 <= a0) a1 += 2 * Math.PI;
    const sweep = a1 - a0;
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
    const points: Vec3[] = [];
    for (let i = 1; i < steps; i++) {
        const a = a0 + (sweep * i) / steps;
        points.push([
            center[0] + r * Math.cos(a),
            center[1] + r * Math.sin(a),
            from[2] + ((to[2] - from[2]) * i) / steps,
        ]);
    }
    points.push(to);
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
