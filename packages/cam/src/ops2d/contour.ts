// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { fitArcs } from "../geometry2d/arcs";
import { offset, regionLoops } from "../geometry2d/clip";
import type { LeadKind } from "../geometry2d/leads";
import { nearestNeighborOrder } from "../geometry2d/order";
import { type Path2, pathLength, pathPointAt, reversePath } from "../geometry2d/path";
import { isCounterClockwise } from "../geometry2d/polygon";
import { tabCenters, tabIntervals } from "../geometry2d/tabs";
import type { Point2 } from "../geometry2d/vec";
import type { CamOperationContext, CamOperationHandler, CamParameterSpec } from "../model/operation";
import type { CamOperationData } from "../model/setup";
import { type ToolData, toolRadius } from "../model/tool";
import type { ToolpathData } from "../model/toolpath";
import {
    depthLevels,
    FEED_PARAMETERS,
    feedDefaults,
    feedsOf,
    HEIGHT_PARAMETERS,
    heightsOf,
    LEAD_OPTIONS,
    toolpathOf,
} from "./common";
import { type Profile, type SelectionGeometry, selectionGeometry, stockBottom } from "./geometry";
import { MoveBuilder } from "./moves";
import { ParamReader, when } from "./params";
import { bestStart, emitContour, offsetOpenPolyline } from "./passes";

/**
 * 2D contour (profile): the tool runs along picked edges, sketch loops or the outer boundary
 * of picked faces — outside, inside or on the line — with the cutter radius (plus stock to
 * leave) offset into the path, at levels stepping down to the floor, then an optional
 * finishing pass. Climb milling keeps the material on the right of the tool (G41).
 */

type Side = "outside" | "inside" | "on";

/** One profile to cut: its tool-centre path (in travel order) and where its floor is. */
interface ContourJob {
    readonly path: Path2;
    /** The finishing pass path (same direction), when a finish pass is asked for. */
    readonly finish?: Path2;
    readonly z: number;
    /** Free side of the path: +1 left of travel. */
    readonly side: 1 | -1;
    /** The control-compensation side of the path, for the G41/G42 note. */
    readonly compensation: "G41" | "G42";
}

export interface ContourSettings {
    readonly side: Side;
    readonly chainSide: "left" | "right" | "on";
    readonly climb: boolean;
    readonly radialOffset: number;
    readonly finishStock: number;
    readonly includeHoles: boolean;
}

function closedJobs(profiles: readonly Profile[], s: ContourSettings): Result<ContourJob[]> {
    const jobs: ContourJob[] = [];
    for (const profile of profiles) {
        const sign = s.side === "outside" ? 1 : s.side === "inside" ? -1 : 0;
        const rough = sign * (s.radialOffset + s.finishStock);
        const fine = sign * s.radialOffset;
        const loopsAt = (delta: number) =>
            Math.abs(delta) < 1e-9 ? [profile.points as Point2[]] : offset([profile.points], delta);
        const roughLoops = loopsAt(rough);
        if (roughLoops.length === 0) {
            return Result.err(
                `The tool does not fit inside a ${profile.source === "face" ? "face" : "profile"} (inside contour)`,
            );
        }
        const finishLoops = s.finishStock > 1e-9 ? loopsAt(fine) : [];
        jobs.push(...loopJobs(roughLoops, finishLoops, profile.z, s, s.side !== "inside"));
    }
    return Result.ok(jobs);
}

/**
 * Jobs for offset loops oriented by the region convention (outer CCW, holes CW). With
 * `materialInside` the material lies inside each outer loop (left of its CCW travel):
 * climb milling, with the material on the right, reverses the loops.
 */
