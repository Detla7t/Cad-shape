// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Sheet metal features in parametric bodies: a flat blank from a sketch, bend lines from a
 * second sketch, Pittsburgh pocket and easy edge on edges picked on the formed part, the
 * flat pattern, and a round duct (roll, crimp, ring bead). Every step is a feature row, so
 * a parameter edit rebuilds the chain and the picked edges re-match.
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
import { Arena } from "../../src/sheetMetal/frame";
import { layoutOf, mapPoint } from "../../src/sheetMetal/layout";
import { bendAllowance, sheetModelOf } from "../../src/sheetMetal/model";
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

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

const rect = (x0: number, y0: number, x1: number, y1: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [x0, y0, x1, y0] },
        { id: 2, type: "line", params: [x1, y0, x1, y1] },
        { id: 3, type: "line", params: [x1, y1, x0, y1] },
        { id: 4, type: "line", params: [x0, y1, x0, y0] },
    ],
    constraints: [],
});

function addSketch(doc: TestDocument, data: SketchData): SketchNode {
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data });
    doc.modelManager.addNode(sketch);
    return sketch;
}

/** A sheet metal body from a rectangle sketch. */
function sheet(doc: TestDocument, w: number, h: number, thickness = 1): ParametricBodyNode {
    const sketch = addSketch(doc, rect(0, 0, w, h));
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "base", type: "smBase", sketchId: sketch.id, thickness, radius: 1, kFactor: 0.5 }],
    });
    doc.modelManager.addNode(body);
    return body;
}

function add(doc: TestDocument, body: ParametricBodyNode, feature: FeatureData) {
    Transaction.execute(doc, "add", () => body.setFeaturesEmitShapeChanged([...body.features, feature]));
}

/** Bend lines drawn as lines of their own sketch. */
function bendLines(doc: TestDocument, xs: number[], h: number) {
    const sketch = addSketch(doc, {
        entities: xs.map((x, i) => ({ id: i + 1, type: "line" as const, params: [x, -10, x, h + 10] })),
        constraints: [],
    });
    const edges = sketch.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    return edges.map((edge) => captureSheetLine(sketch.id, edge, Matrix4.identity()));
}

/** Midpoint of the formed image (bottom face) of a blank edge. */
function formedImage(
    body: ParametricBodyNode,
    a: [number, number],
    b: [number, number],
): [number, number, number] {
    const model = sheetModelOf(body.shape.value)!;
    const arena = new Arena();
    try {
        const layout = layoutOf(arena, model);
        const p = mapPoint(layout, a, 0)!;
        const q = mapPoint(layout, b, 0)!;
        return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    } finally {
        arena.dispose();
    }
}

/** The body's straight edge whose midpoint is nearest to `point`. */
function edgeNear(body: ParametricBodyNode, point: [number, number, number]) {
    const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    let best = edges[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const edge of edges) {
        const [a, b] = edge.ends();
        const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2];
        const d = Math.hypot(mid[0] - point[0], mid[1] - point[1], mid[2] - point[2]);
        if (d < bestDistance) {
            best = edge;
            bestDistance = d;
        }
    }
    return captureEdgeRef(best);
}

const errors = (body: ParametricBodyNode) => body.featureItems().map((item) => item.error);

