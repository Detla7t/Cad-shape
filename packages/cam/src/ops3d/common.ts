// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { offset, type Point2 } from "../geometry2d";
import { type Cutter, cutterForTool, holderForTool } from "../mesh/cutter";
import { DropCutter } from "../mesh/dropCutter";
import { simplify3 } from "../mesh/polyline";
import { indexOfMeshes, shadowRegion } from "../mesh/shadow";
import { TriangleIndex } from "../mesh/triangleIndex";
import type { Yielder } from "../mesh/yielder";
import type { CamMesh, CamOperationContext, CamParameterSpec } from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolData } from "../model/tool";
import type { ToolpathData, ToolpathMove, Vec3 } from "../model/toolpath";
import { type Feeds, feedsOf } from "../ops2d/common";
import { ParamReader } from "../ops2d/params";

/** Shared plumbing of the 3-axis surfacing operations: parameters, cutters, moves and links. */

export type Params = Readonly<Record<string, unknown>>;

// Parameter reads as the 2D operations do them (numbers may arrive as strings from a panel).
export const num = (params: Params, key: string, fallback: number): number =>
    new ParamReader(params).num(key, fallback);
export const optionalNum = (params: Params, key: string): number | undefined =>
    new ParamReader(params).optionalNum(key);
export const bool = (params: Params, key: string, fallback: boolean): boolean =>
    new ParamReader(params).bool(key, fallback);
export const choice = <T extends string>(
    params: Params,
    key: string,
    options: readonly T[],
    fallback: T,
): T => new ParamReader(params).pick(key, options, fallback);

/** A triangle index per part mesh, so operations of a setup share one BVH. */
const indexCache = new WeakMap<CamMesh, TriangleIndex>();

export function triangleIndexOf(mesh: CamMesh): TriangleIndex {
    let index = indexCache.get(mesh);
    if (!index) {
        index = TriangleIndex.fromMesh(mesh);
        indexCache.set(mesh, index);
    }
    return index;
}

/** Everything the 3D operations resolve the same way. */
export interface SurfacingSetup {
    readonly tool: ToolData;
    readonly cutter: Cutter;
    readonly index: TriangleIndex;
    /** Drops the cutter grown by the radial stock to leave, raised by the axial one. */
    readonly drop: DropCutter;
    /**
     * The same, with the cutter eroded by the tolerance: links and leads that clear it gouge by
     * at most the tolerance (straight moves between contour points sag that much at walls).
     */
    readonly check: DropCutter;
    readonly feeds: Feeds;
    readonly tolerance: number;
    readonly stockToLeave: number;
    readonly axialStockToLeave: number;
    /** Rapid plane: above the stock and the parts. */
    readonly clearanceZ: number;
    /** Rapids stop this far above where feeding starts. */
    readonly safeDistance: number;
    readonly stock: CamOperationContext["stock"];
}

export function surfacingSetup(
    operation: CamOperationData,
    context: CamOperationContext,
    defaults: { tolerance: number; stockToLeave: number },
): Result<SurfacingSetup> {
    const params = operation.params;
    const cutterResult = cutterForTool(context.tool);
    if (!cutterResult.isOk) return Result.err(cutterResult.error);
    const cutter = cutterResult.value;
    const tolerance = Math.max(num(params, "tolerance", defaults.tolerance), 1e-4);
    // Reserve part of the operation tolerance for tessellation; display meshes
    // use relative precision and cannot establish an absolute machining budget.
    const mesh = context.partMesh(tolerance / 4);
    const index = triangleIndexOf(mesh);
    if (index.count === 0) return Result.err("The setup has no part geometry to machine");
    const stockToLeave = Math.max(0, num(params, "stockToLeave", defaults.stockToLeave));
    const axialStockToLeave = Math.max(0, num(params, "axialStockToLeave", stockToLeave));
    const holder = bool(params, "holderCheck", true) ? holderForTool(context.tool) : undefined;
    // Where nothing is under the cutter it stands at the parts' bottom.
    const floor = index.min[2] + axialStockToLeave;
    const grown = cutter.offset(stockToLeave);
    const drop = new DropCutter(index, grown, {
        floor,
        lift: axialStockToLeave,
        holder: holder && { radius: holder.radius + stockToLeave, offset: holder.offset },
    });
    const eroded = grown.erode(Math.min(tolerance, grown.radius / 4));
    const check = new DropCutter(index, eroded.cutter, {
        floor,
        lift: axialStockToLeave + eroded.lift,
        holder: holder && { radius: holder.radius + stockToLeave - tolerance, offset: holder.offset },
    });
    const top = Math.max(context.stock.max[2], index.max[2]);
    return Result.ok({
        tool: context.tool,
        cutter,
        index,
        drop,
        check,
        feeds: feedsOf(new ParamReader(params), context.tool, context.machine),
        tolerance,
        stockToLeave,
        axialStockToLeave,
        clearanceZ: top + Math.max(0, num(params, "clearance", 5)),
        safeDistance: Math.max(0, num(params, "safeDistance", 1)),
        stock: context.stock,
    });
}

