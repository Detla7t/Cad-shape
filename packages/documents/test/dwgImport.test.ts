// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectFileFormat, Result } from "@chili3d/core";
import { acadDwgToDxf } from "../src/cad/acadTs";
import { drawingToSketchData } from "../src/cad/drawingToSketch";
import { type DwgBackend, importDwg, setDwgBackends, writeDwg } from "../src/cad/dwg";
import { importDxf } from "../src/cad/dxfToDrawing";
import { libreDwgToDxf, setLibreDwgWasmBinary } from "../src/cad/libredwg";

/**
 * DWG import through LibreDWG (the real WebAssembly module, run in Node) and acad-ts. The
 * fixture `plate.dwg` is `plate.dxf` written as AutoCAD 2004 DWG by acad-ts
 * (`scripts/make-documents-dwg-fixture.mjs`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const plateDxf = readFileSync(path.join(here, "fixtures/plate.dxf"));
const plateDwg = new Uint8Array(readFileSync(path.join(here, "fixtures/plate.dwg")));
const libredwgDir = path.dirname(createRequire(import.meta.url).resolve("@mlightcad/libredwg-web"));

beforeAll(() => {
    setLibreDwgWasmBinary(readFileSync(path.join(libredwgDir, "../wasm/libredwg-web.wasm")));
});

afterEach(() => {
    setDwgBackends(undefined);
});

/** The part of acad-ts the tests drive (imported without its declarations, see `acadTs.ts`). */
interface AcadForTests {
    ACadVersion: { AC1018: number };
    DxfReaderConfiguration: new () => { createDefaults: boolean };
    DxfReader: {
        readFromStreamWithConfig(
            stream: Uint8Array,
            configuration: unknown,
            notification: () => void,
        ): { header: { version: number }; layers: Iterable<{ name: string; isOn: boolean }> };
    };
    DwgWriter: { writeToBuffer(document: unknown): Uint8Array };
}

/** The fixture's sketch entities, rounded (DWG stores doubles; the DXF text rounds them). */
function sketchOf(drawing: ReturnType<typeof importDxf>) {
    expect(drawing.isOk).toBe(true);
    const { data } = drawingToSketchData(drawing.value.drawing, drawing.value.sources);
    return data.entities.map((entity) => ({
        type: entity.type,
        params: entity.params.map((value) => Math.round(value * 1e6) / 1e6 + 0),
    }));
}

