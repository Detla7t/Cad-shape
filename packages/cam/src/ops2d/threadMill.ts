// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { shortPathOrder } from "../geometry2d/order";
import { add, type Point2 } from "../geometry2d/vec";
import type { CamOperationContext, CamOperationHandler, CamParameterSpec } from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolpathData } from "../model/toolpath";
import { FEED_PARAMETERS, feedDefaults, feedsOf, HEIGHT_PARAMETERS, heightsOf, toolpathOf } from "./common";
import { operationHoles } from "./drill";
import type { Hole } from "./holes";
import { MoveBuilder } from "./moves";
import { ParamReader, when } from "./params";

/**
 * Thread milling: a helical interpolation at the thread's diameter, one pitch of Z per turn,
 * entered and left on tangent half circles from the hole's centre (internal) or from outside
 * (external). Right-hand climb milling goes counter-clockwise upward inside a hole and
 * clockwise downward around a stud; left-hand threads and conventional milling flip it.
 * ISO metric depths: an internal thread's major diameter is the drilled diameter plus
 * 1.0825·P; an external one is cut down to its minor diameter, major − 1.2269·P.
 */

export const THREAD_PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "threadType",
        label: "Thread",
        kind: "enum",
        options: [
            { value: "internal", label: "Internal" },
            { value: "external", label: "External" },
        ],
    },
    { key: "pitch", label: "Pitch", kind: "length", min: 0 },
    {
        key: "diameter",
        label: "Major diameter",
        kind: "length",
        min: 0,
        description: "0: from the hole and pitch",
    },
    { key: "length", label: "Thread length", kind: "length", min: 0, description: "0: the hole's depth" },
    {
        key: "hand",
        label: "Hand",
        kind: "enum",
        options: [
            { value: "right", label: "Right" },
            { value: "left", label: "Left" },
        ],
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
    { key: "radialPasses", label: "Radial passes", kind: "integer", min: 1 },
    {
        key: "depth",
        label: "Depth at picked circles",
        kind: "length",
        min: 0,
        visibleWhen: when("threadType", "external"),
    },
    ...HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
];

export const ISO_INTERNAL = 1.0825;
export const ISO_EXTERNAL = 1.2269;

export function generateThreadMill(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const tool = context.tool;
    const r = tool.diameter / 2;
    const internal = p.pick("threadType", ["internal", "external"] as const, "internal") === "internal";
    const pitch = p.num("pitch", tool.pitch ?? 1.5);
    if (pitch <= 0) return Result.err("Set the thread pitch");
    const holes = operationHoles(context, Math.max(0, p.num("depth", 10)));
    if (holes.length === 0) return Result.err("Pick hole faces, circular edges or sketch circles to thread");
    const rightHand = p.pick("hand", ["right", "left"] as const, "right") === "right";
    const climb = p.pick("direction", ["climb", "conventional"] as const, "climb") === "climb";
    const passes = Math.max(1, p.int("radialPasses", 1));
    const feeds = feedsOf(p, tool, context.machine);
    const heights = heightsOf(p, context);

    // Internal climb is counter-clockwise, external climb clockwise; a right-hand helix rises
    // when counter-clockwise.
    const ccw = internal === climb;
    const upward = ccw === rightHand;

    const builder = new MoveBuilder();
    builder.comment(
        `${operation.name}: ${internal ? "internal" : "external"} thread, pitch ${pitch}, ${rightHand ? "RH" : "LH"}`,
    );
    const order = shortPathOrder(
        holes.map((h) => h.center),
        [context.stock.min[0], context.stock.min[1]],
    );
    let first = true;
    for (const index of order) {
        const hole: Hole = holes[index];
        const major =
            p.num("diameter", 0) > 0
                ? p.num("diameter", 0)
                : internal
                  ? hole.diameter + ISO_INTERNAL * pitch
                  : hole.diameter;
        const finalRadius = internal ? major / 2 - r : (major - ISO_EXTERNAL * pitch) / 2 + r;
        if (finalRadius <= 1e-3 || (internal && hole.diameter / 2 - r <= 0)) {
            return Result.err(`The thread mill Ø${tool.diameter} is too large for a Ø${major} thread`);
        }
        // Radial passes start where the tool just touches: the drilled wall, or the stud's major diameter.
        const startRadius = internal ? Math.min(finalRadius, hole.diameter / 2 - r) : major / 2 + r;
        const length = p.num("length", 0) > 0 ? p.num("length", 0) : hole.top - hole.bottom;
        const zBottom = hole.top - length;
        const c = hole.center;
        for (let pass = 1; pass <= passes; pass++) {
            const radius =
                passes === 1 ? finalRadius : startRadius + ((finalRadius - startRadius) * pass) / passes;
            // Whole half turns at the exact pitch: down-cuts start high enough to end at the bottom.
            const halfTurns = Math.max(1, Math.ceil((2 * length) / pitch - 1e-9));
            const travel = (halfTurns * pitch) / 2;
            const z0 = upward ? zBottom : zBottom + travel;
            const dz = upward ? pitch / 2 : -pitch / 2;
            const start: Point2 = add(c, [radius, 0]);
            // Lead-in on a half circle tangent to the helix: from the centre inside a hole
            // (turning with the helix), from outside around a stud (turning against it).
            const leadRadius = internal ? radius / 2 : r + 1;
            const leadCenter: Point2 = add(c, [internal ? radius / 2 : radius + leadRadius, 0]);
            const entry: Point2 = add(leadCenter, [internal ? -leadRadius : leadRadius, 0]);
            builder.rapidTo(entry, heights.retract, first ? heights.clearance : heights.retract);
            first = false;
            builder.linear([entry[0], entry[1], z0], feeds.plunge);
            builder.arc([start[0], start[1], z0], leadCenter, internal ? ccw : !ccw, feeds.feed);
            for (let k = 1; k <= halfTurns; k++) {
                const point = add(c, [radius * Math.cos(Math.PI * k), 0]);
                builder.arc([point[0], point[1], z0 + dz * k], c, ccw, feeds.feed);
            }
            const zEnd = z0 + dz * halfTurns;
            const end: Point2 = add(c, [radius * Math.cos(Math.PI * halfTurns), 0]);
            const outward: Point2 = [(end[0] - c[0]) / radius, (end[1] - c[1]) / radius];
            if (internal) {
                // Back to the centre on a half circle, then straight up the hole.
                builder.arc([c[0], c[1], zEnd], [(end[0] + c[0]) / 2, (end[1] + c[1]) / 2], ccw, feeds.feed);
            } else {
                const center = add(end, [outward[0] * leadRadius, outward[1] * leadRadius]);
                const away = add(end, [outward[0] * 2 * leadRadius, outward[1] * 2 * leadRadius]);
                builder.arc([away[0], away[1], zEnd], center, !ccw, feeds.feed);
            }
            builder.retract(heights.retract);
        }
    }
    builder.retract(heights.clearance);
    return Result.ok(toolpathOf(builder, operation, context, feeds));
}
export const threadMillOperation: CamOperationHandler = {
    type: "threadMill",
    label: "Thread mill",
    category: "2d",
    machineKinds: ["mill"],
    selects: ["face", "edge", "sketch"],
    defaults: (_machine, tool) => ({
        threadType: "internal",
        pitch: tool?.pitch ?? 1.5,
        diameter: 0,
        length: 0,
        hand: "right",
        direction: "climb",
        radialPasses: 1,
        depth: 10,
        clearance: 10,
        retract: 2,
        ...feedDefaults(tool),
    }),
    parameters: () => THREAD_PARAMETERS,
    generate: generateThreadMill,
};
