// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { KinematicsData, MachineProfileData, RotaryAxisName } from "../model/machine";
import type { Vec3 } from "../model/toolpath";
import {
    addScaled,
    cross,
    DEG,
    dot,
    IDENTITY3,
    length,
    type Mat3,
    mulMM,
    mulMV,
    normalize,
    reject,
    rotation,
    sub,
    transpose,
    wrap180,
    Z_AXIS,
} from "./vec";

/**
 * Forward and inverse kinematics of 4- and 5-axis mills (table-table trunnions, head-head
 * forks, head-table machines) from a profile's rotary axes and `KinematicsData`.
 *
 * Conventions: the machine frame has the linear axes' directions; with every rotary at zero
 * the WCS axes are parallel to it and the tool points along +Z (tip → spindle). A positive
 * angle turns the axis' carrier (table or head) right-handedly about `direction`; flip a
 * direction in the profile for a machine whose sign convention is the other way. Chains are
 * listed from the machine base outwards, so a trunnion with a C table is ["A", "C"] and a
 * fork head on a C swivel is ["C", "A"]; the carrier's rotation is R(first)·R(second).
 *
 * Table axes pass through `tableCenter` (machine coordinates); head axes through the pivot,
 * `pivotLength` + the tool's gauge length above the tool tip.
 */

export interface RotaryJoint {
    readonly name: RotaryAxisName;
    /** Unit direction at the zero position of the axes below it. */
    readonly direction: Vec3;
    readonly carrier: "table" | "head";
    /** Degrees; both undefined for a continuous axis. */
    readonly min?: number;
    readonly max?: number;
}

/** Joint angles in degrees, in chain order (`FiveAxisKinematics.joints`). */
export type JointAngles = readonly number[];

export interface KinematicsOptions {
    /** Machine position of the WCS origin with the rotaries at zero (the work offset). Default: the table centre. */
    readonly workOffset?: Vec3;
    /** Degrees: inside this cone around a pole (tool axis ∥ a rotary axis) that axis holds its angle. */
    readonly singularityTolerance?: number;
    /** The solution a point without a previous one takes when both are equally far from zero. */
    readonly preferredTilt?: "positive" | "negative" | "any";
}

export interface IkSolution {
    /** Degrees, chain order. */
    readonly angles: number[];
    /** The tool axis was at a pole: `freeJoint` held its previous angle. */
    readonly singular: boolean;
    readonly freeJoint?: number;
}

const DEFAULT_SINGULARITY_TOLERANCE = 0.01;
const LIMIT_EPSILON = 1e-6;

/** One rotation about a joint, then the next: the carrier's orientation relative to the machine. */
function chainRotation(
    joints: readonly RotaryJoint[],
    angles: JointAngles,
    indices: readonly number[],
): Mat3 {
    let r: Mat3 = IDENTITY3;
    for (const index of indices) r = mulMM(r, rotation(joints[index].direction, angles[index]));
    return r;
}

/** Paden–Kahan subproblem 1: the angle (deg) turning `p` into `q` about the unit `w`. */
function rotationAngle(w: Vec3, p: Vec3, q: Vec3): number {
    const pp = reject(p, w);
    const qp = reject(q, w);
    return Math.atan2(dot(w, cross(pp, qp)), dot(pp, qp)) / DEG;
}

interface TwoAxisProblem {
    /** R(w1, α)·p = R(w2, β)·q, joint j1 = s1·α, joint j2 = s2·β. */
    readonly w1: Vec3;
    readonly w2: Vec3;
    readonly j1: number;
    readonly j2: number;
    readonly s1: 1 | -1;
    readonly s2: 1 | -1;
    /** Whether p (else q) is the tool axis. */
    readonly pIsAxis: boolean;
}

export class FiveAxisKinematics {
    readonly type: KinematicsData["type"];
    /** Chain order: base outwards. */
    readonly joints: readonly RotaryJoint[];
    readonly toolCenterPointControl: boolean;
    readonly tableCenter: Vec3;
    readonly pivotLength: number;
    readonly workOffset: Vec3;
    readonly singularityTolerance: number;
    readonly preferredTilt: "positive" | "negative" | "any";
    private readonly tableJoints: number[];
    private readonly headJoints: number[];
    private readonly problem?: TwoAxisProblem;
    /** The joint that tilts the tool off vertical (the other one spins about it). */
    readonly tiltJoint: number;

