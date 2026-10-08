// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, type IPicker, isHistoryHidden, Plane, ShapeTypes } from "@chili3d/core";
import {
    createMockApplication,
    createMockPicker,
    createMockSelection,
    createMockVisualShapeData,
    TestDocument,
} from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { captureEdgeRef } from "../src/features/edgeRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
        ),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function chain() {
    const doc = new TestDocument({ application: createMockApplication() });
    const sketch = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: {
            entities: [
                [0, 0, 40, 0],
                [40, 0, 40, 30],
                [40, 30, 0, 30],
                [0, 30, 0, 0],
            ].map((params, i) => ({ id: i + 1, type: "line", params })),
            constraints: [],
        },
    });
    doc.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "e", type: "extrude", sketchId: sketch.id, depth: 20 }],
    });
    doc.modelManager.addNode(body);
    const refs = (x: number, y: number) => {
        expect(body.shape.isOk).toBe(true);
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        try {
            const index = edges.findIndex((edge) =>
                [edge.startPoint(), edge.endPoint()].every(
                    (p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6,
                ),
            );
            expect(index).toBeGreaterThanOrEqual(0);
            return [captureEdgeRef(edges[index], body.edgeIdAt(index))];
        } finally {
            for (const edge of edges) edge.dispose();
        }
    };
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        { id: "f", type: "fillet", radius: 2, edges: refs(0, 0) },
    ]);
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        { id: "c", type: "chamfer", distance: 1, edges: refs(40, 30) },
    ]);
    expect(body.featureItems().map((f) => f.error)).toEqual([undefined, undefined, undefined]);
    const volume = () => {
        expect(body.shape.isOk).toBe(true);
        return body.shape.value.volume();
    };
    return { doc, body, volume };
}

test("a middle feature draft excludes later geometry and Cancel restores parameters, picks and history", async () => {
    const { doc, body, volume } = chain();
    const original = body.featuresJson,
        finalVolume = volume(),
        undo = doc.history.undoCount();
    const result = await body.beginFeatureEdit("f");
    expect(result.isOk).toBe(true);
    expect(body.rollbackIndex).toBe(2);
    expect(volume()).toBeCloseTo(24000 - (1 - Math.PI / 4) * 4 * 20, 5);
    body.setFeatureParameter("f", "radius", 4);
    expect(volume()).toBeCloseTo(24000 - (1 - Math.PI / 4) * 16 * 20, 5);
    expect(body.featuresJson).toBe(original);
    expect(doc.history.undoCount()).toBe(undo);
    await result.value.cancel();
    expect(body.featuresJson).toBe(original);
    expect(body.rollbackIndex).toBeUndefined();
    expect(volume()).toBeCloseTo(finalVolume, 5);
    expect(doc.history.undoCount()).toBe(undo);
    expect(doc.application.executingCommand).toBeUndefined();
});

test("Apply records one change and replays downstream operations; undo and redo rebuild all three", async () => {
    const { doc, body, volume } = chain();
    const originalVolume = volume(),
        undo = doc.history.undoCount();
    const result = await body.beginFeatureEdit("e");
    expect(result.isOk).toBe(true);
    expect(volume()).toBeCloseTo(24000, 5);
    body.setFeatureParameter("e", "depth", 25);
    body.setFeatureParameter("e", "depth", 30);
    expect(volume()).toBeCloseTo(36000, 5);
    expect((await result.value.apply()).isOk).toBe(true);
    expect(doc.history.undoCount()).toBe(undo + 1);
    expect(body.featureItems().map((f) => f.error)).toEqual([undefined, undefined, undefined]);
    const finalVolume = 36000 - (1 - Math.PI / 4) * 4 * 30 - 0.5 * 30;
    expect(volume()).toBeCloseTo(finalVolume, 5);
    doc.history.undo();
    expect(volume()).toBeCloseTo(originalVolume, 5);
    doc.history.redo();
    expect(volume()).toBeCloseTo(finalVolume, 5);
});

test("an invalid preview cannot be applied and cancellation recovers the original solid", async () => {
    const { body, volume } = chain();
    const original = body.featuresJson,
        originalVolume = volume();
    const result = await body.beginFeatureEdit("f");
    expect(result.isOk).toBe(true);
    body.setFeatureParameter("f", "radius", 1000);
    expect(body.featureItems()[1].error).toBeTruthy();
    expect(volume()).toBeCloseTo(24000, 5);
    expect((await result.value.apply()).isOk).toBe(false);
    expect(result.value.closed).toBe(false);
    expect(body.featuresJson).toBe(original);
    await result.value.cancel();
    expect(volume()).toBeCloseTo(originalVolume, 5);
});

test("inspection without edits makes no undo entry and restores an existing rollback position", async () => {
    const { doc, body, volume } = chain();
    expect(body.setRollbackIndex(1)).toBe(true);
    const original = body.featuresJson,
        undo = doc.history.undoCount();
    const result = await body.beginFeatureEdit("c");
    expect(result.isOk).toBe(true);
    expect(body.rollbackIndex).toBe(3);
    expect((await result.value.apply()).isOk).toBe(true);
    expect(body.rollbackIndex).toBe(1);
    expect(volume()).toBeCloseTo(24000, 5);
    expect(body.featuresJson).toBe(original);
    expect(doc.history.undoCount()).toBe(undo);
});

