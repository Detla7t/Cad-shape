// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import {
    difference,
    intersection,
    offset,
    type Point2,
    polylineLength,
    type Region,
    regionArea,
    regions,
    signedArea,
} from "../geometry2d";
import { HeightField } from "../mesh/heightField";
import type { TriangleIndex } from "../mesh/triangleIndex";
import { Yielder } from "../mesh/yielder";
import {
    type CamOperationContext,
    type CamOperationHandler,
    type CamParameterSpec,
    registerCamOperation,
} from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolpathData, Vec3 } from "../model/toolpath";
import { FEED_PARAMETERS, feedDefaults } from "../ops2d/common";
import {
    bool,
    choice,
    MoveWriter,
    num,
    optionalNum,
    STOCK_PARAMETERS,
    SURFACE_HEIGHT_PARAMETERS,
    type SurfacingSetup,
    surfacingSetup,
    surfacingToolpath,
    TOLERANCE_PARAMETER,
} from "./common";
import { gridSpacing } from "./waterline";

/**
 * Z-level roughing: the stock cleared in slabs. At each level the region the cutter may not
 * enter is the slice of the offset surface (the part grown by the cutter and the stock to
 * leave, `HeightField.contours`); the rest of the stock box is cleared as a pocket with
 * contour-parallel offsets (`geometry2d`), cut inside out from a helix or ramp entry so the last
 * ring of each pocket runs along the part at the stock to leave. Levels fall every step-down,
 * plus at the part's flat areas; optional intermediate levels clear only the steps the main
 * levels leave on sloped walls (rest material).
 */
export const ZLEVEL_ROUGHING = "zLevelRoughing";

const PARAMETERS: readonly CamParameterSpec[] = [
    { key: "stepdown", label: "Step-down", kind: "length", min: 0.01 },
    { key: "stepover", label: "Stepover", kind: "length", min: 0.01 },
    {
        key: "intermediateSteps",
        label: "Intermediate rest levels",
        kind: "integer",
        min: 0,
        max: 20,
        description: "Levels between step-downs that only clear the steps left on sloped walls",
    },
    { key: "detectFlats", label: "Add levels at flat areas", kind: "boolean" },
    {
        key: "entry",
        label: "Entry",
        kind: "enum",
        options: [
            { value: "helix", label: "Helix" },
            { value: "ramp", label: "Ramp along the contour" },
            { value: "plunge", label: "Plunge" },
        ],
    },
    {
        key: "helixRadius",
        label: "Helix radius",
        kind: "length",
        min: 0.01,
        visibleWhen: { key: "entry", values: ["helix"] },
    },
    { key: "rampAngle", label: "Ramp angle", kind: "angle", min: 0.5, max: 90 },
    {
        key: "direction",
        label: "Direction",
        kind: "enum",
        options: [
            { value: "climb", label: "Climb" },
            { value: "conventional", label: "Conventional" },
        ],
    },
    { key: "sampling", label: "Contour grid spacing", kind: "length", min: 0.01 },
    TOLERANCE_PARAMETER,
    ...STOCK_PARAMETERS,
    ...SURFACE_HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
];

export const zLevelRoughing: CamOperationHandler = {
    type: ZLEVEL_ROUGHING,
    label: "Z-level roughing",
    category: "3d",
    machineKinds: ["mill"],
    selects: ["body"],
    defaults(_machine, tool) {
        const diameter = tool?.diameter ?? 6;
        return {
            ...feedDefaults(tool),
            stepdown: tool?.cutting.stepdown ?? diameter / 2,
            stepover: tool?.cutting.stepover ?? 0.4 * diameter,
            intermediateSteps: 0,
            detectFlats: true,
            entry: "helix",
            helixRadius: 0.4 * diameter,
            rampAngle: 3,
            direction: "climb",
            sampling: gridSpacing(diameter / 2),
            tolerance: 0.02,
            stockToLeave: 0.3,
            clearance: 5,
            safeDistance: 1,
            holderCheck: true,
        };
    },
    parameters: () => PARAMETERS,
    generate: generateZLevelRoughing,
};

registerCamOperation(zLevelRoughing);

/** One roughing level: its height, the material top above it, and the region the tool centre clears. */
export interface RoughingLevel {
    readonly z: number;
    readonly materialTop: number;
    readonly region: Point2[][];
    /** A rest level: only the steps the main level below left on sloped walls. */
    readonly rest: boolean;
}

