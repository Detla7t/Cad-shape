// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { fitArcs } from "../geometry2d/arcs";
import {
    clipPolylines,
    difference,
    offset,
    type Region,
    regionArea,
    regionLoops,
    regions,
} from "../geometry2d/clip";
import { nearestNeighborOrder } from "../geometry2d/order";
import {
    nearestArcLength,
    type Path2,
    pathPointAt,
    pathPoints,
    reversePath,
    startClosedPathAt,
} from "../geometry2d/path";
import { bounds } from "../geometry2d/polygon";
import { distance, type Point2, rotate } from "../geometry2d/vec";
import type { CamOperationContext, CamOperationHandler, CamParameterSpec } from "../model/operation";
import type { CamOperationData } from "../model/setup";
import { toolRadius } from "../model/tool";
import type { ToolpathData } from "../model/toolpath";
import {
    depthLevels,
    FEED_PARAMETERS,
    type Feeds,
    feedDefaults,
    feedsOf,
    HEIGHT_PARAMETERS,
    type Heights,
    heightsOf,
    toolpathOf,
} from "./common";
import { deepestPoint, helixPieces, rampAroundRing, segmentInside, zigzagRamp } from "./entries";
import { type RegionAt, selectionGeometry } from "./geometry";
import { flat, MoveBuilder } from "./moves";
import { ParamReader, when } from "./params";
import { bestStart, emitClosedContour } from "./passes";

/**
 * 2D pocket: clears the inside of picked floor faces or closed loops down to the floor,
 * around islands (face holes, nested loops), with contour-parallel rings stepping inward by
 * the stepover (cut from the inside out, each ring tree branch entered by a helix or a
 * ramp) or zig-zag rows plus a boundary ring, then an optional finishing pass on the walls.
 * The tool centre never comes closer than its radius plus the stock to leave to a wall.
 */

export interface PocketPlan {
    /** Where the roughing tool centre may go: the region shrunk by r + stock (+ finish stock). */
    readonly allowed: Point2[][];
    /** Roughing passes at one level, in cutting order, with how each is entered. */
    readonly passes: readonly PocketPass[];
    /** The finishing pass loops (walls at r + stock), when a finish pass is asked for. */
    readonly finish: readonly Path2[];
    /** Area the tool cannot reach (corners and gaps narrower than the tool), mm². */
    readonly restArea: number;
}

export type PocketPass =
    /** A closed ring; `enter` when it starts a new branch (no cleared area to link from). */
    | { readonly kind: "ring"; readonly path: Path2; readonly enter: boolean }
    /** A zig-zag row from `a` to `b`. */
    | { readonly kind: "row"; readonly a: Point2; readonly b: Point2; readonly enter: boolean };

interface RingNode {
    readonly region: Region;
    readonly children: RingNode[];
}

export interface PocketSettings {
    readonly strategy: "offset" | "zigzag";
    readonly stepover: number;
    readonly radius: number;
    readonly stockToLeave: number;
    readonly finishStock: number;
    readonly climb: boolean;
    readonly angle: number;
}

function ringTree(region: Region, stepover: number, radius: number): RingNode {
    const children: RingNode[] = [];
    let next = regions(offset(regionLoops(region), -stepover));
    if (next.length === 0 && stepover > radius) {
        // Points deeper than the tool radius would stay uncut: one more ring at the radius.
        next = regions(offset(regionLoops(region), -0.95 * radius));
    }
    for (const child of next) children.push(ringTree(child, stepover, radius));
    return { region, children };
}