    private constructor(
        type: KinematicsData["type"],
        joints: readonly RotaryJoint[],
        data: KinematicsData | undefined,
        options: KinematicsOptions | undefined,
    ) {
        this.type = type;
        this.joints = joints;
        this.toolCenterPointControl = data?.toolCenterPointControl ?? false;
        this.tableCenter = (data?.tableCenter as Vec3 | undefined) ?? [0, 0, 0];
        this.pivotLength = data?.pivotLength ?? 0;
        this.workOffset = options?.workOffset ?? this.tableCenter;
        this.singularityTolerance = options?.singularityTolerance ?? DEFAULT_SINGULARITY_TOLERANCE;
        this.preferredTilt = options?.preferredTilt ?? "any";
        this.tableJoints = joints.flatMap((joint, index) => (joint.carrier === "table" ? [index] : []));
        this.headJoints = joints.flatMap((joint, index) => (joint.carrier === "head" ? [index] : []));
        this.tiltJoint = joints.reduce(
            (best, joint, index) =>
                Math.abs(joint.direction[2]) < Math.abs(joints[best].direction[2]) ? index : best,
            0,
        );
        if (joints.length === 2) this.problem = this.twoAxisProblem();
    }

    /**
     * Kinematics of a profile with one or two rotary axes. A profile without `kinematics`
     * infers the type from the axes' carriers, the chain from their order.
     */
    static fromProfile(profile: MachineProfileData, options?: KinematicsOptions): Result<FiveAxisKinematics> {
        const axes = profile.rotaryAxes ?? [];
        if (axes.length === 0) return Result.err(`Machine "${profile.name}" has no rotary axes`);
        const data = profile.kinematics;
        const chain = data?.chain ?? axes.map((axis) => axis.name);
        const joints: RotaryJoint[] = [];
        for (const name of chain) {
            const axis = axes.find((candidate) => candidate.name === name);
            if (axis === undefined) {
                return Result.err(
                    `Machine "${profile.name}": kinematic chain axis ${name} is not a rotary axis`,
                );
            }
            const direction = normalize(axis.direction as Vec3, [0, 0, 0]);
            if (length(direction) === 0)
                return Result.err(`Machine "${profile.name}": axis ${name} has no direction`);
            joints.push({ name, direction, carrier: axis.carrier, min: axis.min, max: axis.max });
        }
        if (joints.length > 2) {
            return Result.err(`Machine "${profile.name}": only one or two rotary axes are supported`);
        }
        const tables = joints.filter((joint) => joint.carrier === "table").length;
        const inferred: KinematicsData["type"] =
            tables === joints.length ? "table-table" : tables === 0 ? "head-head" : "head-table";
        const type = data?.type ?? inferred;
        if (joints.length === 2 && type !== inferred) {
            return Result.err(
                `Machine "${profile.name}": a ${type} machine cannot carry ${joints.map((j) => `${j.name} on the ${j.carrier}`).join(" and ")}`,
            );
        }
        if (joints.length === 2 && length(cross(joints[0].direction, joints[1].direction)) < 1e-6) {
            return Result.err(`Machine "${profile.name}": the two rotary axes are parallel`);
        }
        return Result.ok(new FiveAxisKinematics(type, joints, data, options));
    }

    /** Same machine, other options (a post's work offset, a different preferred solution). */
    with(options: KinematicsOptions): FiveAxisKinematics {
        const data: KinematicsData = {
            type: this.type,
            chain: this.joints.map((joint) => joint.name),
            pivotLength: this.pivotLength,
            tableCenter: this.tableCenter,
            toolCenterPointControl: this.toolCenterPointControl,
        };
        return new FiveAxisKinematics(this.type, this.joints, data, {
            workOffset: options.workOffset ?? this.workOffset,
            singularityTolerance: options.singularityTolerance ?? this.singularityTolerance,
            preferredTilt: options.preferredTilt ?? this.preferredTilt,
        });
    }

    private twoAxisProblem(): TwoAxisProblem {
        const [base, outer] = [0, 1];
        const d = this.joints.map((joint) => joint.direction);
        if (this.type === "table-table") {
            // R(base)·R(outer)·a = z  ⇒  R(outer, θo)·a = R(base, −θb)·z
            return { w1: d[outer], w2: d[base], j1: outer, j2: base, s1: 1, s2: -1, pIsAxis: true };
        }
        if (this.type === "head-head") {
            // a = R(base)·R(outer)·z  ⇒  R(outer, θo)·z = R(base, −θb)·a
            return { w1: d[outer], w2: d[base], j1: outer, j2: base, s1: 1, s2: -1, pIsAxis: false };
        }
        // R(table)·a = R(head)·z
        const table = this.tableJoints[0];
        const head = this.headJoints[0];
        return { w1: d[table], w2: d[head], j1: table, j2: head, s1: 1, s2: 1, pIsAxis: true };
    }

    /** The table's orientation relative to the machine (identity for head-head). */
    tableRotation(angles: JointAngles): Mat3 {
        return chainRotation(this.joints, angles, this.tableJoints);
    }

    /** The head's orientation relative to the machine (identity for table-table). */
    headRotation(angles: JointAngles): Mat3 {
        return chainRotation(this.joints, angles, this.headJoints);
    }

