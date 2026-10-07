// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { offset, type Point2, regions, signedArea } from "../geometry2d";
import type { DropCutter } from "../mesh/dropCutter";
import { simplify3 } from "../mesh/polyline";
import { Yielder } from "../mesh/yielder";
import {
    type CamOperationContext,
    type CamOperationHandler,
    type CamParameterSpec,
    registerCamOperation,
} from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolpathData } from "../model/toolpath";
import { FEED_PARAMETERS, feedDefaults } from "../ops2d/common";
import {
    BOUNDARY_DEFAULTS,
    BOUNDARY_PARAMETERS,
    choice,
    containmentRegion,
    cutPasses,
    defaultSampling,
    LINK_PARAMETERS,
    linkOptions,
    MoveWriter,
    num,
    optionalNum,
    orderPasses,
    type Pass,
    STOCK_PARAMETERS,
    SURFACE_HEIGHT_PARAMETERS,
    scallopStepover,
    surfacingSetup,
    surfacingToolpath,
    TOLERANCE_PARAMETER,
} from "./common";
import { clampHeights } from "./parallel";

/**
 * Scallop (constant stepover) finishing, projected: rings offset inward from the machining
 * boundary at the stepover in XY, each dropped onto the part. On shallow areas this keeps
 * the stepover — and the scallop height — constant around the boundary's shape; on slopes
 * the surface distance between rings grows by 1/cos(slope) (steep walls are for waterline).
 */
export const SCALLOP_3D = "scallop3d";

const PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "stepoverMode",
        label: "Stepover from",
        kind: "enum",
        options: [
            { value: "distance", label: "Distance" },
            { value: "scallop", label: "Scallop height" },
        ],
    },
    {
        key: "stepover",
        label: "Stepover",
        kind: "length",
        min: 0.001,
        visibleWhen: { key: "stepoverMode", values: ["distance"] },
    },
    {
        key: "scallopHeight",
        label: "Scallop height",
        kind: "length",
        min: 0.0001,
        visibleWhen: { key: "stepoverMode", values: ["scallop"] },
    },
    {
        key: "order",
        label: "Order",
        kind: "enum",
        options: [
            { value: "outsideIn", label: "Outside in" },
            { value: "insideOut", label: "Inside out" },
        ],
    },
    {
        key: "direction",
        label: "Direction (outer rings)",
        kind: "enum",
        options: [
            { value: "ccw", label: "Counter-clockwise" },
            { value: "cw", label: "Clockwise" },
        ],
    },
    { key: "sampling", label: "Largest point spacing", kind: "length", min: 0.001 },
    TOLERANCE_PARAMETER,
    ...STOCK_PARAMETERS,
    ...BOUNDARY_PARAMETERS,
    ...SURFACE_HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
    ...LINK_PARAMETERS,
];

export const scallopFinishing: CamOperationHandler = {
    type: SCALLOP_3D,
    label: "Scallop finishing",
    category: "3d",
    machineKinds: ["mill"],
    selects: ["face"],
    defaults(_machine, tool) {
        const diameter = tool?.diameter ?? 6;
        return {
            ...feedDefaults(tool),
            stepoverMode: "distance",
            stepover: tool?.cutting.stepover ?? diameter / 10,
            scallopHeight: 0.01,
            order: "outsideIn",
            direction: "ccw",
            sampling: Math.min(Math.max(diameter / 8, 0.05), 2),
            tolerance: 0.01,
            stockToLeave: 0,
            ...BOUNDARY_DEFAULTS,
            clearance: 5,
            safeDistance: 1,
            holderCheck: true,
            linking: "stayDown",
            stayDownDistance: 2 * diameter,
            leadDistance: diameter / 4,
            leadAngle: 30,
        };
    },
    parameters: () => PARAMETERS,
    generate: generateScallop,
};

registerCamOperation(scallopFinishing);

