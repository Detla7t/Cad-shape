// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, OccShapeConverter, ShapeFactory } from "@chili3d/wasm";
import { PROJECTION_LAYERS, projectView } from "../../../documents/src/cad/projection";
import { writeDxf } from "../../src/drawing/dxf";
import { writeSvg } from "../../src/drawing/svg";
import { FsContext } from "../../src/featurescript/context/fsContext";
import { FsArray, FsMap, type FsValue } from "../../src/featurescript/lang/values";
import { describeStatus, featureState } from "../../src/featurescript/onshape/featureBuiltins";
import { createOnshapeInterpreter } from "../../src/featurescript/onshape/onshapeStd";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(directory, "fixtures/export-parity/testing.fs"), "utf8");
const originalFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
const exportDirectory = process.env["CAD_PARITY_OUTPUT"];

beforeAll(async () => {
    await initWasm({ wasmBinary: readFileSync(path.join(directory, "../../../wasm/lib/chili-wasm.wasm")) });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    if (exportDirectory) mkdirSync(exportDirectory, { recursive: true });
});

afterAll(() => {
    if (originalFactory) Object.defineProperty(globalThis, "shapeFactory", originalFactory);
    else Reflect.deleteProperty(globalThis, "shapeFactory");
});

function plain(value: FsValue): any {
    if (value instanceof FsArray) return value.items.map(plain);
    if (value instanceof FsMap)
        return Object.fromEntries(value.pairs().map(([k, v]) => [String(k), plain(v)]));
    return value;
}

function run(body: string, inspect: (context: FsContext, result: any) => void) {
    const interpreter = createOnshapeInterpreter({ std: ONSHAPE_STD });
    const module = interpreter.load({
        path: "testing",
        source: `${source}\nexport function run(context is Context) { ${body} }`,
    });
    const context = new FsContext();
    try {
        const result = plain(interpreter.callFunction(module.env.lookup("run")?.value, [context.value]));
        const errors = [...featureState(context).status.entries()]
            .map(([id, status]) => ({ id, ...describeStatus(status) }))
            .filter((status) => status.kind === "ERROR");
        expect(errors).toEqual([]);
        inspect(context, result);
    } finally {
        context.dispose();
    }
}

// Analytical volumes verify construction, independently of either engine's exporter.
const expectedVolumes = [
    1000,
    3000 * Math.PI,
    4000 - 160 * (1 - Math.PI / 4),
    3920,
    1084,
    3000,
    3000,
    2000,
    7000,
    156 * Math.PI,
    252 * Math.PI,
    4000 - 4000 * Math.tan((5 * Math.PI) / 180) + (4000 / 3) * Math.tan((5 * Math.PI) / 180) ** 2,
    400,
];

test.each(
    expectedVolumes.map((volume, index) => ({ volume, index })),
)("specimen $index has its analytical volume", ({ volume, index }) => {
    run(`return buildSpecimen(context, makeId("specimen"), ${index});`, (_context, measurement) => {
        expect(measurement.volume).toBeCloseTo(volume, 5);
    });
});

test("13 sketch-based specimens produce 19 valid gallery solids and raw STEP", () => {
    run('return buildGallery(context, makeId("testing"));', (context, measurements) => {
        expect(measurements).toHaveLength(13);
        measurements.forEach((measurement: { volume: number }, i: number) => {
            expect(measurement.volume, `specimen ${i}`).toBeCloseTo(expectedVolumes[i], 5);
        });
        const solids = context.bodies.filter((body) => body.isModelGeometry && body.kind === "SOLID");
        expect(solids).toHaveLength(19);
        for (const solid of solids) expect(solid.shape.checkShape(), solid.name).toBe(true);
        const step = new OccShapeConverter().convertToSTEP(...solids.map((body) => body.shape));
        expect(step.isOk).toBe(true);
        if (!step.isOk) throw new Error(step.error);
        expect(step.value).toContain("MANIFOLD_SOLID_BREP");
        if (exportDirectory) {
            writeFileSync(path.join(exportDirectory, "gallery.step"), step.value);
            writeFileSync(
                path.join(exportDirectory, "measurements.json"),
                `${JSON.stringify(
                    {
                        engine: "Chili3D",
                        libraryVersion: 3083,
                        sourceSha256: createHash("sha256").update(source).digest("hex"),
                        measurements,
                    },
                    null,
                    2,
                )}\n`,
            );
        }
    });
});

test("2D drawing exports its solved rectangle, circle, semicircle and hexagon", () => {
    run('buildDrawing(context, makeId("drawing"));', (context) => {
        const shapes = context.bodies
            .filter((body) => body.flags.sketch && body.kind === "WIRE")
            .map((body) => body.shape);
        expect(shapes.length).toBeGreaterThan(0);
        const entities = projectView(shapes, "top", { hidden: false });
        expect(entities.filter((entity) => entity.kind === "line")).toHaveLength(11);
        expect(entities.filter((entity) => entity.kind === "circle")).toHaveLength(1);
        expect(entities.filter((entity) => entity.kind === "arc")).toHaveLength(1);
        const drawing = { layers: [PROJECTION_LAYERS.visible], entities };
        if (exportDirectory) {
            writeFileSync(path.join(exportDirectory, "drawing.dxf"), writeDxf(drawing));
            writeFileSync(path.join(exportDirectory, "drawing.svg"), writeSvg(drawing));
        }
    });
});
