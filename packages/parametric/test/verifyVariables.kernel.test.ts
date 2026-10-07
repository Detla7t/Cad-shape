// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * What the document variable table does today, end to end on the OCCT kernel:
 *
 * - the table (`core/src/parameters/variableTable.ts`) is ordered, typed (length / angle /
 *   unitless) and unit-checked; feature parameters and sketch dimensions reference its rows
 *   by BARE name (`w * 2`) — Onshape's `#w` and unit literals (`10 mm`) are not accepted, and
 *   a broken row does not claim its name (a `test.fails` pins the duplicate-name bug);
 * - one table edit re-solves the sketches and rebuilds the bodies that read it
 *   (`variableSync.ts`), and undo / redo of that edit rebuild them back;
 * - a body's expressions and the table survive a serialize → deserialize round trip;
 * - FeatureScript features read document variables through `getVariable` on both stds
 *   (`featureScriptFeature.ts` `documentVariables` → `runtime.ts` `run.variables`), and std's
 *   own `assignVariable` (variable.fs) works inside one feature run;
 * - but a FeatureScript `setVariable` dies with its feature's context: a later feature in the
 *   same body cannot read it, and it never reaches the document table (Onshape: "can be
 *   retrieved by another feature defined later").
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    evaluateExpression,
    evaluateVariables,
    type IFace,
    Plane,
    Serializer,
    ShapeTypes,
    Transaction,
    type VariableData,
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

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    return doc;
}

function setVariables(doc: TestDocument, items: VariableData[]): void {
    Transaction.execute(doc, "edit variables", () => doc.variables.setItems(items));
}

const length = (name: string, expression: string, id = name): VariableData => ({
    id,
    name,
    type: "length",
    expression,
});

const rect = (x0: number, y0: number, x1: number, y1: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [x0, y0, x1, y0] },
        { id: 2, type: "line", params: [x1, y0, x1, y1] },
        { id: 3, type: "line", params: [x1, y1, x0, y1] },
        { id: 4, type: "line", params: [x0, y1, x0, y0] },
    ],
    constraints: [],
});

/** A body extruding the single profile of a `size` square sketch by `depth`. */
function extrudedSquare(doc: TestDocument, size: number, depth: number | string): ParametricBodyNode {
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(0, 0, size, size) });
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

const volume = (body: ParametricBodyNode) => body.shape.value.volume();

/**
 * The feature rows' errors. A body evaluates lazily, on its first `shape` read — rows read
 * before that carry no error even when the chain cannot build — so read the shape first.
 */
function rowErrors(body: ParametricBodyNode): (string | undefined)[] {
    void body.shape;
    return body.featureItems().map((item) => item.error);
}

// ------------------------------------------------------------------ The table itself

describe("the document variable table", () => {
    test("rows resolve in order, typed and unit-checked; a bad row reports on itself only", () => {
        const doc = newDoc();
        setVariables(doc, [
            length("w", "40"),
            { id: "a", name: "a", type: "angle", expression: "30" },
            { id: "n", name: "n", type: "unitless", expression: "3" },
            length("h", "w * sin(a) + n"),
            length("early", "late"),
            length("late", "1"),
            length("mixed", "w + a"),
        ]);
        const { scope, errors } = doc.variables.evaluate();

        expect(scope.get("h")?.value).toBeCloseTo(40 * 0.5 + 3, 9);
        expect(scope.get("late")?.value).toBe(1);
        // Only rows ABOVE are visible, so a forward reference is an error, not a cycle.
        expect(errors.get("early")).toBe("Unknown identifier: late");
        expect(errors.get("mixed")).toBe("Dimension mismatch: cannot combine length with angle");
        expect(scope.has("early")).toBe(false);
    });

    // Onshape writes a variable reference as `#w` in every expression field; Chili3d's
    // expression language uses the bare name and rejects the hash.
    test("references are bare names — Onshape's `#name` syntax is not accepted (gap)", () => {
        const scope = new Map([["w", { value: 40, unit: { length: 1, angle: 0 } }]]);
        expect(evaluateExpression("w * 2", scope).value?.value).toBe(80);
        const hashed = evaluateExpression("#w * 2", scope);
        expect(hashed.isOk).toBe(false);
        expect(hashed.error).toBe("Unexpected character: #");
    });

    // BUG: a name is claimed only once its row RESOLVES (`defined.add` follows the evaluation in
    // `variableTable.ts`), so while the first `w` is broken a second `w` silently takes the name —
    // and fixing the first one later flips every reference over to it. Remove `.fails` once the
    // patch (claim the name before evaluating the expression) lands.
    test.fails("a duplicate name is reported even while the first row fails to resolve", () => {
        const { scope, errors } = evaluateVariables([length("w", "nope", "v1"), length("w", "5", "v2")]);
        expect(errors.get("v1")).toBe("Unknown identifier: nope");
        expect(errors.get("v2")).toBe("Duplicate variable name: w");
        expect(scope.has("w")).toBe(false);
    });

    // Onshape expressions carry units (`10 mm + 1 in`); here a literal is a bare number in
    // the slot's display unit.
    test("literals carry no units — `10 mm` is not an expression (gap)", () => {
        const result = evaluateExpression("10 mm", new Map());
        expect(result.isOk).toBe(false);
        expect(result.error).toBe("Unexpected character: m");
    });
});