    /** Forward kinematics: the tool axis in WCS at these joint angles. */
    toolAxis(angles: JointAngles): Vec3 {
        const headAxis = mulMV(this.headRotation(angles), Z_AXIS);
        return normalize(mulMV(transpose(this.tableRotation(angles)), headAxis));
    }

    /**
     * The tilted frame of these angles in WCS (columns x, y, z; z = tool axis): the work
     * plane a 3+2 post programs in (machine axes as seen from the rotated work).
     */
    toolFrame(angles: JointAngles): Mat3 {
        return mulMM(transpose(this.tableRotation(angles)), this.headRotation(angles));
    }

    /** Table centre relative to the work offset. */
    private get centerOffset(): Vec3 {
        return sub(this.tableCenter, this.workOffset);
    }

    /** Head pivot distance above the tip for a tool of this gauge length. */
    pivotDistance(toolLength = 0): number {
        return this.pivotLength + toolLength;
    }

    /**
     * Machine coordinates (relative to the work offset, machine axis directions) of the
     * controlled point for a WCS tip position at these angles — what a controller without
     * tool centre point control is programmed with. `toolLength` is the gauge length.
     */
    machinePosition(tip: Vec3, angles: JointAngles, toolLength = 0): Vec3 {
        const c = this.centerOffset;
        const onTable = addScaled(c, mulMV(this.tableRotation(angles), sub(tip, c)), 1);
        const headAxis = mulMV(this.headRotation(angles), Z_AXIS);
        return addScaled(onTable, sub(headAxis, Z_AXIS), this.pivotDistance(toolLength));
    }

    /** Inverse of `machinePosition`: the WCS tip a controlled point and angles put the tool at. */
    tipPosition(machine: Vec3, angles: JointAngles, toolLength = 0): Vec3 {
        const c = this.centerOffset;
        const headAxis = mulMV(this.headRotation(angles), Z_AXIS);
        const tool = addScaled(machine, sub(headAxis, Z_AXIS), -this.pivotDistance(toolLength));
        return addScaled(c, mulMV(transpose(this.tableRotation(angles)), sub(tool, c)), 1);
    }

    /**
     * Every joint solution for a WCS tool axis, angles wrapped into (-180, 180]; `hold`
     * gives the angles a free joint keeps at a pole (default 0). Empty when unreachable.
     */
    solutions(axis: Vec3, hold?: JointAngles): IkSolution[] {
        const a = normalize(axis);
        const sinTolerance = Math.sin(this.singularityTolerance * DEG);
        if (this.joints.length === 1) {
            const joint = this.joints[0];
            const w = joint.direction;
            const [p, q] = joint.carrier === "table" ? [a, Z_AXIS] : [Z_AXIS, a];
            if (Math.abs(dot(w, p) - dot(w, q)) > sinTolerance) return [];
            if (length(reject(p, w)) < sinTolerance) {
                return [{ angles: [hold?.[0] ?? 0], singular: true, freeJoint: 0 }];
            }
            return [{ angles: [wrap180(rotationAngle(w, p, q))], singular: false }];
        }
        const problem = this.problem!;
        const { w1, w2, j1, j2, s1, s2 } = problem;
        const [p, q] = problem.pIsAxis ? [a, Z_AXIS] : [Z_AXIS, a];
        const make = (alpha: number, beta: number, singular: boolean, freeJoint?: number): IkSolution => {
            const angles = [0, 0];
            angles[j1] = s1 * alpha;
            angles[j2] = s2 * beta;
            return {
                angles: angles.map((angle, index) => (index === freeJoint ? angle : wrap180(angle))),
                singular,
                freeJoint,
            };
        };
        if (length(reject(p, w1)) < sinTolerance) {
            // p ∥ w1: joint j1 spins in place; hold it and solve the other.
            const alpha = (hold?.[j1] ?? 0) * s1;
            const target = mulMV(rotation(w1, alpha), p);
            return [make(alpha, rotationAngle(w2, q, target), true, j1)];
        }
        if (length(reject(q, w2)) < sinTolerance) {
            const beta = (hold?.[j2] ?? 0) * s2;
            const target = mulMV(rotation(w2, beta), q);
            return [make(rotationAngle(w1, p, target), beta, true, j2)];
        }
        // Paden–Kahan subproblem 2: c = x·w1 + y·w2 ± z·(w1 × w2) with w1·c = w1·p, w2·c = w2·q.
        const g = dot(w1, w2);
        const den = 1 - g * g;
        const x = (dot(w1, p) - g * dot(w2, q)) / den;
        const y = (dot(w2, q) - g * dot(w1, p)) / den;
        const w = cross(w1, w2);
        const z2 = (1 - x * x - y * y - 2 * x * y * g) / dot(w, w);
        if (z2 < -1e-9) return [];
        const z = Math.sqrt(Math.max(0, z2));
        const signs = z < 1e-12 ? [1] : [1, -1];
        return signs.map((sign) => {
            const c = addScaled(addScaled(addScaled([0, 0, 0], w1, x), w2, y), w, sign * z);
            return make(rotationAngle(w1, p, c), rotationAngle(w2, q, c), false);
        });
    }

