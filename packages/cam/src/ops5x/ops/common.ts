// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { simultaneousAxes } from "../../model/machine";
import type { CamOperationContext, CamParameterSpec } from "../../model/operation";
import type { CamOperationData } from "../../model/setup";
import type { ToolData } from "../../model/tool";
import type { ToolpathData, ToolpathMove, Vec3 } from "../../model/toolpath";
import { avoidCollision, type ToolAssembly, TriangleGrid, toolAssembly } from "../collision";
import { FiveAxisKinematics, type JointAngles } from "../kinematics";
import { limitAxisSteps } from "../linearize";
import { tipFromContact } from "../toolContact";
import { addScaled, distance } from "../vec";

/** Parameter reading, the parameters every 5-axis strategy shares, linking and checks. */

export function num(params: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
    const value = params[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function bool(params: Readonly<Record<string, unknown>>, key: string, fallback: boolean): boolean {
    const value = params[key];
    return typeof value === "boolean" ? value : fallback;
}

export function str<T extends string>(
    params: Readonly<Record<string, unknown>>,
    key: string,
    fallback: T,
): T {
    const value = params[key];
    return typeof value === "string" && value.length > 0 ? (value as T) : fallback;
}

/** A cutting position: tool tip and tool axis (tip → spindle), WCS. */
export interface CutPoint {
    readonly tip: Vec3;
    readonly axis: Vec3;
}

export type Pass = readonly CutPoint[];

export interface CommonParams {
    readonly feed: number;
    readonly plungeFeed: number;
    /** Lift along the tool axis off and onto the surface, mm. */
    readonly retract: number;
    /** WCS Z the tool rises to between distant passes. */
    readonly clearanceZ: number;
    /** Passes whose retract points are closer than this link directly, mm. */
    readonly shortLink: number;
    readonly stockToLeave: number;
    readonly tolerance: number;
    readonly maxStep: number;
    readonly maxAngleStep: number;
    readonly checkCollisions: boolean;
    readonly maxTiltAway: number;
    readonly collisionClearance: number;
}

export const COMMON_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "feed", label: "Feed (mm/min)", kind: "number", min: 0 },
    { key: "plungeFeed", label: "Plunge feed (mm/min)", kind: "number", min: 0 },
    { key: "stockToLeave", label: "Stock to leave", kind: "length" },
    { key: "tolerance", label: "Tolerance", kind: "length", min: 0 },
    { key: "maxStep", label: "Maximum step", kind: "length", min: 0 },
    { key: "maxAngleStep", label: "Maximum axis change per move", kind: "angle", min: 0 },
    { key: "retract", label: "Retract along the tool axis", kind: "length", min: 0 },
    { key: "clearanceHeight", label: "Clearance above the stock", kind: "length", min: 0 },
    { key: "shortLink", label: "Link passes directly within", kind: "length", min: 0 },
    { key: "checkCollisions", label: "Check shank and holder", kind: "boolean" },
    {
        key: "maxTiltAway",
        label: "Tilt away up to",
        kind: "angle",
        min: 0,
        max: 90,
        visibleWhen: { key: "checkCollisions", values: [true] },
    },
    {
        key: "collisionClearance",
        label: "Collision clearance",
        kind: "length",
        min: 0,
        visibleWhen: { key: "checkCollisions", values: [true] },
    },
];

export function commonDefaults(tool?: ToolData): Record<string, unknown> {
    const feed = tool?.cutting.feed ?? 1000;
    return {
        feed,
        plungeFeed: tool?.cutting.plungeFeed ?? Math.round(feed / 3),
        stockToLeave: 0,
        tolerance: 0.01,
        maxStep: 1,
        maxAngleStep: 2,
        retract: 5,
        clearanceHeight: 10,
        shortLink: 10,
        checkCollisions: true,
        maxTiltAway: 20,
        collisionClearance: 0.5,
    };
}

export function readCommon(operation: CamOperationData, context: CamOperationContext): CommonParams {
    const params = operation.params;
    const feed = num(params, "feed", context.tool.cutting.feed);
    return {
        feed,
        plungeFeed: num(params, "plungeFeed", context.tool.cutting.plungeFeed ?? feed / 3),
        retract: num(params, "retract", 5),
        clearanceZ: context.stock.max[2] + num(params, "clearanceHeight", 10),
        shortLink: num(params, "shortLink", 10),
        stockToLeave: num(params, "stockToLeave", 0),
        tolerance: Math.max(1e-4, num(params, "tolerance", 0.01)),
        maxStep: Math.max(1e-3, num(params, "maxStep", 1)),
        maxAngleStep: num(params, "maxAngleStep", 2),
        checkCollisions: bool(params, "checkCollisions", true),
        maxTiltAway: num(params, "maxTiltAway", 20),
        collisionClearance: num(params, "collisionClearance", 0.5),
    };
}

/**
 * Multi-axis strategies need a machine that interpolates at least four axes; the machine's
 * kinematics (when the profile describes them) check that every tool axis is reachable.
 */
export function fiveAxisMachine(context: CamOperationContext): Result<FiveAxisKinematics | undefined> {
    if (simultaneousAxes(context.machine) < 4) {
        return Result.err(
            `"${context.machine.name}" has ${simultaneousAxes(context.machine)} axes; this needs 4 or 5`,
        );
    }
    const kinematics = FiveAxisKinematics.fromProfile(context.machine);
    return Result.ok(kinematics.isOk ? kinematics.value : undefined);
}

