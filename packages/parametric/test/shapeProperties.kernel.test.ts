// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { evaluateShapeProperties, type IFace, Plane, ShapeTypes } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import "../src/measurement/shapeProperties";

let factory: ShapeFactory;
beforeAll(async () => {
    await initWasm({ wasmBinary: readFileSync("packages/wasm/lib/chili-wasm.wasm") });
    factory = new ShapeFactory();
    rs.stubGlobal("shapeFactory", factory);
});
afterAll(() => {
    rs.unstubAllGlobals();
});

test("solid mass properties integrate volume, centroid and moments without consuming the shape", () => {
    const box = factory.box(Plane.XY, 10, 20, 30);
    expect(box.isOk).toBe(true);
    try {
        const result = evaluateShapeProperties([box.value]);
        expect(result.isOk).toBe(true);
        expect(result.value.dimension).toBe(3);
        expect(result.value.measure).toBeCloseTo(6000, 6);
        for (const [i, value] of result.value.centroid.entries())
            expect(value).toBeCloseTo([5, 10, 15][i], 6);
        expect(result.value.inertia[0][0]).toBeCloseTo(650000, 4);
        expect(result.value.inertia[0][1]).toBeCloseTo(0, 5);
        expect(box.value.volume()).toBeCloseTo(6000, 6);
    } finally {
        box.value.dispose();
    }
});
test("a selected planar face reports section area and centroidal area moments", () => {
    const box = factory.box(Plane.XY, 10, 20, 30);
    expect(box.isOk).toBe(true);
    const faces = box.value.findSubShapes(ShapeTypes.face) as IFace[];
    const face = faces.find((face) => Math.abs(face.normal(0, 0)[1].z) > 0.99);
    expect(face).not.toBeUndefined();
    try {
        const result = evaluateShapeProperties([face!]);
        expect(result.isOk).toBe(true);
        expect(result.value.dimension).toBe(2);
        expect(result.value.measure).toBeCloseTo(200, 6);
        expect(result.value.inertia[0][0]).toBeCloseTo((200 * 400) / 12, 5);
        expect(result.value.inertia[1][1]).toBeCloseTo((200 * 100) / 12, 5);
    } finally {
        for (const face of faces) face.dispose();
        box.value.dispose();
    }
});