// ------------------------------------------------------------------ Built-in features and sketches

describe("variables drive built-in features and sketch dimensions", () => {
    test("one edit re-solves a dimensioned sketch and rebuilds a body; undo and redo follow", () => {
        const doc = newDoc();
        setVariables(doc, [length("w", "40"), length("depth", "w / 2")]);

        // Stored already solved, as the sketch editor leaves it: a SketchNode takes its data as
        // given and only re-solves when the table changes.
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
                        datum: "w + 5",
                    },
                ],
            },
        });
        doc.modelManager.addNode(dimensioned);
        const lineLength = () => {
            const [x1, y1, x2, y2] = dimensioned.data.entities[0].params;
            return Math.hypot(x2 - x1, y2 - y1);
        };
        const body = extrudedSquare(doc, 40, "depth * 2");
        expect(rowErrors(body)).toEqual([undefined]);
        expect(lineLength()).toBeCloseTo(45, 6);
        expect(zExtent(body)).toBe(40);

        setVariables(doc, [length("w", "30"), length("depth", "w / 2")]);
        expect(lineLength()).toBeCloseTo(35, 6);
        expect(zExtent(body)).toBe(30);
        // The feature row still stores the expression, not the number it came to.
        expect((body.features[0] as { depth: unknown }).depth).toBe("depth * 2");

        doc.history.undo();
        expect(doc.variables.evaluate().scope.get("w")?.value).toBe(40);
        expect(lineLength()).toBeCloseTo(45, 6);
        expect(zExtent(body)).toBe(40);

        doc.history.redo();
        expect(lineLength()).toBeCloseTo(35, 6);
        expect(zExtent(body)).toBe(30);
    });

    test("deleting a variable a feature uses fails that feature and keeps the last good shape", () => {
        const doc = newDoc();
        setVariables(doc, [length("depth", "25")]);
        const body = extrudedSquare(doc, 10, "depth");
        expect(zExtent(body)).toBe(25);

        setVariables(doc, []);
        expect(rowErrors(body)).toEqual(["Unknown identifier: depth"]);
        expect(zExtent(body)).toBe(25);

        doc.history.undo();
        expect(rowErrors(body)).toEqual([undefined]);
        expect(zExtent(body)).toBe(25);
    });

    test("the body's expressions and the table survive a serialize → deserialize round trip", async () => {
        const doc = newDoc();
        setVariables(doc, [length("depth", "12")]);
        const body = extrudedSquare(doc, 10, "depth * 2");
        expect(zExtent(body)).toBe(24);
        const models = doc.modelManager.serialize();
        // What `Document.serialize` writes for the table: the rows themselves.
        const variables = doc.variables.items;

        const reloaded = newDoc();
        // `Document.load` order: the table first, so the bodies rebuild against it.
        reloaded.history.disabled = true;
        reloaded.variables.setItems(JSON.parse(JSON.stringify(variables)));
        await reloaded.modelManager.deserialize(models);
        reloaded.history.disabled = false;

        const copy = reloaded.modelManager.findNode((n) => n instanceof ParametricBodyNode);
        if (!(copy instanceof ParametricBodyNode)) throw new Error("the body did not deserialize");
        expect((copy.features[0] as { depth: unknown }).depth).toBe("depth * 2");
        expect(zExtent(copy)).toBe(24);

        setVariables(reloaded, [length("depth", "7")]);
        expect(zExtent(copy)).toBe(14);
        // A body serialized on its own keeps the expression verbatim too.
        expect(JSON.stringify(Serializer.serializeObject(copy))).toContain("depth * 2");
    });
});

