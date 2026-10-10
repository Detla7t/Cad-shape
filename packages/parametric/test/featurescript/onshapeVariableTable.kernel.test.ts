// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The End Cap Configurator's Part Studio variable table as Onshape holds it: an "Add My
 * Functions" feature stores `sizeCrimp` and `sizeOverlap` as function variables
 * ("Unspecified"), and the Length rows read them — `#sizeOverlap(#OD,#ID)` — beside
 * Onshape's other spellings (`(9+ 5/8) in`, `13/16 in`, `PI`, `6.75 *in`, a bare `1` as
 * one document inch, a ternary over a checkbox input). Every value matches the Onshape
 * document's table.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Transaction, type VariableData } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { FeatureStudioNode } from "../../src/featurescript/featureStudioNode";
import { newFeatureScriptFeature } from "../../src/featurescript/insertFeature";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import "../sketch/setup";
import { fixture } from "./_helpers/onshapeStd";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);
const IN = 25.4;

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function inchDocument(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as never;
    doc.userData = { displayUnits: { length: "in", angle: "deg", lengthPrecision: 3, anglePrecision: 1 } };
    return doc;
}

/** The Onshape document's "Part Studio 1" rows, verbatim (Wall_Length is a measurement there). */
const ONSHAPE_ROWS: readonly [string, VariableData["type"], string][] = [
    ["OD", "length", "(9+ 5/8) in"],
    ["ID", "length", "(6 + 5/8) in"],
    ["Z_Lock_Size", "length", "13/16 in"],
    [
        "Wall_Height",
        "length",
        "(#OD >= 6.75  *in) ?  (#Wall_Height + #Z_Lock_Size) : ((#Wall_Height - (0.75*  in)) + #Z_Lock_Size)",
    ],
    ["Wall_Overlap", "length", "1"],
    ["Edge_Size", "length", "(1/8) in"],
    ["Female_Offset", "length", "0"],
    ["Male_Taper_Length", "length", "(1/16) in"],
    ["Max_Overlap", "length", "1"],
    ["End_Cap_Overlap", "length", "1"],
    ["Material_Thickness", "length", "0.016"],
    ["Female_Wall_Length", "length", "((#ID+(1/8in))*PI)/2"],
    ["Male_Wall_Length", "length", "(((#ID+(#Material_Thickness*3))*PI)/2)+(#Wall_Overlap*2)"],
    ["Overlap", "length", "#sizeOverlap(#OD,#ID)"],
    ["Final_ID", "length", "(((#ID <= 0 * in) ? 0 : ((#ID/in)-(3/16)) )) in"],
    ["OD_gt_ID_Check", "length", "((#OD <= #ID) ? 0 : #Final_ID / in) in"],
    ["Crimp_tolerance", "length", "0"],
    ["Crimp", "length", "(#Crimp ? #Crimp_Size :  (#sizeCrimp(#OD) + #Crimp_tolerance))"],
    ["size_off_top", "length", "((-1/16)-(1/16)) in"],
    ["size_off_bottom", "length", "(24-4.5) in"],
    ["combined_off", "length", "(#size_off_top/#size_off_bottom) in"],
    ["base_correction", "length", "(3/32) in"],
    ["wall_correction_factor", "length", "(#combined_off/in*#ID/in) * in+ #base_correction"],
    ["Wall_Length", "length", "10.677 in"],
];