/** Plans the roughing passes of one pocket region (the same at every level). */
export function planPocket(region: Region, s: PocketSettings): Result<PocketPlan> {
    const loops = regionLoops(region);
    const roughOffset = s.radius + s.stockToLeave + s.finishStock;
    const allowed = offset(loops, -roughOffset);
    if (allowed.length === 0) return Result.err("The tool is too large for the pocket");
    const finishLoops = s.finishStock > 1e-9 ? offset(loops, -(s.radius + s.stockToLeave)) : [];
    const orient = (path: Path2) => (s.climb ? path : reversePath(path));
    const finish = finishLoops.map((loop) => orient(fitArcs(loop, true)));

    const passes: PocketPass[] = [];
    if (s.strategy === "offset") {
        for (const top of regions(allowed)) {
            const tree = ringTree(top, s.stepover, s.radius);
            const visit = (node: RingNode, enter: boolean): void => {
                let entering = enter;
                for (const child of node.children) {
                    visit(child, entering);
                    entering = true;
                }
                // A leaf starts a branch: its first ring is entered (helix or ramp) unless linked.
                regionLoops(node.region).forEach((loop, i) => {
                    const path = orient(fitArcs(loop, true));
                    passes.push({
                        kind: "ring",
                        path,
                        enter: node.children.length === 0 && i === 0 && enter,
                    });
                });
            };
            visit(tree, true);
        }
    } else {
        passes.push(...zigzagRows(allowed, s));
        for (const loop of allowed)
            passes.push({ kind: "ring", path: orient(fitArcs(loop, true)), enter: false });
    }

    // What the finished walls reach: the last wall pass swept by the tool.
    const wall = offset(loops, -(s.radius + s.stockToLeave));
    const reach = wall.length > 0 ? offset(wall, s.radius) : [];
    const target = s.stockToLeave > 1e-9 ? offset(loops, -s.stockToLeave) : loops;
    const restArea = Math.max(0, regionArea(difference(target, reach)));
    return Result.ok({ allowed, passes, finish, restArea });
}

function zigzagRows(allowed: Point2[][], s: PocketSettings): PocketPass[] {
    const angle = (s.angle * Math.PI) / 180;
    const rotated = allowed.map((loop) => loop.map((p) => rotate(p, -angle)));
    const box = bounds(rotated.flat());
    const height = box.max[1] - box.min[1];
    const n = Math.max(1, Math.ceil(height / s.stepover - 1e-9));
    const lines: Point2[][] = [];
    for (let i = 0; i <= n; i++) {
        const y = n === 0 ? box.min[1] + height / 2 : box.min[1] + (height * i) / n;
        if (i === 0 || i === n) continue;
        lines.push([
            [box.min[0] - 1, y],
            [box.max[0] + 1, y],
        ]);
    }
    if (lines.length === 0)
        lines.push([
            [box.min[0] - 1, box.min[1] + height / 2],
            [box.max[0] + 1, box.min[1] + height / 2],
        ]);
    const rows: { a: Point2; b: Point2; y: number }[] = [];
    for (const piece of clipPolylines(lines, rotated, "inside")) {
        const a = piece[0];
        const b = piece[piece.length - 1];
        rows.push({ a: rotate(a, angle), b: rotate(b, angle), y: a[1] });
    }
    // Zig-zag: rows in order, alternating direction; a row joins the previous when close.
    rows.sort((r1, r2) => r1.y - r2.y || Math.min(r1.a[0], r1.b[0]) - Math.min(r2.a[0], r2.b[0]));
    const out: PocketPass[] = [];
    let at: Point2 | undefined;
    const remaining = [...rows];
    while (remaining.length > 0) {
        let index = 0;
        if (at !== undefined) {
            let best = Number.POSITIVE_INFINITY;
            remaining.forEach((row, i) => {
                const d = Math.min(distance(at!, row.a), distance(at!, row.b));
                if (d < best - 1e-9) {
                    best = d;
                    index = i;
                }
            });
        }
        const [row] = remaining.splice(index, 1);
        const forward = at === undefined || distance(at, row.a) <= distance(at, row.b);
        const a = forward ? row.a : row.b;
        const b = forward ? row.b : row.a;
        const link = at === undefined ? Number.POSITIVE_INFINITY : distance(at, a);
        out.push({ kind: "row", a, b, enter: at === undefined || link > 2 * s.stepover + 1e-6 });
        at = b;
    }
    return out;
}

