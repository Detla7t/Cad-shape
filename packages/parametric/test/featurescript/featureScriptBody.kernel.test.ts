// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * FeatureScript custom features inside parametric bodies: the feature panel shows the
 * precondition's parameters (with conditional visibility), parameter edits and
 * document variables rebuild the body, editing the studio's source rebuilds every body
 * that uses it (and undo restores it), and stable ids let a downstream fillet follow an
 * edge the custom feature created. Studios run on Onshape's own std library, as in the app.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, Plane, Serializer, ShapeTypes, Transaction } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { captureEdgeRef } from "../../src/features/edgeRef";
import type { FeatureData, FeatureScriptFeatureData } from "../../src/features/feature";
import { DEFAULT_STUDIO_SOURCE, FeatureStudioNode } from "../../src/featurescript/featureStudioNode";
import { customFeatures, newFeatureScriptFeature } from "../../src/featurescript/insertFeature";
import { provideOnshapeStd } from "../../src/featurescript/runtime";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import "../sketch/setup";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";

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
    provideOnshapeStd(ONSHAPE_STD);
});

afterAll(() => provideOnshapeStd(undefined));

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

function addStudio(doc: TestDocument, source: string, name = "Studio"): FeatureStudioNode {
    const studio = new FeatureStudioNode({ document: doc, name, source });
    doc.modelManager.addNode(studio);
    return studio;
}

function addBody(doc: TestDocument, features: FeatureData[]): ParametricBodyNode {
    const body = new ParametricBodyNode({ document: doc, features });
    doc.modelManager.addNode(body);
    return body;
}

function customFeature(doc: TestDocument, studio: FeatureStudioNode, name: string): FeatureScriptFeatureData {
    const feature = newFeatureScriptFeature(doc, studio, name);
    expect(feature.error).toBeUndefined();
    return feature.value;
}

const volume = (body: ParametricBodyNode) => body.shape.value.volume();

describe("the default studio", () => {
    test("exports a feature whose panel parameters come from its precondition", () => {
        const doc = newDoc();
        const studio = addStudio(doc, DEFAULT_STUDIO_SOURCE);
        expect(customFeatures(doc).map((entry) => entry.displayName)).toEqual(["Rounded Plate"]);

        const body = addBody(doc, [customFeature(doc, studio, "roundedPlate")]);
        const [item] = body.featureItems();
        expect(item.error).toBeUndefined();
        expect(item.name).toBe("Rounded Plate");
        expect(item.parameters.map((p) => [p.label, p.value])).toEqual([
            ["Width", 80],
            ["Height", 50],
            ["Thickness", 5],
            ["Round corners", true],
            ["Corner radius", 6],
        ]);
        // 80 × 50 × 5 with four 6 mm corner rounds.
        expect(volume(body)).toBeCloseTo((80 * 50 - (4 - Math.PI) * 36) * 5, 3);
    });

    test("a conditional parameter hides when its condition stops holding", () => {
        const doc = newDoc();
        const studio = addStudio(doc, DEFAULT_STUDIO_SOURCE);
        const body = addBody(doc, [customFeature(doc, studio, "roundedPlate")]);
        const id = body.features[0].id;
        Transaction.execute(doc, "edit", () => body.setFeatureParameter(id, "rounded", false));
        expect(body.featureItems()[0].parameters.map((p) => p.key)).toEqual([
            "width",
            "height",
            "thickness",
            "rounded",
        ]);
        expect(volume(body)).toBeCloseTo(80 * 50 * 5, 3);
    });

    test("parameters accept expressions over document variables", () => {
        const doc = newDoc();
        Transaction.execute(doc, "vars", () =>
            doc.variables.setItems([{ id: "v", name: "w", type: "length", expression: "30" }]),
        );
        const studio = addStudio(doc, DEFAULT_STUDIO_SOURCE);
        const body = addBody(doc, [customFeature(doc, studio, "roundedPlate")]);
        const id = body.features[0].id;
        Transaction.execute(doc, "edit", () => {
            body.setFeatureParameter(id, "rounded", false);
            body.setFeatureParameter(id, "width", "w * 2");
        });
        expect(volume(body)).toBeCloseTo(60 * 50 * 5, 3);
        Transaction.execute(doc, "vars", () =>
            doc.variables.setItems([{ id: "v", name: "w", type: "length", expression: "20" }]),
        );
        expect(volume(body)).toBeCloseTo(40 * 50 * 5, 3);
    });

    test("an out-of-bounds value is reported on the feature row", () => {
        const doc = newDoc();
        const studio = addStudio(doc, DEFAULT_STUDIO_SOURCE);
        const body = addBody(doc, [customFeature(doc, studio, "roundedPlate")]);
        Transaction.execute(doc, "edit", () =>
            body.setFeatureParameter(body.features[0].id, "thickness", -3),
        );
        expect(body.featureItems()[0].error).toMatch(/Thickness must be at least 0/);
    });
});