export async function generateZLevelRoughing(
    operation: CamOperationData,
    context: CamOperationContext,
): Promise<Result<ToolpathData>> {
    const setupResult = surfacingSetup(operation, context, { tolerance: 0.02, stockToLeave: 0.3 });
    if (!setupResult.isOk) return Result.err(setupResult.error);
    const setup = setupResult.value;
    const params = operation.params;
    const yielder = new Yielder(15, context.signal);
    const levels = await roughingLevels(setup, params, yielder);
    if (!levels.isOk) return Result.err(levels.error);

    const radius = setup.cutter.radius;
    const stepover = Math.min(Math.max(num(params, "stepover", 0.8 * radius), 0.01), 2 * radius);
    const entry = choice(params, "entry", ["helix", "ramp", "plunge"], "helix");
    const options: ClearingOptions = {
        stepover,
        entry,
        helixRadius: Math.max(num(params, "helixRadius", 0.8 * radius), 0.01),
        rampAngle: Math.min(Math.max(num(params, "rampAngle", 3), 0.5), 90),
        climb: choice(params, "direction", ["climb", "conventional"], "climb") === "climb",
        arcTolerance: setup.tolerance / 2,
    };
    const writer = new MoveWriter(setup.feeds, setup.clearanceZ, setup.safeDistance);
    writer.comment(`${operation.name}: Z-level roughing, ${levels.value.length} levels`);
    for (const level of levels.value) {
        clearLevel(writer, setup, level, options);
        await yielder.tick();
    }
    writer.retract();
    if (!writer.moves.some((move) => move.kind === "linear" || move.kind === "arc")) {
        return Result.err("Nothing to rough: the stock is already at the part");
    }
    return Result.ok(surfacingToolpath(operation, setup, writer.moves));
}

/**
 * The roughing levels from the stock top down to the part's bottom (each limited by
 * maxZ / minZ): every step-down, at flat areas (+ the axial stock to leave), and the
 * intermediate rest levels, with the region each clears.
 */
export async function roughingLevels(
    setup: SurfacingSetup,
    params: Readonly<Record<string, unknown>>,
    yielder?: Yielder,
): Promise<Result<RoughingLevel[]>> {
    const { tolerance, cutter, stock, index } = setup;
    const top = Math.min(optionalNum(params, "maxZ") ?? Infinity, stock.max[2]);
    const bottom = Math.max(optionalNum(params, "minZ") ?? -Infinity, index.min[2] + setup.axialStockToLeave);
    if (!(top > bottom)) return Result.err("The height range is empty");
    const stepdown = Math.max(num(params, "stepdown", cutter.radius), 0.01);
    const heights: number[] = [];
    const count = Math.max(1, Math.ceil((top - bottom) / stepdown - 1e-9));
    for (let k = 1; k <= count; k++) heights.push(k === count ? bottom : top - ((top - bottom) * k) / count);
    if (bool(params, "detectFlats", true)) {
        for (const z of flatHeights(index, cutter.radius)) {
            const level = z + setup.axialStockToLeave;
            if (level < top - tolerance && level > bottom + tolerance) heights.push(level);
        }
    }
    heights.sort((a, b) => b - a);
    const main = heights.filter((z, k) => k === 0 || heights[k - 1] - z > tolerance / 2);

    const spacing = Math.max(num(params, "sampling", gridSpacing(cutter.radius)), 0.01);
    const field = await HeightField.build(setup.drop, UNBOUNDED, spacing, yielder);
    // The tool centre may leave the stock box by its radius less a sliver, so the outermost
    // ring still takes a cut at the stock's edge.
    const { min, max } = stock;
    const box: Point2[] = [
        [min[0], min[1]],
        [max[0], min[1]],
        [max[0], max[1]],
        [min[0], max[1]],
    ];
    const outer = offset([box], cutter.radius - Math.max(tolerance, 0.05 * cutter.radius), {
        tolerance: tolerance / 2,
    });
    const intermediate = Math.max(0, Math.round(num(params, "intermediateSteps", 0)));

    const levels: RoughingLevel[] = [];
    let above = top;
    for (const z of main) {
        const forbidden = await field.contours(z, tolerance, yielder);
        levels.push({ z, materialTop: above, region: difference(outer, forbidden), rest: false });
        // Rest levels between this level and the one above, top down: the band the cutter
        // could not enter at z but can at the rest height.
        let restTop = above;
        for (let j = 1; j <= intermediate; j++) {
            const zi = above - ((above - z) * j) / (intermediate + 1);
            const forbiddenAt = await field.contours(zi, tolerance, yielder);
            const band = intersection(difference(forbidden, forbiddenAt), outer);
            if (regionArea(band) > tolerance * tolerance) {
                levels.push({ z: zi, materialTop: restTop, region: band, rest: true });
                restTop = zi;
            }
        }
        above = z;
    }
    return Result.ok(levels);
}

const UNBOUNDED = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };

/**
 * Heights of the part's horizontal areas (facets within 0.5° of level), where a level should
 * fall so the floor keeps exactly the axial stock to leave; tiny ones are ignored.
 */
