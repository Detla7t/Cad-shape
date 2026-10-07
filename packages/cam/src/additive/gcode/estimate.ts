// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ToolpathMove, Vec3 } from "../../model/toolpath";

/**
 * Print-time estimate of a printer toolpath: every move runs a trapezoidal speed profile
 * (acceleration up to its feed, deceleration into the next move), with junction speeds
 * limited by a jerk-style rule (a direction change of θ allows `jerk / (2 sin(θ/2))`) and
 * by what acceleration can reach over the move lengths (a forward and a backward pass, as a
 * firmware planner does). Retractions take |E| / feed. Raw G-code takes no time.
 */
export interface PrintKinematics {
    /** mm/s² while extruding. */
    readonly acceleration: number;
    /** mm/s² for travels. */
    readonly travelAcceleration: number;
    /** mm/s. */
    readonly jerk: number;
    /** mm/s, used for rapid moves without a feed. */
    readonly rapidSpeed: number;
    /** mm/s caps. */
    readonly maxSpeedXY?: number;
    readonly maxSpeedZ?: number;
}

export const DEFAULT_PRINT_KINEMATICS: PrintKinematics = {
    acceleration: 1250,
    travelAcceleration: 1250,
    jerk: 8,
    rapidSpeed: 150,
};

export interface PrintTimeEstimate {
    readonly seconds: number;
    /** Seconds elapsed at the end of each move (same indexing as the moves). */
    readonly elapsed: Float64Array;
}

interface Segment {
    index: number;
    length: number;
    speed: number;
    acceleration: number;
    dir: [number, number, number];
}

export function estimatePrintTime(
    moves: readonly ToolpathMove[],
    kinematics: PrintKinematics = DEFAULT_PRINT_KINEMATICS,
): PrintTimeEstimate {
    const elapsed = new Float64Array(moves.length);
    const fixed = new Float64Array(moves.length);
    const segments: Segment[] = [];
    let at: Vec3 | undefined;
    moves.forEach((move, index) => {
        if (move.kind === "dwell") {
            fixed[index] = move.seconds;
            return;
        }
        if (
            move.kind !== "rapid" &&
            move.kind !== "linear" &&
            move.kind !== "extrude" &&
            move.kind !== "arc"
        ) {
            return;
        }
        const to = move.to;
        const from = at ?? to;
        at = to;
        const dx = to[0] - from[0];
        const dy = to[1] - from[1];
        const dz = to[2] - from[2];
        const length = Math.hypot(dx, dy, dz);
        const feed = "feed" in move && move.feed !== undefined ? move.feed / 60 : kinematics.rapidSpeed;
        if (length < 1e-9) {
            if (move.kind === "extrude" && feed > 0) fixed[index] = Math.abs(move.extrude) / feed;
            return;
        }
        let speed = feed > 0 ? feed : kinematics.rapidSpeed;
        const xy = Math.hypot(dx, dy);
        if (kinematics.maxSpeedXY && xy > 1e-9)
            speed = Math.min(speed, (kinematics.maxSpeedXY * length) / xy);
        if (kinematics.maxSpeedZ && Math.abs(dz) > 1e-9) {
            speed = Math.min(speed, (kinematics.maxSpeedZ * length) / Math.abs(dz));
        }
        const travel = move.kind === "rapid" || move.kind === "linear";
        segments.push({
            index,
            length,
            speed,
            acceleration: travel ? kinematics.travelAcceleration : kinematics.acceleration,
            dir: [dx / length, dy / length, dz / length],
        });
    });
    // Junction speeds: junction[i] is the speed between segment i-1 and i.
    const junction = new Float64Array(segments.length + 1);
    for (let i = 1; i < segments.length; i++) {
        const a = segments[i - 1];
        const b = segments[i];
        const cos = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2];
        const half = Math.sqrt(Math.max(0, (1 - cos) / 2));
        const limit = half < 1e-6 ? Number.POSITIVE_INFINITY : kinematics.jerk / (2 * half);
        junction[i] = Math.min(a.speed, b.speed, limit);
    }
    junction[0] = 0;
    junction[segments.length] = 0;
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        junction[i + 1] = Math.min(
            junction[i + 1],
            Math.sqrt(junction[i] ** 2 + 2 * s.acceleration * s.length),
        );
    }
    for (let i = segments.length - 1; i >= 0; i--) {
        const s = segments[i];
        junction[i] = Math.min(junction[i], Math.sqrt(junction[i + 1] ** 2 + 2 * s.acceleration * s.length));
    }
    const segmentTime = new Float64Array(moves.length);
    segments.forEach((s, i) => {
        segmentTime[s.index] = trapezoidTime(s.length, s.speed, junction[i], junction[i + 1], s.acceleration);
    });
    let total = 0;
    for (let i = 0; i < moves.length; i++) {
        total += segmentTime[i] + fixed[i];
        elapsed[i] = total;
    }
    return { seconds: total, elapsed };
}

function trapezoidTime(length: number, cruise: number, v0: number, v1: number, a: number): number {
    if (a <= 0) return length / cruise;
    const accelDistance = (cruise * cruise - v0 * v0) / (2 * a);
    const decelDistance = (cruise * cruise - v1 * v1) / (2 * a);
    if (accelDistance + decelDistance <= length) {
        return (cruise - v0) / a + (cruise - v1) / a + (length - accelDistance - decelDistance) / cruise;
    }
    const peak = Math.sqrt(Math.max(0, (2 * a * length + v0 * v0 + v1 * v1) / 2));
    return Math.max(0, (peak - v0) / a) + Math.max(0, (peak - v1) / a);
}

/** "1h 2m 3s" / "2m 3s" / "45s", PrusaSlicer's style. */
export function formatPrintDuration(seconds: number): string {
    const total = Math.round(seconds);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}
