// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IShape, Plane, XYZ } from "@chili3d/core";
import { type DrawingEntity, writeDxf } from "@chili3d/parametric";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { importDxf } from "../src/cad/dxfToDrawing";
import { projectionDrawing, projectView } from "../src/cad/projection";

/** Multiview drawings with the real kernel's hidden-line removal. */

const here = path.dirname(fileURLToPath(import.meta.url));
let factory: ShapeFactory;

beforeAll(async () => {
    await initWasm({ wasmBinary: readFileSync(path.resolve(here, "../../wasm/lib/chili-wasm.wasm")) });
    factory = new ShapeFactory();
});

function extent(entities: readonly DrawingEntity[]) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const entity of entities) {
        if (entity.kind === "line") {
            xs.push(entity.a[0], entity.b[0]);
            ys.push(entity.a[1], entity.b[1]);
        } else if (entity.kind === "circle" || entity.kind === "arc") {
            xs.push(entity.center[0] - entity.radius, entity.center[0] + entity.radius);
            ys.push(entity.center[1] - entity.radius, entity.center[1] + entity.radius);
        }
    }
    const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
    return {
        width: round(Math.max(...xs) - Math.min(...xs)),
        height: round(Math.max(...ys) - Math.min(...ys)),
    };
}

describe("projection drawing", () => {
    test("a 10×20×30 box: top view 10×20, front 10×30, right 20×30, four visible edges each", () => {
        const box = factory.box(Plane.XY, 10, 20, 30).value as IShape;
        const top = projectView([box], "top");
        const front = projectView([box], "front");
        const right = projectView([box], "right");
        expect(extent(top)).toEqual({ width: 10, height: 20 });
        expect(extent(front)).toEqual({ width: 10, height: 30 });
        expect(extent(right)).toEqual({ width: 20, height: 30 });
        // The back face's edges project onto the front face's: drawn once, as visible.
        expect([top, front, right].map((view) => view.length)).toEqual([4, 4, 4]);
        expect(top.every((entity) => entity.kind === "line" && entity.layer === "VISIBLE")).toBe(true);
    });

    test("a hole through a plate: one circle from above; from the front the outline and the hole's seam", () => {
        const plate = factory.box(Plane.XY, 40, 40, 10).value as IShape;
        const drill = factory.cylinder(XYZ.unitZ, new XYZ(20, 20, -1), 5, 12).value as IShape;
        const part = factory.booleanCut([plate], [drill]).value;
        const top = projectView([part], "top");
        expect(top.filter((entity) => entity.kind === "circle")).toHaveLength(1);
        expect(extent(top)).toEqual({ width: 40, height: 40 });
        const front = projectView([part], "front");
        // The hole's top and bottom circles, seen edge-on, lie on the plate's edges: not repeated.
        const lines = front.filter(
            (entity): entity is Extract<DrawingEntity, { kind: "line" }> => entity.kind === "line",
        );
        expect(lines).toHaveLength(front.length);
        const vertical = lines
            .filter((line) => Math.abs(line.a[0] - line.b[0]) < 1e-9)
            .map((line) => Math.round(line.a[0]));
        expect(vertical.sort((a, b) => a - b)).toEqual([0, 25, 40]);
        expect(lines.filter((line) => Math.abs(line.a[1] - line.b[1]) < 1e-9)).toHaveLength(2);
    });

    test("a cylinder seen from the top is an exact circle", () => {
        const cylinder = factory.cylinder(XYZ.unitZ, new XYZ(5, 5, 0), 7, 12).value as IShape;
        const top = projectView([cylinder], "top");
        const circles = top.filter(
            (entity): entity is Extract<DrawingEntity, { kind: "circle" }> => entity.kind === "circle",
        );
        expect(circles).toHaveLength(1);
        expect(circles[0].radius).toBeCloseTo(7, 9);
        expect(circles[0].center[0]).toBeCloseTo(5, 9);
        expect(circles[0].center[1]).toBeCloseTo(5, 9);
    });

    test("third-angle layout: the top view above the front view, the right view to its right", () => {
        const box = factory.box(Plane.XY, 10, 20, 30).value as IShape;
        const drawing = projectionDrawing([box], { gap: 5, iso: false });
        expect(drawing.entities).toHaveLength(12);
        expect(drawing.layers.map((layer) => layer.name)).toEqual(["VISIBLE"]);
        expect(extent(drawing.entities)).toEqual({ width: 10 + 5 + 20, height: 30 + 5 + 20 });
        const iso = projectionDrawing([box], { gap: 5 });
        expect(iso.entities.length).toBeGreaterThan(12);
        // The drawing writes as DXF and reads back.
        expect(importDxf(writeDxf(drawing)).value.drawing.entities).toHaveLength(12);
    });

    test("first-angle layout puts the top view below and the right view to the left", () => {
        const box = factory.box(Plane.XY, 10, 20, 30).value as IShape;
        const third = projectionDrawing([box], { gap: 5, iso: false, angle: "third" });
        const first = projectionDrawing([box], { gap: 5, iso: false, angle: "first" });
        const minY = (entities: readonly DrawingEntity[]) =>
            Math.min(...entities.flatMap((e) => (e.kind === "line" ? [e.a[1], e.b[1]] : [])));
        const minX = (entities: readonly DrawingEntity[]) =>
            Math.min(...entities.flatMap((e) => (e.kind === "line" ? [e.a[0], e.b[0]] : [])));
        expect(minY(first.entities)).toBeLessThan(minY(third.entities));
        expect(minX(first.entities)).toBeLessThan(minX(third.entities));
    });
});