export function surfacingToolpath(
    operation: CamOperationData,
    setup: SurfacingSetup,
    moves: ToolpathMove[],
): ToolpathData {
    return {
        toolId: setup.tool.id,
        ...(setup.feeds.rpm !== undefined ? { spindleRpm: setup.feeds.rpm } : {}),
        ...(setup.feeds.coolant !== undefined ? { coolant: setup.feeds.coolant } : {}),
        moves,
        label: operation.name,
    };
}

// Parameter rows shared by the operations.

export const TOLERANCE_PARAMETER: CamParameterSpec = {
    key: "tolerance",
    label: "Tolerance",
    kind: "length",
    min: 0.0001,
    description: "Chord error of the toolpath against the cutter-location surface",
};

export const STOCK_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "stockToLeave", label: "Stock to leave", kind: "length", min: 0 },
    {
        key: "axialStockToLeave",
        label: "Axial stock to leave",
        kind: "length",
        min: 0,
        description: "Stock left on floors (defaults to the radial stock to leave)",
    },
];

export const SURFACE_HEIGHT_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "clearance", label: "Clearance above stock", kind: "length", min: 0 },
    { key: "safeDistance", label: "Feed start distance", kind: "length", min: 0 },
    { key: "minZ", label: "Bottom height (Z)", kind: "length" },
    { key: "maxZ", label: "Top height (Z)", kind: "length" },
    { key: "holderCheck", label: "Keep the holder clear", kind: "boolean" },
];

export const BOUNDARY_PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "boundary",
        label: "Machining boundary",
        kind: "enum",
        options: [
            { value: "silhouette", label: "Part silhouette" },
            { value: "selection", label: "Selected faces" },
            { value: "stock", label: "Stock box" },
        ],
    },
    {
        key: "containment",
        label: "Tool containment",
        kind: "enum",
        options: [
            { value: "center", label: "Tool centre on boundary" },
            { value: "inside", label: "Tool inside boundary" },
            { value: "outside", label: "Tool outside boundary" },
        ],
    },
    { key: "boundaryOffset", label: "Boundary offset", kind: "length" },
];

export const LINK_PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "linking",
        label: "Linking",
        kind: "enum",
        options: [
            { value: "stayDown", label: "Stay down when safe" },
            { value: "retract", label: "Retract between passes" },
        ],
    },
    {
        key: "stayDownDistance",
        label: "Stay-down distance",
        kind: "length",
        min: 0,
        visibleWhen: { key: "linking", values: ["stayDown"] },
    },
    { key: "leadDistance", label: "Lead-in/out ramp length", kind: "length", min: 0 },
    { key: "leadAngle", label: "Lead-in/out ramp angle", kind: "angle", min: 1, max: 90 },
];

export const BOUNDARY_DEFAULTS = {
    boundary: "silhouette",
    containment: "center",
    boundaryOffset: 0,
} as const;

/**
 * The machining boundary as a region for the tool centre: the parts' silhouette, the picked
 * faces' silhouette, or the stock box, moved by the containment (half a diameter in or out)
 * and the extra offset.
 */
