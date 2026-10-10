// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Data driving geometry end to end on the OCCT kernel: an extrude depth, a sketch dimension, a
 * Variable Studio row and FeatureScript (both stds) read Data Source tables, and a source edit
 * or refresh rebuilds what reads it — undo and redo included.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IFace, Plane, ShapeTypes, VariableStudioNode } from "@chili3d/core";
import type { TestDocument } from "@chili3d/core/test-utils";
import {
    ConstraintKind,
    captureProfileRef,
    FeatureStudioNode,
    newFeatureScriptFeature,
    ParametricBodyNode,
    provideOnshapeStd,
    type SketchData,
    SketchNode,
} from "@chili3d/parametric";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { ONSHAPE_STD } from "../../parametric/test/featurescript/_helpers/onshapeStd";
import "../../parametric/test/sketch/setup";
import { collectDataDependencies, DataSourceNode } from "../src";
import { csvSource, newDoc, sourceOf } from "./_helpers";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

afterEach(() => {
    rs.unstubAllGlobals();
});

const square = (size: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [0, 0, size, 0] },
        { id: 2, type: "line", params: [size, 0, size, size] },
        { id: 3, type: "line", params: [size, size, 0, size] },
        { id: 4, type: "line", params: [0, size, 0, 0] },
    ],
    constraints: [],
});

function extrudedSquare(doc: TestDocument, size: number, depth: number | string): ParametricBodyNode {
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: square(size) });
    doc.modelManager.addNode(sketch);
    const faces = sketch.mesh.faces?.range.filter((x) => x.shape.shapeType === ShapeTypes.face) ?? [];
    expect(faces).toHaveLength(1);
    const body = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "e1",
                type: "extrude",
                sketchId: sketch.id,
                depth,
                profiles: [captureProfileRef(faces[0].shape as unknown as IFace)],
            },
        ],
    });
    doc.modelManager.addNode(body);
    return body;
}

function zExtent(body: ParametricBodyNode): number {
    const box = body.shape.value.boundingBox();
    if (box === undefined) throw new Error("the body has no bounding box");
    return Math.round((box.max.z - box.min.z) * 1e6) / 1e6;
}

function rowErrors(body: ParametricBodyNode): (string | undefined)[] {
    void body.shape;
    return body.featureItems().map((item) => item.error);
}

const DIMS = "Name,Value\nDepth,10\nSpan,45 mm";

describe("a feature parameter reads a data cell", () => {
    test('extrude depth = data("Dims", "B2"): editing the source rebuilds the body; undo / redo follow', async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Dims", DIMS);
        const body = extrudedSquare(doc, 10, 'data("Dims", "B2")');
        expect(rowErrors(body)).toEqual([undefined]);
        expect(zExtent(body)).toBe(10);

        await source.apply({ fileText: "Name,Value\nDepth,25\nSpan,45 mm" });
        expect(zExtent(body)).toBe(25);
        // The feature keeps the expression, not the number it came to.
        expect((body.features[0] as { depth: unknown }).depth).toBe('data("Dims", "B2")');

        doc.history.undo();
        expect(source.fileText).toBe(DIMS);
        expect(zExtent(body)).toBe(10);
        doc.history.redo();
        expect(zExtent(body)).toBe(25);
    });

    test("a remote source: Refresh fetches the new value and rebuilds; undo goes back to the cached one", async () => {
        const doc = newDoc();
        const answer = (depth: number) =>
            rs.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
                Response.json([{ name: "depth", value: depth }]),
            );
        rs.stubGlobal("fetch", answer(12));
        const source = await sourceOf(doc, "Api", { kind: "http", url: "https://api.example.com/dims" });
        expect((await source.refresh()).isOk).toBe(true);
        const body = extrudedSquare(doc, 10, 'lookup("Api", "name", "depth", "value")');
        expect(zExtent(body)).toBe(12);

        rs.stubGlobal("fetch", answer(30));
        expect((await source.refresh()).isOk).toBe(true);
        expect(zExtent(body)).toBe(30);
        doc.history.undo();
        expect(zExtent(body)).toBe(12);
    });

    test("a missing cell fails the feature and keeps the last good shape", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Dims", DIMS);
        const body = extrudedSquare(doc, 10, 'data("Dims", "B2")');
        expect(zExtent(body)).toBe(10);
        await source.apply({ fileText: "Name,Value\nDepth," });
        expect(rowErrors(body)).toEqual(["Dims!B2: the cell is empty"]);
        expect(zExtent(body)).toBe(10);
    });
});