describe("Onshape's End Cap variable table on the native engine", () => {
    test("the Add My Functions feature stores function variables the table rows call", () => {
        const doc = inchDocument();
        // The configuration the rows switch on: Wall_Height's input, the Custom Crimp checkbox.
        doc.variables.setConfigurationInputs([
            {
                kind: "variable",
                id: "wh",
                name: "Wall_Height",
                type: "length",
                defaultExpression: "2.875 in",
            },
            { kind: "checkbox", id: "crimp", name: "Crimp", defaultValue: false },
            { kind: "variable", id: "cs", name: "Crimp_Size", type: "length", defaultExpression: "0.5 in" },
        ]);
        const studio = new FeatureStudioNode({
            document: doc,
            name: "Feature Studio 1",
            source: fixture("endCapFunctions.fs"),
        });
        doc.modelManager.addNode(studio);
        const feature = newFeatureScriptFeature(doc, studio, "addMyFunctions");
        expect(feature.error).toBeUndefined();
        const body = new ParametricBodyNode({ document: doc, features: [feature.value] });
        Transaction.execute(doc, "add", () => doc.modelManager.addNode(body));
        expect(body.shape.isOk).toBe(true);
        expect(body.featureItems()[0].error).toBeUndefined();
        // The feature's variables: Onshape's "Unspecified" rows of the Part Studio.
        expect(body.items.map((item) => [item.name, item.type])).toEqual([
            ["sizeCrimp", "function"],
            ["sizeOverlap", "function"],
        ]);
        expect([...body.functionValues().keys()]).toEqual(["sizeCrimp", "sizeOverlap"]);

        Transaction.execute(doc, "rows", () =>
            doc.variables.setItems(
                ONSHAPE_ROWS.map(([name, type, expression]) => ({ id: name, name, type, expression })),
            ),
        );
        const evaluated = doc.variables.evaluate();
        expect([...evaluated.errors]).toEqual([]);
        const inches = (name: string) => evaluated.scope.get(name)!.value / IN;
        expect(inches("OD")).toBeCloseTo(9.625, 9);
        expect(inches("ID")).toBeCloseTo(6.625, 9);
        expect(inches("Z_Lock_Size")).toBeCloseTo(0.8125, 9);
        expect(inches("Wall_Height")).toBeCloseTo(3.6875, 9);
        expect(inches("Wall_Overlap")).toBeCloseTo(1, 9);
        expect(inches("Edge_Size")).toBeCloseTo(0.125, 9);
        expect(inches("Material_Thickness")).toBeCloseTo(0.016, 9);
        expect(inches("Female_Wall_Length")).toBeCloseTo(10.603, 3);
        expect(inches("Male_Wall_Length")).toBeCloseTo(12.482, 3);
        expect(inches("Overlap")).toBeCloseTo(1, 9);
        expect(inches("Final_ID")).toBeCloseTo(6.4375, 9);
        expect(inches("OD_gt_ID_Check")).toBeCloseTo(6.4375, 9);
        expect(inches("Crimp")).toBeCloseTo(0.625, 9);
        expect(inches("size_off_top")).toBeCloseTo(-0.125, 9);
        expect(inches("size_off_bottom")).toBeCloseTo(19.5, 9);
        expect(inches("combined_off")).toBeCloseTo(-0.00641, 5);
        expect(inches("base_correction")).toBeCloseTo(0.09375, 9);
        expect(inches("wall_correction_factor")).toBeCloseTo(0.0513, 3);
        expect(Number.isNaN(evaluated.scope.get("sizeCrimp")!.value)).toBe(true);
        expect(evaluated.scope.get("sizeCrimp")!.call).toBeDefined();

        // The Custom Crimp checkbox switches the Crimp row to the custom size.
        doc.variables.setActiveConfiguration({ Crimp: true });
        expect(doc.variables.evaluate().scope.get("Crimp")!.value / IN).toBeCloseTo(0.5, 9);
    });

    test("a later feature reads the stored function and a feature parameter calls it", () => {
        const doc = inchDocument();
        const studio = new FeatureStudioNode({
            document: doc,
            name: "Feature Studio 1",
            source: fixture("endCapFunctions.fs"),
        });
        doc.modelManager.addNode(studio);
        const cube = new FeatureStudioNode({
            document: doc,
            name: "Cube",
            source: `FeatureScript 2931;
import(path : "onshape/std/geometry.fs", version : "2931.0");
annotation { "Feature Type Name" : "Crimp cube" }
export const crimpCube = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Height" }
        isLength(definition.height, LENGTH_BOUNDS);
    }
    {
        const crimp = getVariable(context, "sizeCrimp")(9.625 * inch);
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * inch, "corner2" : vector(crimp, crimp, definition.height) });
    });
`,
        });
        doc.modelManager.addNode(cube);
        const functions = newFeatureScriptFeature(doc, studio, "addMyFunctions");
        const crimpCube = newFeatureScriptFeature(doc, cube, "crimpCube");
        expect(functions.error).toBeUndefined();
        expect(crimpCube.error).toBeUndefined();
        const body = new ParametricBodyNode({ document: doc, features: [functions.value, crimpCube.value] });
        Transaction.execute(doc, "add", () => doc.modelManager.addNode(body));
        Transaction.execute(doc, "height", () =>
            body.setFeatureParameter(body.features[1].id, "height", "#sizeCrimp(4 in) * 4"),
        );
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
        // 5/8 in × 5/8 in × (3/8 in × 4): the crimp of a 9 5/8" duct squared, four small crimps high.
        expect(body.shape.value.volume()).toBeCloseTo(0.625 * IN * 0.625 * IN * 1.5 * IN, 3);
    });
});
