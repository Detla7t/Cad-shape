// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Kernel queries that throw — reading the curve of a degenerate edge, which a chamfer
 * run into a fillet can leave on a body — must fail one feature visibly, never escape a
 * rebuild: an escaped throw left the body showing a stale (or rolled-back, empty) shape
 * with no error on any feature row.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, type IFace, Plane, type Result, ShapeTypes, XYZ } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { type FeatureHandler, registerFeature } from "../src/features/feature";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { type SketchData, SketchNode } from "../src/sketch";
import { edgeSnapshotUV, isEdgeCoplanarWithPlane } from "../src/sketch/externalRef";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
);

const THROWING = "test.throwingQuery";

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    const handler: FeatureHandler = {
        display: "common.length",
        evaluate: () => {
            throw new Error("Edge.curve: degenerate edge has no 3D curve");
        },
        nodeIds: () => [],
        parameters: () => [],
        setParameter: (feature) => feature,
    };
    registerFeature(THROWING, handler);
});

function square(size: number): SketchData {
    return {
        entities: [
            { id: 1, type: "line", params: [0, 0, size, 0] },
            { id: 2, type: "line", params: [size, 0, size, size] },
            { id: 3, type: "line", params: [size, size, 0, size] },
            { id: 4, type: "line", params: [0, size, 0, 0] },
        ],
        constraints: [],
    };
}

/** An edge whose curve cannot be read, like OCCT's degenerate edges. */
const degenerateEdge = {
    get curve(): never {
        throw new Error("Edge.curve: degenerate edge has no 3D curve");
    },
} as unknown as IEdge;

describe("degenerate edges", () => {
    test("are not projectable into a sketch", () => {
        expect(edgeSnapshotUV(Plane.XY, degenerateEdge)).toBeUndefined();
    });

    test("are never coplanar with a sketch plane", () => {
        expect(isEdgeCoplanarWithPlane(Plane.XY, degenerateEdge)).toBe(false);
    });
});

describe("a throwing feature step", () => {
    test("fails that feature with its message and keeps the last good shape", () => {
        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc) as any;
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: square(10) });
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "f1", type: "extrude", sketchId: sketch.id, depth: 10 }],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.unchecked()?.volume()).toBeCloseTo(1000, 6);

        body.setFeaturesEmitShapeChanged([...body.features, { id: "f2", type: THROWING } as any]);

        const items = body.featureItems();
        expect(items.map((item) => item.error)).toEqual([
            undefined,
            "Edge.curve: degenerate edge has no 3D curve",
        ]);
        expect(body.shape.unchecked()?.volume()).toBeCloseTo(1000, 6);

        body.setFeaturesEmitShapeChanged(body.features.filter((feature) => feature.id !== "f2"));
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined]);
    });

    test("a rollback whose replay throws keeps the previous timeline position", () => {
        const doc = new TestDocument({ application: createMockApplication() });
        doc.visual = createMockVisualWithDocument(doc) as any;
        const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: square(10) });
        doc.modelManager.addNode(sketch);
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "f1", type: "extrude", sketchId: sketch.id, depth: 10 }],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        // The replay itself throws (the rebuild entry point is protected; reach it for the test).
        const internals = body as unknown as { generateShape(): Result<never> };
        const generate = internals.generateShape;
        internals.generateShape = () => {
            throw new Error("kernel abort");
        };
        try {
            expect(body.setRollbackIndex(0)).toBe(false);
            expect(body.rollbackIndex).toBeUndefined();
        } finally {
            internals.generateShape = generate;
        }
    });
});

describe("projected arcs", () => {
    test("every fillet arc on a face projects as its own 90° arc, whatever the edge's orientation", () => {
        const box = shapeFactory.box(Plane.XY, 40, 30, 10).value;
        const vertical = (box.findSubShapes(ShapeTypes.edge) as IEdge[]).flatMap((edge, index) =>
            Math.abs(edge.startPoint().z - edge.endPoint().z) > 1 ? [index] : [],
        );
        expect(vertical).toHaveLength(4);
        const filleted = shapeFactory.fillet(box, vertical, 5).value;
        const top = (filleted.findSubShapes(ShapeTypes.face) as IFace[]).find(
            (face) => face.normal(0, 0)[1].z > 0.99 && face.boundingBox()!.min.z > 9.99,
        );
        expect(top).not.toBeUndefined();
        const plane = new Plane({ origin: new XYZ(0, 0, 10), normal: XYZ.unitZ, xvec: XYZ.unitX });
        const sweeps = (top!.findSubShapes(ShapeTypes.edge) as IEdge[])
            .map((edge) => edgeSnapshotUV(plane, edge))
            .filter((snapshot) => snapshot?.type === "arc")
            .map((snapshot) => {
                const [cu, cv, su, sv, eu, ev] = snapshot!.params;
                const sweep = Math.atan2(ev - cv, eu - cu) - Math.atan2(sv - cv, su - cu);
                return ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            });
        expect(sweeps).toHaveLength(4);
        for (const sweep of sweeps) expect(sweep).toBeCloseTo(Math.PI / 2, 9);
    });
});
