// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { fitCircle } from "../geometry2d/arcs";
import { shortPathOrder } from "../geometry2d/order";
import type { Point2 } from "../geometry2d/vec";
import type { CamOperationContext, CamOperationHandler, CamParameterSpec } from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolData } from "../model/tool";
import type { ToolpathData, ToolpathMove } from "../model/toolpath";
import { FEED_PARAMETERS, feedDefaults, feedsOf, HEIGHT_PARAMETERS, heightsOf, toolpathOf } from "./common";
import { circleOfEdge, stockBottom } from "./geometry";
import { detectHoles, type Hole, holesFromCircles, holesFromFaces, holesFromRims } from "./holes";
import { MoveBuilder } from "./moves";
import { ParamReader, when } from "./params";

/**
 * Drilling: canned cycles at vertical holes — recognized in the parts (cylindrical faces:
 * center, diameter, top, bottom, through or blind), or from picked hole faces, circular edges
 * or sketch circles — visited in a short order. Each hole is one `drill` move: `at` is the
 * hole's rim (x, y, top), `depth` how far below `at` the tool tip goes, `retract` the
 * absolute Z of the R plane.
 */

type Cycle = "drill" | "peck" | "chipBreak" | "tap" | "bore";

export const DRILL_PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "cycle",
        label: "Cycle",
        kind: "enum",
        options: [
            { value: "drill", label: "Drill (G81/G82)" },
            { value: "peck", label: "Deep peck (G83)" },
            { value: "chipBreak", label: "Chip break (G73)" },
            { value: "tap", label: "Tap (G84)" },
            { value: "bore", label: "Bore (G85/G86)" },
        ],
    },
    {
        key: "peck",
        label: "Peck depth",
        kind: "length",
        min: 0,
        visibleWhen: when("cycle", "peck", "chipBreak"),
    },
    { key: "dwell", label: "Dwell", kind: "number", min: 0, description: "Seconds at the bottom" },
    { key: "retractOffset", label: "R plane above hole", kind: "length", min: 0 },
    {
        key: "depthFrom",
        label: "Depth",
        kind: "enum",
        options: [
            { value: "hole", label: "Hole bottom" },
            { value: "depth", label: "Fixed depth" },
        ],
    },
    {
        key: "depth",
        label: "Depth below the rim",
        kind: "length",
        min: 0,
        visibleWhen: when("depthFrom", "depth"),
    },
    {
        key: "tipCompensation",
        label: "Full diameter to depth",
        kind: "boolean",
        description: "Adds the drill point length",
    },
    {
        key: "breakthrough",
        label: "Breakthrough",
        kind: "length",
        min: 0,
        description: "Below through holes",
    },
    {
        key: "spotDrill",
        label: "Spot drill",
        kind: "boolean",
        description: "Spot each hole with a chamfer instead",
    },
    {
        key: "spotChamfer",
        label: "Spot chamfer",
        kind: "length",
        min: 0,
        visibleWhen: when("spotDrill", true),
    },
    { key: "minDiameter", label: "Smallest hole", kind: "length", min: 0 },
    { key: "maxDiameter", label: "Largest hole", kind: "length", min: 0, description: "0: no limit" },
    ...HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
];

function defaultCycle(tool?: ToolData): Cycle {
    if (tool?.kind === "tap") return "tap";
    return "drill";
}

/** Length of the drill point: the cone below the full diameter. */
export function tipLength(tool: ToolData): number {
    const angle = tool.tipAngle ?? (tool.kind === "spotDrill" ? 90 : tool.kind === "drill" ? 118 : 180);
    if (angle >= 179.9) return 0;
    return tool.diameter / 2 / Math.tan((angle * Math.PI) / 360);
}

/**
 * The holes an operation drills: picked faces, edges or sketch circles, else every hole of the
 * parts. Picked circles are `depth` deep or — given `rimBottom`, when drilling to the hole
 * bottom — the part hole they lie on, else holes down to `rimBottom`.
 */
export function operationHoles(context: CamOperationContext, depth: number, rimBottom?: number): Hole[] {
    const faces = context.selectedFaces();
    if (faces.length > 0) {
        const fromFaces = holesFromFaces(faces, context.parts);
        if (fromFaces.length > 0) return fromFaces;
    }
    const circles: { center: Point2; radius: number; z: number }[] = [];
    for (const edge of context.selectedEdges()) {
        const circle = circleOfEdge(edge);
        if (circle !== undefined) circles.push(circle);
    }
    for (const loop of context.selectedLoops()) {
        if (!loop.closed) continue;
        const circle = fitCircle(
            loop.points.map((p) => [p[0], p[1]] as Point2),
            0.01,
        );
        if (circle !== undefined) circles.push({ ...circle, z: loop.z ?? 0 });
    }
    if (circles.length > 0)
        return rimBottom === undefined
            ? holesFromCircles(circles, depth)
            : holesFromRims(circles, context.parts, rimBottom);
    if (faces.length > 0 || context.selectedEdges().length > 0) return [];
    return detectHoles(context.parts);
}