export function flatHeights(index: TriangleIndex, radius: number): number[] {
    const areas = new Map<number, number>();
    const v = index.vertices;
    const level = Math.cos((0.5 * Math.PI) / 180);
    for (let t = 0; t < index.count; t++) {
        if (index.planes[t * 4 + 2] < level) continue;
        const o = t * 9;
        const z = Math.round(((v[o + 2] + v[o + 5] + v[o + 8]) / 3) * 1e4) / 1e4;
        const area =
            Math.abs((v[o + 3] - v[o]) * (v[o + 7] - v[o + 1]) - (v[o + 4] - v[o + 1]) * (v[o + 6] - v[o])) /
            2;
        areas.set(z, (areas.get(z) ?? 0) + area);
    }
    const minimum = (radius * radius) / 4;
    return [...areas].filter(([, area]) => area >= minimum).map(([z]) => z);
}

interface ClearingOptions {
    readonly stepover: number;
    readonly entry: "helix" | "ramp" | "plunge";
    readonly helixRadius: number;
    readonly rampAngle: number;
    readonly climb: boolean;
    readonly arcTolerance: number;
}

/** A pocket ring and the rings offset inside it, cut inside out. */
interface RingTree {
    readonly rings: (readonly Point2[])[];
    readonly children: RingTree[];
}

function ringTree(region: Region, options: ClearingOptions, depth = 0): RingTree {
    const rings = [region.outer, ...region.holes];
    const children =
        depth > 5000
            ? []
            : regions(offset(rings, -options.stepover, { tolerance: options.arcTolerance }))
                  .filter((child) => Math.abs(signedArea(child.outer)) > options.arcTolerance ** 2)
                  .map((child) => ringTree(child, options, depth + 1));
    return { rings: rings.filter((ring) => polylineLength(ring, true) > 2 * options.arcTolerance), children };
}

/** Clears one level's region: each connected pocket inside out, linking at the level where clear. */
function clearLevel(
    writer: MoveWriter,
    setup: SurfacingSetup,
    level: RoughingLevel,
    options: ClearingOptions,
): void {
    const pockets = regions(level.region).filter(
        (region) => regionArea([region.outer, ...region.holes]) > 1e-6,
    );
    const trees = pockets.map((pocket) => ringTree(pocket, options));
    const remaining = trees.slice();
    while (remaining.length > 0) {
        const at = writer.position;
        let best = 0;
        let bestDistance = Infinity;
        for (let k = 0; k < remaining.length && at; k++) {
            const d = distanceToTree(remaining[k], at);
            if (d < bestDistance) {
                bestDistance = d;
                best = k;
            }
        }
        const [tree] = remaining.splice(best, 1);
        cutTree(writer, setup, tree, level, options);
    }
}

function distanceToTree(tree: RingTree, at: Vec3): number {
    let leaf = tree;
    while (leaf.children.length > 0) leaf = leaf.children[0];
    let best = Infinity;
    for (const ring of leaf.rings)
        for (const [x, y] of ring) best = Math.min(best, Math.hypot(x - at[0], y - at[1]));
    return best;
}

/** Inside out: the children's pockets (each from its own entry), then this ring set. */
function cutTree(
    writer: MoveWriter,
    setup: SurfacingSetup,
    tree: RingTree,
    level: RoughingLevel,
    options: ClearingOptions,
) {
    const children = tree.children.slice();
    while (children.length > 0) {
        const at = writer.position;
        let best = 0;
        let bestDistance = Infinity;
        for (let k = 0; k < children.length && at; k++) {
            const d = distanceToTree(children[k], at);
            if (d < bestDistance) {
                bestDistance = d;
                best = k;
            }
        }
        cutTree(writer, setup, children.splice(best, 1)[0], level, options);
    }
    const rings = tree.rings.slice();
    let enter = tree.children.length === 0;
    while (rings.length > 0) {
        const at = writer.position;
        let bestRing = 0;
        let bestVertex = 0;
        let bestDistance = Infinity;
        for (let k = 0; k < rings.length; k++) {
            for (let i = 0; i < rings[k].length && at; i++) {
                const d = Math.hypot(rings[k][i][0] - at[0], rings[k][i][1] - at[1]);
                if (d < bestDistance) {
                    bestDistance = d;
                    bestRing = k;
                    bestVertex = i;
                }
            }
        }
        const ring = rings.splice(bestRing, 1)[0];
        let loop = [...ring.slice(bestVertex), ...ring.slice(0, bestVertex)];
        if (!options.climb) loop = [loop[0], ...loop.slice(1).reverse()];
        const start: Vec3 = [loop[0][0], loop[0][1], level.z];
        const from = writer.position;
        const down = from !== undefined && Math.abs(from[2] - level.z) < 1e-9;
        if (enter || !down || !setup.check.isClear(from, start)) {
            loop = enterRing(writer, setup, loop, level, options);
        } else {
            writer.feed(start);
        }
        for (let k = 1; k <= loop.length; k++) {
            const [x, y] = loop[k % loop.length];
            writer.feed([x, y, level.z]);
        }
        enter = false;
    }
}

