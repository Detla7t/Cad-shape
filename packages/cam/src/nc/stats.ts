// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DEFAULT_PRINT_KINEMATICS, estimatePrintTime } from "../additive/gcode/estimate";
import type { MachineProfileData } from "../model/machine";
import type { ToolpathMove, Vec3 } from "../model/toolpath";
import { arcPoints, arcRadius, arcSweep, drillPlanes, planeAxes } from "../posts/motion";
import type { NcBounds, NcStats, NcToolpath } from "./program";

/**
 * Statistics of a read program: feed and rapid lengths (arcs and helices at their true
 * length, drilling cycles as the motion they make), times at the programmed feeds capped
 * by the machine's limits (printers: the trapezoidal planner estimate), bounds, tools,
 * spindle and feed ranges. Home moves (reference returns) do not count: where the machine
 * goes for them is not in the program.
 */

/** Rapid rate assumed without a machine profile, mm/min. */
export const ASSUMED_RAPID_FEED = 5000;

class Box {
    readonly min: [number, number, number] = [Infinity, Infinity, Infinity];
    readonly max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    add(p: Vec3): void {
        for (let k = 0; k < 3; k++) {
            if (p[k] < this.min[k]) this.min[k] = p[k];
            if (p[k] > this.max[k]) this.max[k] = p[k];
        }
    }

    get value(): NcBounds | undefined {
        return this.min[0] <= this.max[0] ? { min: [...this.min], max: [...this.max] } : undefined;
    }
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** The length of a move from `from` (arcs: along the arc, helices included). */
export function moveLength(from: Vec3, move: ToolpathMove): number {
    switch (move.kind) {
        case "rapid":
        case "linear":
        case "taper":
        case "extrude":
            return distance(from, move.to);
        case "arc": {
            const [, , w] = planeAxes(move.plane);
            const along = Math.abs(arcSweep(from, move)) * arcRadius(from, move);
            return Math.hypot(along, move.to[w] - from[w]);
        }
        default:
            return 0;
    }
}

export function ncStats(
    toolpaths: readonly NcToolpath[],
    options: {
        readonly machine?: MachineProfileData;
        readonly printer: boolean;
        readonly spindle?: { readonly min: number; readonly max: number };
        readonly layers: number;
    },
): NcStats {
    const machine = options.machine;
    const rapidFeed = machine !== undefined && machine.rapidFeed > 0 ? machine.rapidFeed : ASSUMED_RAPID_FEED;
    const maxFeed = machine !== undefined && machine.maxFeed > 0 ? machine.maxFeed : Number.POSITIVE_INFINITY;
    const bounds = new Box();
    const cutBounds = new Box();
    let cuttingLength = 0;
    let rapidLength = 0;
    let cuttingTime = 0;
    let rapidTime = 0;
    let dwellTime = 0;
    let moves = 0;
    let filament = 0;
    let feedMin = Number.POSITIVE_INFINITY;
    let feedMax = 0;
    const tools: number[] = [];
    const feedTime = (length: number, feed: number) => {
        const rate = Math.min(feed > 0 ? feed : rapidFeed, maxFeed);
        return (length / rate) * 60;
    };
    const noteFeed = (feed: number) => {
        if (feed <= 0) return;
        feedMin = Math.min(feedMin, feed);
        feedMax = Math.max(feedMax, feed);
    };
    for (const path of toolpaths) {
        if (!tools.includes(path.toolNumber)) tools.push(path.toolNumber);
        let at: Vec3 | undefined = path.start;
        if (at !== undefined) bounds.add(at);
        path.toolpath.moves.forEach((move, index) => {
            const home = path.homeMoves.has(index);
            if (move.kind === "dwell") {
                dwellTime += Math.max(0, move.seconds);
                return;
            }
            if (move.kind === "cutterOn") {
                dwellTime += move.pierceDelay ?? 0;
                return;
            }
            if (move.kind === "drill") {
                moves++;
                const { bottom, r } = drillPlanes(move);
                const top = at?.[2] ?? r;
                const position: Vec3 = [move.at[0], move.at[1], top];
                if (at !== undefined) {
                    const travel = distance(at, position);
                    rapidLength += travel;
                    rapidTime += (travel / rapidFeed) * 60;
                }
                const approach = Math.abs(top - r);
                const depth = r - bottom;
                const feedOut = move.cycle === "tap" || move.cycle === "bore";
                rapidLength += approach * 2 + (feedOut ? 0 : depth);
                rapidTime += ((approach * 2 + (feedOut ? 0 : depth)) / rapidFeed) * 60;
                cuttingLength += depth * (feedOut ? 2 : 1);
                cuttingTime += feedTime(depth * (feedOut ? 2 : 1), move.feed);
                dwellTime += move.dwell ?? 0;
                noteFeed(move.feed);
                bounds.add([move.at[0], move.at[1], bottom]);
                bounds.add([move.at[0], move.at[1], Math.max(top, r)]);
                cutBounds.add([move.at[0], move.at[1], bottom]);
                cutBounds.add([move.at[0], move.at[1], r]);
                at = [move.at[0], move.at[1], Math.max(top, r)];
                return;
            }
            if (!("to" in move)) return;
            moves++;
            const from = at ?? move.to;
            at = move.to;
            if (home) return;
            bounds.add(move.to);
            const length = moveLength(from, move);
            if (move.kind === "rapid") {
                rapidLength += length;
                rapidTime += (length / (options.printer && move.feed ? move.feed : rapidFeed)) * 60;
                return;
            }
            cuttingLength += length;
            cuttingTime += feedTime(length, move.feed);
            noteFeed(move.feed);
            cutBounds.add(from);
            cutBounds.add(move.to);
            if (move.kind === "arc") {
                // An arc bulges past its end points.
                for (const point of arcPoints(from, move, 0.01)) {
                    bounds.add(point);
                    cutBounds.add(point);
                }
            }
            if (move.kind === "extrude") filament += move.extrude;
        });
    }
    let totalTime = cuttingTime + rapidTime + dwellTime;
    if (options.printer) {
        const all = toolpaths.flatMap((path) =>
            path.toolpath.moves.filter((_, index) => !path.homeMoves.has(index)),
        );
        const estimate = estimatePrintTime(all, DEFAULT_PRINT_KINEMATICS);
        totalTime = estimate.seconds;
    }

    return {
        cuttingLength,
        rapidLength,
        cuttingTime,
        rapidTime,
        dwellTime,
        totalTime,
        timeAssumed: machine === undefined,
        ...(bounds.value === undefined ? {} : { bounds: bounds.value }),
        ...(cutBounds.value === undefined ? {} : { cutBounds: cutBounds.value }),
        tools,
        toolChanges: Math.max(0, toolpaths.length - 1),
        ...(options.spindle === undefined ? {} : { spindle: options.spindle }),
        ...(feedMax > 0 ? { feed: { min: feedMin, max: feedMax } } : {}),
        moves,
        ...(options.printer ? { filament, layers: options.layers } : {}),
    };
}

/** "1:02:03" / "2:03" for a duration in seconds. */
export function formatNcDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
