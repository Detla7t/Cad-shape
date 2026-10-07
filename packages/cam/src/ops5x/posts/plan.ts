// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { CamProgram } from "../../model/post";
import type { ToolData } from "../../model/tool";
import type { ToolpathData, ToolpathMove, Vec3 } from "../../model/toolpath";
import { FiveAxisKinematics, type JointAngles } from "../kinematics";
import { type LinearizeOptions, linearizeSegment, type MotionPoint, rotaryDelta } from "../linearize";
import { expandDrill, straightMoves } from "../moves";
import { addScaled, angleBetween, distance, frameFromZ, type Mat3, normalize, wrap180, Z_AXIS } from "../vec";

/**
 * What every 5-axis post does before writing a word: classify each toolpath (3-axis, 3+2
 * indexed, simultaneous), position or solve the rotaries through the machine's kinematics
 * continuously across the program, linearize simultaneous moves and insert rewinds where a
 * rotary limit forces another solution.
 */

export type ToolpathMode = "3axis" | "indexed" | "simultaneous";

export type PostBlock =
    | {
          readonly kind: "rapid" | "linear";
          readonly point: MotionPoint;
          readonly feed?: number;
          /** Tip travel of the block, mm. */
          readonly distance: number;
          /** Largest rotary motion of the block, degrees. */
          readonly rotary: number;
      }
    | { readonly kind: "dwell"; readonly seconds: number }
    | { readonly kind: "comment"; readonly text: string }
    | { readonly kind: "raw"; readonly code: string };

export interface PlannedToolpath {
    readonly path: ToolpathData;
    readonly tool: ToolData;
    /** A different tool than the toolpath before (or the first). */
    readonly toolChange: boolean;
    readonly mode: ToolpathMode;
    /** Rotary positions the toolpath starts at (all modes, when the machine has rotaries). */
    readonly angles?: number[];
    /** Indexed: the tilted work plane in WCS (columns; z = tool axis), from the machine's rotation. */
    readonly frame?: Mat3;
    /** 3-axis: the moves with drill cycles expanded (arcs kept); otherwise straight moves. */
    readonly moves: readonly ToolpathMove[];
    /** Indexed and simultaneous: every move solved through the kinematics. */
    readonly blocks: readonly PostBlock[];
    /** Gauge length used for head kinematics. */
    readonly toolLength: number;
}

export interface PlanOptions extends LinearizeOptions {
    /** Chord tolerance for arcs that become straight moves, mm. Default 0.005. */
    readonly chordTolerance?: number;
    /** Retract along the tool axis before a rewind, mm. Default 20. */
    readonly rewindRetract?: number;
    /** WCS origin in machine coordinates (non-TCP output). */
    readonly workOffset?: Vec3;
    readonly preferredTilt?: "positive" | "negative" | "any";
    readonly singularityTolerance?: number;
    /** Treat constant-axis toolpaths as simultaneous (no tilted plane). */
    readonly indexedAsSimultaneous?: boolean;
    /** Unwind continuous rotaries at each toolpath start (default true). */
    readonly unwind?: boolean;
}

export interface ProgramPlan {
    readonly kinematics?: FiveAxisKinematics;
    readonly toolpaths: readonly PlannedToolpath[];
}

const AXIS_EPSILON = 1e-7;

function motionAxis(move: ToolpathMove): Vec3 | undefined {
    switch (move.kind) {
        case "rapid":
        case "linear":
            return normalize(move.axis ?? Z_AXIS);
        case "arc":
        case "drill":
            return Z_AXIS;
        default:
            return undefined;
    }
}

/** 3-axis when every motion points along +Z, indexed when along one other axis, else simultaneous. */
export function toolpathMode(path: ToolpathData): { mode: ToolpathMode; axis: Vec3 } {
    let first: Vec3 | undefined;
    let constant = true;
    let curved = false;
    for (const move of path.moves) {
        const axis = motionAxis(move);
        if (axis === undefined) continue;
        if (move.kind === "arc" || move.kind === "drill") curved = true;
        first ??= axis;
        if (angleBetween(first, axis) > AXIS_EPSILON) constant = false;
    }
    const axis = first ?? Z_AXIS;
    if (constant && angleBetween(axis, Z_AXIS) <= AXIS_EPSILON) return { mode: "3axis", axis: Z_AXIS };
    if (constant && !curved) return { mode: "indexed", axis };
    return { mode: "simultaneous", axis };
}