test("Boolean tool reselection previews against the original input and Cancel preserves consumed tools", async () => {
    const { doc, body, volume } = chain();
    doc.selection = createMockSelection();
    doc.picker = createMockPicker();
    const makeTool = (radius: number) => {
        const sketch = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [{ id: 1, type: "circle", params: [20, 15, radius] }],
                constraints: [],
            },
        });
        doc.modelManager.addNode(sketch);
        const tool = new ParametricBodyNode({
            document: doc,
            features: [{ id: "tool-extrude", type: "extrude", sketchId: sketch.id, depth: 20 }],
        });
        doc.modelManager.addNode(tool);
        expect(tool.shape.isOk).toBe(true);
        return { sketch, tool };
    };
    const old = makeTool(2),
        replacement = makeTool(3);
    // This replacement part precedes the operation; it remains available while editing.
    const root = doc.modelManager.rootNode;
    root.move(replacement.tool, root, body.previousSibling);
    const inputVolume = volume();
    body.setFeaturesEmitShapeChanged([
        ...body.features,
        { id: "b", type: "boolean", operation: "cut", toolIds: [old.tool.id] },
    ]);
    const original = body.featuresJson,
        undo = doc.history.undoCount();
    expect(old.tool.parent).toBe(body);
    expect(volume()).toBeCloseTo(inputVolume - Math.PI * 4 * 20, 5);
    const started = await body.beginFeatureEdit("b");
    expect(started.isOk).toBe(true);
    // A required tool and its sketch are available even though they were made after the host.
    expect(isHistoryHidden(old.tool)).toBe(false);
    expect(isHistoryHidden(old.sketch)).toBe(false);
    let pickingVolume = 0;
    doc.picker.pickNode = rs.fn<IPicker["pickNode"]>(async (_prompt, controller) => {
        pickingVolume = volume();
        controller.success();
        return [replacement.tool];
    });
    await body.reselectShapes("b", "toolIds");
    expect(pickingVolume).toBeCloseTo(inputVolume, 5);
    expect(volume()).toBeCloseTo(inputVolume - Math.PI * 9 * 20, 5);
    expect(body.featuresJson).toBe(original);
    expect(old.tool.parent).toBe(body);
    await started.value.cancel();
    expect(volume()).toBeCloseTo(inputVolume - Math.PI * 4 * 20, 5);
    expect(body.featuresJson).toBe(original);
    expect(doc.history.undoCount()).toBe(undo);
    expect(old.tool.parent).toBe(body);
});

test("a reselected Revolve axis stays in the draft until Apply and rebuilds from its referenced line", async () => {
    const { doc, body } = chain();
    const base = body.features[0];
    expect(base.type).toBe("extrude");
    if (base.type !== "extrude") throw new Error("Expected the source extrusion");
    doc.selection = createMockSelection();
    doc.picker = createMockPicker();
    const axisSketch = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: {
            entities: [{ id: 1, type: "line", params: [-10, 0, -10, 30] }],
            constraints: [],
        },
    });
    doc.modelManager.addNode(axisSketch);
    const revolved = new ParametricBodyNode({
        document: doc,
        features: [
            {
                id: "r",
                type: "revolve",
                sketchId: base.sketchId!,
                angle: 90,
                axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
            },
        ],
    });
    doc.modelManager.addNode(revolved);
    expect(revolved.shape.isOk).toBe(true);
    expect(revolved.shape.value.volume()).toBeCloseTo(12000 * Math.PI, 5);
    const original = revolved.featuresJson,
        undo = doc.history.undoCount();
    const started = await revolved.beginFeatureEdit("r");
    expect(started.isOk).toBe(true);
    const pick = createMockVisualShapeData();
    const edge = axisSketch.mesh.edges!.range[0].shape;
    doc.picker.pickShape = rs.fn<IPicker["pickShape"]>(async (_prompt, controller) => {
        controller.success();
        return [{ ...pick, shape: edge, owner: { ...pick.owner, node: axisSketch }, indexes: [0] }];
    });
    await revolved.reselectShapes("r", "axis");
    expect(revolved.shape.isOk).toBe(true);
    expect(revolved.shape.value.volume()).toBeCloseTo(18000 * Math.PI, 5);
    expect(revolved.featuresJson).toBe(original);
    expect(doc.history.undoCount()).toBe(undo);
    expect((await started.value.apply()).isOk).toBe(true);
    expect(revolved.features[0]).toMatchObject({ axisSource: { nodeId: axisSketch.id } });
    expect(doc.history.undoCount()).toBe(undo + 1);
    doc.history.undo();
    expect(revolved.shape.value.volume()).toBeCloseTo(12000 * Math.PI, 5);
});
