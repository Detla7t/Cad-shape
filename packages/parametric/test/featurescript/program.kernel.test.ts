// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Transaction } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { FeatureStudioNode } from "../../src/featurescript/featureStudioNode";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { type ParametricOp, runParametricProgram } from "../../src/program/parametricProgram";
import "../sketch/setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

const BOSS = `FeatureScript 2384;
annotation { "Feature Type Name" : "Boss" }
export const boss = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Diameter" }
        isLength(definition.d, NONNEGATIVE_LENGTH_BOUNDS);
    }
    {
        fCylinder(context, id + "c", { "bottomCenter" : vector(0, 0, 0) * mm, "topCenter" : vector(0, 0, 10) * mm, "radius" : definition.d / 2 });
    }, { "d" : 8 * mm });`;

function run(doc: TestDocument, ops: ParametricOp[]) {
    let result: ReturnType<typeof runParametricProgram> | undefined;
    Transaction.execute(doc, "program", () => {
        result = runParametricProgram(doc, ops);
    });
    return result!;
}

test("a studio op reports its features; a featurescript op builds a body from one", () => {
    const doc = newDoc();
    const result = run(doc, [
        { op: "studio", id: "st", name: "Bosses", source: BOSS },
        { op: "featurescript", id: "b1", studio: "st", feature: "boss", parameters: { d: 12 } },
    ]);
    expect(result.results["st"]).toEqual({
        features: [
            {
                feature: "boss",
                display: "Boss",
                parameters: [{ key: "d", kind: "length", label: "Diameter", default: 8 }],
            },
        ],
    });
    const body = doc.modelManager.findNodes(
        (node) => node instanceof ParametricBodyNode,
    )[0] as ParametricBodyNode;
    expect(body.name).toBe("Boss");
    expect(body.shape.value.volume()).toBeCloseTo(Math.PI * 36 * 10, 3);
});

test("a studio that does not compile rolls the whole program back", () => {
    const doc = newDoc();
    let message = "";
    try {
        run(doc, [
            { op: "studio", id: "st", name: "Broken", source: "FeatureScript 1;\nexport const x = ;" },
        ]);
    } catch (error) {
        message = (error as Error).message;
    }
    expect(message).toMatch(/does not compile: Unexpected/);
    expect(doc.modelManager.findNodes((node) => node instanceof FeatureStudioNode)).toHaveLength(0);
});

test("an unknown parameter name is rejected with the valid ones", () => {
    const doc = newDoc();
    let message = "";
    try {
        run(doc, [
            { op: "studio", id: "st", name: "Bosses", source: BOSS },
            { op: "featurescript", id: "b1", studio: "st", feature: "boss", parameters: { diameter: 12 } },
        ]);
    } catch (error) {
        message = (error as Error).message;
    }
    expect(message).toMatch(/has no parameter "diameter" \(parameters: d\)/);
});