function loopJobs(
    roughLoops: readonly Point2[][],
    finishLoops: readonly Point2[][],
    z: number,
    s: ContourSettings,
    materialInside: boolean,
): ContourJob[] {
    const reverse = materialInside === s.climb;
    const make = (loop: Point2[]) => {
        const path = fitArcs(loop, true);
        return reverse ? reversePath(path) : path;
    };
    // The material is on the right when climbing: the free side is on the left (+1).
    const side: 1 | -1 = s.climb ? 1 : -1;
    const compensation = s.climb ? "G41" : "G42";
    return roughLoops.map((loop) => {
        const path = bestStart(make(loop));
        const start = pathPointAt(path, 0);
        const ccw = isCounterClockwise(loop);
        // Pair the finishing loop of the same orientation nearest to this loop's start.
        const candidates = finishLoops.filter((f) => isCounterClockwise(f) === ccw).map(make);
        const finish = candidates
            .map((c) => bestStart(c))
            .sort((a, b) => distanceTo(a, start) - distanceTo(b, start))[0];
        return { path, z, side, compensation, ...(finish !== undefined ? { finish } : {}) };
    });
}

const distanceTo = (path: Path2, p: Point2) => {
    const q = pathPointAt(path, 0);
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
};

function regionJobs(geometry: SelectionGeometry, s: ContourSettings): ContourJob[] {
    const jobs: ContourJob[] = [];
    for (const region of geometry.regions) {
        const sign = s.side === "inside" ? -1 : s.side === "outside" ? 1 : 0;
        const loops = regionLoops(region);
        const at = (delta: number) => (Math.abs(delta) < 1e-9 ? loops : offset(loops, delta));
        const rough = at(sign * (s.radialOffset + s.finishStock));
        const fine = s.finishStock > 1e-9 ? at(sign * s.radialOffset) : [];
        // Region loops keep the material on their left: outward offsets have it inside.
        jobs.push(...loopJobs(rough, fine, region.z, s, s.side !== "inside"));
    }
    return jobs;
}

function openJobs(profiles: readonly Profile[], s: ContourSettings): ContourJob[] {
    return profiles.map((profile) => {
        const sign = s.chainSide === "left" ? 1 : s.chainSide === "right" ? -1 : 0;
        const path = offsetOpenPolyline(profile.points, sign * (s.radialOffset + s.finishStock));
        const finish =
            s.finishStock > 1e-9 ? offsetOpenPolyline(profile.points, sign * s.radialOffset) : undefined;
        // The tool on the left of the chain has the material on its right (climb) as it goes.
        const travelsClimb = sign >= 0;
        const flip = travelsClimb !== s.climb;
        const p = flip ? reversePath(path) : path;
        const f = finish !== undefined && flip ? reversePath(finish) : finish;
        const side: 1 | -1 = s.climb ? 1 : -1;
        return {
            path: p,
            z: profile.z,
            side,
            compensation: s.climb ? "G41" : "G42",
            ...(f ? { finish: f } : {}),
        };
    });
}

function tabsFor(path: Path2, count: number, width: number, tool: ToolData) {
    if (!path.closed || count <= 0 || width <= 0) return [];
    const total = pathLength(path);
    return tabIntervals(total, tabCenters(total, count), width + tool.diameter);
}