/** Rapid/feed moves through passes: in along the axis, across short links, up over long ones. */
export function linkPasses(passes: readonly Pass[], params: CommonParams): ToolpathMove[] {
    const moves: ToolpathMove[] = [];
    let last: CutPoint | undefined;
    for (const pass of passes) {
        if (pass.length === 0) continue;
        const first = pass[0];
        const approach = addScaled(first.tip, first.axis, params.retract);
        if (last === undefined) {
            moves.push({
                kind: "rapid",
                to: [approach[0], approach[1], Math.max(params.clearanceZ, approach[2])],
                axis: first.axis,
            });
            moves.push({ kind: "rapid", to: approach, axis: first.axis });
        } else {
            const up = addScaled(last.tip, last.axis, params.retract);
            moves.push({ kind: "linear", to: up, feed: params.plungeFeed, axis: last.axis });
            if (distance(up, approach) > params.shortLink) {
                const z = Math.max(params.clearanceZ, up[2], approach[2]);
                moves.push({ kind: "rapid", to: [up[0], up[1], z], axis: last.axis });
                moves.push({ kind: "rapid", to: [approach[0], approach[1], z], axis: first.axis });
            }
            moves.push({ kind: "rapid", to: approach, axis: first.axis });
        }
        moves.push({ kind: "linear", to: first.tip, feed: params.plungeFeed, axis: first.axis });
        for (const point of pass.slice(1)) {
            moves.push({ kind: "linear", to: point.tip, feed: params.feed, axis: point.axis });
        }
        last = pass[pass.length - 1];
    }
    if (last !== undefined) {
        const up = addScaled(last.tip, last.axis, params.retract);
        moves.push({ kind: "linear", to: up, feed: params.plungeFeed, axis: last.axis });
        moves.push({
            kind: "rapid",
            to: [up[0], up[1], Math.max(params.clearanceZ, up[2])],
            axis: last.axis,
        });
    }
    return moves;
}

/** Fails at the first move whose tool axis the machine cannot reach (limits, out of reach). */
export function checkReach(kinematics: FiveAxisKinematics, moves: readonly ToolpathMove[]): Result<true> {
    let previous: JointAngles | undefined;
    for (const move of moves) {
        if (move.kind !== "rapid" && move.kind !== "linear") continue;
        const solved = kinematics.inverse(move.axis ?? [0, 0, 1], previous);
        if (!solved.isOk) {
            const at = move.to.map((value) => value.toFixed(3)).join(", ");
            return Result.err(`At (${at}): ${solved.error}`);
        }
        previous = solved.value.angles;
    }
    return Result.ok(true);
}

/** The toolpath of linked moves: axis steps limited, reach checked. */
export function finishToolpath(
    operation: CamOperationData,
    context: CamOperationContext,
    moves: readonly ToolpathMove[],
    params: CommonParams,
    kinematics: FiveAxisKinematics | undefined,
): Result<ToolpathData> {
    if (moves.length === 0) return Result.err(`${operation.name}: no toolpath (nothing to machine)`);
    const limited = params.maxAngleStep > 0 ? limitAxisSteps(moves, params.maxAngleStep) : [...moves];
    if (kinematics !== undefined) {
        const reach = checkReach(kinematics, limited);
        if (!reach.isOk) return Result.err(`${operation.name}: ${reach.error}`);
    }
    return Result.ok({
        toolId: context.tool.id,
        spindleRpm: context.tool.cutting.spindleRpm,
        coolant: context.tool.cutting.coolant,
        moves: limited,
        label: operation.name,
    });
}

/** Contact points → tool positions, with the shank/holder check and tilt-away. */
export class ContactPlacer {
    private grid?: TriangleGrid;
    private readonly assembly: ToolAssembly;

    constructor(
        private readonly context: CamOperationContext,
        private readonly params: CommonParams,
    ) {
        this.assembly = toolAssembly(context.tool);
    }

    place(contact: Vec3, normal: Vec3, axis: Vec3, feedDirection: Vec3): Result<CutPoint> {
        const tool = this.context.tool;
        const leave = this.params.stockToLeave;
        if (!this.params.checkCollisions) {
            return Result.ok({ tip: tipFromContact(tool, contact, normal, axis, leave), axis });
        }
        this.grid ??= new TriangleGrid(this.context.partMesh());
        const placed = avoidCollision(
            this.grid,
            this.assembly,
            axis,
            (candidate) => tipFromContact(tool, contact, normal, candidate, leave),
            {
                maxTilt: this.params.maxTiltAway,
                lead: feedDirection,
                clearance: this.params.collisionClearance,
            },
        );
        if (!placed.isOk) return Result.err(placed.error);
        return Result.ok({ tip: placed.value.tip, axis: placed.value.axis });
    }

    /** Collision check only (no tilting) for positions that must keep their axis. */
    check(point: CutPoint): Result<CutPoint> {
        if (!this.params.checkCollisions) return Result.ok(point);
        this.grid ??= new TriangleGrid(this.context.partMesh());
        const checked = avoidCollision(this.grid, this.assembly, point.axis, () => point.tip, {
            maxTilt: 0,
            clearance: this.params.collisionClearance,
        });
        return checked.isOk ? Result.ok(point) : Result.err(checked.error);
    }
}