export interface PocketEmitOptions {
    readonly levels: readonly number[];
    readonly top: number;
    readonly heights: Heights;
    readonly feeds: Feeds;
    readonly entry: "helix" | "ramp" | "plunge";
    readonly rampAngle: number;
    readonly helixRadius: number;
    readonly stepover: number;
    readonly radius: number;
    readonly climb: boolean;
}

/** Emits a planned pocket at every level, then its finishing pass at the bottom. */
export function emitPocket(
    builder: MoveBuilder,
    plan: PocketPlan,
    o: PocketEmitOptions,
    first: boolean,
): void {
    const linkStep = Math.max(0.05, o.radius / 4);
    let firstMove = first;
    o.levels.forEach((z, levelIndex) => {
        const above = levelIndex === 0 ? o.top : o.levels[levelIndex - 1];
        let down = false;
        const reposition = (xy: Point2) => {
            if (firstMove) builder.rapidTo(xy, o.heights.retract, o.heights.clearance);
            else {
                builder.retract(o.heights.retract);
                builder.rapidTo(xy, o.heights.retract, o.heights.retract);
            }
            firstMove = false;
            builder.rapid([xy[0], xy[1], Math.min(o.heights.retract, above + 1)]);
        };
        const canLink = (to: Point2) => {
            const at = builder.position;
            if (!down || at === undefined) return false;
            const from: Point2 = [at[0], at[1]];
            return (
                distance(from, to) <= 2 * o.stepover + o.radius &&
                segmentInside(from, to, plan.allowed, linkStep)
            );
        };
        for (const pass of plan.passes) {
            if (pass.kind === "ring") {
                const at = builder.position;
                const ring =
                    at !== undefined && !pass.enter ? startAtNearest(pass.path, [at[0], at[1]]) : pass.path;
                const start = pathPointAt(ring, 0);
                if (!pass.enter && canLink(start)) {
                    builder.linear([start[0], start[1], z], o.feeds.feed);
                    builder.follow(flat(ring.segments, z), o.feeds.feed);
                    continue;
                }
                enterRing(builder, ring, z, above, plan, o, reposition);
                down = true;
            } else {
                if (!pass.enter && canLink(pass.a)) {
                    builder.linear([pass.a[0], pass.a[1], z], o.feeds.feed);
                    builder.linear([pass.b[0], pass.b[1], z], o.feeds.feed);
                    continue;
                }
                reposition(pass.a);
                if (o.entry === "plunge") {
                    builder.linear([pass.a[0], pass.a[1], z], o.feeds.plunge);
                    builder.linear([pass.b[0], pass.b[1], z], o.feeds.feed);
                } else {
                    const { pieces, end } = zigzagRamp(pass.a, pass.b, above, z, o.rampAngle, o.feeds.ramp);
                    builder.follow(pieces, o.feeds.feed);
                    const other = end === pass.a ? pass.b : pass.a;
                    builder.linear([other[0], other[1], z], o.feeds.feed);
                    if (other === pass.a) builder.linear([pass.b[0], pass.b[1], z], o.feeds.feed);
                }
                down = true;
            }
        }
    });
    if (plan.finish.length > 0) {
        builder.comment("Finishing pass");
        const bottom = o.levels[o.levels.length - 1];
        const side: 1 | -1 = o.climb ? 1 : -1;
        for (const path of plan.finish) {
            const leadSize = Math.min(o.radius, o.stepover);
            emitClosedContour(
                builder,
                {
                    path: bestStart(path),
                    levels: [bottom],
                    top: o.top,
                    heights: o.heights,
                    feeds: o.feeds,
                    lead: { inKind: "arc", inSize: leadSize, outKind: "arc", outSize: leadSize, side },
                    entry: "plunge",
                    rampAngle: o.rampAngle,
                },
                false,
            );
        }
    }
    builder.retract(o.heights.retract);
}

function startAtNearest(path: Path2, p: Point2): Path2 {
    return startClosedPathAt(path, nearestArcLength(path, p).s);
}