export const CONTOUR_PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "side",
        label: "Side",
        kind: "enum",
        options: [
            { value: "outside", label: "Outside" },
            { value: "inside", label: "Inside" },
            { value: "on", label: "On the line" },
        ],
    },
    {
        key: "chainSide",
        label: "Open chain side",
        kind: "enum",
        options: [
            { value: "left", label: "Left" },
            { value: "right", label: "Right" },
            { value: "on", label: "On" },
        ],
        description: "For open chains of edges or sketch lines",
    },
    {
        key: "includeHoles",
        label: "Contour holes too",
        kind: "boolean",
        description: "Inner boundaries of faces and nested loops",
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
        key: "compensation",
        label: "Compensation",
        kind: "enum",
        options: [
            { value: "computer", label: "In computer" },
            { value: "control", label: "In control (G41/G42)" },
        ],
    },
    {
        key: "bottomFrom",
        label: "Bottom",
        kind: "enum",
        options: [
            { value: "geometry", label: "Selected geometry" },
            { value: "depth", label: "Depth below top" },
            { value: "stockBottom", label: "Through the stock" },
        ],
    },
    { key: "depth", label: "Depth", kind: "length", min: 0, visibleWhen: when("bottomFrom", "depth") },
    {
        key: "breakthrough",
        label: "Breakthrough",
        kind: "length",
        min: 0,
        visibleWhen: when("bottomFrom", "stockBottom"),
    },
    { key: "stepdown", label: "Stepdown", kind: "length", min: 0 },
    { key: "stockToLeave", label: "Stock to leave", kind: "length" },
    { key: "floorStock", label: "Floor stock", kind: "length", min: 0 },
    { key: "finishPass", label: "Finishing pass", kind: "boolean" },
    {
        key: "finishStock",
        label: "Finishing stock",
        kind: "length",
        min: 0,
        visibleWhen: when("finishPass", true),
    },
    { key: "tabCount", label: "Tabs", kind: "integer", min: 0 },
    { key: "tabWidth", label: "Tab width", kind: "length", min: 0 },
    { key: "tabHeight", label: "Tab height", kind: "length", min: 0 },
    { key: "leadIn", label: "Lead-in", kind: "enum", options: [...LEAD_OPTIONS] },
    { key: "leadOut", label: "Lead-out", kind: "enum", options: [...LEAD_OPTIONS] },
    { key: "leadRadius", label: "Lead radius / length", kind: "length", min: 0 },
    {
        key: "overlap",
        label: "Overlap",
        kind: "length",
        min: 0,
        description: "Cut past the start of closed contours",
    },
    {
        key: "entry",
        label: "Entry",
        kind: "enum",
        options: [
            { value: "plunge", label: "Plunge" },
            { value: "ramp", label: "Ramp along the contour" },
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

export function contourSettings(p: ParamReader, tool: ToolData): ContourSettings {
    const compensation = p.pick("compensation", ["computer", "control"] as const, "computer");
    const radius = compensation === "control" ? 0 : toolRadius(tool);
    const side = p.pick("side", ["outside", "inside", "on"] as const, "outside");
    const stock = p.num("stockToLeave", 0);
    return {
        side,
        chainSide: p.pick("chainSide", ["left", "right", "on"] as const, "on"),
        climb: p.pick("direction", ["climb", "conventional"] as const, "climb") === "climb",
        radialOffset: side === "on" ? stock : radius + stock,
        finishStock: p.bool("finishPass", false) ? Math.max(0, p.num("finishStock", 0.2)) : 0,
        includeHoles: p.bool("includeHoles", false),
    };
}

export function generateContour(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const tool = context.tool;
    const settings = contourSettings(p, tool);
    const geometry = selectionGeometry(context);
    if (geometry.closed.length === 0 && geometry.open.length === 0) {
        return Result.err("Select edges, a sketch or faces to contour");
    }
    let jobs: ContourJob[] = [];
    if (settings.includeHoles) {
        jobs.push(...regionJobs(geometry, settings));
        // Closed edge chains and loops not part of a region are already in the regions.
    } else {
        // Without hole contouring, flat-pattern holes and marks are not profiles of their own.
        const profiles = geometry.closed.filter(
            (profile) => profile.role !== "hole" && profile.role !== "bend" && profile.role !== "mark",
        );
        const closed = closedJobs(profiles, settings);
        if (!closed.isOk) return Result.err(closed.error);
        jobs.push(...closed.value);
    }
    jobs.push(
        ...openJobs(
            geometry.open.filter((profile) => profile.role !== "bend" && profile.role !== "mark"),
            settings,
        ),
    );
    jobs = jobs.filter((job) => job.path.segments.length > 0);
    if (jobs.length === 0) return Result.err("Nothing to cut: the offset contours vanished");

    const feeds = feedsOf(p, tool, context.machine);
    const heights = heightsOf(p, context);
    const stepdown = p.num("stepdown", tool.cutting.stepdown ?? tool.diameter);
    const floorStock = Math.max(0, p.num("floorStock", 0));
    const bottomFrom = p.pick("bottomFrom", ["geometry", "depth", "stockBottom"] as const, "geometry");
    const bottomOf = (job: ContourJob) =>
        bottomFrom === "depth"
            ? heights.top - Math.max(0, p.num("depth", 5)) + floorStock
            : bottomFrom === "stockBottom"
              ? stockBottom(context) - Math.max(0, p.num("breakthrough", 0.5))
              : job.z + floorStock;
    const leadSize = Math.max(0, p.num("leadRadius", toolRadius(tool)));
    const inKind = p.pick<LeadKind>("leadIn", ["arc", "line", "none"], "arc");
    const outKind = p.pick<LeadKind>("leadOut", ["arc", "line", "none"], inKind);
    const tabCount = Math.max(0, p.int("tabCount", 0));
    const tabWidth = Math.max(0, p.num("tabWidth", 5));
    const tabHeight = Math.max(0, p.num("tabHeight", 2));
    const entry = p.pick("entry", ["plunge", "ramp"] as const, "plunge");
    const rampAngle = p.num("rampAngle", 3);
    const overlap = Math.max(0, p.num("overlap", 0));
    const control = p.pick("compensation", ["computer", "control"] as const, "computer") === "control";

    const builder = new MoveBuilder();
    builder.comment(`${operation.name}: contour ${settings.side}, tool Ø${tool.diameter}`);
    const ordered = nearestNeighborOrder(jobs, [context.stock.min[0], context.stock.min[1]], (job) =>
        pathPointAt(job.path, 0),
    );
    let first = true;
    for (const job of ordered) {
        const bottom = bottomOf(job);
        if (bottom >= heights.top - 1e-9) {
            return Result.err("Nothing to cut: the floor is at or above the top (set a depth below the top)");
        }
        const levels = depthLevels(heights.top, bottom, stepdown);
        const tabs = { intervals: tabsFor(job.path, tabCount, tabWidth, tool), top: bottom + tabHeight };
        if (control)
            builder.comment(
                `Cutter compensation ${job.compensation} (${job.compensation === "G41" ? "left" : "right"}), D${tool.number}`,
            );
        const lead = { inKind, inSize: leadSize, outKind, outSize: leadSize, side: job.side };
        emitContour(
            builder,
            {
                path: job.path,
                levels,
                top: heights.top,
                heights,
                feeds,
                lead,
                entry,
                rampAngle,
                tabs,
                overlap,
            },
            first,
        );
        first = false;
        if (job.finish !== undefined) {
            builder.comment("Finishing pass");
            const finishTabs = {
                intervals: tabsFor(job.finish, tabCount, tabWidth, tool),
                top: bottom + tabHeight,
            };
            emitContour(
                builder,
                {
                    path: job.finish,
                    levels: [bottom],
                    top: heights.top,
                    heights,
                    feeds,
                    lead,
                    entry: "plunge",
                    rampAngle,
                    tabs: finishTabs,
                    overlap,
                },
                false,
            );
        }
    }
    builder.retract(heights.clearance);
    return Result.ok(toolpathOf(builder, operation, context, feeds));
}

export const contourOperation: CamOperationHandler = {
    type: "contour2d",
    label: "2D contour",
    category: "2d",
    machineKinds: ["mill"],
    selects: ["edge", "face", "sketch"],
    defaults: (_machine, tool) => ({
        side: "outside",
        chainSide: "on",
        includeHoles: false,
        direction: "climb",
        compensation: "computer",
        bottomFrom: "geometry",
        depth: 5,
        breakthrough: 0.5,
        stepdown: tool?.cutting.stepdown ?? tool?.diameter ?? 3,
        stockToLeave: 0,
        floorStock: 0,
        finishPass: false,
        finishStock: 0.2,
        tabCount: 0,
        tabWidth: 5,
        tabHeight: 2,
        leadIn: "arc",
        leadOut: "arc",
        leadRadius: tool !== undefined ? tool.diameter / 2 : 3,
        overlap: 0,
        entry: "plunge",
        rampAngle: 3,
        clearance: 10,
        retract: 2,
        ...feedDefaults(tool),
    }),
    parameters: () => CONTOUR_PARAMETERS,
    generate: generateContour,
};
