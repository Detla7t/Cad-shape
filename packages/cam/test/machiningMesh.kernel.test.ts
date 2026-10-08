// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Matrix4 } from "@chili3d/core";
import { MockShape } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { shapesMesh } from "../src/context/setupGeometry";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../wasm/lib/chili-wasm.wasm")),
    });
    rs.stubGlobal("shapeFactory", new ShapeFactory());
});

afterAll(() => {
    rs.unstubAllGlobals();
});

test.each([10, 100])("machining mesh holds absolute precision for a radius %s sphere", (radius) => {
    const result = shapeFactory.sphere({ x: 0, y: 0, z: 0 }, radius);
    expect(result.isOk).toBe(true);
    const shape = result.value;
    try {
        const display = shape.mesh.faces;
        expect(display).toBeDefined();
        const deflection = 0.02;
        const mesh = shapesMesh([shape], deflection);
        expect(mesh.indices.length).toBeGreaterThan(0);
        let deviation = 0;
        for (let i = 0; i < mesh.indices.length; i += 3) {
            const a = mesh.indices[i] * 3;
            const b = mesh.indices[i + 1] * 3;
            const c = mesh.indices[i + 2] * 3;
            // Check vertices, edge midpoints and the face centroid against the
            // analytic sphere, independently of the mesher and toolpath algorithm.
            for (const weights of [
                [1, 0, 0],
                [0.5, 0.5, 0],
                [0, 0.5, 0.5],
                [0.5, 0, 0.5],
                [1 / 3, 1 / 3, 1 / 3],
            ]) {
                const point = [0, 1, 2].map(
                    (axis) =>
                        mesh.positions[a + axis] * weights[0] +
                        mesh.positions[b + axis] * weights[1] +
                        mesh.positions[c + axis] * weights[2],
                );
                deviation = Math.max(deviation, Math.abs(radius - Math.hypot(...point)));
            }
        }
        expect(deviation).toBeLessThanOrEqual(deflection);
        expect(shape.mesh.faces).toBe(display);
    } finally {
        shape.dispose();
    }
});

test("machining tessellation preserves placed geometry and disposes its native ranges", () => {
    const result = shapeFactory.sphere({ x: 0, y: 0, z: 0 }, 10);
    expect(result.isOk).toBe(true);
    const shape = result.value.transformedMul(Matrix4.fromTranslation(20, 0, 0));
    try {
        const mesh = shapesMesh([shape], 0.01);
        const xs = Array.from(mesh.positions).filter((_, index) => index % 3 === 0);
        expect(Math.min(...xs)).toBeCloseTo(10, 1);
        expect(Math.max(...xs)).toBeCloseTo(30, 1);
        const precision = shape.tessellate?.(0.01);
        expect(precision?.faces?.range.length).toBeGreaterThan(0);
        const range = precision?.faces?.range[0];
        if (range === undefined) throw new Error("No face range");
        const dispose = rs.spyOn(range.shape, "dispose");
        shape.dispose();
        expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
        shape.dispose();
        result.value.dispose();
    }
});

test.each([
    0,
    -0.01,
    Number.NaN,
    Number.POSITIVE_INFINITY,
])("rejects invalid machining deflection %s", (deflection) => {
    expect(() => shapesMesh([], deflection)).toThrow("finite positive length");
});

test("kernels without a precision API cannot silently supply a display mesh", () => {
    expect(() => shapesMesh([new MockShape()], 0.01)).toThrow("does not support machining tessellation");
});