const BOSS_SOURCE = `FeatureScript 2384;
import(path : "onshape/std/geometry.fs", version : "2384.0");

export enum BossShape
{
    annotation { "Name" : "Round" }
    ROUND,
    annotation { "Name" : "Square" }
    SQUARE
}

annotation { "Feature Type Name" : "Boss" }
export const boss = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Shape" }
        definition.shape is BossShape;
        annotation { "Name" : "Size" }
        isLength(definition.size, NONNEGATIVE_LENGTH_BOUNDS);
        annotation { "Name" : "Height" }
        isLength(definition.height, NONNEGATIVE_LENGTH_BOUNDS);
    }
    {
        const top = qFarthestAlong(qHostBody(EntityType.FACE), Z_DIRECTION);
        const plane = evPlane(context, { "face" : top });
        const sketch1 = newSketchOnPlane(context, id + "sketch", { "sketchPlane" : plane });
        if (definition.shape == BossShape.ROUND)
            skCircle(sketch1, "c", { "center" : vector(0, 0) * millimeter, "radius" : definition.size / 2 });
        else
            skRectangle(sketch1, "r", { "firstCorner" : vector(-1, -1) * definition.size / 2, "secondCorner" : vector(1, 1) * definition.size / 2 });
        skSolve(sketch1);
        extrude(context, id + "extrude", {
            "entities" : qSketchRegion(id + "sketch"),
            "depth" : definition.height,
            "operationType" : NewBodyOperationType.ADD
        });
        opDeleteBodies(context, id + "clean", { "entities" : qCreatedBy(id + "sketch", EntityType.BODY) });
    }, { "size" : 10 * millimeter, "height" : 5 * millimeter });

annotation { "Feature Type Name" : "Chamfer picked edges" }
export const chamferPicked = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Edges", "Filter" : EntityType.EDGE }
        definition.edges is Query;
        annotation { "Name" : "Width" }
        isLength(definition.width, BLEND_BOUNDS);
    }
    {
        if (isQueryEmpty(context, definition.edges))
            throw regenError("Pick edges to chamfer", ["edges"]);
        opChamfer(context, id + "chamfer", { "entities" : definition.edges, "width" : definition.width });
    }, { "width" : 1 * millimeter });
`;

/** A 20 mm cube body, centered on the origin in X/Y, made by a custom feature. */
const CUBE_SOURCE = `FeatureScript 2384;
import(path : "onshape/std/geometry.fs", version : "2384.0");
annotation { "Feature Type Name" : "Cube" }
export const cube = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Size" }
        isLength(definition.size, NONNEGATIVE_LENGTH_BOUNDS);
    }
    {
        fCuboid(context, id + "cube", {
            "corner1" : vector(-definition.size / 2, -definition.size / 2, 0 * millimeter),
            "corner2" : vector(definition.size / 2, definition.size / 2, definition.size)
        });
    }, { "size" : 20 * millimeter });
`;

describe("custom features on a host body", () => {
    test("an enum parameter renders as options and switches the geometry", () => {
        const doc = newDoc();
        const cube = addStudio(doc, CUBE_SOURCE, "Cube");
        const boss = addStudio(doc, BOSS_SOURCE, "Boss");
        const body = addBody(doc, [customFeature(doc, cube, "cube"), customFeature(doc, boss, "boss")]);
        const bossId = body.features[1].id;
        const shape = body.featureItems()[1].parameters.find((p) => p.key === "shape")!;
        expect(shape.options).toEqual([
            { value: "ROUND", label: "Round" },
            { value: "SQUARE", label: "Square" },
        ]);
        expect(volume(body)).toBeCloseTo(8000 + Math.PI * 25 * 5, 3);
        Transaction.execute(doc, "edit", () => body.setFeatureParameter(bossId, "shape", "SQUARE"));
        expect(volume(body)).toBeCloseTo(8000 + 100 * 5, 3);
    });

    test("a query parameter picks the host body's edges and follows them through upstream edits", () => {
        const doc = newDoc();
        const cube = addStudio(doc, CUBE_SOURCE, "Cube");
        const tools = addStudio(doc, BOSS_SOURCE, "Tools");
        const body = addBody(doc, [customFeature(doc, cube, "cube")]);
        const chamfer = customFeature(doc, tools, "chamferPicked");
        // Without picks the feature reports its own regenError.
        Transaction.execute(doc, "add", () => body.setFeaturesEmitShapeChanged([...body.features, chamfer]));
        expect(body.featureItems()[1].error).toMatch(/Pick edges to chamfer/);
        expect(body.featureItems()[1].parameters.find((p) => p.key === "edges")?.pick).toEqual({
            kinds: ["edge"],
        });

        // Pick the top edges, captured from the pre-feature geometry as the pick session does.
        body.setRollbackIndex(1);
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const refs = edges
            .map((edge, index) => ({ edge, index }))
            .filter(({ edge }) => edge.startPoint().z > 19.9 && edge.endPoint().z > 19.9)
            .map(({ edge, index }) => captureEdgeRef(edge, body.edgeIdAt(index)));
        body.setRollbackIndex(undefined);
        expect(refs).toHaveLength(4);
        Transaction.execute(doc, "pick", () =>
            body.setFeaturesEmitShapeChanged(
                body.features.map((f) =>
                    f.id === chamfer.id
                        ? {
                              ...f,
                              definition: {
                                  ...(f as FeatureScriptFeatureData).definition,
                                  edges: { edges: refs },
                              },
                          }
                        : f,
                ),
            ),
        );
        expect(body.featureItems()[1].error).toBeUndefined();
        expect(body.featureItems()[1].parameters.find((p) => p.key === "edges")?.value).toBe("4 edges");
        // Each top edge loses a 1 mm × 1 mm triangular prism (corners overlap slightly).
        expect(volume(body)).toBeLessThan(8000);
        expect(body.shape.value.findSubShapes(ShapeTypes.face)).toHaveLength(10);

        // Growing the cube upstream: the picks re-match on the rebuilt edges.
        Transaction.execute(doc, "grow", () => body.setFeatureParameter(body.features[0].id, "size", 30));
        expect(body.featureItems()[1].error).toBeUndefined();
        expect(body.shape.value.boundingBox().max.z).toBeCloseTo(30, 6);
        expect(body.shape.value.findSubShapes(ShapeTypes.face)).toHaveLength(10);
    });

    test("a downstream fillet follows an edge the custom feature created", () => {
        const doc = newDoc();
        const cube = addStudio(doc, CUBE_SOURCE, "Cube");
        const body = addBody(doc, [customFeature(doc, cube, "cube")]);
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const index = edges.findIndex((edge) => edge.startPoint().z > 19.9 && edge.endPoint().z > 19.9);
        const edgeId = body.edgeIdAt(index);
        // Scoped to the operation that made it: std's fCuboid sketches, then extrudes.
        expect(edgeId).toMatch(/:e:cube\/extrude:/);
        Transaction.execute(doc, "fillet", () =>
            body.setFeaturesEmitShapeChanged([
                ...body.features,
                { id: "fil", type: "fillet", radius: 2, edges: [captureEdgeRef(edges[index], edgeId)] },
            ]),
        );
        expect(body.featureItems()[1].error).toBeUndefined();
        Transaction.execute(doc, "grow", () => body.setFeatureParameter(body.features[0].id, "size", 40));
        expect(body.featureItems()[1].error).toBeUndefined();
        expect(body.shape.value.findSubShapes(ShapeTypes.face)).toHaveLength(7);
    });
});

