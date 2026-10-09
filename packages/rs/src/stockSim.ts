// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { StockSim } from "../lib/chili_rs.js";
import { assertRustReady } from "./runtime";

/**
 * Stock material-removal simulation (the `stocksim` crate): a 3-axis Z-map of the stock cut
 * by straight tool moves, each column lowered to the exact lower envelope of the swept tool.
 * Moves are added as polylines per tool and cut a range at a time (playback seeks back
 * through snapshots); each move's removed volume and the warnings — rapids that cut, shank
 * and holder collisions, gouges below a part — come back by move index, the stock as a mesh
 * with the deviation from the part per vertex. Millimetres and degrees, in the moves' frame.
 * Inputs the kernel refuses throw an `Error` with its reason.
 */

export type StockVec3 = readonly [number, number, number];

export type StockToolKind = "flat" | "ball" | "bull" | "cone" | "drill" | "tapered";

export interface StockToolData {
    readonly kind: StockToolKind;
    readonly diameter: number;
    /** Bull nose and tapered corner radius. */
    readonly cornerRadius?: number;
    /** Cone: the included angle; drill: the point angle; tapered: each flank's angle from the axis. */
    readonly angle?: number;
    /** Cone: the flat tip's diameter; tapered: the flat bottom's. */
    readonly tipDiameter?: number;
    /** Cutting length above the tip; above it is the shank. Absent: the whole tool cuts. */
    readonly fluteLength?: number;
    /** The shank above the flutes (default: the cutting diameter). */
    readonly shankDiameter?: number;
    /** The holder, its face `stickout` above the tip. */
    readonly holder?: { readonly diameter: number; readonly length: number; readonly stickout: number };
}

export type StockWarningKind =
    | "rapidInStock"
    | "shankCollision"
    | "holderCollision"
    | "gouge"
    | "unsupported";

const WARNING_KINDS: Record<number, StockWarningKind> = {
    1: "rapidInStock",
    2: "shankCollision",
    3: "holderCollision",
    4: "gouge",
    5: "unsupported",
};

export interface StockWarning {
    readonly kind: StockWarningKind;
    readonly moveIndex: number;
    /** Rapid, gouge: how deep, mm; collisions: how far the stock reaches into the shank/holder, mm. */
    readonly depth: number;
    /** Rapid: removed volume, mm³; gouge: cells cut below the part. */
    readonly amount: number;
    readonly at: StockVec3;
}

export interface StockMeshData {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly indices: Uint32Array;
    /** Signed deviation from the part per vertex (≥ 0 material left, < −tolerance a gouge, NaN on the bottom); absent without a part. */
    readonly deviation?: Float32Array;
}

export interface StockComparison {
    readonly excessVolume: number;
    readonly maxExcess: number;
    readonly gougeVolume: number;
    readonly maxGouge: number;
    readonly gougeCells: number;
    readonly maxGougeAt: StockVec3;
}

export interface StockGrid {
    readonly x0: number;
    readonly y0: number;
    readonly cellX: number;
    readonly cellY: number;
    readonly nx: number;
    readonly ny: number;
    readonly bottom: number;
}

export interface StockSimulatorOptions {
    /** A cut deeper than this below the part is a gouge (also the XY slack at part walls), mm. Default 0.01. */
    readonly gougeTolerance?: number;
    /** Shank or holder interference below this is not a collision, mm. Default 0.01. */
    readonly collisionTolerance?: number;
}

const U32_MAX = 0xffffffff;

function count(value: number): number {
    if (!(value > 0)) return 0;
    return value >= U32_MAX ? U32_MAX : Math.floor(value);
}

export class StockSimulator {
    private sim: StockSim | undefined;

    /** A box of stock in cells of at most `cellSize` mm. */
    constructor(
        box: { readonly min: StockVec3; readonly max: StockVec3 },
        cellSize: number,
        options?: StockSimulatorOptions,
    ) {
        assertRustReady();
        const { min, max } = box;
        this.sim = new StockSim(min[0], min[1], min[2], max[0], max[1], max[2], cellSize);
        if (options?.gougeTolerance !== undefined || options?.collisionTolerance !== undefined) {
            this.sim.set_tolerances(options.gougeTolerance ?? 0.01, options.collisionTolerance ?? 0.01);
        }
    }

    private get raw(): StockSim {
        if (this.sim === undefined) throw new Error("The stock simulator has been disposed");
        return this.sim;
    }