export async function containmentRegion(
    params: Params,
    context: CamOperationContext,
    setup: SurfacingSetup,
    defaults: { readonly boundary: string; readonly containment: string } = BOUNDARY_DEFAULTS,
    yielder?: Yielder,
): Promise<Point2[][]> {
    const kind = choice(
        params,
        "boundary",
        ["silhouette", "selection", "stock"],
        boundaryKind(defaults.boundary),
    );
    const containment = choice(
        params,
        "containment",
        ["center", "inside", "outside"],
        defaults.containment === "inside" || defaults.containment === "outside"
            ? defaults.containment
            : "center",
    );
    const radius = setup.cutter.radius;
    const delta =
        num(params, "boundaryOffset", 0) +
        (containment === "inside" ? -radius : containment === "outside" ? radius : 0);
    if (kind === "stock") {
        const { min, max } = setup.stock;
        const box: Point2[] = [
            [min[0], min[1]],
            [max[0], min[1]],
            [max[0], max[1]],
            [min[0], max[1]],
        ];
        return offset([box], delta, { tolerance: setup.tolerance / 2 });
    }
    let index = setup.index;
    if (kind === "selection") {
        const meshes = context
            .selectedFaces()
            .map((face) => face.mesh.faces)
            .filter((faces) => faces !== undefined && faces.index.length >= 3);
        if (meshes.length > 0)
            index = indexOfMeshes(meshes as { position: Float32Array; index: Uint32Array }[]);
    }
    // The shadow traced on a grid of half the cutter radius (gaps narrower than that close).
    const spacing = Math.min(Math.max(radius / 2, 0.1), 2);
    return shadowRegion(index, delta, spacing, setup.tolerance, yielder);
}

function boundaryKind(value: string): "silhouette" | "selection" | "stock" {
    return value === "selection" || value === "stock" ? value : "silhouette";
}

/** Moves of one toolpath, with the rapid plane and the feeds. */
export class MoveWriter {
    readonly moves: ToolpathMove[] = [];
    private at: Vec3 | undefined;

    constructor(
        readonly feeds: Feeds,
        readonly clearanceZ: number,
        readonly safeDistance: number,
    ) {}

    get position(): Vec3 | undefined {
        return this.at;
    }

    rapid(to: Vec3): void {
        if (this.at && same(this.at, to)) return;
        this.moves.push({ kind: "rapid", to });
        this.at = to;
    }

    feed(to: Vec3, feed = this.feeds.feed): void {
        if (this.at && same(this.at, to)) return;
        this.moves.push({ kind: "linear", to, feed });
        this.at = to;
    }

    /** An XY-plane arc (a helix when z changes) from the current point. */
    arc(to: Vec3, center: Vec3, clockwise: boolean, feed = this.feeds.feed): void {
        this.moves.push({ kind: "arc", to, center, clockwise, plane: "XY", feed });
        this.at = to;
    }

    comment(text: string): void {
        this.moves.push({ kind: "comment", text });
    }

    /** Straight up to the rapid plane. */
    retract(): void {
        if (this.at && this.at[2] < this.clearanceZ) this.rapid([this.at[0], this.at[1], this.clearanceZ]);
    }

    /** From the rapid plane: over `target`, rapid down to `safeDistance` above it, feed down. */
    approach(target: Vec3, plungeFeed = this.feeds.plunge): void {
        this.retract();
        this.rapid([target[0], target[1], this.clearanceZ]);
        const stop = target[2] + this.safeDistance;
        if (stop < this.clearanceZ) this.rapid([target[0], target[1], stop]);
        this.feed(target, plungeFeed);
    }
}

function same(a: Vec3, b: Vec3): boolean {
    return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9;
}

export interface LinkOptions {
    /** Stay down for links up to this long (0: always retract). */
    readonly stayDownDistance: number;
    /** Short links that are not straight-clear follow the surface (else they retract). */
    readonly followSurface: boolean;
    readonly leadDistance: number;
    /** Lead ramp angle, degrees above horizontal. */
    readonly leadAngle: number;
    /** Point spacing of links that follow the surface. */
    readonly sampling: number;
    readonly tolerance: number;
    /** Surface-following links keep to the operation's height range (else they retract). */
    readonly minZ?: number;
    readonly maxZ?: number;
}

export function linkOptions(
    params: Params,
    cutter: Cutter,
    sampling: number,
    tolerance: number,
    followSurface = true,
): LinkOptions {
    const linking = choice(params, "linking", ["stayDown", "retract"], "stayDown");
    return {
        stayDownDistance:
            linking === "retract" ? 0 : Math.max(0, num(params, "stayDownDistance", 4 * cutter.radius)),
        followSurface,
        leadDistance: Math.max(0, num(params, "leadDistance", cutter.radius / 2)),
        leadAngle: Math.min(90, Math.max(1, num(params, "leadAngle", 30))),
        sampling,
        tolerance,
        minZ: optionalNum(params, "minZ"),
        maxZ: optionalNum(params, "maxZ"),
    };
}

