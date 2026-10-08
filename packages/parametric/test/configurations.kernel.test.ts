// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Configurations end to end on the OCCT kernel: one Part Studio, a family of parts.
 *
 * - a `configure(…)` value selects its arm before evaluation (`resolveUnitSpec`), so a
 *   built-in feature parameter and a sketch datum switch with the active configuration;
 * - switching is not an edit — no undo step — yet every body and sketch rebuilds, and
 *   switching back gives the identical geometry;
 * - configured suppression takes a feature in or out per configuration;
 * - FeatureScript lengths, enums and booleans take configured values; `getVariable` sees the
 *   configuration VARIABLES only (as in Onshape), and std's `getAllVariables(context, false)`
 *   leaves them out.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type ConfigurationInputData,
    type IFace,
    modelParameters,
    Plane,
    ShapeTypes,
    Transaction,
} from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import type { FeatureData, FeatureScriptFeatureData } from "../src/features/feature";
import { captureProfileRef } from "../src/features/profileRef";
import { FeatureStudioNode } from "../src/featurescript/featureStudioNode";
import { newFeatureScriptFeature } from "../src/featurescript/insertFeature";
import { provideOnshapeStd } from "../src/featurescript/runtime";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { ConstraintKind, type SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import { ONSHAPE_STD } from "./featurescript/_helpers/onshapeStd";
import "./sketch/setup";
import "../src/sketch/modelParameters";

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

const SIZE: ConfigurationInputData = {
    kind: "list",
    id: "c-size",
    name: "Size",
    options: [
        { id: "o-s", name: "S" },
        { id: "o-l", name: "L" },
    ],
    defaultOption: "o-s",
};
const HOLES: ConfigurationInputData = { kind: "checkbox", id: "c-holes", name: "Holes", defaultValue: false };
const THICKNESS: ConfigurationInputData = {
    kind: "variable",
    id: "c-thickness",
    name: "Thickness",
    type: "length",
    defaultExpression: "4",
};

function newDoc(inputs: ConfigurationInputData[] = [SIZE, HOLES, THICKNESS]): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    Transaction.execute(doc, "edit configuration", () => doc.variables.setConfigurationInputs(inputs));
    return doc;
}

function activate(doc: TestDocument, active: Record<string, string | boolean>): void {
    doc.variables.setActiveConfiguration({ ...doc.variables.activeConfiguration, ...active });
}

const rect = (x0: number, y0: number, x1: number, y1: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [x0, y0, x1, y0] },
        { id: 2, type: "line", params: [x1, y0, x1, y1] },
        { id: 3, type: "line", params: [x1, y1, x0, y1] },
        { id: 4, type: "line", params: [x0, y1, x0, y0] },
    ],
    constraints: [],
});

function squareSketch(doc: TestDocument, size: number) {
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(0, 0, size, size) });
    doc.modelManager.addNode(sketch);
    const faces = sketch.mesh.faces?.range.filter((x) => x.shape.shapeType === ShapeTypes.face) ?? [];
    expect(faces).toHaveLength(1);
    return { sketch, profile: captureProfileRef(faces[0].shape as unknown as IFace) };
}

function addBody(doc: TestDocument, features: FeatureData[]): ParametricBodyNode {
    const body = new ParametricBodyNode({ document: doc, features });
    doc.modelManager.addNode(body);
    return body;
}

const volume = (body: ParametricBodyNode) => body.shape.value.volume();

function zExtent(body: ParametricBodyNode): number {
    const box = body.shape.value.boundingBox();
    if (box === undefined) throw new Error("the body has no bounding box");
    return Math.round((box.max.z - box.min.z) * 1e6) / 1e6;
}

/** Read the shape first: a body evaluates lazily, and rows carry nothing before that. */
function rows(body: ParametricBodyNode) {
    void body.shape;
    return body.featureItems().map((item) => ({ error: item.error, warning: item.warning }));
}