    get disposed(): boolean {
        return this.sim === undefined;
    }

    /** Adds a tool; returns its index for `addPath`. */
    addTool(tool: StockToolData): number {
        return this.raw.add_tool(
            tool.kind,
            tool.diameter,
            tool.cornerRadius,
            tool.angle,
            tool.tipDiameter,
            tool.fluteLength,
            tool.shankDiameter,
            tool.holder?.diameter,
            tool.holder?.length,
            tool.holder?.stickout,
        );
    }

    /**
     * Appends moves cut with `tool`: `points` are n + 1 xyz points (the start, then each
     * move's end), `rapid` n flags. Returns the index of the first move.
     */
    addPath(
        tool: number,
        points: Float64Array | readonly number[],
        rapid: Uint8Array | readonly boolean[],
    ): number {
        const xyz = points instanceof Float64Array ? points : Float64Array.from(points);
        const flags = rapid instanceof Uint8Array ? rapid : Uint8Array.from(rapid, (x) => (x ? 1 : 0));
        return this.raw.add_moves(tool, xyz, flags);
    }

    /** The part (triangles) gouges are checked against and the deviation is measured from. */
    setPart(positions: Float32Array, indices: Uint32Array): void {
        this.raw.set_part(positions, indices);
    }

    /** Replaces the stock's column heights (row-major over `grid()`). */
    setStockHeights(heights: Float32Array): void {
        this.raw.set_stock_heights(heights);
    }

    /** Makes the stock the material under a triangulated body, within the box. */
    setStockTriangles(positions: Float32Array, indices: Uint32Array): void {
        this.raw.set_stock_triangles(positions, indices);
    }

    get moveCount(): number {
        return this.raw.move_count();
    }

    /** The moves cut so far: the stock is after the first `cursor` moves. */
    get cursor(): number {
        return this.raw.cursor();
    }

    /** Cuts up to `moves` more moves (all by default); returns the new cursor. */
    run(moves = Number.POSITIVE_INFINITY): number {
        return this.raw.run(count(moves));
    }

    /** Puts the stock in its state after the first `moveIndex` moves. */
    seek(moveIndex: number): void {
        this.raw.seek(count(moveIndex));
    }

    /** Removed volume of each move cut so far, mm³. */
    removedVolumes(): Float64Array {
        return this.raw.removed();
    }

    /** Warnings of the moves cut at least once, in move order. */
    warnings(): StockWarning[] {
        const packed = this.raw.warnings();
        const warnings: StockWarning[] = [];
        for (let k = 0; k + 6 < packed.length; k += 7) {
            warnings.push({
                kind: WARNING_KINDS[packed[k]] ?? "unsupported",
                moveIndex: packed[k + 1],
                depth: packed[k + 2],
                amount: packed[k + 3],
                at: [packed[k + 4], packed[k + 5], packed[k + 6]],
            });
        }
        return warnings;
    }

    /** The stock as triangles, from every `step`-th cell (1: full resolution). */
    mesh(step = 1): StockMeshData {
        const mesh = this.raw.mesh(Math.max(1, Math.floor(step)));
        try {
            const deviation = mesh.deviation();
            return {
                positions: mesh.positions(),
                normals: mesh.normals(),
                indices: mesh.indices(),
                deviation: deviation.length > 0 ? deviation : undefined,
            };
        } finally {
            mesh.free();
        }
    }

    /** The material's volume, mm³. */
    volume(): number {
        return this.raw.volume();
    }

    /** The stock compared with the part, if one is set. */
    comparison(): StockComparison | undefined {
        const c = this.raw.comparison();
        if (c.length < 8) return undefined;
        return {
            excessVolume: c[0],
            maxExcess: c[1],
            gougeVolume: c[2],
            maxGouge: c[3],
            gougeCells: c[4],
            maxGougeAt: [c[5], c[6], c[7]],
        };
    }

    grid(): StockGrid {
        const g = this.raw.grid();
        return { x0: g[0], y0: g[1], cellX: g[2], cellY: g[3], nx: g[4], ny: g[5], bottom: g[6] };
    }

    /** Column heights, row-major over `grid()`. */
    heights(): Float32Array {
        return this.raw.heights();
    }

    /** Each column's signed deviation from the part (NaN without one). */
    deviations(): Float32Array {
        return this.raw.deviations();
    }

    /** Releases the kernel's memory (idempotent). */
    dispose(): void {
        this.sim?.free();
        this.sim = undefined;
    }
}