describe("flat-first parts", () => {
    test("a sketch profile becomes a flat blank carrying the sheet metal model", () => {
        const doc = newDoc();
        const body = sheet(doc, 300, 200);
        expect(errors(body)).toEqual([undefined]);
        expect(body.shape.value.volume()).toBeCloseTo(60000, 3);
        expect(sheetModelOf(body.shape.value)?.thickness).toBe(1);
    });

    test("bend lines from a sketch fold the blank; flatten restores it with bend marks", () => {
        const doc = newDoc();
        const body = sheet(doc, 300, 200);
        add(doc, body, {
            id: "bend",
            type: "smBend",
            lines: bendLines(doc, [100], 200),
            angle: 90,
            direction: "up",
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(body.shape.value.volume()).toBeCloseTo(60000, 2);
        const ba = bendAllowance(90, 1, 1, 0.5);
        // The larger region (right of the bend) stays down; the left one stands up.
        expect(body.shape.value.boundingBox().max.z).toBeCloseTo(2 + 100 - ba / 2, 2);

        add(doc, body, { id: "flat", type: "smFlatten" });
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        const box = body.shape.value.boundingBox();
        expect(box.max.x - box.min.x).toBeCloseTo(300, 3);
        expect(box.max.z - box.min.z).toBeCloseTo(1, 3);
    });

    test("a duct wrapper: four bends, a Pittsburgh pocket and its easy edge", () => {
        const doc = newDoc();
        const t = 0.7;
        const body = sheet(doc, 860, 400, t);
        add(doc, body, {
            id: "bends",
            type: "smBend",
            lines: bendLines(doc, [200, 430, 630, 830], 400),
            angle: 90,
            direction: "up",
        });
        expect(errors(body)).toEqual([undefined, undefined]);

        // Pick the free end edges on the FORMED part, as a user clicks them: wherever the
        // folding carried the blank's x = 0 and x = 860 edges.
        const leftEnd = edgeNear(body, formedImage(body, [0, 0], [0, 400]));
        add(doc, body, {
            id: "pocket",
            type: "smEdge",
            kind: "pittsburgh",
            edges: [leftEnd],
            direction: "up",
            length: 7.94,
            height: 9.5,
        });
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        expect(body.shape.value.boundingBox().max.z).toBeGreaterThan(100);
        expect(sheetModelOf(body.shape.value)?.flanges.map((flange) => flange.kind)).toEqual(["pittsburgh"]);

        const rightEnd = edgeNear(body, formedImage(body, [860, 0], [860, 400]));
        add(doc, body, {
            id: "easy",
            type: "smEdge",
            kind: "easyEdge",
            edges: [rightEnd],
            direction: "up",
            length: 6.35,
        });
        const items = body.featureItems();
        expect(items[3].error).toBeUndefined();
        expect(items[3].warning).toBeUndefined();
        expect(sheetModelOf(body.shape.value)?.flanges.map((flange) => flange.kind)).toEqual([
            "pittsburgh",
            "easyEdge",
        ]);

        // An easy edge deeper than the pocket is flagged.
        Transaction.execute(doc, "deep", () => body.setFeatureParameter("easy", "length", 9));
        expect(body.featureItems()[3].warning).toMatch(/deeper than the Pittsburgh pocket/);

        // A thicker sheet rebuilds the whole chain; the picked edges re-match.
        Transaction.execute(doc, "thicker", () => body.setFeatureParameter("base", "thickness", 1));
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined]);
        doc.history.undo();
        expect(sheetModelOf(body.shape.value)?.thickness).toBe(t);
    });

    test("an edge treatment on a non-outline edge is rejected", () => {
        const doc = newDoc();
        const body = sheet(doc, 100, 50);
        // A vertical (thickness) edge of the plate is not an outline edge.
        const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
        const vertical = edges.find((edge) => Math.abs(edge.length() - 1) < 1e-9)!;
        add(doc, body, {
            id: "hem",
            type: "smEdge",
            kind: "hem",
            edges: [captureEdgeRef(vertical)],
            direction: "up",
            length: 10,
        });
        expect(body.featureItems()[1].error).toMatch(/not a straight outline edge/);
    });
});

describe("round duct", () => {
    const circumference = 2 * Math.PI * 100.5;

    test("roll, crimp and ring bead", () => {
        const doc = newDoc();
        const body = sheet(doc, circumference, 500);
        add(doc, body, { id: "roll", type: "smRoll", axis: "v", radius: 0, direction: "up" });
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(body.shape.value.volume()).toBeCloseTo(Math.PI * (101 ** 2 - 100 ** 2) * 500, 0);

        add(doc, body, { id: "crimp", type: "smCrimp", end: "end", length: 38, depth: 1.5, count: 36 });
        add(doc, body, {
            id: "bead",
            type: "smBead",
            offset: 60,
            from: "end",
            width: 8,
            height: 3,
            direction: "out",
        });
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined]);
        const box = body.shape.value.boundingBox();
        expect(box.max.z - box.min.z).toBeGreaterThan(202 + 2);

        add(doc, body, { id: "flat", type: "smFlatten" });
        const flat = body.shape.value.boundingBox();
        expect(flat.max.x - flat.min.x).toBeCloseTo(circumference, 3);
        expect(flat.max.y - flat.min.y).toBeCloseTo(500, 3);
    });

    test("a crimp before rolling is rejected", () => {
        const doc = newDoc();
        const body = sheet(doc, 100, 100);
        add(doc, body, { id: "crimp", type: "smCrimp", end: "end", length: 30, depth: 1.5, count: 24 });
        expect(body.featureItems()[1].error).toMatch(/needs a rolled sheet/);
    });

    test("a sheet metal feature without a sheet metal part before it fails clearly", () => {
        const doc = newDoc();
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "roll", type: "smRoll", axis: "v", radius: 0, direction: "up" }],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(false);
        expect(body.featureItems()[0].error).toMatch(/sheet metal part/);
    });
});
