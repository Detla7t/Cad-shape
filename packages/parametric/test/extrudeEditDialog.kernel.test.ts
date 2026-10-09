// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AsyncController, type IPicker, Plane, XYZ } from "@chili3d/core";
import { createMockApplication, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { closestAlong, ExtrudeEditArrow, extrudeFrame } from "../src/commands/extrudeEditArrow";
import type { ExtrudeFeatureData } from "../src/features/feature";
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

/** A 40 × 30 mm rectangle on a plane 5 mm above XY, extruded 20 mm. */
function tray() {
    const doc = new TestDocument({ application: createMockApplication() });
    const sketch = new SketchNode({
        document: doc,
        plane: new Plane({ origin: new XYZ(0, 0, 5), normal: XYZ.unitZ, xvec: XYZ.unitX }),
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
    const extrude = () => body.features[0] as ExtrudeFeatureData;
    const parameter = (key: string) => body.featureItems()[0].parameters.find((p) => p.key === key);
    const zRange = () => {
        expect(body.shape.isOk).toBe(true);
        const box = body.shape.value.boundingBox();
        return [box.min.z, box.max.z];
    };
    return { doc, body, sketch, extrude, parameter, zRange };
}

test("the dialog shows a positive depth and Onshape's opposite-direction toggle", () => {
    const { body, extrude, parameter, zRange } = tray();
    expect(parameter("depth")?.value).toBe(20);
    expect(parameter("oppositeDirection")).toMatchObject({ value: false, flip: true });
    expect(zRange()).toEqual([5, 25]);

    body.setFeatureParameter("e", "oppositeDirection", true);
    expect(extrude().depth).toBe(-20);
    expect(parameter("depth")?.value).toBe(20);
    expect(parameter("oppositeDirection")?.value).toBe(true);
    expect(zRange()[0]).toBeCloseTo(-15, 9);

    // A new depth keeps the chosen direction.
    body.setFeatureParameter("e", "depth", 8);
    expect(extrude().depth).toBe(-8);
    expect(zRange()[0]).toBeCloseTo(-3, 9);

    body.setFeatureParameter("e", "oppositeDirection", false);
    expect(extrude().depth).toBe(8);
});

test("an expression depth flips as -(expression) and back", () => {
    const { body, extrude, parameter } = tray();
    body.setFeatureParameter("e", "depth", "10 + 2");
    body.setFeatureParameter("e", "oppositeDirection", true);
    expect(extrude().depth).toBe("-(10 + 2)");
    expect(parameter("depth")?.value).toBe("10 + 2");
    expect(parameter("oppositeDirection")?.value).toBe(true);
    body.setFeatureParameter("e", "oppositeDirection", false);
    expect(extrude().depth).toBe("10 + 2");
});

test("the arrow frame sits on the sketch plane at the middle of the profile, along its normal", () => {
    const { body, extrude } = tray();
    const frame = extrudeFrame(body, extrude());
    expect(frame).toBeDefined();
    expect(frame!.normal.isEqualTo(XYZ.unitZ)).toBe(true);
    expect(frame!.anchor.x).toBeCloseTo(20, 9);
    expect(frame!.anchor.y).toBeCloseTo(15, 9);
    expect(frame!.anchor.z).toBeCloseTo(5, 9);
});

test("a drag ray lands on the extrude axis where it passes closest", () => {
    // Axis: the Z line through (20, 15, 0); a ray along +X at height 12 crosses it at t = 12.
    const t = closestAlong(new XYZ(20, 15, 0), XYZ.unitZ, new XYZ(-100, 15, 12), XYZ.unitX);
    expect(t).toBeCloseTo(12, 9);
    expect(closestAlong(XYZ.zero, XYZ.unitZ, new XYZ(1, 0, 0), XYZ.unitZ)).toBeUndefined();
});

test("the edit arrow points the way the extrude goes, from its end face", () => {
    const { body, doc } = tray();
    const view = {
        dom: undefined,
        cameraController: { onPropertyChanged: () => {}, removePropertyChanged: () => {} },
        direction: () => new XYZ(-1, -1, -1).normalize()!,
        up: () => XYZ.unitZ,
        worldToScreen: (point: XYZ) => ({ x: point.x * 10, y: point.y * 10, distanceTo: () => 0 }),
    } as never;
    const displayed: number[] = [];
    const context = doc.visual.context as unknown as {
        displayMesh: (...args: unknown[]) => number;
        removeMesh: (id: number) => void;
    };
    context.displayMesh = () => {
        displayed.push(displayed.length);
        return displayed.length;
    };
    context.removeMesh = () => {};
    const arrow = new ExtrudeEditArrow(body, "e", view);
    try {
        const up = arrow.segment();
        expect(up?.start.z).toBeCloseTo(25, 9);
        expect(up!.end.z).toBeGreaterThan(up!.start.z);
        expect(displayed.length).toBeGreaterThan(0);

        body.setFeatureParameter("e", "oppositeDirection", true);
        const down = arrow.segment();
        expect(down?.start.z).toBeCloseTo(-15, 9);
        expect(down!.end.z).toBeLessThan(down!.start.z);
    } finally {
        arrow.dispose();
    }
});

test("a depth edit made while the regions box picks survives the pick", async () => {
    const { body, doc, extrude } = tray();
    // A pick that stays open until the dialog's ✓ confirms it, as a real one does.
    doc.picker = {
        pickShape: (_prompt: unknown, controller: AsyncController) =>
            new Promise((resolve) => {
                controller.onCompleted(() => resolve([]));
                controller.onCancelled(() => resolve([]));
            }),
        pickNode: () => Promise.resolve([]),
        pickAsync: () => Promise.resolve(),
    } as unknown as IPicker;
    const session = await body.beginFeatureEdit("e");
    expect(session.isOk).toBe(true);
    const picking = body.reselectShapes("e", "profiles");
    body.setFeatureParameter("e", "depth", 12);
    await session.value.apply();
    await picking;
    expect(extrude().depth).toBe(12);
});
