// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { bounds } from "../geometry2d/polygon";
import { type Point2, rotate } from "../geometry2d/vec";
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
import { partsTop } from "./geometry";
import { MoveBuilder } from "./moves";
import { ParamReader, when } from "./params";

/**
 * Facing: parallel passes over the whole stock top, zig-zag or one-way, at an angle, each
 * starting and ending clear of the stock; down to the parts' top (or a depth) in steps,
 * leaving an optional stock allowance.
 */

export const FACE_PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "pattern",
        label: "Pattern",
        kind: "enum",
        options: [
            { value: "zigzag", label: "Zig-zag" },
            { value: "oneWay", label: "One way" },
        ],
    },
    { key: "angle", label: "Pass direction", kind: "angle" },
    {
        key: "stepover",
        label: "Stepover",
        kind: "number",
        min: 1,
        max: 100,
        description: "% of the tool diameter",
    },
    { key: "edgeOverhang", label: "Overhang past the sides", kind: "length", min: 0 },
    {
        key: "bottomFrom",
        label: "Bottom",
        kind: "enum",
        options: [
            { value: "partTop", label: "Top of the parts" },
            { value: "depth", label: "Depth below the stock top" },
        ],
    },
    { key: "depth", label: "Depth", kind: "length", min: 0, visibleWhen: when("bottomFrom", "depth") },
    { key: "stepdown", label: "Stepdown", kind: "length", min: 0 },
    { key: "finishStep", label: "Finishing pass depth", kind: "length", min: 0 },
    { key: "stockToLeave", label: "Stock to leave", kind: "length", min: 0 },
    ...HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
];

export function generateFace(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const tool = context.tool;
    const r = tool.diameter / 2;
    const heights = heightsOf(p, context);
    const feeds = feedsOf(p, tool, context.machine);
    const top = heights.top;
    const stockToLeave = Math.max(0, p.num("stockToLeave", 0));
    const bottomFrom = p.pick("bottomFrom", ["partTop", "depth"] as const, "partTop");
    const partTop = partsTop(context);
    const floor =
        bottomFrom === "depth" || partTop === undefined
            ? top - Math.max(0, p.num("depth", 1))
            : Math.min(partTop, top);
    const bottom = floor + stockToLeave;
    if (bottom >= top - 1e-9)
        return Result.err("Nothing to face: the stock top is already at the bottom (set a depth)");

    const angle = (p.num("angle", 0) * Math.PI) / 180;
    const stepover =
        (tool.diameter *
            Math.max(
                1,
                Math.min(
                    100,
                    p.num(
                        "stepover",
                        tool.cutting.stepover !== undefined
                            ? (100 * tool.cutting.stepover) / tool.diameter
                            : 70,
                    ),
                ),
            )) /
        100;
    const overhang = Math.max(0, p.num("edgeOverhang", tool.diameter * 0.1));
    const oneWay = p.pick("pattern", ["zigzag", "oneWay"] as const, "zigzag") === "oneWay";

    const corners: Point2[] = [
        [context.stock.min[0], context.stock.min[1]],
        [context.stock.max[0], context.stock.min[1]],
        [context.stock.max[0], context.stock.max[1]],
        [context.stock.min[0], context.stock.max[1]],
    ];
    const box = bounds(corners.map((c) => rotate(c, -angle)));
    const clear = r + 2;
    const x0 = box.min[0] - clear;
    const x1 = box.max[0] + clear;
    const y0 = box.min[1] + r - overhang;
    const y1 = box.max[1] - r + overhang;
    const rows: number[] = [];
    if (y1 <= y0) rows.push((box.min[1] + box.max[1]) / 2);
    else {
        const n = Math.max(1, Math.ceil((y1 - y0) / stepover - 1e-9));
        for (let i = 0; i <= n; i++) rows.push(y0 + ((y1 - y0) * i) / n);
    }
    const at = (x: number, y: number): Point2 => rotate([x, y], angle);

    const builder = new MoveBuilder();
    builder.comment(`${operation.name}: face to Z${bottom.toFixed(3)}, tool Ø${tool.diameter}`);
    const levels = depthLevels(
        top,
        bottom,
        p.num("stepdown", tool.cutting.stepdown ?? top - bottom),
        Math.max(0, p.num("finishStep", 0)),
    );
    let first = true;
    for (const z of levels) {
        rows.forEach((y, i) => {
            const forward = oneWay || i % 2 === 0;
            const from = at(forward ? x0 : x1, y);
            const to = at(forward ? x1 : x0, y);
            if (first || oneWay || i === 0) {
                // Start clear of the stock: down at rapid beside it.
                builder.rapidTo(from, z, first ? heights.clearance : heights.retract);
                first = false;
            } else builder.linear([from[0], from[1], z], feeds.feed);
            builder.linear([to[0], to[1], z], feeds.feed);
        });
        builder.retract(heights.retract);
    }
    builder.retract(heights.clearance);
    return Result.ok(toolpathOf(builder, operation, context, feeds));
}

export const faceOperation: CamOperationHandler = {
    type: "face",
    label: "Face",
    category: "2d",
    machineKinds: ["mill"],
    selects: ["body"],
    defaults: (_machine, tool) => ({
        pattern: "zigzag",
        angle: 0,
        stepover: 70,
        edgeOverhang: tool !== undefined ? tool.diameter * 0.1 : 1,
        bottomFrom: "partTop",
        depth: 1,
        stepdown: tool?.cutting.stepdown ?? 1,
        finishStep: 0,
        stockToLeave: 0,
        clearance: 10,
        retract: 2,
        ...feedDefaults(tool),
    }),
    parameters: () => FACE_PARAMETERS,
    generate: generateFace,
};
