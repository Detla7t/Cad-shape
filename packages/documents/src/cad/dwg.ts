// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger, Result } from "@chili3d/core";
import type { Drawing } from "@chili3d/parametric";
import { type DrawingImportOptions, type ImportedDrawing, importDxf } from "./dxfToDrawing";

/**
 * DWG through DXF: a DWG is converted to DXF text by a backend and then read like any
 * DXF, so both formats share one importer. The default backend is LibreDWG compiled to
 * WebAssembly (`@mlightcad/libredwg-web`, GPL-3.0, its own lazily loaded chunk and a
 * ~9.5 MB wasm asset), with the MIT `@node-projects/acad-ts` reader as the fallback for
 * files LibreDWG refuses. Writing DWG goes through acad-ts (LibreDWG's published wasm is
 * built without write support).
 */

/** A DWG file converted to DXF. */
export interface DwgConversion {
    /** DXF text or bytes. */
    readonly dxf: Uint8Array | string;
    /**
     * The layers that are off or frozen in the DWG, when the backend knows them better than
     * the layer table of the DXF it wrote (see `libredwg.ts`).
     */
    readonly hiddenLayers?: ReadonlySet<string>;
}

export interface DwgBackend {
    readonly name: string;
    dwgToDxf(bytes: Uint8Array): Promise<Result<DwgConversion>>;
}

let backends: readonly DwgBackend[] | undefined;

/** The backends tried in order (LibreDWG, then acad-ts) — replaceable for tests and other builds. */
export function setDwgBackends(list: readonly DwgBackend[] | undefined): void {
    backends = list;
}

const LIBREDWG: DwgBackend = {
    name: "LibreDWG",
    dwgToDxf: async (bytes) => (await import("./libredwg")).libreDwgToDxf(bytes),
};

const ACAD_TS: DwgBackend = {
    name: "acad-ts",
    dwgToDxf: async (bytes) => (await import("./acadTs")).acadDwgToDxf(bytes),
};

/** A DWG file as DXF, from the first backend that reads it. */
export async function dwgToDxf(bytes: Uint8Array): Promise<Result<DwgConversion>> {
    const errors: string[] = [];
    for (const backend of backends ?? [LIBREDWG, ACAD_TS]) {
        try {
            const dxf = await backend.dwgToDxf(bytes);
            if (dxf.isOk) return dxf;
            errors.push(`${backend.name}: ${dxf.error}`);
        } catch (error) {
            errors.push(`${backend.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    Logger.warn(`DWG could not be read — ${errors.join("; ")}`);
    return Result.err(errors.join("; "));
}

/** Reads a DWG file into a drawing in millimetres (see `importDxf`). */
export async function importDwg(
    bytes: Uint8Array,
    options: DrawingImportOptions = {},
): Promise<Result<ImportedDrawing>> {
    const converted = await dwgToDxf(bytes);
    if (!converted.isOk) return Result.err(converted.error);
    const { dxf, hiddenLayers } = converted.value;
    return importDxf(dxf, hiddenLayers === undefined ? options : { hiddenLayers, ...options });
}

/** A drawing (millimetres) as AutoCAD 2004 (AC1018) DWG bytes. */
export async function writeDwg(
    drawing: Drawing,
    options: { properties?: Readonly<Record<string, string>> } = {},
): Promise<Result<Uint8Array>> {
    try {
        return Result.ok(await (await import("./acadTs")).drawingToDwg(drawing, options));
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}