// ------------------------------------------------------------------ FeatureScript

/**
 * `plate` builds a w × h × 10 mm block, reading `w` from the document through `getVariable`
 * and publishing `published` with `setVariable`; `reader` then asks for `published`.
 * Works on both stds: the native one ignores the std import, Onshape's loads geometry.fs.
 */
const VARIABLE_STUDIO_SOURCE = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

annotation { "Feature Type Name" : "Plate" }
export const plate = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Height" }
        isLength(definition.height, LENGTH_BOUNDS);
    }
    {
        const width = getVariable(context, "w");
        const fallback = getVariable(context, "missing", 3 * millimeter);
        const sketch1 = newSketch(context, id + "sketch1", {
                "sketchPlane" : qCreatedBy(makeId("Top"), EntityType.FACE)
        });
        skRectangle(sketch1, "rectangle", {
                "firstCorner" : vector(0 * millimeter, 0 * millimeter),
                "secondCorner" : vector(width, definition.height + fallback - 3 * millimeter)
        });
        skSolve(sketch1);
        extrude(context, id + "extrude1", {
                "entities" : qSketchRegion(id + "sketch1"),
                "endBound" : BoundingType.BLIND,
                "depth" : 10 * millimeter
        });
        opDeleteBodies(context, id + "deleteSketch", {
                "entities" : qCreatedBy(id + "sketch1", EntityType.BODY)
        });
        setVariable(context, "published", width);
    }, { "height" : 20 * millimeter });

annotation { "Feature Type Name" : "Reader" }
export const reader = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        getVariable(context, "published");
    });
`;

/** A cube of side `w * cos(a) + n mm`: every declared variable type, read as FeatureScript sees it. */
const TYPED_STUDIO_SOURCE = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

annotation { "Feature Type Name" : "Typed Cube" }
export const typedCube = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        const side = getVariable(context, "w") * cos(getVariable(context, "a")) + getVariable(context, "n") * millimeter;
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * meter, "corner2" : vector(side, side, side) });
    });
`;

/** Onshape std only: std's own Variable feature, called inside a custom feature. */
const ASSIGN_VARIABLE_SOURCE = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

annotation { "Feature Type Name" : "Assigned Cube" }
export const assignedCube = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        assignVariable(context, id + "var", {
                "name" : "side",
                "variableType" : VariableType.LENGTH,
                "lengthValue" : getVariable(context, "w") / 2
        });
        const side = getVariable(context, "side");
        fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * meter, "corner2" : vector(side, side, side) });
    });