export async function generateScallop(
    operation: CamOperationData,
    context: CamOperationContext,
): Promise<Result<ToolpathData>> {
    const setupResult = surfacingSetup(operation, context, { tolerance: 0.01, stockToLeave: 0 });
    if (!setupResult.isOk) return Result.err(setupResult.error);
    const setup = setupResult.value;
    const params = operation.params;
    const { cutter, tolerance } = setup;
    const yielder = new Yielder();
    const boundary = await containmentRegion(params, context, setup, undefined, yielder);
    if (boundary.length === 0) return Result.err("The machining boundary is empty");
    const stepover =
        choice(params, "stepoverMode", ["distance", "scallop"], "distance") === "scallop"
            ? scallopStepover(cutter, num(params, "scallopHeight", 0.01))
            : num(params, "stepover", setup.tool.cutting.stepover ?? cutter.radius / 5);
    if (!(stepover > 1e-4)) return Result.err("The stepover must be positive");
    const sampling = Math.max(num(params, "sampling", defaultSampling(cutter)), 1e-3);
    const minZ = optionalNum(params, "minZ");
    const maxZ = optionalNum(params, "maxZ");
    const counterClockwise = choice(params, "direction", ["ccw", "cw"], "ccw") === "ccw";

    // Ring sets, outermost first: the boundary, then offsets inward until nothing is left.
    const rings: Pass[][] = [];
    let region: Point2[][] = boundary;
    for (let k = 0; region.length > 0 && k < 100000; k++) {
        const passes: Pass[] = [];
        for (const piece of regions(region)) {
            for (const loop of [piece.outer, ...piece.holes]) {
                if (loop.length < 3) continue;
                // Outer loops come counter-clockwise, holes clockwise: flip both for "cw".
                const ordered = counterClockwise ? loop : [...loop].reverse();
                passes.push(...dropRing(ordered, setup.drop, sampling, tolerance, minZ, maxZ));
            }
        }
        if (passes.length > 0) rings.push(passes);
        region = offset(region, -stepover, { tolerance: tolerance / 2 }).filter(
            (loop) => Math.abs(signedArea(loop)) > tolerance * tolerance,
        );
        await yielder.tick();
    }
    if (rings.length === 0) return Result.err("No rings: the boundary or height range leaves nothing to cut");
    if (choice(params, "order", ["outsideIn", "insideOut"], "outsideIn") === "insideOut") rings.reverse();

    const ordered: Pass[] = [];
    for (const passes of rings) {
        const last = ordered[ordered.length - 1];
        const at = last && (last.closed ? last.points.slice(0, 3) : last.points.slice(-3));
        ordered.push(...orderPasses(passes, at, false));
    }
    const writer = new MoveWriter(setup.feeds, setup.clearanceZ, setup.safeDistance);
    writer.comment(`${operation.name}: scallop finishing, ${rings.length} rings`);
    cutPasses(writer, setup, ordered, linkOptions(params, cutter, sampling, tolerance));
    return Result.ok(surfacingToolpath(operation, setup, writer.moves));
}

/** A closed XY loop dropped onto the part: one closed pass, or open pieces where heights clip it. */
function dropRing(
    loop: readonly Point2[],
    drop: DropCutter,
    sampling: number,
    tolerance: number,
    minZ: number | undefined,
    maxZ: number | undefined,
): Pass[] {
    const points: number[] = [];
    for (let k = 0; k < loop.length; k++) {
        const [x0, y0] = loop[k];
        const [x1, y1] = loop[(k + 1) % loop.length];
        const piece = drop.dropPath(x0, y0, x1, y1, { sampling, tolerance: tolerance / 2 });
        points.push(...piece.slice(0, piece.length - 3));
    }
    const pieces = clampHeights(points, minZ, maxZ);
    const whole = pieces.length === 1 && pieces[0].length === points.length;
    if (whole) return [{ points: simplifyRing(pieces[0], tolerance / 2), closed: true }];
    return pieces.map((piece) => ({ points: simplify3(piece, tolerance / 2), closed: false }));
}

/** Collinear reduction of a closed 3D ring (split at its first point and halfway). */
function simplifyRing(points: number[], tolerance: number): number[] {
    const n = points.length / 3;
    if (n < 4) return points;
    const half = Math.floor(n / 2);
    const first = simplify3(points.slice(0, (half + 1) * 3), tolerance);
    const second = simplify3([...points.slice(half * 3), points[0], points[1], points[2]], tolerance);
    return [...first, ...second.slice(3, second.length - 3)];
}