describe("studio edits", () => {
    test("editing the source rebuilds the body; undo restores it", () => {
        const doc = newDoc();
        const cube = addStudio(doc, CUBE_SOURCE, "Cube");
        const body = addBody(doc, [customFeature(doc, cube, "cube")]);
        expect(volume(body)).toBeCloseTo(8000, 3);
        Transaction.execute(doc, "edit studio", () => {
            cube.source = CUBE_SOURCE.replace(
                '"corner2" : vector(definition.size / 2, definition.size / 2, definition.size)',
                '"corner2" : vector(definition.size / 2, definition.size / 2, definition.size * 2)',
            );
        });
        expect(volume(body)).toBeCloseTo(16000, 3);
        doc.history.undo();
        expect(cube.source).toBe(CUBE_SOURCE);
        expect(volume(body)).toBeCloseTo(8000, 3);
    });

    test("a studio error surfaces on the feature row and keeps the last good shape", () => {
        const doc = newDoc();
        const cube = addStudio(doc, CUBE_SOURCE, "Cube");
        const body = addBody(doc, [customFeature(doc, cube, "cube")]);
        expect(volume(body)).toBeCloseTo(8000, 3);
        Transaction.execute(doc, "break studio", () => {
            cube.source = `${CUBE_SOURCE}\nexport const broken = ;`;
        });
        expect(body.featureItems()[0].error).toMatch(/has an error/);
        expect(volume(body)).toBeCloseTo(8000, 3);
    });

    test("a studio can import another by name", () => {
        const doc = newDoc();
        addStudio(
            doc,
            `FeatureScript 2384;
import(path : "onshape/std/geometry.fs", version : "2384.0");
export function plateSize() returns ValueWithUnits { return 12 * millimeter; }`,
            "Library",
        );
        const user = addStudio(
            doc,
            `FeatureScript 2384;
import(path : "onshape/std/geometry.fs", version : "2384.0");
import(path : "Library", version : "");
annotation { "Feature Type Name" : "Library plate" }
export const libraryPlate = defineFeature(function(context is Context, id is Id, definition is map) precondition {} {
    fCuboid(context, id + "b", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(plateSize(), plateSize(), 1 * millimeter) });
});`,
            "User",
        );
        const body = addBody(doc, [customFeature(doc, user, "libraryPlate")]);
        expect(volume(body)).toBeCloseTo(144, 3);
    });

    test("a studio serializes with its source", () => {
        const doc = newDoc();
        const studio = addStudio(doc, CUBE_SOURCE, "Cube");
        const data = Serializer.serializeObject(studio);
        const copy = Serializer.deserializeObject(doc, data) as FeatureStudioNode;
        expect(copy).toBeInstanceOf(FeatureStudioNode);
        expect(copy.source).toBe(CUBE_SOURCE);
        expect(copy.name).toBe("Cube");
    });
});

test("plane sanity", () => {
    expect(Plane.XY.normal.z).toBe(1);
});
