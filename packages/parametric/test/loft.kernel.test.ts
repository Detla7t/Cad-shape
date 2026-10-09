// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IFace, Plane, ShapeTypes, Transaction, XYZ } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import type { LoftFeatureData } from "../src/features/feature";
import { featureHandler } from "../src/features/feature";
import { buildLoft } from "../src/features/loft";
import { captureProfileRef } from "../src/features/profileRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import type { SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
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

const circle = (r: number): SketchData => ({
    entities: [{ id: 1, type: "circle", params: [0, 0, r] }],
    constraints: [],
});

const square = (half: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [-half, -half, half, -half] },
        { id: 2, type: "line", params: [half, -half, half, half] },
        { id: 3, type: "line", params: [half, half, -half, half] },
        { id: 4, type: "line", params: [-half, half, -half, -half] },
    ],
    constraints: [],
});

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

/** The Onshape trial fixture: a Ø40 circle on Top and a 30 mm square on a plane 50 mm above. */
function circleToSquare(doc: TestDocument) {
    const bottom = new SketchNode({ document: doc, plane: Plane.XY, data: circle(20) });
    const top = new SketchNode({
        document: doc,
        plane: new Plane({ origin: new XYZ({ x: 0, y: 0, z: 50 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
        data: square(15),
    });
    doc.modelManager.addNode(bottom);
    doc.modelManager.addNode(top);
    return { bottom, top };
}

function firstFace(sketch: SketchNode): IFace {
    const range = sketch.mesh.faces?.range.find((x) => x.shape.shapeType === ShapeTypes.face);
    expect(range).not.toBeUndefined();
    return range!.shape as unknown as IFace;
}

function loftFeature(
    bottom: SketchNode,
    top: SketchNode,
    extra: Partial<LoftFeatureData> = {},
): LoftFeatureData {
    return {
        id: "l1",
        type: "loft",
        sections: [
            { sketchId: bottom.id, profile: captureProfileRef(firstFace(bottom)) },
            { sketchId: top.id, profile: captureProfileRef(firstFace(top)) },
        ],
        ...extra,
    };
}

describe("loft feature", () => {
    test("lofts a circle to a square into a solid whose volume lies between the two prisms", () => {
        const doc = newDoc();
        const { bottom, top } = circleToSquare(doc);
        const body = new ParametricBodyNode({ document: doc, features: [loftFeature(bottom, top)] });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        const volume = body.shape.value.volume();
        // circle area 1256.6, square area 900: a 50 mm loft between them
        expect(volume).toBeGreaterThan(900 * 50);
        expect(volume).toBeLessThan(1256.7 * 50);
        expect(body.shape.value.findSubShapes(ShapeTypes.solid)).toHaveLength(1);
        expect(featureHandler("loft")?.nodeIds(loftFeature(bottom, top))).toEqual([bottom.id, top.id]);
    });

    test("a surface loft has no solid, and a ruled loft differs from the smooth one", () => {
        const doc = newDoc();
        const { bottom, top } = circleToSquare(doc);
        const surface = buildLoft(doc, { ...loftFeature(bottom, top), solid: false });
        expect(surface.isOk).toBe(true);
        expect(surface.value.findSubShapes(ShapeTypes.solid)).toHaveLength(0);
        expect(surface.value.findSubShapes(ShapeTypes.face).length).toBeGreaterThan(0);
        // through three sections a smooth skin bulges where a ruled one stays straight
        const middle = new SketchNode({
            document: doc,
            plane: new Plane({ origin: new XYZ({ x: 0, y: 0, z: 25 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
            data: circle(30),
        });
        doc.modelManager.addNode(middle);
        const three = loftFeature(bottom, top);
        const sections = [three.sections[0], { sketchId: middle.id }, three.sections[1]];
        const smooth = buildLoft(doc, { sections });
        const ruled = buildLoft(doc, { sections, ruled: true });
        expect(smooth.isOk && ruled.isOk).toBe(true);
        expect(smooth.value.volume()).toBeGreaterThan(ruled.value.volume() + 1);
    });

    test("editing a section sketch rebuilds the loft", () => {
        const doc = newDoc();
        const { bottom, top } = circleToSquare(doc);
        const body = new ParametricBodyNode({ document: doc, features: [loftFeature(bottom, top)] });
        doc.modelManager.addNode(body);
        const before = body.shape.value.volume();
        Transaction.execute(doc, "grow circle", () => bottom.setDataEmitShapeChanged(circle(25)));
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeGreaterThan(before);
    });

    test("a loft joined into a body fuses with it", () => {
        const doc = newDoc();
        const { bottom, top } = circleToSquare(doc);
        const base = new SketchNode({
            document: doc,
            plane: new Plane({ origin: new XYZ({ x: 0, y: 0, z: -10 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
            data: square(30),
        });
        doc.modelManager.addNode(base);
        const body = new ParametricBodyNode({
            document: doc,
            features: [
                { id: "e1", type: "extrude", sketchId: base.id, depth: 10 },
                loftFeature(bottom, top, { operation: "fuse" }),
            ],
        });
        doc.modelManager.addNode(body);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.findSubShapes(ShapeTypes.solid)).toHaveLength(1);
        expect(body.shape.value.volume()).toBeGreaterThan(60 * 60 * 10 + 900 * 50);
    });

    test("fewer than two sections or a missing sketch is a feature error", () => {
        const doc = newDoc();
        const { bottom, top } = circleToSquare(doc);
        const one = buildLoft(doc, { sections: [{ sketchId: bottom.id }] });
        expect(one.isOk).toBe(false);
        const missing = buildLoft(doc, { sections: [{ sketchId: bottom.id }, { sketchId: "gone" }] });
        expect(missing.isOk).toBe(false);
        expect(missing.error).toMatch(/not found/);
        const whole = buildLoft(doc, { sections: [{ sketchId: bottom.id }, { sketchId: top.id }] });
        expect(whole.isOk).toBe(true);
    });

    test("the handler's parameters round-trip through setParameter", () => {
        const handler = featureHandler("loft")!;
        const feature: LoftFeatureData = { id: "l", type: "loft", sections: [] };
        let next = handler.setParameter(feature, "solid", false) as LoftFeatureData;
        next = handler.setParameter(next, "ruled", true) as LoftFeatureData;
        next = handler.setParameter(next, "continuity", "c2") as LoftFeatureData;
        next = handler.setParameter(next, "operation", "cut") as LoftFeatureData;
        expect(next).toEqual({ ...feature, solid: false, ruled: true, continuity: "c2", operation: "cut" });
        next = handler.setParameter(next, "operation", "new") as LoftFeatureData;
        expect(next.operation).toBeUndefined();
        const values = Object.fromEntries(handler.parameters(next).map((p) => [p.key, p.value]));
        expect(values).toEqual({
            sections: "0 profiles",
            solid: false,
            operation: "new",
            ruled: true,
            continuity: "c2",
        });
    });
});
