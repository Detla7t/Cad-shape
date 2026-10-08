// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Plane, ShapeTypes } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { sketchProfiles } from "../../src/features/profileBuilder";
import { collectEdges, needsKernelSplit } from "../../src/features/profileGeometry";
import { roundCorner } from "../../src/sketch/commands/sketchTools";
import type { SketchData } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import { offsetSketchEntities } from "../../src/sketch/sketchOffset";
import { appendEntity } from "../../src/sketch/sketchOperations";
import { appendText } from "../../src/sketch/textGeometry";
import "./setup";

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
});
test("Bezier outlines create exact closed kernel profiles that can extrude", () => {
    const data: SketchData = { entities: [], constraints: [] };
    appendText(data, "BO", 20, [0, 0]);
    const doc = new TestDocument(),
        node = new SketchNode({ document: doc, plane: Plane.XY });
    node.setDataEmitShapeChanged(data);
    expect(node.shape.isOk).toBe(true);
    expect(node.shape.value.findSubShapes(ShapeTypes.edge)).toHaveLength(data.entities.length);
    expect(needsKernelSplit(collectEdges(node.shape.value))).toBe(false);
    const profiles = sketchProfiles(node);
    expect(profiles.isOk).toBe(true);
    expect(profiles.value.outer.length).toBe(2);
    expect(profiles.value.inner).toHaveLength(3);
    const areas = profiles.value.outer.map((face) => face.area());
    expect(areas.every((area) => area > 10)).toBe(true);
});
test("fillet and chamfer preserve a rectangle's kernel profile", () => {
    for (const fillet of [true, false]) {
        const data: SketchData = { entities: [], constraints: [] };
        const ids = [
            [0, 0, 40, 0],
            [40, 0, 40, 30],
            [40, 30, 0, 30],
            [0, 30, 0, 0],
        ].map((p) => appendEntity(data, "line", p));
        roundCorner(data, ids[0], ids[1], 5, fillet);
        const node = new SketchNode({ document: new TestDocument(), plane: Plane.XY });
        node.setDataEmitShapeChanged(data);
        const profiles = sketchProfiles(node);
        expect(profiles.isOk).toBe(true);
        expect(profiles.value.outer).toHaveLength(1);
        expect(profiles.value.outer[0].area()).toBeCloseTo(
            fillet ? 1200 - 25 + (Math.PI * 25) / 4 : 1200 - 12.5,
            5,
        );
    }
});

test("offset a closed rectangle joins every corner into an extrudable loop", () => {
    const data: SketchData = { entities: [], constraints: [] };
    const ids = [
        [0, 0, 40, 0],
        [40, 0, 40, 30],
        [40, 30, 0, 30],
        [0, 30, 0, 0],
    ].map((p) => appendEntity(data, "line", p));
    offsetSketchEntities(data, ids, 5, Plane.XY);
    const node = new SketchNode({ document: new TestDocument(), plane: Plane.XY });
    node.setDataEmitShapeChanged({ ...data, entities: data.entities.filter((e) => !ids.includes(e.id)) });
    const profiles = sketchProfiles(node);
    expect(profiles.isOk).toBe(true);
    expect(profiles.value.outer).toHaveLength(1);
    expect(profiles.value.outer[0].area()).toBeCloseTo(50 * 40, 6);
});