/** The cutter-location heights a toolpath is linked against: exact, and eroded for checks. */
export interface Clearance {
    readonly drop: DropCutter;
    readonly check: DropCutter;
}

/**
 * Moves the cutter from where it is to `target` (the start of the next pass, entered along
 * `direction`): a straight feed when that clears the part, else (when allowed) a feed that
 * follows the surface when the link is short, else a lead-out ramp, a retract to the rapid
 * plane and a lead-in ramp (each ramp only where it is clear, vertical otherwise).
 * `previous` is the direction the last pass ended in.
 */
export function link(
    writer: MoveWriter,
    clearance: Clearance,
    target: Vec3,
    direction: Point2 | undefined,
    previous: Point2 | undefined,
    options: LinkOptions,
): void {
    const { drop, check } = clearance;
    const from = writer.position;
    if (from && from[2] < writer.clearanceZ - 1e-9) {
        const distance = Math.hypot(target[0] - from[0], target[1] - from[1]);
        if (distance <= options.stayDownDistance) {
            if (check.isClear(from, target)) {
                writer.feed(target);
                return;
            }
            const points = options.followSurface ? surfaceLink(drop, from, target, options) : undefined;
            if (points) {
                for (let k = 0; k < points.length; k += 3)
                    writer.feed([points[k], points[k + 1], points[k + 2]]);
                writer.feed(target);
                return;
            }
            // Up (or across first when the target is lower), across at the higher end, down:
            // the vertical parts are safe by construction, only the level part needs checking.
            const top = Math.max(from[2], target[2]);
            const over: Vec3 = [from[0], from[1], top];
            const above: Vec3 = [target[0], target[1], top];
            if (check.isClear(over, above)) {
                writer.feed(over);
                writer.feed(above);
                writer.feed(target);
                return;
            }
        }
        const out = leadPoint(from, previous, 1, options);
        if (out && out[2] < writer.clearanceZ && check.isClear(from, out)) writer.feed(out);
    }
    const lead = leadPoint(target, direction, -1, options);
    if (lead && lead[2] < writer.clearanceZ && check.isClear(lead, target)) {
        writer.approach(lead);
        writer.feed(target);
    } else {
        writer.approach(target);
    }
}

/** The cutter-location surface between two points, raised to minZ; undefined when it rises above maxZ. */
function surfaceLink(drop: DropCutter, from: Vec3, to: Vec3, options: LinkOptions): number[] | undefined {
    const points = drop.dropPath(from[0], from[1], to[0], to[1], {
        sampling: options.sampling,
        tolerance: options.tolerance / 2,
    });
    for (let k = 2; k < points.length; k += 3) {
        if (options.minZ !== undefined && points[k] < options.minZ) points[k] = options.minZ;
        if (options.maxZ !== undefined && points[k] > options.maxZ + 1e-9) return undefined;
    }
    return simplify3(points, options.tolerance / 2);
}

function leadPoint(
    at: Vec3,
    direction: Point2 | undefined,
    sign: number,
    options: LinkOptions,
): Vec3 | undefined {
    if (!direction || options.leadDistance <= 0) return undefined;
    const length = Math.hypot(direction[0], direction[1]);
    if (length < 1e-12) return undefined;
    const d = options.leadDistance;
    const rise = d * Math.tan((options.leadAngle * Math.PI) / 180);
    return [
        at[0] + (sign * d * direction[0]) / length,
        at[1] + (sign * d * direction[1]) / length,
        at[2] + rise,
    ];
}

/** Direction of a polyline (xyz triples) at its start or end, in XY. */
export function endDirection(points: readonly number[], atEnd: boolean): Point2 | undefined {
    const n = points.length / 3;
    if (n < 2) return undefined;
    if (atEnd) {
        for (let k = n - 2; k >= 0; k--) {
            const dx = points[(n - 1) * 3] - points[k * 3];
            const dy = points[(n - 1) * 3 + 1] - points[k * 3 + 1];
            if (Math.hypot(dx, dy) > 1e-9) return [dx, dy];
        }
    } else {
        for (let k = 1; k < n; k++) {
            const dx = points[k * 3] - points[0];
            const dy = points[k * 3 + 1] - points[1];
            if (Math.hypot(dx, dy) > 1e-9) return [dx, dy];
        }
    }
    return undefined;
}

/**
 * Removes and returns the pass nearest to `at` (the first one when `at` is undefined): a
 * closed pass starting at its nearest vertex, a `reversible` open one possibly reversed.
 */
