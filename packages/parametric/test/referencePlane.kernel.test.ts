// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Plane, ReferencePlaneNode, Serializer, Transaction, XYZ } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
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
        configurable: true,
        writable: true,
    });
});

test("sketch geometry follows a reference plane, undo and restored plane edits", () => {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const plane = new ReferencePlaneNode({ document: doc, basePlane: Plane.XY, offset: 20 });
    doc.modelManager.addNode(plane);
    const sketch = new SketchNode({
        document: doc,
        plane: plane.plane,
        planeRef: { kind: "plane", nodeId: plane.id, normal: XYZ.unitZ, offset: 20 },
        data: { entities: [{ id: 1, type: "circle", params: [0, 0, 8] }], constraints: [] },
    });
    doc.modelManager.addNode(sketch);
    expect(sketch.shape.isOk).toBe(true);
    expect(sketch.boundingBox()!.min.z).toBeCloseTo(20);
    Transaction.execute(doc, "move plane", () => {
        plane.offset = 45;
    });
    expect(sketch.plane.origin.z).toBe(45);
    expect(sketch.boundingBox()!.max.z).toBeCloseTo(45);
    doc.history.undo();
    expect(sketch.plane.origin.z).toBe(20);
    expect(sketch.boundingBox()!.max.z).toBeCloseTo(20);
    doc.history.redo();
    expect(sketch.boundingBox()!.min.z).toBeCloseTo(45);
    const restored = Serializer.deserializeObject(doc, Serializer.serializeObject(sketch)) as SketchNode;
    expect(restored.planeRef?.nodeId).toBe(plane.id);
    expect(restored.shape.isOk).toBe(true);
    Transaction.execute(doc, "move again", () => {
        plane.offset = -10;
    });
    expect(restored.plane.origin.z).toBe(-10);
    expect(restored.boundingBox()!.min.z).toBeCloseTo(-10);
});
