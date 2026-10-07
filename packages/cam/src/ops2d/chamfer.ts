// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IShape, type ISolid, Result, ShapeTypes } from "@chili3d/core";
import { fitArcs } from "../geometry2d/arcs";
import { offset, regionLoops } from "../geometry2d/clip";
import { nearestNeighborOrder } from "../geometry2d/order";
import { type Path2, pathPointAt, reversePath } from "../geometry2d/path";
import { add, normalize, type Point2, perpLeft, scale, sub } from "../geometry2d/vec";
import type { CamOperationContext, CamOperationHandler, CamParameterSpec } from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolData } from "../model/tool";
import type { ToolpathData } from "../model/toolpath";
import {
    FEED_PARAMETERS,
    feedDefaults,
    feedsOf,
    HEIGHT_PARAMETERS,
    heightsOf,
    LEAD_OPTIONS,
    toolpathOf,
} from "./common";
import { type Profile, selectionGeometry } from "./geometry";
import { MoveBuilder } from "./moves";
import { ParamReader } from "./params";
import { bestStart, emitContour, offsetOpenPolyline } from "./passes";

/**
 * Chamfer / deburr: a chamfer mill (or V-bit, spot drill) runs along top edges with its
 * cone cutting a 45° (or the tool's half angle) chamfer of the given width. The tip goes
 * `tipOffset` below the chamfer's bottom so the cone, not the point, cuts; the tool centre
 * then runs `tipOffset · tan(α)` off the edge on the air side. The air side comes from the
 * parts (a point beside the edge inside a solid is material), or from the side parameter.
 */

export const CHAMFER_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "width", label: "Chamfer width", kind: "length", min: 0 },
    { key: "tipOffset", label: "Tip offset", kind: "length", min: 0 },
    {
        key: "side",
        label: "Material side",
        kind: "enum",
        options: [
            { value: "auto", label: "From the parts" },
            { value: "inside", label: "Inside / left" },
            { value: "outside", label: "Outside / right" },
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
    { key: "leadIn", label: "Lead-in", kind: "enum", options: [...LEAD_OPTIONS] },
    ...HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
];

/** The tool's half angle (radians): 45° for a 90° chamfer mill. */
export function halfAngle(tool: ToolData): number {
    return ((tool.tipAngle ?? 90) * Math.PI) / 360;
}

function solids(parts: readonly IShape[]): ISolid[] {
    return parts.flatMap((part) =>
        part.shapeType === ShapeTypes.solid
            ? [part as ISolid]
            : (part.findSubShapes(ShapeTypes.solid) as ISolid[]),
    );
}

/** Whether the material lies left of the polyline's first segment (probing the parts). */
function materialOnLeft(points: readonly Point2[], z: number, parts: readonly ISolid[]): boolean | undefined {
    if (parts.length === 0 || points.length < 2) return undefined;
    const a = points[0];
    const b = points[1];
    const mid: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const left = perpLeft(normalize(sub(b, a)));
    const probe = (side: number) => {
        const p = add(mid, scale(left, side * 0.05));
        const point = { x: p[0], y: p[1], z: z - 0.05 };
        return parts.some((solid) => solid.containsPoint(point as never, false, 1e-5));
    };
    const l = probe(1);
    const r = probe(-1);
    if (l === r) return undefined;
    return l;
}

export function generateChamfer(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const tool = context.tool;
    const alpha = halfAngle(tool);
    const width = Math.max(0, p.num("width", 0.5));
    const tipOffset = Math.max(0, p.num("tipOffset", 0.5));
    const depth = width / Math.tan(alpha) + tipOffset;
    if (depth * Math.tan(alpha) > tool.diameter / 2 + 1e-9) {
        return Result.err(`A ${width} mm chamfer is too wide for a Ø${tool.diameter} tool`);
    }
    const along = tipOffset * Math.tan(alpha);
    const sideParam = p.pick("side", ["auto", "inside", "outside"] as const, "auto");
    const climb = p.pick("direction", ["climb", "conventional"] as const, "climb") === "climb";
    const geometry = selectionGeometry(context);
    const bodies = solids(context.parts);

    const jobs: { path: Path2; z: number }[] = [];
    // The tool travels with the material on its right (climb) or left (conventional).
    const orient = (path: Path2, materialLeft: boolean) =>
        materialLeft === climb ? reversePath(path) : path;
    for (const region of geometry.regions.filter((r) => r.source === "face")) {
        // Region loops have the material on their left; grow the material to reach the air side.
        for (const loop of along > 1e-9 ? offset(regionLoops(region), along) : regionLoops(region)) {
            jobs.push({ path: bestStart(orient(fitArcs(loop, true), true)), z: region.z });
        }
    }
    const loose: Profile[] = [...geometry.closed.filter((c) => c.source !== "face"), ...geometry.open];
    for (const profile of loose) {
        const auto = materialOnLeft(profile.points, profile.z, bodies);
        // Closed profiles are counter-clockwise: without parts the material is taken inside.
        const materialLeft = sideParam === "inside" ? true : sideParam === "outside" ? false : (auto ?? true);
        if (profile.closed) {
            // Material inside: the air is outside, grow; material outside (a hole's rim): shrink.
            const loops =
                along > 1e-9
                    ? offset([profile.points], materialLeft ? along : -along)
                    : [profile.points as Point2[]];
            for (const loop of loops)
                jobs.push({ path: bestStart(orient(fitArcs(loop, true), materialLeft)), z: profile.z });
            continue;
        }
        const path = offsetOpenPolyline(profile.points, materialLeft ? -along : along);
        if (path.segments.length > 0) jobs.push({ path: orient(path, materialLeft), z: profile.z });
    }
    if (jobs.length === 0) return Result.err("Select top edges, faces or a sketch to chamfer");

    const feeds = feedsOf(p, tool, context.machine);
    const heights = heightsOf(p, context);
    const leadKind = p.pick("leadIn", ["arc", "line", "none"] as const, "arc");
    const builder = new MoveBuilder();
    builder.comment(`${operation.name}: chamfer ${width} mm, tool ${tool.tipAngle ?? 90}°`);
    const ordered = nearestNeighborOrder(jobs, [context.stock.min[0], context.stock.min[1]], (job) =>
        pathPointAt(job.path, 0),
    );
    ordered.forEach((job, i) => {
        const z = job.z - depth;
        const lead = {
            inKind: leadKind,
            inSize: tool.diameter / 4,
            outKind: leadKind,
            outSize: tool.diameter / 4,
            side: (climb ? 1 : -1) as 1 | -1,
        };
        emitContour(
            builder,
            { path: job.path, levels: [z], top: job.z, heights, feeds, lead, entry: "plunge", rampAngle: 3 },
            i === 0,
        );
    });
    builder.retract(heights.clearance);
    return Result.ok(toolpathOf(builder, operation, context, feeds));
}

export const chamferOperation: CamOperationHandler = {
    type: "chamfer2d",
    label: "Chamfer / deburr",
    category: "2d",
    machineKinds: ["mill"],
    selects: ["edge", "face", "sketch"],
    defaults: (_machine, tool) => ({
        width: 0.5,
        tipOffset: 0.5,
        side: "auto",
        direction: "climb",
        leadIn: "arc",
        clearance: 10,
        retract: 2,
        ...feedDefaults(tool),
    }),
    parameters: () => CHAMFER_PARAMETERS,
    generate: generateChamfer,
};
