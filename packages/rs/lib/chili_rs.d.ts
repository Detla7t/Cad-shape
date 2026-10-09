/* tslint:disable */
/* eslint-disable */

/**
 * A containment tree: loop indices by decreasing area, and per loop its parent (-1: none) and depth.
 */
export class PolygonNesting {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_depth(): Uint32Array;
    take_order(): Uint32Array;
    take_parent(): Int32Array;
}

/**
 * Result paths, flat. `take_coords` / `take_lengths` move the arrays out.
 */
export class PolygonPaths {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_coords(): Float64Array;
    take_lengths(): Uint32Array;
}

/**
 * A 3-axis stock simulation: a box of material cut by straight moves of tools (see the
 * `stocksim` crate). Millimetres, in the moves' frame.
 */
export class StockSim {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Appends a polyline of moves cut with `tool`: `points` holds n + 1 xyz points (where the
     * tool starts, then each move's end), `rapid` n flags (non-zero: a rapid). Returns the
     * index of its first move.
     */
    add_moves(tool: number, points: Float64Array, rapid: Uint8Array): number;
    /**
     * Adds a tool and returns its index. `kind`: `flat`, `ball`, `bull` (`corner_radius`),
     * `cone` (included `angle`, `tip_diameter`), `drill` (point `angle`) or `tapered`
     * (`corner_radius`, `angle` of each flank from the axis, `tip_diameter` of the flat
     * bottom). Absent lengths: flutes along the whole tool, a shank of the cutting diameter,
     * no holder; a holder needs its `stickout` (its face's height above the tip).
     */
    add_tool(kind: string, diameter: number, corner_radius?: number | null, angle?: number | null, tip_diameter?: number | null, flute_length?: number | null, shank_diameter?: number | null, holder_diameter?: number | null, holder_length?: number | null, stickout?: number | null): number;
    /**
     * The stock compared with the part, 8 numbers: excess volume (mm³), thickest excess
     * (mm), gouge volume (mm³), deepest gouge (mm), gouged cells, and the deepest gouge's
     * x, y, z; empty without a part.
     */
    comparison(): Float64Array;
    /**
     * The moves cut so far (the stock is after `moves[..cursor]`).
     */
    cursor(): number;
    /**
     * Each column's signed deviation from the part (NaN without one).
     */
    deviations(): Float32Array;
    /**
     * The grid: x0, y0, cell size x, cell size y, nx, ny, bottom.
     */
    grid(): Float64Array;
    /**
     * The column heights, row-major.
     */
    heights(): Float32Array;
    /**
     * The stock's mesh from every `step`-th cell centre.
     */
    mesh(step: number): StockSimMesh;
    move_count(): number;
    /**
     * A box of stock from `min` to `max`, in cells of at most `cell` mm.
     */
    constructor(min_x: number, min_y: number, min_z: number, max_x: number, max_y: number, max_z: number, cell: number);
    /**
     * Removed volume of each move cut at least once, mm³.
     */
    removed(): Float64Array;
    /**
     * Cuts up to `count` more moves; returns how many are cut.
     */
    run(count: number): number;
    /**
     * Puts the stock in its state after the first `index` moves.
     */
    seek(index: number): void;
    /**
     * The part the cuts are checked against (gouges) and compared with (deviation).
     */
    set_part(positions: Float32Array, indices: Uint32Array): void;
    /**
     * Replaces the stock's column heights (row-major, `nx × ny`, see `grid`).
     */
    set_stock_heights(heights: Float32Array): void;
    /**
     * Makes the stock the region under a triangulated body (xyz positions, 3 indices per
     * triangle), within the box.
     */
    set_stock_triangles(positions: Float32Array, indices: Uint32Array): void;
    /**
     * Gouge (also the XY slack of the part comparison) and collision tolerances, mm. Set
     * them before the part.
     */
    set_tolerances(gouge: number, collision: number): void;
    /**
     * The material's volume, mm³.
     */
    volume(): number;
    /**
     * Warnings of the moves cut at least once, 7 numbers each: kind (1 rapid in stock,
     * 2 shank collision, 3 holder collision, 4 gouge, 5 unsupported move), move index, depth
     * (mm), amount (rapid: mm³ removed; gouge: cells), x, y, z.
     */
    warnings(): Float64Array;
}

/**
 * A mesh of the stock: positions and normals (xyz per vertex), indices (three per
 * triangle) and, with a part set, the signed deviation from it per vertex.
 */
export class StockSimMesh {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Empty when no part is set.
     */
    deviation(): Float32Array;
    indices(): Uint32Array;
    normals(): Float32Array;
    positions(): Float32Array;
}

/**
 * A boolean of two regions, each filled by its fill rule: clean loops, outer boundaries
 * counter-clockwise each followed by its (clockwise) holes.
 */
export function polygon_boolean(op: string, subject_coords: Float64Array, subject_lengths: Uint32Array, clip_coords: Float64Array, clip_lengths: Uint32Array, fill: string, scale: number): PolygonPaths;

/**
 * The parts of open polylines inside (or outside) a region filled by `fill`.
 */
export function polygon_clip_polylines(line_coords: Float64Array, line_lengths: Uint32Array, region_coords: Float64Array, region_lengths: Uint32Array, fill: string, keep: string, scale: number): PolygonPaths;

/**
 * How closed loops nest (containment, any orientation).
 */
export function polygon_nesting(coords: Float64Array, lengths: Uint32Array): PolygonNesting;

/**
 * Closed loops offset by `delta` mm (positive grows the region; roles by orientation).
 */
export function polygon_offset(coords: Float64Array, lengths: Uint32Array, delta: number, join: string, join_parameter: number, scale: number): PolygonPaths;

/**
 * The module's version (the workspace version), for a loaded-module check.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_polygonnesting_free: (a: number, b: number) => void;
    readonly __wbg_polygonpaths_free: (a: number, b: number) => void;
    readonly __wbg_stocksim_free: (a: number, b: number) => void;
    readonly __wbg_stocksimmesh_free: (a: number, b: number) => void;
    readonly polygon_boolean: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number, number];
    readonly polygon_clip_polylines: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number, number];
    readonly polygon_nesting: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly polygon_offset: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly polygonnesting_take_depth: (a: number) => [number, number];
    readonly polygonnesting_take_order: (a: number) => [number, number];
    readonly polygonnesting_take_parent: (a: number) => [number, number];
    readonly polygonpaths_take_coords: (a: number) => [number, number];
    readonly polygonpaths_take_lengths: (a: number) => [number, number];
    readonly stocksim_add_moves: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly stocksim_add_tool: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number) => [number, number, number];
    readonly stocksim_comparison: (a: number) => [number, number];
    readonly stocksim_cursor: (a: number) => number;
    readonly stocksim_deviations: (a: number) => [number, number];
    readonly stocksim_grid: (a: number) => [number, number];
    readonly stocksim_heights: (a: number) => [number, number];
    readonly stocksim_mesh: (a: number, b: number) => number;
    readonly stocksim_move_count: (a: number) => number;
    readonly stocksim_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly stocksim_removed: (a: number) => [number, number];
    readonly stocksim_run: (a: number, b: number) => number;
    readonly stocksim_seek: (a: number, b: number) => void;
    readonly stocksim_set_part: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly stocksim_set_stock_heights: (a: number, b: number, c: number) => [number, number];
    readonly stocksim_set_stock_triangles: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly stocksim_set_tolerances: (a: number, b: number, c: number) => [number, number];
    readonly stocksim_volume: (a: number) => number;
    readonly stocksim_warnings: (a: number) => [number, number];
    readonly stocksimmesh_deviation: (a: number) => [number, number];
    readonly stocksimmesh_indices: (a: number) => [number, number];
    readonly stocksimmesh_normals: (a: number) => [number, number];
    readonly stocksimmesh_positions: (a: number) => [number, number];
    readonly version: () => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
