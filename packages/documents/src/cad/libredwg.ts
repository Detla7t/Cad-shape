// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";

/**
 * The LibreDWG backend: DWG → DXF with GNU LibreDWG compiled to WebAssembly
 * (`@mlightcad/libredwg-web`, GPL-3.0 — compatible with Chili3D's AGPL-3.0). Loaded on
 * the first DWG; the module is created once and recreated after a failure (an aborted
 * WebAssembly instance cannot be reused).
 */

/** The part of `@mlightcad/libredwg-web` used here (its bundled .d.ts files do not type-check). */
interface LibreDwgModule {
    createModule(options: Record<string, unknown>): Promise<unknown>;
    LibreDwg: { createByWasmInstance(instance: unknown): LibreDwgApi };
}

interface LibreDwgApi {
    /** DWG bytes → DXF bytes, null when LibreDWG cannot read the file. */
    dwg_write_dxf(content: ArrayBuffer): Uint8Array | null;
    /** Parses a DWG (file type 0); a pointer to the drawing, undefined on failure. */
    dwg_read_data(content: ArrayBuffer, fileType: number): number | undefined;
    convert(data: number): {
        tables?: { LAYER?: { entries?: { name: string; off?: boolean; frozen?: boolean }[] } };
    };
    dwg_free(data: number): void;
}

const DWG_FILE = 0;

let instance: Promise<LibreDwgApi> | undefined;
let wasmBinary: Uint8Array | undefined;

/** Hands the module its wasm bytes instead of fetching them (Node tests). */
export function setLibreDwgWasmBinary(binary: Uint8Array | undefined): void {
    wasmBinary = binary;
    instance = undefined;
}

async function createLibreDwg(): Promise<LibreDwgApi> {
    // A non-literal type keeps TypeScript out of the package's declarations; the bundler
    // still sees the literal specifier and gives the module its own chunk.
    const module = (await import("@mlightcad/libredwg-web" as string)) as LibreDwgModule;
    // In the app the module finds its wasm next to itself (the bundler emits it as an asset).
    const wasm = await module.createModule(
        wasmBinary === undefined ? {} : { wasmBinary: wasmBinary.slice().buffer },
    );
    return module.LibreDwg.createByWasmInstance(wasm);
}

/**
 * The layers that are off or frozen, from LibreDWG's own reading of the drawing: the
 * layer table of the DXF it writes marks layers off that the drawing has on.
 */
function hiddenLayers(libredwg: LibreDwgApi, bytes: Uint8Array): Set<string> | undefined {
    const data = libredwg.dwg_read_data(bytes.slice().buffer, DWG_FILE);
    if (data === undefined || data === 0) return undefined;
    try {
        const layers = libredwg.convert(data).tables?.LAYER?.entries ?? [];
        return new Set(
            layers.filter((layer) => layer.off === true || layer.frozen === true).map((layer) => layer.name),
        );
    } finally {
        libredwg.dwg_free(data);
    }
}

export async function libreDwgToDxf(
    bytes: Uint8Array,
): Promise<Result<{ dxf: Uint8Array; hiddenLayers?: Set<string> }>> {
    instance ??= createLibreDwg();
    const libredwg = await instance;
    let dxf: Uint8Array | null;
    let hidden: Set<string> | undefined;
    try {
        dxf = libredwg.dwg_write_dxf(bytes.slice().buffer);
        if (dxf !== null && dxf.length > 0) hidden = hiddenLayers(libredwg, bytes);
    } catch (error) {
        instance = undefined;
        throw error;
    }
    if (dxf === null || dxf.length === 0) return Result.err("LibreDWG could not convert the file");
    return Result.ok(hidden === undefined ? { dxf } : { dxf, hiddenLayers: hidden });
}
