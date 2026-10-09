// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    addDefaultPlanes,
    type IEdge,
    type IFace,
    Plane,
    ReferencePlaneNode,
    ShapeTypes,
} from "@chili3d/core";
import { createMockApplication, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { captureEdgeRef } from "../../src/features/edgeRef";
import type { FeatureScriptFeatureData, FeatureScriptParameterValue } from "../../src/features/feature";
import {
    captureFeatureScriptBodyRef,
    captureFeatureScriptFaceRef,
    captureFeatureScriptPlaneRef,
} from "../../src/featurescript/featureScriptFeature";
import {
    newOnshapeToolFeature,
    ONSHAPE_TOOLS,
    type OnshapeToolName,
    onshapeToolsSource,
} from "../../src/featurescript/onshapeTools";
import { provideOnshapeStd } from "../../src/featurescript/runtime";
import { compileStudioSource } from "../../src/featurescript/studioCompiler";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { SketchNode } from "../../src/sketch/sketchNode";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";
import "../sketch/setup";

const originalFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
        ),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    provideOnshapeStd(ONSHAPE_STD);
});
afterAll(() => {
    provideOnshapeStd(undefined);
    if (originalFactory) Object.defineProperty(globalThis, "shapeFactory", originalFactory);
});

/** The testing tray: a 20 × 20 mm XY rectangle extruded 10 mm. */
function tray() {
    const doc = new TestDocument({ application: createMockApplication() });
    addDefaultPlanes(doc);
    const sketch = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: {
            entities: [
                [0, 0, 20, 0],
                [20, 0, 20, 20],
                [20, 20, 0, 20],
                [0, 20, 0, 0],
            ].map((params, i) => ({ id: i + 1, type: "line", params })),
            constraints: [],
        },
    });
    doc.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "e", type: "extrude", sketchId: sketch.id, depth: 10 }],
    });
    doc.modelManager.addNode(body);
    return { doc, body };
}

function shape(body: ParametricBodyNode) {
    const result = body.shape;
    if (!result.isOk) throw new Error(result.error);
    return result.value;
}

