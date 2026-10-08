// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { distanceToLoops, distanceToPolyline, type Point2, pointInLoops } from "../geometry2d";
import { HeightField } from "../mesh/heightField";
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
    BOUNDARY_PARAMETERS,
    choice,
    containmentRegion,
    cutPasses,
    LINK_PARAMETERS,
    linkOptions,
    MoveWriter,
    num,
    optionalNum,
    orderPasses,
    type Pass,
    passEnd,
    STOCK_PARAMETERS,
    SURFACE_HEIGHT_PARAMETERS,
    type SurfacingSetup,
    scallopStepover,
    surfacingSetup,
    surfacingToolpath,
    TOLERANCE_PARAMETER,
    takeNearest,
} from "./common";

/**
 * Waterline (Z-level) finishing: the part's walls cut at constant heights. Each level is a
 * set of exact cutter-location contours (`HeightField.contours`), optionally only where the
 * surface is steeper than an angle, at fixed steps or at steps adapted so the surface
 * distance between neighbouring levels keeps the scallop height.
 */
export const WATERLINE_3D = "waterline3d";

/** Waterlines run outside the walls: by default the tool may leave the stock box by its radius. */
const WATERLINE_BOUNDARY = { boundary: "stock", containment: "outside" } as const;

const PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "stepdownMode",
        label: "Step-down",
        kind: "enum",
        options: [
            { value: "fixed", label: "Fixed" },
            { value: "scallop", label: "From scallop height" },
        ],
    },
    { key: "stepdown", label: "Maximum step-down", kind: "length", min: 0.001 },
    {
        key: "scallopHeight",
        label: "Scallop height",
        kind: "length",
        min: 0.0001,
        visibleWhen: { key: "stepdownMode", values: ["scallop"] },
    },
    {
        key: "minStepdown",
        label: "Minimum step-down",
        kind: "length",
        min: 0.001,
        visibleWhen: { key: "stepdownMode", values: ["scallop"] },
    },
    {
        key: "slopeFrom",
        label: "Only slopes steeper than",
        kind: "angle",
        min: 0,
        max: 90,
        description: "0 cuts every contour; e.g. 45 leaves shallow areas for parallel finishing",
    },
    {
        key: "direction",
        label: "Direction",
        kind: "enum",
        options: [
            { value: "climb", label: "Climb" },
            { value: "conventional", label: "Conventional" },
        ],
    },
    {
        key: "order",
        label: "Order",
        kind: "enum",
        options: [
            { value: "level", label: "By level" },
            { value: "region", label: "By region (depth first)" },
        ],
    },
    { key: "sampling", label: "Contour grid spacing", kind: "length", min: 0.01 },
    TOLERANCE_PARAMETER,
    ...STOCK_PARAMETERS,
    ...BOUNDARY_PARAMETERS,
    ...SURFACE_HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
    ...LINK_PARAMETERS,
];

