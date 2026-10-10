// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Config, Plane } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
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

/** A circle and a separate line: one region, one center, two line ends. */
const DATA: SketchData = {
    entities: [
        { id: 1, type: "circle", params: [0, 0, 10] },
        { id: 2, type: "line", params: [20, 0, 30, 5] },
    ],
    constraints: [],
};

function sketch(data: SketchData = DATA) {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const node = new SketchNode({ document: doc, plane: Plane.XY, data });
    doc.modelManager.addNode(node);
    return node;
}

const points = (node: SketchNode) => {
    const position = node.mesh.vertexs?.position ?? new Float32Array();
    const out: [number, number, number][] = [];
    for (let i = 0; i + 2 < position.length; i += 3)
        out.push([position[i], position[i + 1], position[i + 2]]);
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
};

describe("inactive sketch display", () => {
    const original = Config.instance.graphics;
    afterEach(() => {
        Config.instance.graphics = original;
    });

    test("closed regions are a translucent fill in the inactive colour, with entity points", () => {
        const node = sketch();
        const mesh = node.mesh;
        expect(mesh.faces).not.toBeUndefined();
        expect(mesh.faces!.opacity).toBeCloseTo(0.12);
        expect(mesh.faces!.color).toBe(0x999999);
        expect(mesh.vertexs!.size).toBe(4);
        expect(points(node)).toEqual([
            [0, 0, 0],
            [20, 0, 0],
            [30, 5, 0],
        ]);
        // every point takes the inactive colour
        const color = mesh.vertexs!.color as number[];
        expect(color).toHaveLength(9);
        expect(color.slice(0, 3).map((c) => Math.round(c * 255))).toEqual([0x99, 0x99, 0x99]);
    });

    test("each entity point carries a kernel vertex in its range, so it picks and measures on its own", () => {
        const node = sketch();
        const vertexs = node.mesh.vertexs!;
        expect(vertexs.range).toHaveLength(3);
        vertexs.range.forEach((range, index) => {
            expect(range.start).toBe(index);
            expect(range.count).toBe(1);
            const point = (
                range.shape as unknown as { point(): { x: number; y: number; z: number } }
            ).point();
            expect([point.x, point.y, point.z]).toEqual([
                vertexs.position[index * 3],
                vertexs.position[index * 3 + 1],
                vertexs.position[index * 3 + 2],
            ]);
            expect((range.shape as unknown as { parent: unknown }).parent).toBe(range.shape);
        });
        // the circle's centre is the first point: a centre is a pick target like a line's end
        const centre = (vertexs.range[0].shape as unknown as { point(): { x: number; y: number } }).point();
        expect([centre.x, centre.y]).toEqual([0, 0]);
        // the vertices are cached by position: an unchanged point keeps its kernel vertex
        const before = vertexs.range.map((range) => range.shape);
        node.setShowProfileFaces(false);
        node.setShowProfileFaces(true);
        expect(node.mesh.vertexs!.range.map((range) => range.shape)).toEqual(before);
    });

    test("the graphics preferences drive the fill opacity and point size, and 0 hides them", () => {
        const node = sketch();
        Config.instance.graphics = { ...original, inactiveRegionOpacity: 40, inactivePointSize: 6 };
        node.setShowProfileFaces(false);
        node.setShowProfileFaces(true);
        expect(node.mesh.faces!.opacity).toBeCloseTo(0.4);
        expect(node.mesh.vertexs!.size).toBe(6);
        Config.instance.graphics = { ...original, inactiveRegionOpacity: 0, inactivePointSize: 0 };
        node.setShowProfileFaces(false);
        node.setShowProfileFaces(true);
        expect(node.mesh.faces).toBeUndefined();
        expect(node.mesh.vertexs).toBeUndefined();
        expect(node.mesh.edges).not.toBeUndefined();
    });

    test("styled sketches keep the fill and points, and hidden layers contribute no points", () => {
        const node = sketch({
            ...DATA,
            entities: [
                { ...DATA.entities[0], color: "#ff0000" },
                { ...DATA.entities[1], layer: "hidden" },
            ],
            layers: [
                { id: "0", name: "0", color: "#4a9eff" },
                { id: "hidden", name: "hidden", color: "#00ff00", visible: false },
            ],
        });
        const mesh = node.mesh;
        expect(mesh.faces!.opacity).toBeCloseTo(0.12);
        expect(points(node)).toEqual([[0, 0, 0]]);
        const color = mesh.vertexs!.color as number[];
        expect(color.map((c) => Math.round(c * 255))).toEqual([255, 0, 0]);
    });
});