describe("DWG import", () => {
    test("the fixture is recognized as AutoCAD 2004 DWG by its content, whatever its name", () => {
        expect(detectFileFormat("plate.dwg", plateDwg)).toMatchObject({
            id: "dwg",
            version: "AC1018",
            by: "content",
        });
        expect(detectFileFormat("plate.dxf", plateDwg)).toMatchObject({ id: "dwg", mismatch: true });
    });

    test("LibreDWG (WebAssembly) reads the DWG into the same sketch entities as the DXF", async () => {
        const fromDwg = await importDwg(plateDwg);
        expect(fromDwg.isOk).toBe(true);
        expect(fromDwg.value.units).toMatchObject({ name: "mm", assumed: false });
        expect(sketchOf(fromDwg)).toEqual(sketchOf(importDxf(plateDxf)));
        const texts = fromDwg.value.drawing.entities.filter((entity) => entity.kind === "text");
        expect(texts.map((text) => (text.kind === "text" ? text.text : ""))).toEqual(["Plate Ø5"]);
    });

    test("the acad-ts reader converts the same DWG", async () => {
        const converted = await acadDwgToDxf(plateDwg);
        expect(converted.isOk).toBe(true);
        expect(sketchOf(importDxf(converted.value.dxf))).toEqual(sketchOf(importDxf(plateDxf)));
    });

    test("LibreDWG refuses bytes that are not a DWG", async () => {
        const result = await libreDwgToDxf(new TextEncoder().encode("AC1018 but not really a drawing"));
        expect(result.isOk).toBe(false);
    });

    test("backends are tried in order: the first that reads the file wins", async () => {
        const calls: string[] = [];
        const failing: DwgBackend = {
            name: "broken",
            dwgToDxf: async () => {
                calls.push("broken");
                return Result.err("cannot read");
            },
        };
        const throwing: DwgBackend = {
            name: "crashing",
            dwgToDxf: async () => {
                calls.push("crashing");
                throw new Error("aborted");
            },
        };
        const mock: DwgBackend = {
            name: "mock",
            dwgToDxf: async (bytes) => {
                calls.push(`mock:${bytes.length}`);
                return Result.ok({ dxf: plateDxf.toString("utf8") });
            },
        };
        setDwgBackends([failing, throwing, mock]);
        const drawing = await importDwg(plateDwg);
        expect(calls).toEqual(["broken", "crashing", `mock:${plateDwg.length}`]);
        expect(sketchOf(drawing)).toEqual(sketchOf(importDxf(plateDxf)));
    });

    test("when no backend reads the file the error names each backend's reason", async () => {
        setDwgBackends([
            { name: "first", dwgToDxf: async () => Result.err("bad header") },
            { name: "second", dwgToDxf: async () => Result.err("unsupported version") },
        ]);
        const result = await importDwg(plateDwg);
        expect(result.isOk).toBe(false);
        expect(result.error).toBe("first: bad header; second: unsupported version");
    });

    test("layers switched off in the DWG are left out (LibreDWG's own layer table, not its DXF's)", async () => {
        // Built with acad-ts: a DXF with layers ON and OFF, then layer OFF switched off.
        const acad = (await import("@node-projects/acad-ts" as string)) as AcadForTests;
        const dxf = [
            "0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n2",
            "0\nLAYER\n2\nON\n70\n0\n62\n1\n6\nCONTINUOUS",
            "0\nLAYER\n2\nOFF\n70\n0\n62\n-3\n6\nCONTINUOUS",
            "0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES",
            "0\nLINE\n8\nON\n10\n0\n20\n0\n30\n0\n11\n10\n21\n0\n31\n0",
            "0\nLINE\n8\nOFF\n10\n0\n20\n5\n30\n0\n11\n10\n21\n5\n31\n0",
            "0\nENDSEC\n0\nEOF\n",
        ].join("\n");
        const configuration = new acad.DxfReaderConfiguration();
        configuration.createDefaults = true;
        const document = acad.DxfReader.readFromStreamWithConfig(
            new TextEncoder().encode(dxf),
            configuration,
            () => {},
        );
        document.header.version = acad.ACadVersion.AC1018;
        for (const layer of document.layers) if (layer.name === "OFF") layer.isOn = false;
        const drawing = await importDwg(acad.DwgWriter.writeToBuffer(document));
        expect(drawing.isOk).toBe(true);
        expect(drawing.value.drawing.entities.map((entity) => entity.layer)).toEqual(["ON"]);
        expect(drawing.value.skipped).toEqual({ "LINE (hidden layer)": 1 });
    });

    test("a drawing written as DWG (acad-ts) reads back with LibreDWG", async () => {
        const drawing = importDxf(plateDxf).value.drawing;
        const dwg = await writeDwg(drawing);
        expect(dwg.isOk).toBe(true);
        expect(new TextDecoder().decode(dwg.value.subarray(0, 6))).toBe("AC1018");
        const back = await importDwg(dwg.value);
        expect(back.isOk).toBe(true);
        const kinds = (entities: readonly { kind: string }[]) => entities.map((entity) => entity.kind).sort();
        expect(kinds(back.value.drawing.entities)).toEqual(kinds(drawing.entities));
        expect(back.value.drawing.layers.map((layer) => layer.name).sort()).toEqual(
            drawing.layers.map((layer) => layer.name).sort(),
        );
    });
});
