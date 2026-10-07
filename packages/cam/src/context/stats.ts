// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MachineProfileData } from "../model/machine";
import type { ToolpathData, Vec3 } from "../model/toolpath";
import { arcRadius, arcSweep, drillPlanes, planeAxes } from "../posts/motion";

/** What the operations list shows per toolpath: lengths (mm) and an estimated run time (s). */
export interface ToolpathStats {
    readonly cutting: number;
    readonly rapid: number;
    readonly seconds: number;
    readonly moves: number;
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/**
 * Lengths with arcs measured along the arc (helices included), and time at the programmed
 * feeds — rapids at the machine's rapid rate, dwells and pierce delays added; drill cycles
 * as their plunge and retract.
 */
export function toolpathStats(path: ToolpathData, machine: MachineProfileData): ToolpathStats {
    let cutting = 0;
    let rapid = 0;
    let seconds = 0;
    let at: Vec3 | undefined;
    const rapidRate = Math.max(1, machine.rapidFeed) / 60;
    for (const move of path.moves) {
        switch (move.kind) {
            case "rapid":
                if (at !== undefined) {
                    const d = distance(at, move.to);
                    rapid += d;
                    seconds += d / rapidRate;
                }
                at = move.to;
                break;
            case "linear":
            case "taper":
            case "extrude":
                if (at !== undefined) {
                    const d = distance(at, move.to);
                    cutting += d;
                    seconds += d / (Math.max(1e-6, move.feed) / 60);
                }
                at = move.to;
                break;
            case "arc":
                if (at !== undefined) {
                    const w = planeAxes(move.plane)[2];
                    const along = Math.abs(arcSweep(at, move)) * arcRadius(at, move);
                    const d = Math.hypot(along, move.to[w] - at[w]);
                    cutting += d;
                    seconds += d / (Math.max(1e-6, move.feed) / 60);
                }
                at = move.to;
                break;
            case "drill": {
                const { bottom, r } = drillPlanes(move);
                const plunge = r - bottom;
                if (at !== undefined) {
                    const d = Math.hypot(move.at[0] - at[0], move.at[1] - at[1]);
                    rapid += d;
                    seconds += d / rapidRate;
                }
                cutting += plunge;
                seconds += plunge / (Math.max(1e-6, move.feed) / 60) + plunge / rapidRate + (move.dwell ?? 0);
                at = at === undefined ? move.at : [move.at[0], move.at[1], at[2]];
                break;
            }
            case "dwell":
                seconds += Math.max(0, move.seconds);
                break;
            case "cutterOn":
                seconds += move.pierceDelay ?? machine.cutting?.pierceDelay ?? 0;
                break;
            default:
                break;
        }
    }
    return { cutting, rapid, seconds, moves: path.moves.length };
}

/** `1:05:09`, `4:31`, `12 s`. */
export function formatDuration(seconds: number): string {
    const total = Math.round(seconds);
    if (total < 60) return `${total} s`;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** `1234 mm`, `12.35 m`. */
export function formatLength(mm: number): string {
    return mm < 10000 ? `${Math.round(mm)} mm` : `${(mm / 1000).toFixed(2)} m`;
}
