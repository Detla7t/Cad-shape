// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import {
    type StockComparison,
    type StockGrid,
    type StockMeshData,
    StockSimulator,
    type StockWarningKind,
} from "@chili3d/rs";
import { Yielder } from "../mesh/yielder";
import type { CamMesh } from "../model/operation";
import type { ToolData } from "../model/tool";
import type { Vec3 } from "../model/toolpath";
import {
    type FlattenOptions,
    flattenToolpaths,
    moveEndPoint,
    moveStart,
    type SimulationMoves,
    type SimulationToolpath,
} from "./motion";
import { stockToolFor } from "./tools";

/**
 * Stock simulation of a program: `simulateToolpaths` flattens the toolpaths into straight
 * moves (`motion.ts`), cuts them into the Rust stock simulator (`@chili3d/rs`, a Z-map of the
 * stock) in slices that yield to the event loop, and hands back a `StockSimulation` — the
 * stock after any move (playback seeks), its mesh coloured by the deviation from the parts,
 * what each move removed and the warnings (rapids into the stock, shank and holder
 * collisions, gouges, toolpaths it cannot simulate), grouped into runs of nearby moves
 * and traced back to their toolpath and toolpath move. Everything is in the toolpaths' frame
 * (a setup's WCS), millimetres.
 */

/** The stock: a box, optionally narrowed to a round bar or a body inside it. */
export interface SimulationStock {
    readonly min: Vec3;
    readonly max: Vec3;
    /** A bar along Z (cells outside it hold no material). */
    readonly cylinder?: { readonly center: readonly [number, number]; readonly radius: number };
    /** A body (a casting): material under its top surface, within the box. */
    readonly mesh?: CamMesh;
}

export interface SimulationInput {
    readonly toolpaths: readonly SimulationToolpath[];
    readonly stock: SimulationStock;
    /** The parts' triangles in the same frame: what gouges and the deviation are measured against. */
    readonly part?: CamMesh;
}

export interface SimulationOptions extends Omit<FlattenOptions, "skip" | "stockTop"> {
    /** Cell size of the stock's grid, mm (default: about 600 000 cells over the stock). */
    readonly cellSize?: number;
    /** Gouges shallower than this are on the part, mm (default 0.01). */
    readonly gougeTolerance?: number;
    /** Shank/holder interference below this is no collision, mm (default 0.01). */
    readonly collisionTolerance?: number;
    /** Time to cut before letting the event loop run, ms (default 12). */
    readonly budgetMs?: number;
    readonly signal?: AbortSignal;
    /** Called after each slice: moves cut, moves in all. */
    readonly onProgress?: (cut: number, total: number) => void;
}

export type SimulationWarningKind = StockWarningKind;

/** A run of moves of one toolpath raising the same warning, no more than `RUN_GAP` apart. */
export interface SimulationWarning {
    readonly kind: SimulationWarningKind;
    readonly toolpathIndex: number;
    /** The toolpath's `id` (its operation). */
    readonly id?: string;
    /** The toolpath move (index into its `moves`) the run starts in. */
    readonly sourceMove: number;
    /** The run's straight moves (simulation move indices, inclusive). */
    readonly firstMove: number;
    readonly lastMove: number;
    /** The worst depth in the run, mm (see `StockWarning`), and where. */
    readonly depth: number;
    readonly at: Vec3;
    /** Summed: rapid volume, mm³; gouge cells. */
    readonly amount: number;
}

/** One straight move of the simulation. */
export interface SimulatedMove {
    readonly index: number;
    readonly toolpathIndex: number;
    readonly id?: string;
    readonly sourceMove: number;
    readonly from: Vec3;
    readonly to: Vec3;
    readonly rapid: boolean;
    readonly tool: ToolData;
}

/** Warnings of one kind this few moves apart (a pass and its links) join one run. */
export const RUN_GAP = 25;

const NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** A cell size giving about `cells` cells over the stock's XY, rounded up to a round number. */
export function defaultCellSize(stock: { readonly min: Vec3; readonly max: Vec3 }, cells = 600_000): number {
    const area = Math.max(stock.max[0] - stock.min[0], 1e-3) * Math.max(stock.max[1] - stock.min[1], 1e-3);
    const raw = Math.max(Math.sqrt(area / cells), 0.01);
    const decade = 10 ** Math.floor(Math.log10(raw));
    const nice = NICE.find((step) => step * decade >= raw * (1 - 1e-9)) ?? 10;
    return Number((nice * decade).toPrecision(6));
}