function enterRing(
    builder: MoveBuilder,
    ring: Path2,
    z: number,
    above: number,
    plan: PocketPlan,
    o: PocketEmitOptions,
    reposition: (xy: Point2) => void,
): void {
    const start = pathPointAt(ring, 0);
    if (o.entry === "helix") {
        const ringRegion = regions([ringPoints(ring)]);
        const spot = deepestPoint(ringRegion.length > 0 ? regionLoops(ringRegion[0]) : [], plan.allowed);
        const radius = spot === undefined ? 0 : Math.min(o.helixRadius, spot.clearance - 1e-3);
        if (spot !== undefined && radius >= Math.max(0.05, 0.1 * o.radius)) {
            const helixStart: Point2 = [spot.point[0] + radius, spot.point[1]];
            reposition(helixStart);
            builder.follow(
                helixPieces(spot.point, radius, above, z, o.rampAngle, o.climb, o.feeds.ramp),
                o.feeds.feed,
            );
            if (segmentInside(helixStart, start, plan.allowed, Math.max(0.05, o.radius / 4))) {
                builder.linear([start[0], start[1], z], o.feeds.feed);
            } else {
                builder.linear([spot.point[0], spot.point[1], z], o.feeds.feed);
                builder.linear([start[0], start[1], z], o.feeds.feed);
            }
            builder.follow(flat(ring.segments, z), o.feeds.feed);
            return;
        }
        builder.comment("No room for a helix: ramping along the ring");
    }
    reposition(start);
    if (o.entry === "plunge") {
        builder.linear([start[0], start[1], z], o.feeds.plunge);
        builder.follow(flat(ring.segments, z), o.feeds.feed);
        return;
    }
    builder.follow(rampAroundRing(ring, above, z, o.rampAngle, o.feeds.ramp), o.feeds.feed);
}

const ringPoints = (path: Path2) => pathPoints(path, 0.01);

export const POCKET_PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "strategy",
        label: "Strategy",
        kind: "enum",
        options: [
            { value: "offset", label: "Offset (contour-parallel)" },
            { value: "zigzag", label: "Zig-zag" },
        ],
    },
    {
        key: "stepover",
        label: "Stepover",
        kind: "number",
        min: 1,
        max: 100,
        description: "% of the tool diameter",
    },
    { key: "zigzagAngle", label: "Zig-zag angle", kind: "angle", visibleWhen: when("strategy", "zigzag") },
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
        key: "bottomFrom",
        label: "Bottom",
        kind: "enum",
        options: [
            { value: "geometry", label: "Selected floor" },
            { value: "depth", label: "Depth below top" },
        ],
    },
    { key: "depth", label: "Depth", kind: "length", min: 0, visibleWhen: when("bottomFrom", "depth") },
    { key: "stepdown", label: "Stepdown", kind: "length", min: 0 },
    { key: "stockToLeave", label: "Stock to leave (walls)", kind: "length", min: 0 },
    { key: "floorStock", label: "Stock to leave (floor)", kind: "length", min: 0 },
    { key: "finishPass", label: "Finishing wall pass", kind: "boolean" },
    {
        key: "finishStock",
        label: "Finishing stock",
        kind: "length",
        min: 0,
        visibleWhen: when("finishPass", true),
    },
    {
        key: "entry",
        label: "Entry",
        kind: "enum",
        options: [
            { value: "helix", label: "Helix" },
            { value: "ramp", label: "Ramp" },
            { value: "plunge", label: "Plunge" },
        ],
    },
    {
        key: "rampAngle",
        label: "Max ramp angle",
        kind: "angle",
        min: 0.1,
        max: 89,
        visibleWhen: when("entry", "helix", "ramp"),
    },
    {
        key: "helixRadius",
        label: "Helix radius",
        kind: "length",
        min: 0,
        visibleWhen: when("entry", "helix"),
    },
    ...HEIGHT_PARAMETERS,
    ...FEED_PARAMETERS,
];