describe("configured built-in features", () => {
    test("table edits preserve dimension labels and expose reversible sketch suppression", () => {
        const doc = newDoc();
        const sketch = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [{ id: 1, type: "circle", params: [0, 0, 10] }],
                constraints: [
                    { id: 1, kind: ConstraintKind.Radius, refs: [{ entityId: 1, pointIndex: 0 }], datum: 10 },
                ],
                anchors: [{ id: 1, anchor: { kind: "vector", dx: 20, dy: 15 } }],
            },
        });
        doc.modelManager.addNode(sketch);
        const slots = modelParameters(doc);
        const radius = slots.find((s) => s.id.endsWith(":dimension:1"));
        expect(radius).not.toBeUndefined();
        expect(radius!.apply('configure(Size, "S": 12, "L": 30)').isOk).toBe(true);
        expect(sketch.data.entities[0].params[2]).toBeCloseTo(12);
        expect(sketch.data.anchors).toEqual([{ id: 1, anchor: { kind: "vector", dx: 20, dy: 15 } }]);
        const suppression = slots.find((s) => s.label === "Unsuppressed");
        expect(suppression).toMatchObject({ boolean: true, inverted: true });
        expect(suppression!.apply("true").isOk).toBe(true);
        expect(sketch.suppressed).toBe(true);
        doc.history.undo();
        expect(sketch.suppressed).toBe(false);
        expect(sketch.data.entities[0].params[2]).toBeCloseTo(12);
        activate(doc, { Size: "L" });
        expect(sketch.data.entities[0].params[2]).toBeCloseTo(30);
    });

    test("configured sketch suppression removes profiles and construction display, then restores them", () => {
        const doc = newDoc();
        const { sketch } = squareSketch(doc, 10);
        const data = sketch.data;
        data.entities.push({ id: 5, type: "line", params: [0, 0, 10, 10], construction: true });
        sketch.setDataEmitShapeChanged(data);
        Transaction.execute(doc, "configure sketch suppression", () => {
            sketch.suppression = "configure(Holes, true: true, false: false)";
        });
        expect(sketch.mesh.edges!.position.length).toBeGreaterThan(0);
        activate(doc, { Holes: true });
        expect(sketch.suppressed).toBe(true);
        expect(sketch.mesh.edges).toBeUndefined();
        expect(sketch.shape.value.findSubShapes(ShapeTypes.edge)).toHaveLength(0);
        activate(doc, { Holes: false });
        expect(sketch.mesh.edges!.position.length).toBeGreaterThan(0);
        expect(sketch.shape.value.findSubShapes(ShapeTypes.edge)).toHaveLength(4);
        doc.history.undo();
        activate(doc, { Holes: true });
        expect(sketch.suppressed).toBe(false);
        expect(sketch.mesh.edges!.position.length).toBeGreaterThan(0);
    });

    test("a configured extrude depth follows the active configuration; S → L → S is identical", () => {
        const doc = newDoc();
        const { sketch, profile } = squareSketch(doc, 10);
        const body = addBody(doc, [
            {
                id: "e1",
                type: "extrude",
                sketchId: sketch.id,
                depth: 'configure(Size, "S": 10, "L": Thickness * 10)',
                profiles: [profile],
            },
        ]);
        expect(rows(body)).toEqual([{ error: undefined, warning: undefined }]);
        expect(zExtent(body)).toBe(10);
        const small = { volume: volume(body), box: body.shape.value.boundingBox() };
        const undoSteps = doc.history.undoCount();

        activate(doc, { Size: "L" });
        expect(zExtent(body)).toBe(40);
        activate(doc, { Thickness: "5" });
        expect(zExtent(body)).toBe(50);

        activate(doc, { Size: "S" });
        expect(volume(body)).toBeCloseTo(small.volume, 9);
        expect(body.shape.value.boundingBox()).toEqual(small.box);
        // Switching configurations is a view of the document, not an edit of it.
        expect(doc.history.undoCount()).toBe(undoSteps);
        // The feature still stores the configured value, not what it came to.
        expect((body.features[0] as { depth: unknown }).depth).toBe(
            'configure(Size, "S": 10, "L": Thickness * 10)',
        );
    });

    test("a configuration without an arm fails the feature and keeps the last good shape", () => {
        const doc = newDoc([
            {
                kind: "list",
                id: "c-size",
                name: "Size",
                options: [
                    { id: "o-s", name: "S" },
                    { id: "o-l", name: "L" },
                    { id: "o-xl", name: "XL" },
                ],
            },
        ]);
        const { sketch, profile } = squareSketch(doc, 10);
        const body = addBody(doc, [
            {
                id: "e1",
                type: "extrude",
                sketchId: sketch.id,
                depth: 'configure(Size, "S": 10, "L": 20)',
                profiles: [profile],
            },
        ]);
        expect(zExtent(body)).toBe(10);
        activate(doc, { Size: "XL" });
        expect(rows(body)).toEqual([{ error: 'No value for Size = "XL"', warning: undefined }]);
        expect(zExtent(body)).toBe(10);
    });

    test("a configured sketch datum re-solves the sketch on a switch", () => {
        const doc = newDoc();
        const dimensioned = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [{ id: 1, type: "line", params: [0, 0, 20, 0] }],
                constraints: [
                    {
                        id: 2,
                        kind: ConstraintKind.P2PDistance,
                        refs: [
                            { entityId: 1, pointIndex: 0 },
                            { entityId: 1, pointIndex: 1 },
                        ],
                        datum: 'configure(Size, "S": 20, "L": 35)',
                    },
                ],
            },
        });
        doc.modelManager.addNode(dimensioned);
        const lineLength = () => {
            const [x1, y1, x2, y2] = dimensioned.data.entities[0].params;
            return Math.hypot(x2 - x1, y2 - y1);
        };
        expect(lineLength()).toBeCloseTo(20, 6);
        activate(doc, { Size: "L" });
        expect(lineLength()).toBeCloseTo(35, 6);
        activate(doc, { Size: "S" });
        expect(lineLength()).toBeCloseTo(20, 6);
    });

    test("configured suppression takes a feature in and out per configuration", () => {
        const doc = newDoc();
        const { sketch, profile } = squareSketch(doc, 10);
        const body = addBody(doc, [
            { id: "e1", type: "extrude", sketchId: sketch.id, depth: 10, profiles: [profile] },
            {
                id: "e2",
                type: "extrude",
                sketchId: sketch.id,
                depth: 30,
                operation: "fuse",
                profiles: [profile],
                suppressed: "configure(Holes, true: false, false: true)",
            },
        ]);
        // Holes defaults to off: the second extrude is suppressed.
        expect(zExtent(body)).toBe(10);
        expect(body.featureItems()[1]).toMatchObject({
            suppressed: true,
            suppressionConfigured: "configure(Holes, true: false, false: true)",
        });

        activate(doc, { Holes: true });
        expect(zExtent(body)).toBe(30);
        expect(body.featureItems()[1].suppressed).toBe(false);

        activate(doc, { Holes: false });
        expect(zExtent(body)).toBe(10);
    });

    test("a configured suppression that cannot resolve keeps the feature in, with a warning", () => {
        const doc = newDoc();
        const { sketch, profile } = squareSketch(doc, 10);
        const body = addBody(doc, [
            { id: "e1", type: "extrude", sketchId: sketch.id, depth: 10, profiles: [profile] },
            {
                id: "e2",
                type: "extrude",
                sketchId: sketch.id,
                depth: 30,
                operation: "fuse",
                profiles: [profile],
                suppressed: "configure(Gone, true: true)",
            },
        ]);
        expect(zExtent(body)).toBe(30);
        expect(rows(body)[1]).toEqual({ error: undefined, warning: "Unknown configuration input: Gone" });
    });
});