/** Spindle nose to tip: the holder's length plus the stick-out, else the overall length. */
export function toolGaugeLength(tool: ToolData): number {
    if (tool.stickout !== undefined) return tool.stickout + (tool.holder?.length ?? 0);
    return tool.overallLength ?? 0;
}

/** Rotary positions with the work and head square (every joint at a multiple of 360°, nearest `previous`). */
export function squareAngles(kinematics: FiveAxisKinematics, previous?: JointAngles): Result<number[]> {
    const angles = kinematics.joints.map((joint, index) => {
        const near = previous?.[index] ?? 0;
        const continuous = joint.min === undefined && joint.max === undefined;
        return continuous ? 360 * Math.round(near / 360) : 0;
    });
    if (!kinematics.withinLimits(angles)) {
        return Result.err(`The ${kinematics.describe()} axes cannot reach their zero positions`);
    }
    return Result.ok(angles);
}

function block(kind: "rapid" | "linear", point: MotionPoint, from: MotionPoint | undefined, feed?: number) {
    return {
        kind,
        point,
        feed,
        distance: from === undefined ? 0 : distance(from.tip, point.tip),
        rotary: from === undefined ? 0 : rotaryDelta(from.angles, point.angles),
    } as const;
}

/** Solves straight moves through the kinematics, starting from `start` angles. */
export function solveBlocks(
    kinematics: FiveAxisKinematics,
    moves: readonly ToolpathMove[],
    start: JointAngles | undefined,
    options: PlanOptions,
): Result<{ blocks: PostBlock[]; last?: MotionPoint }> {
    const blocks: PostBlock[] = [];
    const toolLength = options.toolLength ?? 0;
    let current: MotionPoint | undefined;
    for (const [index, move] of moves.entries()) {
        if (move.kind === "dwell" || move.kind === "comment" || move.kind === "raw") {
            blocks.push(move);
            continue;
        }
        if (move.kind !== "rapid" && move.kind !== "linear") {
            return Result.err(`Move ${index + 1}: a "${move.kind}" move must be straightened first`);
        }
        const axis = normalize(move.axis ?? Z_AXIS);
        const reference = current?.angles ?? start;
        const solved = kinematics.inverse(axis, reference);
        if (!solved.isOk) return Result.err(`Move ${index + 1} to ${formatPoint(move.to)}: ${solved.error}`);
        if (current !== undefined && move.kind === "linear") {
            const free = kinematics.inverse(axis, current.angles, true);
            if (free.isOk && rotaryDelta(free.value.angles, solved.value.angles) > 1e-6) {
                // A limit sends the rotaries the long way round: lift off, turn, come back.
                const rewound = kinematics.inverse(current.axis, solved.value.angles);
                if (!rewound.isOk) {
                    return Result.err(`Move ${index + 1}: the rotaries cannot rewind (${rewound.error})`);
                }
                const lift = options.rewindRetract ?? 20;
                const up = addScaled(current.tip, current.axis, lift);
                const upOld: MotionPoint = {
                    tip: up,
                    axis: current.axis,
                    angles: current.angles,
                    machine: kinematics.machinePosition(up, current.angles, toolLength),
                };
                const upNew: MotionPoint = {
                    ...upOld,
                    angles: rewound.value.angles,
                    machine: kinematics.machinePosition(up, rewound.value.angles, toolLength),
                };
                const back: MotionPoint = {
                    ...current,
                    angles: rewound.value.angles,
                    machine: kinematics.machinePosition(current.tip, rewound.value.angles, toolLength),
                };
                blocks.push({ kind: "comment", text: "rewind rotary axes" });
                blocks.push(block("rapid", upOld, current));
                blocks.push(block("rapid", upNew, upOld));
                blocks.push(block("linear", back, upNew, move.feed));
                current = back;
            }
        }
        const end: MotionPoint = {
            tip: move.to,
            axis,
            angles: solved.value.angles,
            machine: kinematics.machinePosition(move.to, solved.value.angles, toolLength),
        };
        if (move.kind === "rapid" || current === undefined) {
            blocks.push(block(move.kind, end, current, move.kind === "linear" ? move.feed : undefined));
            current = end;
            continue;
        }
        const segments = linearizeSegment(kinematics, current, end, options);
        if (!segments.isOk) return Result.err(`Move ${index + 1}: ${segments.error}`);
        for (const point of segments.value) {
            blocks.push(block("linear", point, current, move.feed));
            current = point;
        }
    }
    return Result.ok({ blocks, last: current });
}