    /** The joint that spins freely with the tool on this axis (a pole), if any. */
    freeJoint(axis: Vec3): number | undefined {
        const [solution] = this.solutions(axis);
        return solution?.singular ? solution.freeJoint : undefined;
    }

    /** Whether every angle is inside its joint's limits. */
    withinLimits(angles: JointAngles): boolean {
        return this.joints.every((_, index) => this.jointWithin(index, angles[index]));
    }

    private jointWithin(index: number, angle: number): boolean {
        const joint = this.joints[index];
        return (
            (joint.min === undefined || angle >= joint.min - LIMIT_EPSILON) &&
            (joint.max === undefined || angle <= joint.max + LIMIT_EPSILON)
        );
    }

    /** The equivalents (± k·360°) of a joint angle the joint can reach, nearest `near` first. */
    private equivalents(index: number, angle: number, near: number, ignoreLimits = false): number[] {
        const joint = this.joints[index];
        if (ignoreLimits || (joint.min === undefined && joint.max === undefined)) {
            return [angle + 360 * Math.round((near - angle) / 360)];
        }
        const out: number[] = [];
        for (let k = -3; k <= 3; k++) {
            const candidate = angle + 360 * k;
            if (this.jointWithin(index, candidate)) out.push(candidate);
        }
        return out.sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
    }

    /**
     * Inverse kinematics with joint choice: the solution inside the limits closest to
     * `previous` (continuity, shortest rotary motion — continuous axes take the 360°
     * equivalent nearest the previous angle), else closest to zero; ties go to `preferredTilt`
     * (by default the tilt direction with more travel).
     * At a pole the free axis holds its previous angle. Errors name the axis and limits.
     * `ignoreLimits` answers where an unlimited machine would go (to detect a rewind).
     */
    inverse(axis: Vec3, previous?: JointAngles, ignoreLimits = false): Result<IkSolution> {
        const raw = this.solutions(axis, previous);
        if (raw.length === 0) {
            return Result.err(`Tool axis ${formatAxis(axis)} is out of reach of the ${this.describe()} axes`);
        }
        const reference = previous ?? this.joints.map(() => 0);
        const preferred = this.preferredTilt === "any" ? this.roomierTilt() : this.preferredTilt;
        let best: { solution: IkSolution; cost: number } | undefined;
        let violation: string | undefined;
        for (const solution of raw) {
            const angles: number[] = [];
            let failed = false;
            for (let index = 0; index < this.joints.length; index++) {
                const options = this.equivalents(
                    index,
                    solution.angles[index],
                    reference[index],
                    ignoreLimits,
                );
                if (options.length === 0) {
                    const joint = this.joints[index];
                    violation ??= `Tool axis ${formatAxis(axis)} needs ${joint.name} = ${solution.angles[index].toFixed(3)}° (limits ${joint.min ?? "-∞"}…${joint.max ?? "∞"}°)`;
                    failed = true;
                    break;
                }
                angles.push(options[0]);
            }
            if (failed) continue;
            let cost = angles.reduce((sum, angle, index) => sum + Math.abs(angle - reference[index]), 0);
            if (preferred !== "any") {
                const tilt = angles[this.tiltJoint];
                const wrongSign = preferred === "positive" ? tilt < -1e-9 : tilt > 1e-9;
                if (wrongSign) cost += 1e-6;
            }
            if (best === undefined || cost < best.cost - 1e-9) {
                best = { solution: { ...solution, angles }, cost };
            }
        }
        if (best === undefined)
            return Result.err(violation ?? `Tool axis ${formatAxis(axis)} is out of reach`);
        return Result.ok(best.solution);
    }

    /** The tilt direction with more travel (a trunnion's −120…30° prefers negative tilts). */
    private roomierTilt(): "positive" | "negative" | "any" {
        const joint = this.joints[this.tiltJoint];
        const negative = joint.min === undefined ? Number.POSITIVE_INFINITY : -joint.min;
        const positive = joint.max === undefined ? Number.POSITIVE_INFINITY : joint.max;
        if (negative === positive) return "any";
        return negative > positive ? "negative" : "positive";
    }

    /** "A/C table-table" */
    describe(): string {
        return `${this.joints.map((joint) => joint.name).join("/")} ${this.type}`;
    }
}

export function formatAxis(axis: Vec3): string {
    return `(${axis.map((value) => value.toFixed(4)).join(", ")})`;
}
