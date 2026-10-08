// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { Point2 } from "../geometry2d";
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

/**
 * Parallel (raster) finishing: straight passes at an angle across the machining boundary,
 * each dropped onto the part (adaptive drop-cutter sampling to the tolerance, then
 * collinear-point reduction), cut zig-zag or one way and linked by staying down where safe.
 */
export const PARALLEL_3D = "parallel3d";

const PARAMETERS: readonly CamParameterSpec[] = [
    { key: "angle", label: "Pass angle", kind: "angle" },
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
        key: "direction",
        label: "Direction",
        kind: "enum",
        options: [
            { value: "zigzag", label: "Zig-zag" },
            { value: "oneWay", label: "One way" },
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

export const parallelFinishing: CamOperationHandler = {
    type: PARALLEL_3D,
    label: "Parallel finishing",
    category: "3d",
    machineKinds: ["mill"],
    selects: ["face"],
    defaults(_machine, tool) {
        const diameter = tool?.diameter ?? 6;
        return {
            ...feedDefaults(tool),
            angle: 0,
            stepoverMode: "distance",
            stepover: tool?.cutting.stepover ?? diameter / 10,
            scallopHeight: 0.01,
            direction: "zigzag",
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
    generate: generateParallel,
};

registerCamOperation(parallelFinishing);

export async function generateParallel(
    operation: CamOperationData,
    context: CamOperationContext,
): Promise<Result<ToolpathData>> {
    const setupResult = surfacingSetup(operation, context, { tolerance: 0.01, stockToLeave: 0 });
    if (!setupResult.isOk) return Result.err(setupResult.error);
    const setup = setupResult.value;
    const params = operation.params;
    const { cutter, drop, tolerance } = setup;
    const yielder = new Yielder(15, context.signal);
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
    const angle = (num(params, "angle", 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Passes run along u at constant v (the boundary turned by −angle).
    const turned = boundary.map((ring) =>
        ring.map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos] as const),
    );
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const ring of turned) {
        for (const [, v] of ring) {
            vMin = Math.min(vMin, v);
            vMax = Math.max(vMax, v);
        }
    }
    const inset = Math.min(tolerance / 10, (vMax - vMin) / 4);
    const span = vMax - vMin - 2 * inset;
    const lines = Math.max(1, Math.ceil(span / stepover - 1e-9));
    const passes: Pass[] = [];
    for (let line = 0; line <= lines; line++) {
        const v = vMin + inset + (span * line) / lines;
        for (const [u0, u1] of scanline(turned, v)) {
            const points = drop.dropPath(
                u0 * cos - v * sin,
                u0 * sin + v * cos,
                u1 * cos - v * sin,
                u1 * sin + v * cos,
                {
                    sampling,
                    tolerance: tolerance / 2,
                },
            );
            for (const piece of clampHeights(points, minZ, maxZ)) {
                passes.push({ points: simplify3(piece, tolerance / 2), closed: false });
            }
        }
        await yielder.tick();
    }
    if (passes.length === 0)
        return Result.err("No passes: the boundary or height range leaves nothing to cut");

    const zigzag = choice(params, "direction", ["zigzag", "oneWay"], "zigzag") === "zigzag";
    const ordered = orderPasses(passes, undefined, zigzag);
    const writer = new MoveWriter(setup.feeds, setup.clearanceZ, setup.safeDistance);
    writer.comment(`${operation.name}: parallel finishing, ${passes.length} passes`);
    cutPasses(writer, setup, ordered, linkOptions(params, cutter, sampling, tolerance));
    return Result.ok(surfacingToolpath(operation, setup, writer.moves));
}

/** Where the line v = const crosses the rings: inside intervals [u0, u1] (even-odd). */
export function scanline(rings: readonly (readonly Point2[])[], v: number): [number, number][] {
    const hits: number[] = [];
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [ua, va] = ring[j];
            const [ub, vb] = ring[i];
            if (va <= v === vb <= v) continue;
            hits.push(ua + ((v - va) * (ub - ua)) / (vb - va));
        }
    }
    hits.sort((a, b) => a - b);
    const out: [number, number][] = [];
    for (let k = 0; k + 1 < hits.length; k += 2)
        if (hits[k + 1] - hits[k] > 1e-9) out.push([hits[k], hits[k + 1]]);
    return out;
}

/** Raises points below minZ to it and cuts the polyline where it rises above maxZ. */
export function clampHeights(points: readonly number[], minZ?: number, maxZ?: number): number[][] {
    const pieces: number[][] = [];
    let current: number[] = [];
    for (let k = 0; k < points.length; k += 3) {
        let z = points[k + 2];
        if (minZ !== undefined && z < minZ) z = minZ;
        if (maxZ !== undefined && z > maxZ + 1e-9) {
            if (current.length >= 6) pieces.push(current);
            current = [];
            continue;
        }
        current.push(points[k], points[k + 1], z);
    }
    if (current.length >= 6) pieces.push(current);
    return pieces;
}
