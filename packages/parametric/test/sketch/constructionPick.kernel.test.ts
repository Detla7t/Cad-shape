// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DisplayScale, Plane, ShapeTypes, Transaction, XYZ } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { type SketchData, SketchNode } from "../../src/sketch";
import "./setup";

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

afterEach(() => {
    DisplayScale.reset();
});

/** A profile line and a construction line. */
const DATA: SketchData = {
    entities: [
        { id: 1, type: "line", params: [0, 0, 10, 0] },
        { id: 2, type: "line", params: [0, 5, 10, 5], construction: true },
    ],
    constraints: [],
};

test("a construction line carries a kernel edge in its mesh range and redraws its dashes per zoom band", () => {
    const document = new TestDocument();
    const node = new SketchNode({ document, plane: Plane.XY, data: DATA });
    document.modelManager.addNode(node);
    try {
        const edges = node.mesh.edges!;
        expect(edges.range).toHaveLength(2);
        const [profile, construction] = edges.range;
        expect(profile.shape.shapeType).toBe(ShapeTypes.edge);
        expect(construction.shape.shapeType).toBe(ShapeTypes.edge);
        // Its own sub-shape: the pick, highlight and measure read it like a profile edge.
        expect(construction.shape.index).toBe(0);
        expect(construction.shape.parent).toBe(construction.shape);
        expect(construction.start).toBe(profile.start + profile.count);
        // Dashed at 0.1 mm per pixel (the pattern's period snapped to 50 mm): the first dash
        // of a 10 mm line, as one segment.
        expect(construction.count).toBeGreaterThanOrEqual(2);
        // The sketch's shape holds the profile edge only.
        expect(node.shape.value.findSubShapes(ShapeTypes.edge)).toHaveLength(1);

        // Zoomed in ten times: the same edge, a finer pattern (a 5 mm period: several dashes).
        DisplayScale.update(0.01);
        const again = node.mesh.edges!.range[1];
        expect(again.shape).toBe(construction.shape);
        expect(again.count).toBeGreaterThan(construction.count);
        expect(again.count).toBeGreaterThanOrEqual(6);
    } finally {
        node.dispose();
        document.dispose();
    }
});

test("setPlane turns the sketch onto another plane with its reference, as one undo step", () => {
    const document = new TestDocument();
    const node = new SketchNode({ document, plane: Plane.XY, data: DATA });
    document.modelManager.addNode(node);
    try {
        Transaction.execute(document, "Change sketch plane", () => {
            node.setPlane(Plane.YZ, { kind: "plane", nodeId: "right", normal: XYZ.unitX, offset: 0 });
        });
        expect(node.plane.normal.x).toBe(1);
        expect(node.planeRef?.nodeId).toBe("right");
        // The entities keep their plane coordinates: the profile line now runs along Y.
        const box = node.shape.value.boundingBox()!;
        expect(box.max.y - box.min.y).toBeCloseTo(10, 1);
        expect(box.max.x - box.min.x).toBeCloseTo(0, 1);

        document.history.undo();
        expect(node.plane.normal.z).toBe(1);
        expect(node.planeRef).toBeUndefined();
        document.history.redo();
        expect(node.planeRef?.nodeId).toBe("right");
    } finally {
        node.dispose();
        document.dispose();
    }
});