function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class StockSimulation {
    private removed: Float64Array | undefined;
    private readonly firstMoves: number[];

    private constructor(
        private readonly sim: StockSimulator,
        readonly input: SimulationInput,
        readonly moves: SimulationMoves,
        readonly cellSize: number,
        readonly initialVolume: number,
        readonly warnings: readonly SimulationWarning[],
        readonly elapsedMs: number,
        /** Deviations within this of the part are on it, mm. */
        readonly tolerance: number,
    ) {
        this.firstMoves = input.toolpaths.map(() => -1);
        for (let k = moves.toolpath.length - 1; k >= 0; k--) this.firstMoves[moves.toolpath[k]] = k;
    }

    /** Runs a simulation (see the module notes); a cancelled run is an error result. */
    static async run(
        input: SimulationInput,
        options: SimulationOptions = {},
    ): Promise<Result<StockSimulation>> {
        const started = now();
        const cellSize = options.cellSize ?? defaultCellSize(input.stock);
        let sim: StockSimulator;
        try {
            sim = new StockSimulator(input.stock, cellSize, {
                gougeTolerance: options.gougeTolerance,
                collisionTolerance: options.collisionTolerance,
            });
        } catch (error) {
            return Result.err(error instanceof Error ? error.message : String(error));
        }
        try {
            const moves = prepare(sim, input, options);
            const initialVolume = sim.volume();
            const total = sim.moveCount;
            const yielder = new Yielder(options.budgetMs ?? 12);
            let slice = 32;
            while (sim.cursor < total && !options.signal?.aborted) {
                const t0 = now();
                sim.run(slice);
                const dt = now() - t0;
                if (dt < 3) slice = Math.min(slice * 2, 1 << 16);
                else if (dt > 12) slice = Math.max(1, slice >> 1);
                options.onProgress?.(sim.cursor, total);
                const tick = yielder.tick();
                if (tick !== undefined) await tick;
            }
            if (options.signal?.aborted) {
                sim.dispose();
                return Result.err("The simulation was cancelled");
            }
            const warnings = groupWarnings(sim, moves, input);
            return Result.ok(
                new StockSimulation(
                    sim,
                    input,
                    moves,
                    cellSize,
                    initialVolume,
                    warnings,
                    now() - started,
                    options.gougeTolerance ?? 0.01,
                ),
            );
        } catch (error) {
            sim.dispose();
            return Result.err(error instanceof Error ? error.message : String(error));
        }
    }

    get disposed(): boolean {
        return this.sim.disposed;
    }

    /** Straight moves in the simulation. */
    get moveCount(): number {
        return this.moves.rapid.length;
    }

    /** The stock shown is after the first `cursor` moves. */
    get cursor(): number {
        return this.sim.cursor;
    }

    /** Puts the stock in its state after the first `index` moves (`moveCount`: the end). */
    seek(index: number): void {
        this.sim.seek(Math.max(0, Math.min(this.moveCount, Math.round(index))));
    }

    /** The stock's mesh in the toolpaths' frame, from every `step`-th cell. */
    mesh(step = 1): StockMeshData {
        return this.sim.mesh(step);
    }

    /** The stock compared with the parts (after the current move), when parts were given. */
    comparison(): StockComparison | undefined {
        return this.sim.comparison();
    }

    /** The stock's grid of material columns. */
    grid(): StockGrid {
        return this.sim.grid();
    }

    /** The material now, mm³. */
    volume(): number {
        return this.sim.volume();
    }

    /** What each move removed, mm³. */
    removedVolumes(): Float64Array {
        this.removed ??= this.sim.removedVolumes();
        return this.removed;
    }

    /** All the program removes, mm³. */
    get totalRemoved(): number {
        return this.removedVolumes().reduce((sum, value) => sum + value, 0);
    }

    move(index: number): SimulatedMove {
        const toolpathIndex = this.moves.toolpath[index];
        const entry = this.input.toolpaths[toolpathIndex];
        return {
            index,
            toolpathIndex,
            id: entry.id,
            sourceMove: this.moves.source[index],
            from: moveStart(this.moves, index),
            to: moveEndPoint(this.moves, index),
            rapid: this.moves.rapid[index] === 1,
            tool: entry.tool,
        };
    }

    /** The first straight move of a toolpath (−1 when it has none). */
    firstMoveOf(toolpathIndex: number): number {
        return this.firstMoves[toolpathIndex] ?? -1;
    }

    dispose(): void {
        this.sim.dispose();
    }
}

/** Runs a simulation of a program (see `StockSimulation`). */
export function simulateToolpaths(
    input: SimulationInput,
    options?: SimulationOptions,
): Promise<Result<StockSimulation>> {
    return StockSimulation.run(input, options);
}

