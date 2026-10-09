// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    addDefaultPlanes,
    BoundingBox,
    type IEdge,
    type IFace,
    Matrix4,
    Plane,
    ReferencePlaneNode,
    ShapeTypes,
    type VisualShapeData,
    XYZ,
} from "@chili3d/core";
import { createMockApplication, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { previewQueryPick } from "../../src/commands/featureScriptPickSession";
import { stagePartStudioTool } from "../../src/commands/partStudioToolCommands";
import { captureEdgeRef } from "../../src/features/edgeRef";
import type { FeatureScriptFeatureData, FeatureScriptParameterValue } from "../../src/features/feature";
import {
    captureFeatureScriptBodyRef,
    captureFeatureScriptFaceRef,
    captureFeatureScriptPlaneRef,
} from "../../src/featurescript/featureScriptFeature";
import { FeatureStudioNode } from "../../src/featurescript/featureStudioNode";
import {
    newOnshapeToolFeature,
    ONSHAPE_TOOLS,
    ONSHAPE_TOOLS_STUDIO_ID,
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

/**
 * A straight edge of the body with both ends on the given coordinates (undefined = any),
 * and whether it runs towards negative coordinates (a pattern direction may need flipping).
 */
function edgeRef(
    body: ParametricBodyNode,
    at: { x?: number; y?: number; z?: number },
    accept: (edge: IEdge) => boolean = () => true,
) {
    const edges = shape(body).findSubShapes(ShapeTypes.edge) as IEdge[];
    const near = (a: number | undefined, b: number) => a === undefined || Math.abs(a - b) < 1e-6;
    const index = edges.findIndex(
        (edge) =>
            [edge.startPoint(), edge.endPoint()].every(
                (p) => near(at.x, p.x) && near(at.y, p.y) && near(at.z, p.z),
            ) && accept(edge),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const start = edges[index].startPoint();
    const end = edges[index].endPoint();
    return {
        edges: [captureEdgeRef(edges[index], body.edgeIdAt(index))],
        runsNegative: end.x + end.y + end.z < start.x + start.y + start.z,
    };
}

/** The solid whose bounding box centre is nearest `center`. */
function partAt(body: ParametricBodyNode, center: { x: number; y: number; z: number }) {
    const solids = parts(body);
    const target = new XYZ(center.x, center.y, center.z);
    const ranked = solids
        .map((solid) => ({ solid, distance: BoundingBox.center(solid.boundingBox()).distanceTo(target) }))
        .sort((a, b) => a.distance - b.distance);
    expect(ranked[0].distance).toBeLessThan(1e-6);
    return { bodies: [captureFeatureScriptBodyRef(ranked[0].solid)] };
}

/**
 * The ten-tool UI parity run (`artifacts/cad-ui-parity-testing/run.json`), tool by tool in
 * the order it was performed in Onshape, with Onshape's inputs: Extrude, Fillet, Chamfer,
 * Shell, Mirror, Linear pattern, Circular pattern, Transform, Boolean, Revolve.
 */
test("the testing tray sequence runs on Onshape's own features", () => {
    const { doc, body } = tray();
    expect(shape(body).volume()).toBeCloseTo(4000, 6);

    // 2. Fillet 1 mm on the vertical edge at (20, 0); 3. Chamfer 1 mm at (20, 20).
    add(doc, body, "filletTool", { entities: verticalEdge(body, 20, 0), radius: 1 });
    add(doc, body, "chamferTool", { entities: verticalEdge(body, 20, 20), width: 1 });
    const solid = 4000 - (1 - Math.PI / 4) * 10 - 0.5 * 10;
    expect(shape(body).volume()).toBeCloseTo(solid, 6);

    // 4. Shell: remove the top face, 1 mm inward — the thickness the old command refused.
    add(doc, body, "shellTool", { entities: topFace(body, 10), thickness: 1 });
    const shelled = shape(body).volume();
    expect(shelled).toBeGreaterThan(500);
    expect(shelled).toBeLessThan(solid / 2);

    // 5. Mirror the part about the Front plane (y = 0) as a new part.
    add(doc, body, "mirrorTool", {
        entities: allParts(body),
        mirrorPlane: plane(doc, "Front"),
        operationType: "NEW",
    });
    expect(parts(body)).toHaveLength(2);
    expect(shape(body).volume()).toBeCloseTo(2 * shelled, 6);
    expect(shape(body).boundingBox().min.y).toBeCloseTo(-20, 6);

    // 6. Linear pattern: the original tray, +X 40 mm, 2 instances, along the tray's bottom
    //    edge on the x axis (flipped when the picked edge happens to run −X).
    const direction = edgeRef(
        body,
        { y: 0, z: 0 },
        (edge) => edge.startPoint().x >= 0 && edge.endPoint().x >= 0,
    );
    add(doc, body, "linearPatternTool", {
        entities: partAt(body, { x: 10, y: 10, z: 5 }),
        directionOne: { edges: direction.edges },
        distance: 40,
        instanceCount: 2,
        oppositeDirection: direction.runsNegative,
    });
    expect(parts(body)).toHaveLength(3);
    expect(shape(body).boundingBox().max.x).toBeCloseTo(60, 6);

    // 7. Circular pattern: the translated tray, 2 instances over a full 360° (180° apart)
    //    about the vertical cavity edge at (1, −1) of the mirrored tray.
    add(doc, body, "circularPatternTool", {
        entities: partAt(body, { x: 50, y: 10, z: 5 }),
        axis: edgeRef(body, { x: 1, y: -1 }),
        angle: 360,
        instanceCount: 2,
        equalSpace: true,
    });
    expect(parts(body)).toHaveLength(4);
    // (x, y) → (2 − x, −2 − y): the copy spans x ∈ [−58, −38], y ∈ [−22, −2].
    const rotated = shape(body).boundingBox();
    expect(rotated.min.x).toBeCloseTo(-58, 6);
    expect(rotated.min.y).toBeCloseTo(-22, 6);

    // 8. Transform: move the circular copy +Z 20 mm (no copy).
    add(doc, body, "transformTool", {
        entities: partAt(body, { x: -48, y: -12, z: 5 }),
        transformType: "TRANSLATION_3D",
        dz: 20,
        makeCopy: false,
    });
    expect(parts(body)).toHaveLength(4);
    expect(shape(body).boundingBox().max.z).toBeCloseTo(30, 6);

    // 9. Boolean union of the original and the mirrored tray.
    add(doc, body, "booleanTool", {
        tools: {
            bodies: [
                ...partAt(body, { x: 10, y: 10, z: 5 }).bodies,
                ...partAt(body, { x: 10, y: -10, z: 5 }).bodies,
            ],
        },
        operationType: "UNION",
    });
    expect(parts(body)).toHaveLength(3);
    const union = parts(body).find(
        (solid) => BoundingBox.center(solid.boundingBox()).distanceTo(new XYZ(10, 0, 5)) < 1e-6,
    );
    expect(union).toBeDefined();
    expect(union!.volume()).toBeCloseTo(2 * shelled, 4);

    // 10. Revolve the rectangle a full turn about its x = 0 edge: a new cylinder (Chili3d's
    //     own Revolve dialog, which already has Onshape's fields), then Transform it +X 100.
    const sketch = doc.modelManager.findNode((node) => node instanceof SketchNode) as SketchNode;
    const cylinder = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "r",
                type: "revolve",
                sketchId: sketch.id,
                axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
                angle: 360,
            },
        ],
    });
    doc.modelManager.addNode(cylinder);
    expect(shape(cylinder).volume()).toBeCloseTo(Math.PI * 400 * 20, 3);
    add(doc, cylinder, "transformTool", {
        entities: allParts(cylinder),
        transformType: "TRANSLATION_3D",
        dx: 100,
        makeCopy: false,
    });
    const moved = shape(cylinder).boundingBox();
    expect(moved.min.x).toBeCloseTo(80, 6);
    expect(moved.max.x).toBeCloseTo(120, 6);
    expect(shape(body).checkShape()).toBe(true);
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

test("a tool feature needs no studio node: no tab, no tree row, no undo step", () => {
    const { doc, body } = tray();
    const undo = doc.history.undoCount();
    const created = newOnshapeToolFeature(doc, "filletTool", body);
    expect(created.isOk).toBe(true);
    expect(created.value.feature.studioId).toBe(ONSHAPE_TOOLS_STUDIO_ID);
    expect(doc.modelManager.findNodes((node) => node instanceof FeatureStudioNode)).toEqual([]);
    expect(doc.history.undoCount()).toBe(undo);
    // The feature still resolves its dialog and runs.
    add(doc, body, "filletTool", { entities: verticalEdge(body, 20, 0), radius: 1 });
    expect(
        body
            .featureItems()
            .at(-1)
            ?.parameters.map((p) => p.key),
    ).toContain("radius");
    expect(doc.modelManager.findNodes((node) => node instanceof FeatureStudioNode)).toEqual([]);
});

/** The selection of one edge of the body, as the viewport reports it. */
function selectedEdge(body: ParametricBodyNode, x: number, y: number): VisualShapeData {
    const edges = shape(body).findSubShapes(ShapeTypes.edge) as IEdge[];
    const index = edges.findIndex((edge) =>
        [edge.startPoint(), edge.endPoint()].every(
            (p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6,
        ),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    return {
        owner: { node: body } as unknown as VisualShapeData["owner"],
        shape: edges[index],
        transform: Matrix4.identity(),
        indexes: [index],
    };
}

test("a preselected edge fills the tool's first box, and a part selection is left out of an edge box", () => {
    const { doc, body } = tray();
    const edge = selectedEdge(body, 20, 0);
    const solid = { ...edge, shape: parts(body)[0], indexes: [0, 1, 2, 3, 4, 5] };
    doc.selection.getSelectedShapes = () => [edge, solid];
    const staged = stagePartStudioTool(doc, "filletTool");
    expect(staged.isOk).toBe(true);
    expect(staged.value.body).toBe(body);
    expect(staged.value.pick).toBe("entities");
    const entities = staged.value.feature.definition["entities"] as { edges?: unknown[]; bodies?: unknown[] };
    expect(entities.edges).toHaveLength(1);
    expect(entities.bodies).toBeUndefined();
    // The staged feature builds with the preselection at std's default radius: the dialog
    // opens on a fillet.
    body.setFeaturesEmitShapeChanged([...body.features, staged.value.feature]);
    expect(body.featureItems().at(-1)?.error).toBeUndefined();
    const radius = staged.value.feature.definition["radius"];
    expect(typeof radius).toBe("number");
    expect(shape(body).volume()).toBeCloseTo(4000 - (1 - Math.PI / 4) * (radius as number) ** 2 * 10, 6);

    // Nothing selected: the box starts empty.
    doc.selection.getSelectedShapes = () => [];
    const empty = stagePartStudioTool(doc, "chamferTool");
    expect(empty.isOk).toBe(true);
    expect(empty.value.feature.definition["entities"]).toBeUndefined();
});

test("picking previews the feature's result on the rolled-back input", () => {
    const { doc, body } = tray();
    const created = newOnshapeToolFeature(doc, "shellTool", body);
    expect(created.isOk).toBe(true);
    const feature = created.value.feature;
    // The dialog stages the feature and the pick rolls the body back to the feature's input.
    body.setFeaturesEmitShapeChanged([...body.features, feature]);
    expect(body.setRollbackIndex(1)).toBe(true);
    expect(shape(body).volume()).toBeCloseTo(4000, 6);
    const preview = previewQueryPick(body, feature, "entities", topFace(body, 10));
    expect(preview.isOk).toBe(true);
    const volume = preview.value.volume();
    preview.value.dispose();
    // std's default thickness, inward: the block minus the cavity it leaves.
    const thickness = feature.definition["thickness"];
    expect(typeof thickness).toBe("number");
    const t = thickness as number;
    expect(volume).toBeCloseTo(4000 - (20 - 2 * t) ** 2 * (10 - t), 3);
    // The body itself is untouched by the preview.
    expect(shape(body).volume()).toBeCloseTo(4000, 6);
    expect(previewQueryPick(body, feature, "entities", {}).isOk).toBe(false);
});