function verticalEdge(body: ParametricBodyNode, x: number, y: number) {
    const edges = shape(body).findSubShapes(ShapeTypes.edge) as IEdge[];
    const index = edges.findIndex((edge) =>
        [edge.startPoint(), edge.endPoint()].every(
            (p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6,
        ),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    return { edges: [captureEdgeRef(edges[index], body.edgeIdAt(index))] };
}

function topFace(body: ParametricBodyNode, z: number) {
    const faces = shape(body).findSubShapes(ShapeTypes.face) as IFace[];
    const index = faces.findIndex((face) => {
        const box = face.boundingBox();
        return Math.abs(box.min.z - z) < 1e-6 && Math.abs(box.max.z - z) < 1e-6;
    });
    expect(index).toBeGreaterThanOrEqual(0);
    return { faces: [captureFeatureScriptFaceRef(faces[index], body.faceIdAt(index))] };
}

function parts(body: ParametricBodyNode) {
    return shape(body).findSubShapes(ShapeTypes.solid);
}

function allParts(body: ParametricBodyNode) {
    return { bodies: parts(body).map((solid) => captureFeatureScriptBodyRef(solid)) };
}

const DATUMS = { Top: Plane.XY, Front: Plane.ZX, Right: Plane.YZ };

function plane(doc: TestDocument, name: keyof typeof DATUMS) {
    const node = doc.modelManager.findNode(
        (n) => n instanceof ReferencePlaneNode && n.basePlane.normal.isEqualTo(DATUMS[name].normal),
    );
    expect(node).toBeInstanceOf(ReferencePlaneNode);
    return { planes: [captureFeatureScriptPlaneRef(node as ReferencePlaneNode)] };
}

/** Appends a tool feature with std's defaults overridden by `values`; asserts it rebuilt. */
function add(
    doc: TestDocument,
    body: ParametricBodyNode,
    tool: OnshapeToolName,
    values: Record<string, FeatureScriptParameterValue>,
): FeatureScriptFeatureData {
    const created = newOnshapeToolFeature(doc, tool, body);
    if (!created.isOk) throw new Error(created.error);
    const feature = {
        ...created.value.feature,
        definition: { ...created.value.feature.definition, ...values },
    };
    body.setFeaturesEmitShapeChanged([...body.features, feature]);
    const item = body.featureItems().find((entry) => entry.id === feature.id);
    expect(item?.error).toBeUndefined();
    expect(shape(body).checkShape()).toBe(true);
    return feature;
}

test("every tool compiles to std's own dialog", () => {
    const source = onshapeToolsSource();
    expect(source).toBeDefined();
    const compiled = compileStudioSource("tools", "tools", source!, () => undefined);
    expect(compiled.error).toBeUndefined();
    expect(compiled.features.map((feature) => [feature.name, feature.displayName])).toEqual(
        ONSHAPE_TOOLS.map((tool) => [tool.featureName, tool.displayName]),
    );
    const keys = (name: string) => compiled.spec(name)?.parameters.map((p) => p.key);
    expect(keys("shellTool")).toEqual(["isHollow", "entities", "parts", "thickness", "oppositeDirection"]);
    expect(keys("mirrorTool")).toEqual([
        "patternType",
        "operationType",
        "entities",
        "faces",
        "mirrorPlane",
        "defaultScope",
        "booleanScope",
        "fullFeaturePattern",
    ]);
    expect(keys("transformTool")?.slice(0, 2)).toEqual(["entities", "transformType"]);
    const operation = compiled.spec("mirrorTool")?.parameters.find((p) => p.key === "operationType");
    expect(operation?.options?.map((o) => o.value)).toEqual(["NEW", "ADD", "REMOVE", "INTERSECT"]);
    expect(operation?.uiHints).toContain("HORIZONTAL_ENUM");
    expect(compiled.spec("mirrorTool")?.parameters.find((p) => p.key === "mirrorPlane")?.filter).toEqual([
        "FACE",
        "PLANE",
    ]);
});

test("the testing tray sequence runs on Onshape's own features", () => {
    const { doc, body } = tray();
    expect(shape(body).volume()).toBeCloseTo(4000, 6);

    add(doc, body, "filletTool", { entities: verticalEdge(body, 20, 0), radius: 1 });
    add(doc, body, "chamferTool", { entities: verticalEdge(body, 20, 20), width: 1 });
    const solid = 4000 - (1 - Math.PI / 4) * 10 - 0.5 * 10;
    expect(shape(body).volume()).toBeCloseTo(solid, 6);

    // The 1 mm inward shell the old command refused.
    add(doc, body, "shellTool", { entities: topFace(body, 10), thickness: 1 });
    const shelled = shape(body).volume();
    expect(shelled).toBeGreaterThan(500);
    expect(shelled).toBeLessThan(solid / 2);

    // Mirror the part about the Front plane as a new part.
    add(doc, body, "mirrorTool", {
        entities: allParts(body),
        mirrorPlane: plane(doc, "Front"),
        operationType: "NEW",
    });
    expect(parts(body)).toHaveLength(2);
    expect(shape(body).volume()).toBeCloseTo(2 * shelled, 6);
    const box = shape(body).boundingBox();
    expect(box.min.y).toBeCloseTo(-20, 6);
    expect(box.max.y).toBeCloseTo(20, 6);

    // Union the original and the mirrored part.
    add(doc, body, "booleanTool", { tools: allParts(body), operationType: "UNION" });
    expect(parts(body)).toHaveLength(1);

    // Linear pattern: 2 instances, 40 mm along X (the bottom edge on y = -20).
    const xEdge = (() => {
        const edges = shape(body).findSubShapes(ShapeTypes.edge) as IEdge[];
        const index = edges.findIndex((edge) => {
            const a = edge.startPoint();
            const b = edge.endPoint();
            return Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.z - b.z) < 1e-9 && Math.abs(a.x - b.x) > 5;
        });
        expect(index).toBeGreaterThanOrEqual(0);
        return { edges: [captureEdgeRef(edges[index], body.edgeIdAt(index))] };
    })();
    add(doc, body, "linearPatternTool", {
        entities: allParts(body),
        directionOne: xEdge,
        distance: 40,
        instanceCount: 2,
    });
    expect(parts(body)).toHaveLength(2);
    const patterned = shape(body).boundingBox();
    expect(patterned.max.x - patterned.min.x).toBeCloseTo(60, 6);

    // Transform: copy everything up 20 mm.
    add(doc, body, "transformTool", {
        entities: allParts(body),
        transformType: "TRANSLATION_3D",
        dz: 20,
        makeCopy: true,
    });
    expect(parts(body)).toHaveLength(4);
    expect(shape(body).boundingBox().max.z).toBeCloseTo(30, 6);
});

test("a Part Studio tool can be cancelled without leaving a feature or an undo step", async () => {
    const { doc, body } = tray();
    const created = newOnshapeToolFeature(doc, "shellTool", body);
    expect(created.isOk).toBe(true);
    const before = body.featuresJson;
    const session = await body.beginFeatureEdit(created.value.feature.id, { insert: created.value.feature });
    expect(session.isOk).toBe(true);
    expect(session.value.inserting).toBe(true);
    expect(body.features.map((f) => f.id)).toEqual(["e", created.value.feature.id]);
    // Nothing picked yet: std reports "select faces", and the input stays on screen.
    expect(body.featureItems().at(-1)?.error).toBeDefined();
    expect(shape(body).volume()).toBeCloseTo(4000, 6);
    await session.value.cancel();
    expect(body.featuresJson).toBe(before);
    expect(body.featureItems().map((item) => item.error)).toEqual([undefined]);
});

test("applying an inserted tool commits it as one undo step", async () => {
    const { doc, body } = tray();
    const created = newOnshapeToolFeature(doc, "shellTool", body);
    expect(created.isOk).toBe(true);
    const id = created.value.feature.id;
    const session = await body.beginFeatureEdit(id, { insert: created.value.feature });
    expect(session.isOk).toBe(true);
    body.setFeatureParameter(id, "thickness", 1);
    const feature = body.features.find((f) => f.id === id) as FeatureScriptFeatureData;
    body.setFeaturesEmitShapeChanged(
        body.features.map((f) =>
            f.id === id
                ? { ...feature, definition: { ...feature.definition, entities: topFace(body, 10) } }
                : f,
        ),
    );
    expect((await session.value.apply()).isOk).toBe(true);
    expect(body.features.map((f) => f.id)).toEqual(["e", id]);
    expect(shape(body).volume()).toBeLessThan(2000);
    await doc.history.undo();
    expect(body.features.map((f) => f.id)).toEqual(["e"]);
    expect(shape(body).volume()).toBeCloseTo(4000, 6);
});