/** Sets up the stock, the part and the tools, and adds the flattened program. */
function prepare(sim: StockSimulator, input: SimulationInput, options: SimulationOptions): SimulationMoves {
    const { stock } = input;
    if (stock.cylinder !== undefined) sim.setStockHeights(cylinderHeights(sim, stock.max[2], stock.cylinder));
    if (stock.mesh !== undefined && stock.mesh.indices.length > 0)
        sim.setStockTriangles(stock.mesh.positions, stock.mesh.indices);
    if (input.part !== undefined && input.part.indices.length > 0)
        sim.setPart(input.part.positions, input.part.indices);
    // The kernel's tool for each toolpath; negative: not a milling tool, the toolpath is left out.
    const tools = new Map<ToolData, number>();
    const toolOfPath = input.toolpaths.map(({ tool }) => {
        let index = tools.get(tool);
        if (index === undefined) {
            const profile = stockToolFor(tool);
            index = profile.isOk ? sim.addTool(profile.value) : -1;
            tools.set(tool, index);
        }
        return index;
    });
    const moves = flattenToolpaths(input.toolpaths, {
        ...options,
        stockTop: stock.max[2],
        skip: (_entry, index) => toolOfPath[index] < 0,
    });
    addMoves(sim, moves, (k) => toolOfPath[moves.toolpath[k]]);
    return moves;
}

/** Adds the moves as one polyline per run of the same tool. */
function addMoves(sim: StockSimulator, moves: SimulationMoves, toolOf: (move: number) => number): void {
    const count = moves.rapid.length;
    let a = 0;
    while (a < count) {
        const tool = toolOf(a);
        let b = a + 1;
        while (b < count && toolOf(b) === tool) b++;
        const points = new Float64Array((b - a + 1) * 3);
        points.set(moveStart(moves, a), 0);
        points.set(moves.ends.subarray(a * 3, b * 3), 3);
        sim.addPath(tool, points, moves.rapid.subarray(a, b));
        a = b;
    }
}

function cylinderHeights(
    sim: StockSimulator,
    top: number,
    { center, radius }: NonNullable<SimulationStock["cylinder"]>,
): Float32Array {
    const grid = sim.grid();
    const heights = new Float32Array(grid.nx * grid.ny);
    for (let j = 0; j < grid.ny; j++) {
        const y = grid.y0 + (j + 0.5) * grid.cellY - center[1];
        for (let i = 0; i < grid.nx; i++) {
            const x = grid.x0 + (i + 0.5) * grid.cellX - center[0];
            heights[j * grid.nx + i] = x * x + y * y <= radius * radius ? top : grid.bottom;
        }
    }
    return heights;
}

/** The kernel's per-move warnings as runs of nearby moves of one toolpath (see `RUN_GAP`). */
function groupWarnings(
    sim: StockSimulator,
    moves: SimulationMoves,
    input: SimulationInput,
): SimulationWarning[] {
    const runs: SimulationWarning[] = [];
    const open = new Map<SimulationWarningKind, number>();
    for (const warning of sim.warnings()) {
        const toolpathIndex = moves.toolpath[warning.moveIndex];
        const previous = open.get(warning.kind) ?? -1;
        const run = runs[previous];
        if (
            run !== undefined &&
            run.toolpathIndex === toolpathIndex &&
            warning.moveIndex - run.lastMove <= RUN_GAP
        ) {
            const worse = warning.depth > run.depth;
            runs[previous] = {
                ...run,
                lastMove: warning.moveIndex,
                depth: worse ? warning.depth : run.depth,
                at: worse ? warning.at : run.at,
                amount: run.amount + warning.amount,
            };
            continue;
        }
        open.set(warning.kind, runs.length);
        runs.push({
            kind: warning.kind,
            toolpathIndex,
            id: input.toolpaths[toolpathIndex]?.id,
            sourceMove: moves.source[warning.moveIndex],
            firstMove: warning.moveIndex,
            lastMove: warning.moveIndex,
            depth: warning.depth,
            at: warning.at,
            amount: warning.amount,
        });
    }
    // Toolpaths left out, where they would have run.
    for (const toolpathIndex of moves.skipped) {
        let at = 0;
        for (let k = 0; k < moves.toolpath.length && moves.toolpath[k] < toolpathIndex; k++) at = k + 1;
        runs.push({
            kind: "unsupported",
            toolpathIndex,
            id: input.toolpaths[toolpathIndex]?.id,
            sourceMove: 0,
            firstMove: at,
            lastMove: at,
            depth: 0,
            at: at > 0 ? moveEndPoint(moves, at - 1) : moves.start,
            amount: 0,
        });
    }
    return runs.sort((a, b) => a.firstMove - b.firstMove || a.toolpathIndex - b.toolpathIndex);
}
