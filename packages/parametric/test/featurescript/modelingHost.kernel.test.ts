// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, Plane, XYZ } from "@chili3d/core";
import { fsModelingHost } from "@chili3d/featurescript";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { analyzeSketchLoops, PARAMETRIC_MODELING_HOST } from "../../src/featurescript/modelingHost";

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

const line = (x1: number, y1: number, x2: number, y2: number): IEdge =>
    shapeFactory.line(new XYZ(x1, y1, 0), new XYZ(x2, y2, 0)).value;

const square = (size: number): IEdge[] => [
    line(0, 0, size, 0),
    line(size, 0, size, size),
    line(size, size, 0, size),
    line(0, size, 0, 0),
];

test("loading parametric's FeatureScript glue installs its modeling host", () => {
    expect(fsModelingHost()).toBe(PARAMETRIC_MODELING_HOST);
});

test("sketch loops group connected edges and nest a circle inside a square", () => {
    const circle = shapeFactory.circle(XYZ.unitZ, new XYZ(5, 5, 0), 2).value;
    const analysis = analyzeSketchLoops([...square(10), circle], Plane.XY);
    expect(analysis).toBeDefined();
    const groups = analysis!.groups;
    expect(groups.map((group) => group.length).sort()).toEqual([1, 4]);
    const outer = groups.findIndex((group) => group.length === 4);
    const inner = groups.findIndex((group) => group.length === 1);
    expect(analysis!.contains(outer, inner)).toBe(true);
    expect(analysis!.contains(inner, outer)).toBe(false);
});

test("crossing edges are left to the kernel's splitter", () => {
    expect(analyzeSketchLoops([line(0, 0, 10, 10), line(0, 10, 10, 0)], Plane.XY)).toBeUndefined();
});
