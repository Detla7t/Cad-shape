// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { fitArcs } from "../geometry2d/arcs";
import { nearestNeighborOrder } from "../geometry2d/order";
import {
    type Path2,
    pathLength,
    pathPointAt,
    reversePath,
    startClosedPathAt,
    subPath,
} from "../geometry2d/path";
import type { CamOperationContext, CamOperationHandler, CamParameterSpec } from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolpathData } from "../model/toolpath";
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
import { flat, MoveBuilder, ramp } from "./moves";
import { ParamReader, when } from "./params";

/**
 * Slotting: the tool centre runs along a line, arc or chain (a slot as wide as the tool),
 * stepping down by ramping back and forth along the slot at most `rampAngle` steep, then
 * cutting it end to end at each level — alternating direction level by level.
 */

export const SLOT_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "depth", label: "Depth", kind: "length", min: 0 },
    { key: "stepdown", label: "Stepdown", kind: "length", min: 0 },
    {
        key: "entry",
        label: "Entry",
        kind: "enum",
        options: [
            { value: "ramp", label: "Ramp along the slot" },
            { value: "plunge", label: "Plunge" },
        ],
    },
    {
        key: "rampAngle",
        label: "Ramp angle",
        kind: "angle",
        min: 0.1,
        max: 89,
        visibleWhen: when("entry", "ramp"),
    },
    ...HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
];

export function generateSlot(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const tool = context.tool;
    const geometry = selectionGeometry(context);
    const chains: { path: Path2; z: number }[] = [
        ...geometry.open.map((c) => ({ path: fitArcs(c.points, false), z: c.z })),
        ...geometry.closed.map((c) => ({ path: fitArcs(c.points, true), z: c.z })),
    ].filter((c) => pathLength(c.path) > 1e-6);
    if (chains.length === 0) return Result.err("Select a line, an arc or a chain of edges to slot");
    const depth = Math.max(0, p.num("depth", 3));
    if (depth <= 0) return Result.err("Set the slot depth");
    const feeds = feedsOf(p, tool, context.machine);
    const heights = heightsOf(p, context);
    const stepdown = p.num("stepdown", tool.cutting.stepdown ?? tool.diameter / 2);
    const rampEntry = p.pick("entry", ["ramp", "plunge"] as const, "ramp") === "ramp";
    const slope = Math.tan((Math.max(0.1, Math.min(89, p.num("rampAngle", 3))) * Math.PI) / 180);
    const builder = new MoveBuilder();
    builder.comment(`${operation.name}: slot ${tool.diameter} mm wide, ${depth} mm deep`);
    const ordered = nearestNeighborOrder(chains, [context.stock.min[0], context.stock.min[1]], (c) =>
        pathPointAt(c.path, 0),
    );
    let first = true;
    for (const chain of ordered) {
        const top = chain.z;
        let forward = chain.path;
        const total = pathLength(forward);
        const start = pathPointAt(forward, 0);
        builder.rapidTo(start, top + 1, first ? heights.clearance : heights.retract);
        first = false;
        builder.linear([start[0], start[1], top], feeds.plunge);
        let above = top;
        for (const z of depthLevels(top, top - depth, stepdown)) {
            if (!rampEntry || forward.closed) {
                if (forward.closed && rampEntry) {
                    // A closed slot ramps around itself.
                    const needed = Math.min(total, (above - z) / slope);
                    builder.follow(ramp(subPath(forward, 0, needed), above, z, feeds.ramp), feeds.feed);
                    builder.follow(flat(subPath(forward, needed, total), z), feeds.feed);
                    builder.follow(flat(subPath(forward, 0, needed), z), feeds.feed);
                    forward = startClosedPathAt(forward, needed);
                } else {
                    builder.plunge(z, feeds.plunge);
                    builder.follow(flat(forward.segments, z), feeds.feed);
                }
            } else {
                // Back and forth along the slot until the level is reached, then end to end.
                const needed = (above - z) / slope;
                const passes = Math.max(1, Math.ceil(needed / total - 1e-9));
                for (let i = 0; i < passes; i++) {
                    builder.follow(
                        ramp(
                            forward.segments,
                            above - ((above - z) * i) / passes,
                            above - ((above - z) * (i + 1)) / passes,
                            feeds.ramp,
                        ),
                        feeds.feed,
                    );
                    forward = reversePath(forward);
                }
                builder.follow(flat(forward.segments, z), feeds.feed);
            }
            if (!forward.closed) forward = reversePath(forward);
            above = z;
        }
        builder.retract(heights.retract);
    }
    builder.retract(heights.clearance);
    return Result.ok(toolpathOf(builder, operation, context, feeds));
}

export const slotOperation: CamOperationHandler = {
    type: "slot",
    label: "Slot",
    category: "2d",
    machineKinds: ["mill"],
    selects: ["edge", "sketch"],
    defaults: (_machine, tool) => ({
        depth: 3,
        stepdown: tool?.cutting.stepdown ?? (tool !== undefined ? tool.diameter / 2 : 1),
        entry: "ramp",
        rampAngle: 3,
        clearance: 10,
        retract: 2,
        ...feedDefaults(tool),
    }),
    parameters: () => SLOT_PARAMETERS,
    generate: generateSlot,
};