describe("sketch dimensions and Variable Studios", () => {
    test("a sketch dimension and a studio variable bound to data re-solve and rebuild on a refresh", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Dims", DIMS);
        const studio = new VariableStudioNode({
            document: doc,
            name: "From data",
            items: [{ id: "d", name: "depth", type: "length", expression: 'data("Dims", "Value", 1) * 2' }],
        });
        doc.modelManager.addNode(studio);
        const dimensioned = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [{ id: 1, type: "line", params: [0, 0, 45, 0] }],
                constraints: [
                    {
                        id: 2,
                        kind: ConstraintKind.P2PDistance,
                        refs: [
                            { entityId: 1, pointIndex: 0 },
                            { entityId: 1, pointIndex: 1 },
                        ],
                        datum: 'lookup("Dims", "Name", "Span", "Value")',
                    },
                ],
            },
        });
        doc.modelManager.addNode(dimensioned);
        const lineLength = () => {
            const [x1, y1, x2, y2] = dimensioned.data.entities[0].params;
            return Math.hypot(x2 - x1, y2 - y1);
        };
        const body = extrudedSquare(doc, 10, "depth");
        expect(zExtent(body)).toBe(20);
        expect(lineLength()).toBeCloseTo(45, 6);

        await source.apply({ fileText: "Name,Value\nDepth,7\nSpan,2 in" });
        expect(zExtent(body)).toBe(14);
        expect(lineLength()).toBeCloseTo(50.8, 6);

        doc.history.undo();
        expect(zExtent(body)).toBe(20);
        expect(lineLength()).toBeCloseTo(45, 6);

        const report = collectDataDependencies(doc).map((x) => [x.nodeName, x.reference.label]);
        expect(report).toContainEqual(["From data", "Dims!Value[1]"]);
        expect(report).toContainEqual([dimensioned.name, "Dims!Value[Name=Span]"]);
    });

    test("the report names the feature parameter that reads a cell", async () => {
        const doc = newDoc();
        await csvSource(doc, "Dims", DIMS);
        const body = extrudedSquare(doc, 10, 'data("Dims", "B2") + 1');
        const report = collectDataDependencies(doc).filter((x) => x.nodeId === body.id);
        expect(report.map((x) => [x.location, x.reference.label, x.expression])).toEqual([
            ["Extrude › depth", "Dims!B2", 'data("Dims", "B2") + 1'],
        ]);
    });
});

// ------------------------------------------------------------------ FeatureScript

const DATA_CUBE = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

annotation { "Feature Type Name" : "Data Cube" }
export const dataCube = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Height" }
        isLength(definition.height, LENGTH_BOUNDS);
    }
    {
        const rows = getDataTable(context, "Parts");
        if (size(rows) != 2 || rows[0]["Name"] != "Bracket")
        {
            throw regenError("unexpected rows");
        }
        const side = rows[0]["Length"];
        const width = rows[1]["Qty"] * millimeter;
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * meter, "corner2" : vector(side, width, definition.height) });
    }, { "height" : 10 * millimeter });

annotation { "Feature Type Name" : "Missing Table" }
export const missingTable = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        getDataTable(context, "Nope");
    });
`;

describe.each([
    ["the native std", false],
    ["Onshape's std", true],
])("FeatureScript reads data tables on %s", (_label, onshape) => {
    beforeAll(() => provideOnshapeStd(onshape ? ONSHAPE_STD : undefined));
    afterAll(() => provideOnshapeStd(undefined));

    function customFeature(doc: TestDocument, studio: FeatureStudioNode, name: string) {
        const feature = newFeatureScriptFeature(doc, studio, name);
        expect(feature.isOk).toBe(true);
        return feature.value;
    }

    test("getDataTable rows (quantities as ValueWithUnits) and a data() parameter build the part", async () => {
        const doc = newDoc();
        const source = await csvSource(doc, "Parts", "Name,Length,Qty\nBracket,12 mm,4\nPlate,30,3");
        const studio = new FeatureStudioNode({ document: doc, name: "Data", source: DATA_CUBE });
        doc.modelManager.addNode(studio);
        const feature = customFeature(doc, studio, "dataCube");
        const body = new ParametricBodyNode({
            document: doc,
            features: [
                { ...feature, definition: { ...feature.definition, height: 'data("Parts", "Length", 2)' } },
            ],
        });
        doc.modelManager.addNode(body);
        expect(rowErrors(body)).toEqual([undefined]);
        // 12 mm × 3 mm × 30 mm.
        expect(body.shape.value.volume()).toBeCloseTo(12 * 3 * 30, 3);

        await source.apply({ fileText: "Name,Length,Qty\nBracket,1 in,5\nPlate,20,5" });
        expect(body.shape.value.volume()).toBeCloseTo(25.4 * 5 * 20, 3);
        doc.history.undo();
        expect(body.shape.value.volume()).toBeCloseTo(12 * 3 * 30, 3);

        const report = collectDataDependencies(doc).map((x) => [x.nodeName, x.reference.label]);
        expect(report).toContainEqual(["Data", "Parts (FeatureScript)"]);
    });

    test("an unknown table fails the feature with the resolver's message", async () => {
        const doc = newDoc();
        await csvSource(doc, "Parts", "Name\nx");
        const studio = new FeatureStudioNode({ document: doc, name: "Data", source: DATA_CUBE });
        doc.modelManager.addNode(studio);
        const body = new ParametricBodyNode({
            document: doc,
            features: [customFeature(doc, studio, "missingTable")],
        });
        doc.modelManager.addNode(body);
        expect(rowErrors(body)[0]).toMatch(/Unknown data table "Nope" \(available: Parts\)/);
    });
});

test("a data source node is a plain sceneless element", () => {
    const doc = newDoc();
    const source = new DataSourceNode({ document: doc });
    expect(source.sceneless).toBe(true);
    expect(source.icon).toBe("icon-layer-group");
});