export function pocketSettings(p: ParamReader, diameter: number): PocketSettings {
    const percent = Math.max(1, Math.min(100, p.num("stepover", 45)));
    return {
        strategy: p.pick("strategy", ["offset", "zigzag"] as const, "offset"),
        stepover: (diameter * percent) / 100,
        radius: diameter / 2,
        stockToLeave: Math.max(0, p.num("stockToLeave", 0)),
        finishStock: p.bool("finishPass", false) ? Math.max(0, p.num("finishStock", 0.2)) : 0,
        climb: p.pick("direction", ["climb", "conventional"] as const, "climb") === "climb",
        angle: p.num("zigzagAngle", 0),
    };
}

export function generatePocket(
    operation: CamOperationData,
    context: CamOperationContext,
): Result<ToolpathData> {
    const p = new ParamReader(operation.params);
    const tool = context.tool;
    const pockets: RegionAt[] = [...selectionGeometry(context).regions];
    if (pockets.length === 0) return Result.err("Select a pocket floor face or closed sketch loops");
    const settings = pocketSettings(p, tool.diameter);
    const feeds = feedsOf(p, tool, context.machine);
    const heights = heightsOf(p, context);
    const stepdown = p.num("stepdown", tool.cutting.stepdown ?? tool.diameter / 2);
    const floorStock = Math.max(0, p.num("floorStock", 0));
    const bottomFrom = p.pick("bottomFrom", ["geometry", "depth"] as const, "geometry");
    const entry = p.pick("entry", ["helix", "ramp", "plunge"] as const, "helix");
    const builder = new MoveBuilder();
    builder.comment(`${operation.name}: pocket (${settings.strategy}), tool Ø${tool.diameter}`);
    const ordered = nearestNeighborOrder(
        pockets,
        [context.stock.min[0], context.stock.min[1]],
        (region) => region.outer[0],
    );
    let first = true;
    for (const region of ordered) {
        const bottom =
            (bottomFrom === "depth" ? heights.top - Math.max(0, p.num("depth", 5)) : region.z) + floorStock;
        if (bottom >= heights.top - 1e-9) {
            return Result.err("Nothing to cut: the pocket floor is at or above the top (set a depth)");
        }
        const plan = planPocket(region, settings);
        if (!plan.isOk) return Result.err(plan.error);
        if (plan.value.restArea > 0.01) {
            builder.comment(
                `Rest material: about ${plan.value.restArea.toFixed(2)} mm² in corners and gaps narrower than the tool remain`,
            );
        }
        emitPocket(
            builder,
            plan.value,
            {
                levels: depthLevels(heights.top, bottom, stepdown),
                top: heights.top,
                heights,
                feeds,
                entry,
                rampAngle: p.num("rampAngle", 3),
                helixRadius: Math.max(0, p.num("helixRadius", toolRadius(tool) * 0.8)),
                stepover: settings.stepover,
                radius: settings.radius,
                climb: settings.climb,
            },
            first,
        );
        first = false;
    }
    builder.retract(heights.clearance);
    return Result.ok(toolpathOf(builder, operation, context, feeds));
}

export const pocketOperation: CamOperationHandler = {
    type: "pocket2d",
    label: "2D pocket",
    category: "2d",
    machineKinds: ["mill"],
    selects: ["face", "sketch", "edge"],
    defaults: (_machine, tool) => ({
        strategy: "offset",
        stepover: 45,
        zigzagAngle: 0,
        direction: "climb",
        bottomFrom: "geometry",
        depth: 5,
        stepdown: tool?.cutting.stepdown ?? (tool !== undefined ? tool.diameter / 2 : 2),
        stockToLeave: 0,
        floorStock: 0,
        finishPass: false,
        finishStock: 0.2,
        entry: "helix",
        rampAngle: 3,
        helixRadius: tool !== undefined ? Math.round(tool.diameter * 0.4 * 100) / 100 : 2,
        clearance: 10,
        retract: 2,
        ...feedDefaults(tool),
    }),
    parameters: () => POCKET_PARAMETERS,
    generate: generatePocket,
};
