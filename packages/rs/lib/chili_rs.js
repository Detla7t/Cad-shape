/* @ts-self-types="./chili_rs.d.ts" */

/**
 * A containment tree: loop indices by decreasing area, and per loop its parent (-1: none) and depth.
 */
export class PolygonNesting {
    static __wrap(ptr) {
        const obj = Object.create(PolygonNesting.prototype);
        obj.__wbg_ptr = ptr;
        PolygonNestingFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PolygonNestingFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_polygonnesting_free(ptr, 0);
    }
    /**
     * @returns {Uint32Array}
     */
    take_depth() {
        const ret = wasm.polygonnesting_take_depth(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_order() {
        const ret = wasm.polygonnesting_take_order(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Int32Array}
     */
    take_parent() {
        const ret = wasm.polygonnesting_take_parent(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) PolygonNesting.prototype[Symbol.dispose] = PolygonNesting.prototype.free;

/**
 * Result paths, flat. `take_coords` / `take_lengths` move the arrays out.
 */
export class PolygonPaths {
    static __wrap(ptr) {
        const obj = Object.create(PolygonPaths.prototype);
        obj.__wbg_ptr = ptr;
        PolygonPathsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PolygonPathsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_polygonpaths_free(ptr, 0);
    }
    /**
     * @returns {Float64Array}
     */
    take_coords() {
        const ret = wasm.polygonpaths_take_coords(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_lengths() {
        const ret = wasm.polygonpaths_take_lengths(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) PolygonPaths.prototype[Symbol.dispose] = PolygonPaths.prototype.free;

/**
 * A 3-axis stock simulation: a box of material cut by straight moves of tools (see the
 * `stocksim` crate). Millimetres, in the moves' frame.
 */
export class StockSim {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        StockSimFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_stocksim_free(ptr, 0);
    }
    /**
     * Appends a polyline of moves cut with `tool`: `points` holds n + 1 xyz points (where the
     * tool starts, then each move's end), `rapid` n flags (non-zero: a rapid). Returns the
     * index of its first move.
     * @param {number} tool
     * @param {Float64Array} points
     * @param {Uint8Array} rapid
     * @returns {number}
     */
    add_moves(tool, points, rapid) {
        const ptr0 = passArrayF64ToWasm0(points, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(rapid, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.stocksim_add_moves(this.__wbg_ptr, tool, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Adds a tool and returns its index. `kind`: `flat`, `ball`, `bull` (`corner_radius`),
     * `cone` (included `angle`, `tip_diameter`), `drill` (point `angle`) or `tapered`
     * (`corner_radius`, `angle` of each flank from the axis, `tip_diameter` of the flat
     * bottom). Absent lengths: flutes along the whole tool, a shank of the cutting diameter,
     * no holder; a holder needs its `stickout` (its face's height above the tip).
     * @param {string} kind
     * @param {number} diameter
     * @param {number | null} [corner_radius]
     * @param {number | null} [angle]
     * @param {number | null} [tip_diameter]
     * @param {number | null} [flute_length]
     * @param {number | null} [shank_diameter]
     * @param {number | null} [holder_diameter]
     * @param {number | null} [holder_length]
     * @param {number | null} [stickout]
     * @returns {number}
     */
    add_tool(kind, diameter, corner_radius, angle, tip_diameter, flute_length, shank_diameter, holder_diameter, holder_length, stickout) {
        const ptr0 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.stocksim_add_tool(this.__wbg_ptr, ptr0, len0, diameter, !isLikeNone(corner_radius), isLikeNone(corner_radius) ? 0 : corner_radius, !isLikeNone(angle), isLikeNone(angle) ? 0 : angle, !isLikeNone(tip_diameter), isLikeNone(tip_diameter) ? 0 : tip_diameter, !isLikeNone(flute_length), isLikeNone(flute_length) ? 0 : flute_length, !isLikeNone(shank_diameter), isLikeNone(shank_diameter) ? 0 : shank_diameter, !isLikeNone(holder_diameter), isLikeNone(holder_diameter) ? 0 : holder_diameter, !isLikeNone(holder_length), isLikeNone(holder_length) ? 0 : holder_length, !isLikeNone(stickout), isLikeNone(stickout) ? 0 : stickout);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * The stock compared with the part, 8 numbers: excess volume (mm³), thickest excess
     * (mm), gouge volume (mm³), deepest gouge (mm), gouged cells, and the deepest gouge's
     * x, y, z; empty without a part.
     * @returns {Float64Array}
     */
    comparison() {
        const ret = wasm.stocksim_comparison(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The moves cut so far (the stock is after `moves[..cursor]`).
     * @returns {number}
     */
    cursor() {
        const ret = wasm.stocksim_cursor(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Each column's signed deviation from the part (NaN without one).
     * @returns {Float32Array}
     */
    deviations() {
        const ret = wasm.stocksim_deviations(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The grid: x0, y0, cell size x, cell size y, nx, ny, bottom.
     * @returns {Float64Array}
     */
    grid() {
        const ret = wasm.stocksim_grid(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The column heights, row-major.
     * @returns {Float32Array}
     */
    heights() {
        const ret = wasm.stocksim_heights(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The stock's mesh from every `step`-th cell centre.
     * @param {number} step
     * @returns {StockSimMesh}
     */
    mesh(step) {
        const ret = wasm.stocksim_mesh(this.__wbg_ptr, step);
        return StockSimMesh.__wrap(ret);
    }
    /**
     * @returns {number}
     */
    move_count() {
        const ret = wasm.stocksim_move_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * A box of stock from `min` to `max`, in cells of at most `cell` mm.
     * @param {number} min_x
     * @param {number} min_y
     * @param {number} min_z
     * @param {number} max_x
     * @param {number} max_y
     * @param {number} max_z
     * @param {number} cell
     */
    constructor(min_x, min_y, min_z, max_x, max_y, max_z, cell) {
        const ret = wasm.stocksim_new(min_x, min_y, min_z, max_x, max_y, max_z, cell);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        StockSimFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Removed volume of each move cut at least once, mm³.
     * @returns {Float64Array}
     */
    removed() {
        const ret = wasm.stocksim_removed(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Cuts up to `count` more moves; returns how many are cut.
     * @param {number} count
     * @returns {number}
     */
    run(count) {
        const ret = wasm.stocksim_run(this.__wbg_ptr, count);
        return ret >>> 0;
    }
    /**
     * Puts the stock in its state after the first `index` moves.
     * @param {number} index
     */
    seek(index) {
        wasm.stocksim_seek(this.__wbg_ptr, index);
    }
    /**
     * The part the cuts are checked against (gouges) and compared with (deviation).
     * @param {Float32Array} positions
     * @param {Uint32Array} indices
     */
    set_part(positions, indices) {
        const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.stocksim_set_part(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Replaces the stock's column heights (row-major, `nx × ny`, see `grid`).
     * @param {Float32Array} heights
     */
    set_stock_heights(heights) {
        const ptr0 = passArrayF32ToWasm0(heights, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.stocksim_set_stock_heights(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Makes the stock the region under a triangulated body (xyz positions, 3 indices per
     * triangle), within the box.
     * @param {Float32Array} positions
     * @param {Uint32Array} indices
     */
    set_stock_triangles(positions, indices) {
        const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.stocksim_set_stock_triangles(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Gouge (also the XY slack of the part comparison) and collision tolerances, mm. Set
     * them before the part.
     * @param {number} gouge
     * @param {number} collision
     */
    set_tolerances(gouge, collision) {
        const ret = wasm.stocksim_set_tolerances(this.__wbg_ptr, gouge, collision);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The material's volume, mm³.
     * @returns {number}
     */
    volume() {
        const ret = wasm.stocksim_volume(this.__wbg_ptr);
        return ret;
    }
    /**
     * Warnings of the moves cut at least once, 7 numbers each: kind (1 rapid in stock,
     * 2 shank collision, 3 holder collision, 4 gouge, 5 unsupported move), move index, depth
     * (mm), amount (rapid: mm³ removed; gouge: cells), x, y, z.
     * @returns {Float64Array}
     */
    warnings() {
        const ret = wasm.stocksim_warnings(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) StockSim.prototype[Symbol.dispose] = StockSim.prototype.free;

/**
 * A mesh of the stock: positions and normals (xyz per vertex), indices (three per
 * triangle) and, with a part set, the signed deviation from it per vertex.
 */
export class StockSimMesh {
    static __wrap(ptr) {
        const obj = Object.create(StockSimMesh.prototype);
        obj.__wbg_ptr = ptr;
        StockSimMeshFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        StockSimMeshFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_stocksimmesh_free(ptr, 0);
    }
    /**
     * Empty when no part is set.
     * @returns {Float32Array}
     */
    deviation() {
        const ret = wasm.stocksimmesh_deviation(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    indices() {
        const ret = wasm.stocksimmesh_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    normals() {
        const ret = wasm.stocksimmesh_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    positions() {
        const ret = wasm.stocksimmesh_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) StockSimMesh.prototype[Symbol.dispose] = StockSimMesh.prototype.free;

/**
 * A boolean of two regions, each filled by its fill rule: clean loops, outer boundaries
 * counter-clockwise each followed by its (clockwise) holes.
 * @param {string} op
 * @param {Float64Array} subject_coords
 * @param {Uint32Array} subject_lengths
 * @param {Float64Array} clip_coords
 * @param {Uint32Array} clip_lengths
 * @param {string} fill
 * @param {number} scale
 * @returns {PolygonPaths}
 */
export function polygon_boolean(op, subject_coords, subject_lengths, clip_coords, clip_lengths, fill, scale) {
    const ptr0 = passStringToWasm0(op, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(subject_coords, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray32ToWasm0(subject_lengths, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(clip_coords, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray32ToWasm0(clip_lengths, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passStringToWasm0(fill, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len5 = WASM_VECTOR_LEN;
    const ret = wasm.polygon_boolean(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, scale);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return PolygonPaths.__wrap(ret[0]);
}

/**
 * The parts of open polylines inside (or outside) a region filled by `fill`.
 * @param {Float64Array} line_coords
 * @param {Uint32Array} line_lengths
 * @param {Float64Array} region_coords
 * @param {Uint32Array} region_lengths
 * @param {string} fill
 * @param {string} keep
 * @param {number} scale
 * @returns {PolygonPaths}
 */
export function polygon_clip_polylines(line_coords, line_lengths, region_coords, region_lengths, fill, keep, scale) {
    const ptr0 = passArrayF64ToWasm0(line_coords, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(line_lengths, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(region_coords, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(region_lengths, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(fill, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passStringToWasm0(keep, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len5 = WASM_VECTOR_LEN;
    const ret = wasm.polygon_clip_polylines(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, scale);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return PolygonPaths.__wrap(ret[0]);
}

/**
 * How closed loops nest (containment, any orientation).
 * @param {Float64Array} coords
 * @param {Uint32Array} lengths
 * @returns {PolygonNesting}
 */
export function polygon_nesting(coords, lengths) {
    const ptr0 = passArrayF64ToWasm0(coords, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(lengths, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.polygon_nesting(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return PolygonNesting.__wrap(ret[0]);
}

/**
 * Closed loops offset by `delta` mm (positive grows the region; roles by orientation).
 * @param {Float64Array} coords
 * @param {Uint32Array} lengths
 * @param {number} delta
 * @param {string} join
 * @param {number} join_parameter
 * @param {number} scale
 * @returns {PolygonPaths}
 */
export function polygon_offset(coords, lengths, delta, join, join_parameter, scale) {
    const ptr0 = passArrayF64ToWasm0(coords, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(lengths, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(join, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.polygon_offset(ptr0, len0, ptr1, len1, delta, ptr2, len2, join_parameter, scale);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return PolygonPaths.__wrap(ret[0]);
}

/**
 * The module's version (the workspace version), for a loaded-module check.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./chili_rs_bg.js": import0,
    };
}

const PolygonNestingFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_polygonnesting_free(ptr, 1));
const PolygonPathsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_polygonpaths_free(ptr, 1));
const StockSimFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_stocksim_free(ptr, 1));
const StockSimMeshFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_stocksimmesh_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('chili_rs_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
