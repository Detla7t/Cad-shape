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
    readonly polygon_boolean: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number, number];
    readonly polygon_clip_polylines: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number, number];
    readonly polygon_nesting: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly polygon_offset: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly polygonnesting_take_depth: (a: number) => [number, number];
    readonly polygonnesting_take_order: (a: number) => [number, number];
    readonly polygonnesting_take_parent: (a: number) => [number, number];
    readonly polygonpaths_take_coords: (a: number) => [number, number];
    readonly polygonpaths_take_lengths: (a: number) => [number, number];
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
