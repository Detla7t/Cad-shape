// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { fitArcs } from "../geometry2d/arcs";
import { offset, regionLoops } from "../geometry2d/clip";
import { nearestNeighborOrder } from "../geometry2d/order";
import { nearestArcLength, type Path2, pathLength, pathPointAt, startClosedPathAt } from "../geometry2d/path";
import { bounds } from "../geometry2d/polygon";
import type { Point2 } from "../geometry2d/vec";
import type { CamOperationContext, CamOperationHandler, CamParameterSpec } from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolpathData } from "../model/toolpath";
import { halfAngle } from "./chamfer";
import {
    depthLevels,
    FEED_PARAMETERS,
    feedDefaults,
    feedsOf,
    HEIGHT_PARAMETERS,
    heightsOf,
    toolpathOf,
} from "./common";
import { selectionGeometry } from "./geometry";
import { flat, MoveBuilder } from "./moves";
import { ParamReader } from "./params";

/**
 * Engraving runs the tool tip exactly along loops and chains at a depth (in steps); V-carving
 * cuts closed regions with a V-bit whose depth follows the distance to the outline — the
 * medial-axis depth `ρ / tan(α)` — approximated by inward offset rings at small distance
 * steps, each cut at its own depth (clamped to a maximum depth: the floor then is flat).
 */

export const ENGRAVE_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "depth", label: "Depth", kind: "length", min: 0 },
    { key: "stepdown", label: "Stepdown", kind: "length", min: 0 },
    ...HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
];

export const VCARVE_PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "maxDepth",
        label: "Max depth",
        kind: "length",
        min: 0,
        description: "0: as deep as the bit allows",
    },
    { key: "step", label: "Ring spacing", kind: "length", min: 0.01 },
    ...HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
];

interface Chain {
    readonly path: Path2;
    readonly z: number;
}

export function generateEngrave(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const tool = context.tool;
    const geometry = selectionGeometry(context);
    const chains: Chain[] = [
        ...geometry.closed.map((c) => ({ path: fitArcs(c.points, true), z: c.z })),
        ...geometry.holes
            .filter((h) => h.source === "face")
            .map((h) => ({ path: fitArcs(h.points, true), z: h.z })),
        ...geometry.open.map((c) => ({ path: fitArcs(c.points, false), z: c.z })),
    ].filter((c) => c.path.segments.length > 0);
    if (chains.length === 0) return Result.err("Select loops, edges or faces to engrave");
    const feeds = feedsOf(p, tool, context.machine);
    const heights = heightsOf(p, context);
    const depth = Math.max(0, p.num("depth", 0.3));
    if (depth <= 0) return Result.err("Set an engraving depth");
    const stepdown = p.num("stepdown", depth);
    const builder = new MoveBuilder();
    builder.comment(`${operation.name}: engrave ${depth} mm deep`);
    let at: Point2 = [context.stock.min[0], context.stock.min[1]];
    const ordered = nearestNeighborOrder(
        chains,
        at,
        (c, from) =>
            c.path.closed ? pathPointAt(c.path, nearestArcLength(c.path, from).s) : pathPointAt(c.path, 0),
        (c) => (c.path.closed ? pathPointAt(c.path, 0) : pathPointAt(c.path, pathLength(c.path))),
    );
    let first = true;
    for (const chain of ordered) {
        const path = chain.path.closed
            ? startClosedPathAt(chain.path, nearestArcLength(chain.path, at).s)
            : chain.path;
        const start = pathPointAt(path, 0);
        const top = chain.z;
        for (const z of depthLevels(top, top - depth, stepdown)) {
            builder.rapidTo(start, top + 1, first ? heights.clearance : heights.retract);
            first = false;
            builder.linear([start[0], start[1], z], feeds.plunge);
            builder.follow(flat(path.segments, z), feeds.feed);
            builder.retract(top + 1);
        }
        builder.retract(heights.retract);
        at = pathPointAt(path, chain.path.closed ? 0 : pathLength(path));
    }
    builder.retract(heights.clearance);
    return Result.ok(toolpathOf(builder, operation, context, feeds));
}

export function generateVCarve(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const tool = context.tool;
    const alpha = halfAngle(tool);
    const geometry = selectionGeometry(context);
    if (geometry.regions.length === 0) return Result.err("Select closed loops or faces to V-carve");
    const toolMax = tool.diameter / 2 / Math.tan(alpha);
    const maxDepth = Math.min(toolMax, p.num("maxDepth", 0) > 0 ? p.num("maxDepth", 0) : toolMax);
    const step = Math.max(0.01, p.num("step", 0.1));
    const feeds = feedsOf(p, tool, context.machine);
    const heights = heightsOf(p, context);
    const builder = new MoveBuilder();
    builder.comment(
        `${operation.name}: V-carve, ${tool.tipAngle ?? 90}° bit, max depth ${maxDepth.toFixed(3)}`,
    );
    let first = true;
    for (const region of geometry.regions) {
        const top = region.z;
        // Ring k at distance k·step from the outline, cut with the tip at depth ρ / tan α.
        const box = bounds(region.outer);
        const rings = Math.ceil(Math.min(box.max[0] - box.min[0], box.max[1] - box.min[1]) / 2 / step) + 1;
        for (let k = 0; k <= rings; k++) {
            const rho = k * step;
            const loops = rho < 1e-9 ? regionLoops(region) : offset(regionLoops(region), -rho);
            if (loops.length === 0) break;
            const z = top - Math.min(maxDepth, rho / Math.tan(alpha));
            for (const path of loops.map((loop) => fitArcs(loop, true))) {
                const here = builder.position;
                const nearest = here !== undefined ? nearestArcLength(path, [here[0], here[1]]) : undefined;
                const ring = startClosedPathAt(path, nearest?.s ?? 0);
                const start = pathPointAt(ring, 0);
                // Step inward from the previous ring while still in the cut; else come down anew.
                const close =
                    k > 0 &&
                    here !== undefined &&
                    nearest !== undefined &&
                    nearest.distance <= 2 * step + 1e-6 &&
                    here[2] < top;
                if (!close) {
                    builder.rapidTo(start, top + 1, first ? heights.clearance : heights.retract);
                    first = false;
                }
                builder.linear([start[0], start[1], z], feeds.plunge);
                builder.follow(flat(ring.segments, z), feeds.feed);
            }
        }
        builder.retract(heights.retract);
    }
    builder.retract(heights.clearance);
    return Result.ok(toolpathOf(builder, operation, context, feeds));
}

export const engraveOperation: CamOperationHandler = {
    type: "engrave",
    label: "Engrave",
    category: "2d",
    machineKinds: ["mill"],
    selects: ["sketch", "edge", "face"],
    defaults: (_machine, tool) => ({
        depth: 0.3,
        stepdown: 0.3,
        clearance: 10,
        retract: 2,
        ...feedDefaults(tool),
    }),
    parameters: () => ENGRAVE_PARAMETERS,
    generate: generateEngrave,
};

export const vcarveOperation: CamOperationHandler = {
    type: "vcarve",
    label: "V-carve",
    category: "2d",
    machineKinds: ["mill"],
    selects: ["sketch", "face"],
    defaults: (_machine, tool) => ({
        maxDepth: 0,
        step: 0.1,
        clearance: 10,
        retract: 2,
        ...feedDefaults(tool),
    }),
    parameters: () => VCARVE_PARAMETERS,
    generate: generateVCarve,
};
