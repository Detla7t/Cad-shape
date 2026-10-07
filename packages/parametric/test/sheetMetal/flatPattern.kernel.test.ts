// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The exported flat pattern (pure 2D, `flatPattern.ts`) against the kernel's flattened
 * solid of the same part: a duct wrapper with four bends, a Pittsburgh pocket, its easy
 * edge and a hole. Same area (volume / thickness), same extents, and every bend line of
 * the drawing is a bend mark of the solid.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, Matrix4, Plane, ShapeTypes, Transaction } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { captureEdgeRef } from "../../src/features/edgeRef";
import type { FeatureData } from "../../src/features/feature";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { captureSheetLine } from "../../src/sheetMetal/features";
import { flatPatternArea, flatPatternOf } from "../../src/sheetMetal/flatPattern";
import { Arena } from "../../src/sheetMetal/frame";
import { layoutOf, mapPoint } from "../../src/sheetMetal/layout";
import { sheetModelOf } from "../../src/sheetMetal/model";
import type { SketchData } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
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

function addSketch(doc: TestDocument, data: SketchData): SketchNode {
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data });
    doc.modelManager.addNode(sketch);
    return sketch;
}

function add(doc: TestDocument, body: ParametricBodyNode, feature: FeatureData) {
    Transaction.execute(doc, "add", () => body.setFeaturesEmitShapeChanged([...body.features, feature]));
}

/** The body's straight edge nearest to the formed image of the blank edge a–b. */
function formedEdge(body: ParametricBodyNode, a: [number, number], b: [number, number]) {
    const arena = new Arena();
    let target: number[];
    try {
        const layout = layoutOf(arena, sheetModelOf(body.shape.value)!);
        const p = mapPoint(layout, a, 0)!;
        const q = mapPoint(layout, b, 0)!;
        target = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    } finally {
        arena.dispose();
    }
    const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    const distance = (edge: IEdge) => {
        const [s, e] = edge.ends();
        return Math.hypot(
            (s.x + e.x) / 2 - target[0],
            (s.y + e.y) / 2 - target[1],
            (s.z + e.z) / 2 - target[2],
        );
    };
    return captureEdgeRef(edges.reduce((best, edge) => (distance(edge) < distance(best) ? edge : best)));
}

test("the exported flat pattern matches the kernel's flattened duct wrapper", () => {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const t = 0.7;
    const blank = addSketch(doc, {
        entities: [
            { id: 1, type: "line", params: [0, 0, 860, 0] },
            { id: 2, type: "line", params: [860, 0, 860, 400] },
            { id: 3, type: "line", params: [860, 400, 0, 400] },
            { id: 4, type: "line", params: [0, 400, 0, 0] },
            { id: 5, type: "circle", params: [100, 200, 20] },
        ],
        constraints: [],
    });
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "base", type: "smBase", sketchId: blank.id, thickness: t, radius: 1, kFactor: 0.5 }],
    });
    doc.modelManager.addNode(body);
    const lines = addSketch(doc, {
        entities: [200, 430, 630, 830].map((x, i) => ({
            id: i + 1,
            type: "line" as const,
            params: [x, -10, x, 410],
        })),
        constraints: [],
    });
    const lineEdges = lines.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    add(doc, body, {
        id: "bends",
        type: "smBend",
        lines: lineEdges.map((edge) => captureSheetLine(lines.id, edge, Matrix4.identity())),
        angle: 90,
        direction: "up",
    });
    add(doc, body, {
        id: "pocket",
        type: "smEdge",
        kind: "pittsburgh",
        edges: [formedEdge(body, [0, 0], [0, 400])],
        direction: "up",
        length: 7.94,
        height: 9.5,
    });
    add(doc, body, {
        id: "easy",
        type: "smEdge",
        kind: "easyEdge",
        edges: [formedEdge(body, [860, 0], [860, 400])],
        direction: "up",
        length: 6.35,
    });
    add(doc, body, { id: "flat", type: "smFlatten" });
    expect(body.featureItems().map((item) => item.error)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
    ]);

    const flat = body.shape.value;
    const pattern = flatPatternOf(sheetModelOf(flat)!);
    expect(pattern.isOk).toBe(true);
    expect(pattern.value.outline).toHaveLength(2);

    // Same material: area × thickness is the flattened solid's volume.
    expect(flatPatternArea(pattern.value) * t).toBeCloseTo(flat.volume(), 3);

    // Same extents (the kernel box is single precision).
    const box = flat.boundingBox();
    const points = pattern.value.outline[0].map((segment) => segment.a);
    expect(Math.min(...points.map((p) => p[0]))).toBeCloseTo(box.min.x, 4);
    expect(Math.max(...points.map((p) => p[0]))).toBeCloseTo(box.max.x, 4);
    expect(Math.min(...points.map((p) => p[1]))).toBeCloseTo(box.min.y, 4);
    expect(Math.max(...points.map((p) => p[1]))).toBeCloseTo(box.max.y, 4);

    // Every bend line of the drawing is a bend mark (an edge on the top face) of the solid.
    const marks = (flat.findSubShapes(ShapeTypes.edge) as IEdge[]).map((edge) => edge.ends());
    const flangeBends = pattern.value.bendLines.filter((line) => line.source === "flange").length;
    expect(pattern.value.bendLines.filter((line) => line.source === "bend")).toHaveLength(4);
    expect(flangeBends).toBeGreaterThanOrEqual(2);
    for (const line of pattern.value.bendLines) {
        const match = marks.some(([s, e]) => {
            const same = (p: { x: number; y: number; z: number }, q: readonly [number, number]) =>
                Math.hypot(p.x - q[0], p.y - q[1]) < 1e-6 && Math.abs(p.z - t) < 1e-6;
            return (same(s, line.a) && same(e, line.b)) || (same(s, line.b) && same(e, line.a));
        });
        expect(match).toBe(true);
    }
});