/**
 * Gets the cutter down to the level at the start of a ring (from the rapid plane, through
 * the material above): a helix tangent to the ring where its circle clears the part, else a
 * ramp along the ring itself (always clear: the ring is clear at the level and so above it),
 * else a plunge. Returns the ring as it is to be cut (a ramp ends part way round).
 */
function enterRing(
    writer: MoveWriter,
    setup: SurfacingSetup,
    loop: Point2[],
    level: RoughingLevel,
    options: ClearingOptions,
): Point2[] {
    const z = level.z;
    const zTop = Math.max(level.materialTop, z);
    const [x0, y0] = loop[0];
    const tangent = direction(loop);
    const feeds = setup.feeds;
    const approachTop = () => {
        writer.retract();
        writer.rapid([x0, y0, writer.clearanceZ]);
        const stop = zTop + writer.safeDistance;
        if (stop < writer.clearanceZ) writer.rapid([x0, y0, stop]);
        writer.feed([x0, y0, zTop], feeds.plunge);
    };
    const drop = zTop - z;
    if (drop <= 1e-9) {
        approachTop();
        return loop;
    }
    const slope = Math.tan((options.rampAngle * Math.PI) / 180);
    if (options.entry === "helix" && tangent) {
        for (const radius of [options.helixRadius, options.helixRadius / 2]) {
            for (const side of [1, -1]) {
                // A circle through the start, tangent to the ring there, on the given side.
                const cx = x0 - side * tangent[1] * radius;
                const cy = y0 + side * tangent[0] * radius;
                if (!helixClear(setup, cx, cy, radius, z)) continue;
                approachTop();
                const turns = Math.max(1, Math.ceil(drop / (2 * Math.PI * radius * slope)));
                const clockwise = side < 0;
                const ox = 2 * cx - x0;
                const oy = 2 * cy - y0;
                for (let k = 0; k < turns; k++) {
                    const z1 = zTop - (drop * (k + 0.5)) / turns;
                    const z2 = zTop - (drop * (k + 1)) / turns;
                    writer.arc([ox, oy, z1], [cx, cy, z1], clockwise, feeds.ramp);
                    writer.arc([x0, y0, z2], [cx, cy, z2], clockwise, feeds.ramp);
                }
                // A level turn takes off the last ramp's step.
                writer.arc([ox, oy, z], [cx, cy, z], clockwise, feeds.ramp);
                writer.arc([x0, y0, z], [cx, cy, z], clockwise, feeds.ramp);
                return loop;
            }
        }
    }
    const perimeter = polylineLength(loop, true);
    if (options.entry !== "plunge" && perimeter > setup.cutter.radius) {
        approachTop();
        const run = drop / slope;
        let travelled = 0;
        let k = 0;
        let current: Point2 = loop[0];
        while (travelled < run - 1e-9) {
            const next = loop[(k + 1) % loop.length];
            const length = Math.hypot(next[0] - current[0], next[1] - current[1]);
            if (travelled + length >= run) {
                const t = (run - travelled) / length;
                const point: Point2 = [
                    current[0] + (next[0] - current[0]) * t,
                    current[1] + (next[1] - current[1]) * t,
                ];
                writer.feed([point[0], point[1], z], feeds.ramp);
                const rest = (k + 1) % loop.length;
                return [point, ...loop.slice(rest), ...loop.slice(0, rest)];
            }
            travelled += length;
            writer.feed([next[0], next[1], zTop - (drop * travelled) / run], feeds.ramp);
            current = next;
            k = (k + 1) % loop.length;
        }
        return [...loop.slice(k), ...loop.slice(0, k)];
    }
    approachTop();
    writer.feed([x0, y0, z], feeds.plunge);
    return loop;
}

/** Whether the tool centre can circle (cx, cy) at radius r at height z without touching the part. */
function helixClear(setup: SurfacingSetup, cx: number, cy: number, radius: number, z: number): boolean {
    const samples = Math.max(16, Math.ceil((2 * Math.PI * radius) / (setup.cutter.radius / 4)));
    for (let k = 0; k < samples; k++) {
        const angle = (2 * Math.PI * k) / samples;
        if (setup.check.drop(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)) > z + 1e-7)
            return false;
    }
    return true;
}

function direction(loop: readonly Point2[]): Point2 | undefined {
    for (let k = 1; k < loop.length; k++) {
        const dx = loop[k][0] - loop[0][0];
        const dy = loop[k][1] - loop[0][1];
        const length = Math.hypot(dx, dy);
        if (length > 1e-9) return [dx / length, dy / length];
    }
    return undefined;
}