export const waterlineFinishing: CamOperationHandler = {
    type: WATERLINE_3D,
    label: "Waterline finishing",
    category: "3d",
    machineKinds: ["mill"],
    selects: ["face"],
    defaults(_machine, tool) {
        const diameter = tool?.diameter ?? 6;
        return {
            ...feedDefaults(tool),
            stepdownMode: "fixed",
            stepdown: diameter / 10,
            scallopHeight: 0.01,
            minStepdown: diameter / 100,
            slopeFrom: 0,
            direction: "climb",
            order: "level",
            sampling: gridSpacing(diameter / 2),
            tolerance: 0.01,
            stockToLeave: 0,
            ...WATERLINE_BOUNDARY,
            boundaryOffset: 0,
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
    generate: generateWaterline,
};

registerCamOperation(waterlineFinishing);

/** Default contour grid spacing: a quarter of the cutter radius, bounded. */
export function gridSpacing(radius: number): number {
    return Math.min(Math.max(radius / 4, 0.05), 2);
}

/** One waterline level: its height and its passes (closed loops or open steep chains). */
export interface WaterlineLevel {
    readonly z: number;
    readonly passes: Pass[];
}

export async function generateWaterline(
    operation: CamOperationData,
    context: CamOperationContext,
): Promise<Result<ToolpathData>> {
    const setupResult = surfacingSetup(operation, context, { tolerance: 0.01, stockToLeave: 0 });
    if (!setupResult.isOk) return Result.err(setupResult.error);
    const setup = setupResult.value;
    const params = operation.params;
    const yielder = new Yielder(15, context.signal);
    const spacing = Math.max(num(params, "sampling", gridSpacing(setup.cutter.radius)), 0.01);
    const field = await HeightField.build(setup.drop, unbounded(), spacing, yielder);
    const levels = await waterlineLevels(field, setup, params, context, yielder);
    if (!levels.isOk) return Result.err(levels.error);

    const climb = choice(params, "direction", ["climb", "conventional"], "climb") === "climb";
    const passesByLevel = levels.value.map((level) =>
        climb ? level.passes.map((pass) => ({ ...pass, points: reverseLoop(pass) })) : level.passes,
    );
    const order = choice(params, "order", ["level", "region"], "level");
    const ordered =
        order === "region"
            ? orderByRegion(passesByLevel, 2 * setup.tool.diameter)
            : orderByLevel(passesByLevel);
    if (ordered.length === 0) return Result.err("No waterline contours in the height range");

    const writer = new MoveWriter(setup.feeds, setup.clearanceZ, setup.safeDistance);
    writer.comment(`${operation.name}: waterline, ${levels.value.length} levels`);
    cutPasses(writer, setup, ordered, linkOptions(params, setup.cutter, spacing, setup.tolerance, false));
    return Result.ok(surfacingToolpath(operation, setup, writer.moves));
}

function unbounded() {
    return { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };
}

/**
 * The levels from the top of the cutter-location surface (or `maxZ`) down to the part's
 * bottom (or `minZ`), with their passes clipped to the boundary and the slope range.
 */
export async function waterlineLevels(
    field: HeightField,
    setup: SurfacingSetup,
    params: Readonly<Record<string, unknown>>,
    context: CamOperationContext,
    yielder?: Yielder,
): Promise<Result<WaterlineLevel[]>> {
    const { tolerance, cutter } = setup;
    const maxZ = optionalNum(params, "maxZ");
    const minZ = optionalNum(params, "minZ");
    const top = Math.min(maxZ ?? Infinity, field.max());
    const bottom = Math.max(minZ ?? -Infinity, setup.index.min[2] + setup.axialStockToLeave);
    if (!(top > bottom)) return Result.err("The height range is empty");
    const stepdown = Math.max(num(params, "stepdown", cutter.radius / 5), 1e-3);
    const slopeFrom = Math.min(Math.max(num(params, "slopeFrom", 0), 0), 90);
    const boundary = await containmentRegion(params, context, setup, WATERLINE_BOUNDARY, yielder);

    const levelAt = async (z: number): Promise<WaterlineLevel> => {
        const loops = await field.contours(z, tolerance, yielder);
        return { z, passes: clipLoops(loops, z, field, boundary, slopeFrom, tolerance) };
    };

    const levels: WaterlineLevel[] = [];
    if (choice(params, "stepdownMode", ["fixed", "scallop"], "fixed") === "fixed") {
        const count = Math.max(1, Math.ceil((top - bottom) / stepdown - 1e-9));
        const step = (top - bottom) / count;
        for (let k = 1; k <= count; k++) levels.push(await levelAt(k === count ? bottom : top - k * step));
    } else {
        const spacing = scallopStepover(cutter, num(params, "scallopHeight", 0.01));
        const minStep = Math.min(Math.max(num(params, "minStepdown", stepdown / 10), 1e-3), stepdown);
        let z = top;
        let previous: Point2[][] | undefined;
        while (z > bottom + 1e-9) {
            let step = Math.min(stepdown, z - bottom);
            let level = await levelAt(z - step);
            for (let attempt = 0; previous && attempt < 6 && step > minStep + 1e-12; attempt++) {
                const worst = levelSpacing(previous, level, step, 3 * spacing);
                if (worst <= spacing) break;
                step = Math.max(minStep, step * Math.max(0.25, (0.9 * spacing) / worst));
                level = await levelAt(z - step);
            }
            levels.push(level);
            previous = level.passes.map((pass) => toRing(pass.points));
            z -= step;
        }
    }
    return Result.ok(levels);
}

/**
 * The largest 3D distance between a contour point of `level` and the contours above (a step
 * of `step` below), over points within `cap` of them (farther ones start new features).
 */
function levelSpacing(previous: Point2[][], level: WaterlineLevel, step: number, cap: number): number {
    let worst = 0;
    for (const pass of level.passes) {
        const p = pass.points;
        for (let k = 0; k < p.length; k += 3) {
            const d = distanceToLoops([p[k], p[k + 1]], previous);
            if (d <= cap) worst = Math.max(worst, Math.hypot(d, step));
        }
    }
    return worst === 0 ? step : worst;
}

/**
 * Loops (forbidden side left) as passes at height z, keeping the points inside the boundary
 * where the surface is at least `slopeFrom` steep; a loop kept whole stays closed.
 */
function clipLoops(
    loops: Point2[][],
    z: number,
    field: HeightField,
    boundary: Point2[][],
    slopeFrom: number,
    tolerance: number,
): Pass[] {
    const passes: Pass[] = [];
    const minSlope = Math.tan((slopeFrom * Math.PI) / 180);
    const delta = Math.max(field.spacing / 4, 5 * tolerance);
    for (const loop of loops) {
        const n = loop.length;
        const keep = loop.map((point, k) => {
            if (boundary.length > 0 && !pointInLoops(point, boundary)) return false;
            if (slopeFrom <= 0) return true;
            const prev = loop[(k + n - 1) % n];
            const next = loop[(k + 1) % n];
            const tx = next[0] - prev[0];
            const ty = next[1] - prev[1];
            const length = Math.hypot(tx, ty) || 1;
            const nx = -ty / length;
            const ny = tx / length;
            // Rise across the contour (the forbidden side is on the left); nothing at all on
            // the outer side (−∞) counts as a wall.
            const up = field.drop.drop(point[0] + nx * delta, point[1] + ny * delta);
            const down = field.drop.drop(point[0] - nx * delta, point[1] - ny * delta);
            return (Math.max(up, z) - Math.min(down, z)) / (2 * delta) >= minSlope - 1e-9;
        });
        if (keep.every(Boolean)) {
            passes.push({ points: toPoints(loop, z), closed: true });
            continue;
        }
        const start = keep.indexOf(false);
        if (start < 0) continue;
        let run: Point2[] = [];
        for (let i = 1; i <= n; i++) {
            const k = (start + i) % n;
            if (keep[k]) run.push(loop[k]);
            if (!keep[k] || i === n) {
                if (run.length >= 2 && runLength(run) > 2 * tolerance)
                    passes.push({ points: toPoints(run, z), closed: false });
                run = [];
            }
        }
    }
    return passes;
}

function runLength(run: Point2[]): number {
    let length = 0;
    for (let k = 1; k < run.length; k++)
        length += Math.hypot(run[k][0] - run[k - 1][0], run[k][1] - run[k - 1][1]);
    return length;
}

function toPoints(points: readonly Point2[], z: number): number[] {
    const out: number[] = [];
    for (const [x, y] of points) out.push(x, y, z);
    return out;
}

function toRing(points: readonly number[]): Point2[] {
    const ring: Point2[] = [];
    for (let k = 0; k < points.length; k += 3) ring.push([points[k], points[k + 1]]);
    return ring;
}

function reverseLoop(pass: Pass): number[] {
    const p = pass.points;
    const out: number[] = [];
    for (let k = p.length - 3; k >= 0; k -= 3) out.push(p[k], p[k + 1], p[k + 2]);
    return out;
}

function orderByLevel(levels: Pass[][]): Pass[] {
    const out: Pass[] = [];
    for (const passes of levels) {
        const last = out[out.length - 1];
        out.push(...orderPasses(passes, last && passEnd(last), false));
    }
    return out;
}

/**
 * Depth first: from a pass, continue with the nearest pass of the next level when it is
 * within `reach`, else start again from the highest level that has passes left.
 */
function orderByRegion(levels: Pass[][], reach: number): Pass[] {
    const remaining = levels.map((passes) => passes.slice());
    const out: Pass[] = [];
    let level = remaining.findIndex((passes) => passes.length > 0);
    let at: readonly number[] | undefined;
    while (level >= 0) {
        const pass = takeNearest(remaining[level], at, false);
        out.push(pass);
        const end = passEnd(pass);
        at = end;
        const next = level + 1 < remaining.length ? remaining[level + 1] : [];
        const near = next.some(
            (candidate) =>
                distanceToPolyline([end[0], end[1]], toRing(candidate.points), candidate.closed) <= reach,
        );
        level = near ? level + 1 : remaining.findIndex((passes) => passes.length > 0);
    }
    return out;
}