export function takeNearest(remaining: Pass[], at: readonly number[] | undefined, reversible: boolean): Pass {
    let bestIndex = 0;
    let bestDistance = Infinity;
    let bestReverse = false;
    let bestVertex = 0;
    const distance = (p: readonly number[], k: number, q: readonly number[]) =>
        Math.hypot(p[k] - q[0], p[k + 1] - q[1]) + Math.abs(p[k + 2] - q[2]);
    for (let k = 0; at && k < remaining.length; k++) {
        const pass = remaining[k];
        const p = pass.points;
        const n = p.length / 3;
        if (pass.closed) {
            // Vertices only: they are exact cutter locations, points between them are not.
            for (let i = 0; i < n; i++) {
                const d = distance(p, i * 3, at);
                if (d < bestDistance) {
                    bestDistance = d;
                    bestIndex = k;
                    bestVertex = i;
                    bestReverse = false;
                }
            }
            continue;
        }
        const ds = distance(p, 0, at);
        if (ds < bestDistance) {
            bestDistance = ds;
            bestIndex = k;
            bestVertex = 0;
            bestReverse = false;
        }
        const de = reversible ? distance(p, (n - 1) * 3, at) : Infinity;
        if (de < bestDistance) {
            bestDistance = de;
            bestIndex = k;
            bestVertex = 0;
            bestReverse = true;
        }
    }
    const pass = remaining.splice(bestIndex, 1)[0];
    if (pass.closed && bestVertex > 0) {
        const p = pass.points;
        return { ...pass, points: [...p.slice(bestVertex * 3), ...p.slice(0, bestVertex * 3)] };
    }
    if (bestReverse) return { ...pass, points: reversePoints(pass.points) };
    return pass;
}

/** Greedy nearest-neighbour order of passes from `start` (see `takeNearest`). */
export function orderPasses(
    passes: readonly Pass[],
    start: readonly number[] | undefined,
    reversible: boolean,
): Pass[] {
    const remaining = passes.slice();
    const out: Pass[] = [];
    let at = start;
    while (remaining.length > 0) {
        const pass = takeNearest(remaining, at, reversible);
        out.push(pass);
        at = passEnd(pass);
    }
    return out;
}

/** Where cutting a pass ends: its first point when closed, else its last. */
export function passEnd(pass: Pass): Vec3 {
    const p = pass.points;
    return pass.closed ? [p[0], p[1], p[2]] : [p[p.length - 3], p[p.length - 2], p[p.length - 1]];
}

/** A cutting pass: xyz triples; a closed one returns to its first point. */
export interface Pass {
    readonly points: number[];
    readonly closed: boolean;
}

export function reversePoints(points: readonly number[]): number[] {
    const out: number[] = [];
    for (let k = points.length - 3; k >= 0; k -= 3) out.push(points[k], points[k + 1], points[k + 2]);
    return out;
}

/** Cuts the passes in order, linking each to the next. */
export function cutPasses(
    writer: MoveWriter,
    clearance: Clearance,
    passes: readonly Pass[],
    options: LinkOptions,
): void {
    let previous: Point2 | undefined;
    for (const pass of passes) {
        const p = pass.points;
        if (p.length < 3) continue;
        const points = pass.closed ? [...p, p[0], p[1], p[2]] : p;
        link(
            writer,
            clearance,
            [points[0], points[1], points[2]],
            endDirection(points, false),
            previous,
            options,
        );
        for (let k = 3; k < points.length; k += 3) writer.feed([points[k], points[k + 1], points[k + 2]]);
        previous = endDirection(points, true);
    }
    const end = writer.position;
    if (end) {
        const out = leadPoint(end, previous, 1, options);
        if (out && out[2] < writer.clearanceZ && clearance.check.isClear(end, out)) writer.feed(out);
    }
    writer.retract();
}

/** Default largest point spacing along a pass: a quarter of the cutter radius, bounded. */
export function defaultSampling(cutter: Cutter): number {
    return Math.min(Math.max(cutter.radius / 4, 0.05), 2);
}

/**
 * Stepover from the scallop (cusp) height left between passes on a flat floor: twice the
 * radius at which the cutter's profile reaches that height (2√(2rh − h²) for a ball).
 */
export function scallopStepover(cutter: Cutter, height: number): number {
    return Math.min(2 * cutter.radiusAtHeight(Math.max(height, 0)), 2 * cutter.radius);
}