export function generateDrill(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const tool = context.tool;
    const depthFrom = p.pick("depthFrom", ["hole", "depth"] as const, "hole");
    const fixedDepth = Math.max(0, p.num("depth", 10));
    const minDiameter = Math.max(0, p.num("minDiameter", 0));
    const maxDiameter = Math.max(0, p.num("maxDiameter", 0));
    const holes = operationHoles(
        context,
        depthFrom === "depth" ? fixedDepth : context.stock.max[2] - stockBottom(context),
        depthFrom === "depth" ? undefined : stockBottom(context),
    ).filter(
        (hole) =>
            hole.diameter >= minDiameter - 1e-9 && (maxDiameter <= 0 || hole.diameter <= maxDiameter + 1e-9),
    );
    if (holes.length === 0)
        return Result.err("No holes to drill: pick hole faces, circular edges or sketch circles");

    const feeds = feedsOf(p, tool, context.machine);
    const heights = heightsOf(p, context);
    const spot = p.bool("spotDrill", tool.kind === "spotDrill");
    const cycle = spot
        ? "drill"
        : p.pick<Cycle>("cycle", ["drill", "peck", "chipBreak", "tap", "bore"], defaultCycle(tool));
    const peck = Math.max(0.01, p.num("peck", tool.diameter));
    const dwell = Math.max(0, p.num("dwell", 0));
    const retractOffset = Math.max(0, p.num("retractOffset", 2));
    const breakthrough = Math.max(0, p.num("breakthrough", 1));
    const tipCompensation = p.bool("tipCompensation", true);
    const spotChamfer = Math.max(0, p.num("spotChamfer", 0.2));
    let feed = feeds.feed;
    if (cycle === "tap") {
        if (tool.pitch === undefined || tool.pitch <= 0) return Result.err("Tapping needs the tap's pitch");
        if (feeds.rpm === undefined) return Result.err("Tapping needs a spindle speed");
        feed = feeds.rpm * tool.pitch;
    }

    const depthOf = (hole: Hole) => {
        if (spot) {
            const angle = tool.tipAngle ?? 90;
            return (hole.diameter / 2 + spotChamfer) / Math.tan((angle * Math.PI) / 360);
        }
        if (depthFrom === "depth") return fixedDepth;
        const length = hole.top - hole.bottom;
        if (!hole.through) return length;
        return length + breakthrough + (tipCompensation ? tipLength(tool) : 0);
    };

    const centers = holes.map((hole) => hole.center);
    const order = shortPathOrder(centers, [context.stock.min[0], context.stock.min[1]]);
    const builder = new MoveBuilder();
    builder.comment(
        `${operation.name}: ${spot ? "spot drill" : cycle} ${holes.length} hole${holes.length === 1 ? "" : "s"}, tool Ø${tool.diameter}`,
    );
    let first = true;
    for (const index of order) {
        const hole = holes[index];
        // Between holes the tool travels just above the stock (every hole rim is below its top).
        const above = Math.max(heights.retract, hole.top + retractOffset);
        builder.rapidTo(hole.center, above, first ? heights.clearance : above);
        first = false;
        const move: ToolpathMove = {
            kind: "drill",
            at: [hole.center[0], hole.center[1], hole.top],
            depth: depthOf(hole),
            retract: hole.top + retractOffset,
            cycle,
            ...(cycle === "peck" || cycle === "chipBreak" ? { peck } : {}),
            ...(dwell > 0 ? { dwell } : {}),
            feed,
        };
        builder.push(move);
        builder.rapid([hole.center[0], hole.center[1], Math.max(heights.retract, hole.top + retractOffset)]);
    }
    builder.retract(heights.clearance);
    return Result.ok(toolpathOf(builder, operation, context, feeds));
}

export const drillOperation: CamOperationHandler = {
    type: "drill",
    label: "Drill",
    category: "2d",
    machineKinds: ["mill"],
    selects: ["face", "edge", "sketch", "body"],
    defaults: (_machine, tool) => ({
        cycle: defaultCycle(tool),
        peck: tool?.diameter ?? 3,
        dwell: 0,
        retractOffset: 2,
        depthFrom: "hole",
        depth: 10,
        tipCompensation: true,
        breakthrough: 1,
        spotDrill: tool?.kind === "spotDrill",
        spotChamfer: 0.2,
        minDiameter: 0,
        maxDiameter: 0,
        clearance: 10,
        retract: 2,
        ...feedDefaults(tool),
    }),
    parameters: () => DRILL_PARAMETERS,
    generate: generateDrill,
};