`;

function addStudio(doc: TestDocument, source: string): FeatureStudioNode {
    const studio = new FeatureStudioNode({ document: doc, name: "Variables", source });
    doc.modelManager.addNode(studio);
    return studio;
}

function customFeature(doc: TestDocument, studio: FeatureStudioNode, name: string): FeatureScriptFeatureData {
    const feature = newFeatureScriptFeature(doc, studio, name);
    expect(feature.isOk).toBe(true);
    return feature.value;
}

function addBody(doc: TestDocument, features: FeatureData[]): ParametricBodyNode {
    const body = new ParametricBodyNode({ document: doc, features });
    doc.modelManager.addNode(body);
    return body;
}

describe.each([
    ["the native std", false],
    ["Onshape's std", true],
])("FeatureScript and document variables on %s", (_label, onshape) => {
    beforeAll(() => provideOnshapeStd(onshape ? ONSHAPE_STD : undefined));
    afterAll(() => provideOnshapeStd(undefined));

    test("getVariable reads a document variable (in meters) and rebuilds when it changes", () => {
        const doc = newDoc();
        setVariables(doc, [length("w", "40")]);
        const studio = addStudio(doc, VARIABLE_STUDIO_SOURCE);
        const body = addBody(doc, [customFeature(doc, studio, "plate")]);
        expect(rowErrors(body)).toEqual([undefined]);
        expect(volume(body)).toBeCloseTo(40 * 20 * 10, 3);

        setVariables(doc, [length("w", "25")]);
        expect(volume(body)).toBeCloseTo(25 * 20 * 10, 3);

        doc.history.undo();
        expect(volume(body)).toBeCloseTo(40 * 20 * 10, 3);
    });

    test("lengths arrive in meters, angles in radians, unitless rows as plain numbers", () => {
        const doc = newDoc();
        setVariables(doc, [
            length("w", "40"),
            { id: "a", name: "a", type: "angle", expression: "60" },
            { id: "n", name: "n", type: "unitless", expression: "4" },
        ]);
        const studio = addStudio(doc, TYPED_STUDIO_SOURCE);
        const body = addBody(doc, [customFeature(doc, studio, "typedCube")]);
        expect(rowErrors(body)).toEqual([undefined]);
        // 40 mm × cos(60°) + 4 mm = 24 mm.
        expect(volume(body)).toBeCloseTo(24 ** 3, 3);
    });

    test("a feature parameter may be an expression over document variables", () => {
        const doc = newDoc();
        setVariables(doc, [length("w", "40"), length("h", "w / 4")]);
        const studio = addStudio(doc, VARIABLE_STUDIO_SOURCE);
        const feature = customFeature(doc, studio, "plate");
        const body = addBody(doc, [{ ...feature, definition: { ...feature.definition, height: "h + 5" } }]);
        expect(volume(body)).toBeCloseTo(40 * 15 * 10, 3);
    });

    test("an undefined variable without a default fails the feature", () => {
        const doc = newDoc();
        const studio = addStudio(doc, VARIABLE_STUDIO_SOURCE);
        const body = addBody(doc, [customFeature(doc, studio, "plate")]);
        const [error] = rowErrors(body);
        expect(error).toMatch(onshape ? /^Variable "w" not found$/ : /^Variable "w" is not defined/);
        expect(body.shape.isOk).toBe(false);
    });

    // GAP: every featurescript feature runs in a fresh FsContext (`runtime.ts` runFeature),
    // seeded only with the document table — what one feature `setVariable`s is gone before the
    // next feature runs. Onshape keeps it on the Part Studio context for later features.
    test("a variable set by one feature is NOT visible to the next feature (gap)", () => {
        const doc = newDoc();
        setVariables(doc, [length("w", "40")]);
        const studio = addStudio(doc, VARIABLE_STUDIO_SOURCE);
        const body = addBody(doc, [
            customFeature(doc, studio, "plate"),
            customFeature(doc, studio, "reader"),
        ]);
        const [plate, reader] = rowErrors(body);
        expect(plate).toBeUndefined();
        expect(reader).toMatch(
            onshape ? /^Variable "published" not found$/ : /^Variable "published" is not defined/,
        );
        // ...and it never reaches the document table either.
        expect(doc.variables.items.map((x) => x.name)).toEqual(["w"]);
    });
});

describe("std's assignVariable on Onshape's std", () => {
    beforeAll(() => provideOnshapeStd(ONSHAPE_STD));
    afterAll(() => provideOnshapeStd(undefined));

    test("assigns a variable a later statement of the same feature reads", () => {
        const doc = newDoc();
        setVariables(doc, [length("w", "40")]);
        const studio = addStudio(doc, ASSIGN_VARIABLE_SOURCE);
        const body = addBody(doc, [customFeature(doc, studio, "assignedCube")]);
        expect(rowErrors(body)).toEqual([undefined]);
        expect(volume(body)).toBeCloseTo(20 ** 3, 3);
    });
});
