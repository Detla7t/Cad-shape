// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { ToolpathMove, Vec3 } from "../model/toolpath";
import type { FiveAxisKinematics, JointAngles } from "./kinematics";
import { angleBetween, distanceToSegment, lerp, slerp, Z_AXIS } from "./vec";

/**
 * Linearization of 5-axis moves.
 *
 * A controller interpolates the joints of a block linearly. With tool centre point control
 * the tip still runs along the programmed line, but the tool axis follows the joint
 * interpolation; without it the controlled point and the rotaries both move linearly in
 * machine space, so the tip in the work bows away from the line (a table rotation swings
 * the work under the tool). `linearizeSegment` splits a move until the actual tip stays
 * within a tolerance of the line, the actual axis within an angle of the programmed (great
 * circle) axis, and no rotary moves more than a step per block.
 */

/** A point of the machine's motion: the programmed WCS tip and axis, and the joints reaching it. */
export interface MotionPoint {
    readonly tip: Vec3;
    readonly axis: Vec3;
    /** Degrees, chain order. */
    readonly angles: number[];
    /** The controlled point in machine coordinates (equal to the tip's machine position). */
    readonly machine: Vec3;
}

export interface LinearizeOptions {
    /** Largest distance (mm) of the actual tip from the programmed line (non-TCP). Default 0.01. */
    readonly tolerance?: number;
    /** Largest rotary motion per block, degrees. Default: unlimited. */
    readonly maxAngleStep?: number;
    /** Largest deviation of the interpolated tool axis from the programmed one, degrees. Default: unchecked. */
    readonly axisTolerance?: number;
    /** The controller keeps the tip on the line itself (TCP): only angles are checked. */
    readonly tcp?: boolean;
    /** Tool gauge length for head kinematics, mm. */
    readonly toolLength?: number;
    /** Recursion limit (2^depth sub-blocks at most). Default 12. */
    readonly maxDepth?: number;
}

/** Solves the joints for a WCS tip and axis, continuous with `previous`. */
export function motionPoint(
    kinematics: FiveAxisKinematics,
    tip: Vec3,
    axis: Vec3,
    previous: JointAngles | undefined,
    toolLength = 0,
): Result<MotionPoint> {
    const solved = kinematics.inverse(axis, previous);
    if (!solved.isOk) return Result.err(solved.error);
    const angles = solved.value.angles;
    return Result.ok({ tip, axis, angles, machine: kinematics.machinePosition(tip, angles, toolLength) });
}

function lerpAngles(a: JointAngles, b: JointAngles, t: number): number[] {
    return a.map((angle, index) => angle + (b[index] - angle) * t);
}

/** Largest joint change between two points, degrees. */
export function rotaryDelta(a: JointAngles, b: JointAngles): number {
    return a.reduce((max, angle, index) => Math.max(max, Math.abs(b[index] - angle)), 0);
}

/** Where the tool actually is at fraction `t` of a block from `p0` to `p1` (joint-interpolated). */
export function interpolatedTip(
    kinematics: FiveAxisKinematics,
    p0: MotionPoint,
    p1: MotionPoint,
    t: number,
    options: LinearizeOptions = {},
): { tip: Vec3; axis: Vec3 } {
    const angles = lerpAngles(p0.angles, p1.angles, t);
    const tip = options.tcp
        ? lerp(p0.tip, p1.tip, t)
        : kinematics.tipPosition(lerp(p0.machine, p1.machine, t), angles, options.toolLength ?? 0);
    return { tip, axis: kinematics.toolAxis(angles) };
}

const PROBES = [0.25, 0.5, 0.75];

function needsSplit(
    kinematics: FiveAxisKinematics,
    p0: MotionPoint,
    p1: MotionPoint,
    options: LinearizeOptions,
): boolean {
    if (options.maxAngleStep !== undefined && rotaryDelta(p0.angles, p1.angles) > options.maxAngleStep) {
        return true;
    }
    const tolerance = options.tolerance ?? 0.01;
    for (const t of PROBES) {
        const actual = interpolatedTip(kinematics, p0, p1, t, options);
        if (!options.tcp && distanceToSegment(actual.tip, p0.tip, p1.tip) > tolerance) return true;
        if (
            options.axisTolerance !== undefined &&
            angleBetween(actual.axis, slerp(p0.axis, p1.axis, t)) > options.axisTolerance
        ) {
            return true;
        }
    }
    return false;
}

/**
 * The points after `from` that take the tool to `to` within the options' tolerances (the
 * last one is `to`). Intermediate points lie on the programmed line, their axes on the
 * great circle between the end axes, their joints solved continuously.
 */
export function linearizeSegment(
    kinematics: FiveAxisKinematics,
    from: MotionPoint,
    to: MotionPoint,
    options: LinearizeOptions = {},
): Result<MotionPoint[]> {
    const maxDepth = options.maxDepth ?? 12;
    const out: MotionPoint[] = [];
    let error: string | undefined;
    const split = (p0: MotionPoint, p1: MotionPoint, depth: number) => {
        if (error !== undefined) return;
        if (depth >= maxDepth || !needsSplit(kinematics, p0, p1, options)) {
            out.push(p1);
            return;
        }
        const tip = lerp(p0.tip, p1.tip, 0.5);
        const axis = slerp(p0.axis, p1.axis, 0.5);
        const mid = motionPoint(
            kinematics,
            tip,
            axis,
            lerpAngles(p0.angles, p1.angles, 0.5),
            options.toolLength,
        );
        if (!mid.isOk) {
            error = mid.error;
            return;
        }
        split(p0, mid.value, depth + 1);
        split(mid.value, p1, depth + 1);
    };
    // Leaving a pole towards another azimuth: turn the free axis on the pole first (the tool
    // axis does not move), so the departure needs no sudden swing.
    const free = kinematics.freeJoint(from.axis);
    if (free !== undefined && Math.abs(from.angles[free] - to.angles[free]) > 1e-9) {
        const angles = [...from.angles];
        angles[free] = to.angles[free];
        const turned: MotionPoint = {
            ...from,
            angles,
            machine: kinematics.machinePosition(from.tip, angles, options.toolLength ?? 0),
        };
        split(from, turned, 0);
        split(turned, to, 0);
    } else {
        split(from, to, 0);
    }
    return error === undefined ? Result.ok(out) : Result.err(error);
}

/**
 * Splits linear moves whose tool axis turns more than `maxAngle` degrees into equal steps
 * (tip interpolated linearly, axis along the great circle) — machine-independent, in WCS.
 */
export function limitAxisSteps(moves: readonly ToolpathMove[], maxAngle: number): ToolpathMove[] {
    const out: ToolpathMove[] = [];
    let tip: Vec3 | undefined;
    let axis: Vec3 = Z_AXIS;
    for (const move of moves) {
        if (move.kind === "linear" && tip !== undefined && maxAngle > 0) {
            const next = move.axis ?? Z_AXIS;
            const steps = Math.ceil(angleBetween(axis, next) / maxAngle - 1e-9);
            for (let i = 1; i < steps; i++) {
                const t = i / steps;
                out.push({
                    kind: "linear",
                    to: lerp(tip, move.to, t),
                    feed: move.feed,
                    axis: slerp(axis, next, t),
                });
            }
        }
        out.push(move);
        if (move.kind === "rapid" || move.kind === "linear") {
            tip = move.to;
            axis = move.axis ?? Z_AXIS;
        } else if (move.kind === "arc") {
            tip = move.to;
            axis = Z_AXIS;
        }
    }
    return out;
}