function formatPoint(point: Vec3): string {
    return `(${point.map((value) => value.toFixed(3)).join(", ")})`;
}

function onlyDrillsExpanded(moves: readonly ToolpathMove[]): ToolpathMove[] {
    return moves.flatMap((move) => (move.kind === "drill" ? expandDrill(move) : [move]));
}

/** Classifies and solves every toolpath of a program, in order. */
export function planProgram(program: CamProgram, options: PlanOptions = {}): Result<ProgramPlan> {
    const kinematicsResult = FiveAxisKinematics.fromProfile(program.machine, {
        workOffset: options.workOffset,
        preferredTilt: options.preferredTilt,
        singularityTolerance: options.singularityTolerance,
    });
    const kinematics = kinematicsResult.isOk ? kinematicsResult.value : undefined;
    const toolpaths: PlannedToolpath[] = [];
    let previous: number[] | undefined;
    let previousTool: string | undefined;
    for (const [index, path] of program.toolpaths.entries()) {
        const name = `Toolpath ${index + 1}${path.label ? ` "${path.label}"` : ""}`;
        if (kinematics !== undefined && previous !== undefined && options.unwind !== false) {
            // Each toolpath starts off the part: unwind continuous rotaries into (-180°, 180°].
            previous = previous.map((angle, joint) => {
                const { min, max } = kinematics.joints[joint];
                return min === undefined && max === undefined ? wrap180(angle) : angle;
            });
        }
        const tool = program.tools.get(path.toolId);
        if (tool === undefined) return Result.err(`${name}: tool "${path.toolId}" is not in the program`);
        const toolLength = options.toolLength ?? toolGaugeLength(tool);
        let { mode, axis } = toolpathMode(path);
        if (mode === "indexed" && options.indexedAsSimultaneous) mode = "simultaneous";
        if (mode !== "3axis" && kinematics === undefined) {
            return Result.err(`${name} tilts the tool, but ${kinematicsResult.error}`);
        }
        const base = { path, tool, toolChange: tool.id !== previousTool, mode, toolLength };
        previousTool = tool.id;
        if (mode === "3axis") {
            let angles: number[] | undefined;
            if (kinematics !== undefined) {
                const square = squareAngles(kinematics, previous);
                if (!square.isOk) return Result.err(`${name}: ${square.error}`);
                angles = square.value;
                previous = angles;
            }
            toolpaths.push({ ...base, angles, moves: onlyDrillsExpanded(path.moves), blocks: [] });
            continue;
        }
        const kin = kinematics!;
        const straight = straightMoves(path.moves, options.chordTolerance ?? 0.005);
        if (!straight.isOk) return Result.err(`${name}: ${straight.error}`);
        let frame: Mat3 | undefined;
        if (mode === "indexed") {
            const solved = kin.inverse(axis, previous);
            if (!solved.isOk) return Result.err(`${name}: ${solved.error}`);
            previous = solved.value.angles;
            frame = frameFromZ(axis);
        }
        const solved = solveBlocks(kin, straight.value, previous, { ...options, toolLength });
        if (!solved.isOk) return Result.err(`${name}: ${solved.error}`);
        const first = solved.value.blocks.find((entry) => entry.kind === "rapid" || entry.kind === "linear");
        const angles = first !== undefined && "point" in first ? first.point.angles : previous;
        previous = solved.value.last?.angles ?? previous;
        toolpaths.push({ ...base, angles, frame, moves: straight.value, blocks: solved.value.blocks });
    }
    return Result.ok({ kinematics, toolpaths });
}