/** A block whose size, shape (an enum) and doubling (a boolean) are panel parameters. */
const BLOCK_SOURCE = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

export enum BlockShape
{
    annotation { "Name" : "Cube" }
    CUBE,
    annotation { "Name" : "Slab" }
    SLAB
}

annotation { "Feature Type Name" : "Block" }
export const block = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Size" }
        isLength(definition.size, LENGTH_BOUNDS);
        annotation { "Name" : "Shape" }
        definition.shape is BlockShape;
        annotation { "Name" : "Double" }
        definition.double is boolean;
    }
    {
        var height = definition.size;
        if (definition.shape == BlockShape.SLAB)
            height = definition.size / 10;
        if (definition.double)
            height = height * 2;
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * meter, "corner2" : vector(definition.size, definition.size, height) });
    }, { "size" : 10 * millimeter, "shape" : BlockShape.CUBE, "double" : false });

annotation { "Feature Type Name" : "Variable cube" }
export const variableCube = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const side = getVariable(context, "Thickness") + (getVariable(context, "Size", -1) == -1 ? 0 : 100) * millimeter;
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * meter, "corner2" : vector(side, side, side) });
    });
`;

function blockFeature(doc: TestDocument, name = "block"): FeatureScriptFeatureData {
    const studio = new FeatureStudioNode({ document: doc, name: "Blocks", source: BLOCK_SOURCE });
    doc.modelManager.addNode(studio);
    const feature = newFeatureScriptFeature(doc, studio, name);
    expect(feature.isOk).toBe(true);
    return feature.value;
}

describe.each([
    ["the native std", false],
    ["Onshape's std", true],
])("configured FeatureScript parameters on %s", (_label, onshape) => {
    beforeAll(() => provideOnshapeStd(onshape ? ONSHAPE_STD : undefined));
    afterAll(() => provideOnshapeStd(undefined));

    test("a length, an enum and a boolean switch with the active configuration", () => {
        const doc = newDoc();
        const feature = blockFeature(doc);
        const body = addBody(doc, [
            {
                ...feature,
                definition: {
                    ...feature.definition,
                    size: 'configure(Size, "S": 10, "L": 20)',
                    shape: 'configure(Size, "S": "CUBE", "L": SLAB)',
                    double: "configure(Holes, true: true, false: false)",
                },
            },
        ]);
        expect(rows(body)).toEqual([{ error: undefined, warning: undefined }]);
        expect(volume(body)).toBeCloseTo(10 ** 3, 6);

        activate(doc, { Size: "L" });
        // A 20 mm slab: 20 × 20 × 2.
        expect(volume(body)).toBeCloseTo(20 * 20 * 2, 6);
        activate(doc, { Holes: true });
        expect(volume(body)).toBeCloseTo(20 * 20 * 4, 6);
        activate(doc, { Size: "S", Holes: false });
        expect(volume(body)).toBeCloseTo(10 ** 3, 6);

        // The panel shows what the active configuration selects, marked as configured.
        const parameters = body.featureItems()[0].parameters;
        expect(parameters.find((p) => p.key === "shape")).toMatchObject({
            value: "CUBE",
            configured: 'configure(Size, "S": "CUBE", "L": SLAB)',
        });
        expect(parameters.find((p) => p.key === "double")).toMatchObject({
            value: false,
            configured: "configure(Holes, true: true, false: false)",
        });
    });

    test("setting a configured checkbox keeps the configure(…) for the rebuild", () => {
        const doc = newDoc();
        const feature = blockFeature(doc);
        const body = addBody(doc, [feature]);
        Transaction.execute(doc, "configure", () =>
            body.setFeatureParameter(feature.id, "double", "configure(Holes, true: true, false: false)"),
        );
        expect((body.features[0] as FeatureScriptFeatureData).definition["double"]).toBe(
            "configure(Holes, true: true, false: false)",
        );
        activate(doc, { Holes: true });
        expect(volume(body)).toBeCloseTo(10 * 10 * 20, 6);
    });

    test("getVariable sees configuration variables, not lists or checkboxes", () => {
        const doc = newDoc();
        const body = addBody(doc, [blockFeature(doc, "variableCube")]);
        expect(rows(body)).toEqual([{ error: undefined, warning: undefined }]);
        // Thickness is 4 mm; Size is not a variable to FeatureScript, so the default (-1) is used.
        expect(volume(body)).toBeCloseTo(4 ** 3, 6);
        activate(doc, { Thickness: "6" });
        expect(volume(body)).toBeCloseTo(6 ** 3, 6);
    });
});

describe("std's getAllVariables and configuration variables", () => {
    beforeAll(() => provideOnshapeStd(ONSHAPE_STD));
    afterAll(() => provideOnshapeStd(undefined));

    const SOURCE = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

annotation { "Feature Type Name" : "Counted" }
export const counted = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const all = size(getAllVariables(context));
        const plain = size(getAllVariables(context, false));
        const side = (all * 10 + plain) * millimeter;
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * meter, "corner2" : vector(side, side, side) });
    });
`;

    test("includeConfiguration false leaves the configuration variables out", () => {
        const doc = newDoc();
        Transaction.execute(doc, "edit variables", () =>
            doc.variables.setItems([{ id: "v1", name: "w", type: "length", expression: "5" }]),
        );
        const studio = new FeatureStudioNode({ document: doc, name: "Counted", source: SOURCE });
        doc.modelManager.addNode(studio);
        const feature = newFeatureScriptFeature(doc, studio, "counted");
        expect(feature.isOk).toBe(true);
        const body = addBody(doc, [feature.value]);
        expect(rows(body)).toEqual([{ error: undefined, warning: undefined }]);
        // All: w and Thickness (2) → 20; without configuration: w (1) → 21 mm.
        expect(volume(body)).toBeCloseTo(21 ** 3, 6);
    });
});
