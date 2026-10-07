// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IShape, Plane, ShapeTypes } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { buildSheetMetal } from "../../src/sheetMetal/build";
import { bendAllowance, type Loop2, type SheetMetalModel, type V2 } from "../../src/sheetMetal/model";
import { treatmentElements } from "../../src/sheetMetal/treatments";

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

const rect = (w: number, h: number): Loop2 => {
    const p: V2[] = [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
    ];
    return p.map((a, i) => ({ kind: "line" as const, a, b: p[(i + 1) % 4] }));
};

function model(overrides: Partial<SheetMetalModel> = {}): SheetMetalModel {
    return {
        plane: Plane.XY,
        thickness: 1,
        radius: 1,
        kFactor: 0.5,
        blank: [rect(200, 100)],
        bends: [],
        flanges: [],
        crimps: [],
        beads: [],
        flat: false,
        ...overrides,
    };
}

function built(m: SheetMetalModel): IShape {
    const result = buildSheetMetal(m);
    expect(result.error).toBeUndefined();
    return result.value;
}

const solids = (shape: IShape) => shape.findSubShapes(ShapeTypes.solid).length;

describe("folding", () => {
    test("a flat blank is a plate", () => {
        const shape = built(model());
        expect(shape.volume()).toBeCloseTo(200 * 100, 6);
    });

    test("a 90° bend keeps the volume (neutral layer at mid thickness) and raises the far side", () => {
        const shape = built(model({ bends: [{ a: [120, 0], b: [120, 100], angle: 90, radius: 2 }] }));
        expect(solids(shape)).toBe(1);
        expect(shape.volume()).toBeCloseTo(200 * 100, 3);
        const box = shape.boundingBox();
        // The smaller (left) 120-wide facet is... the larger one stays: [0, 120 - BA/2] stays flat.
        const ba = bendAllowance(90, 2, 1, 0.5);
        expect(box.max.z).toBeCloseTo(1 + 2 + (200 - 120 - ba / 2), 3);
        expect(box.max.x).toBeCloseTo(120 - ba / 2 + 2 + 1, 3);
    });

    test("a duct wrapper folds into a closed rectangle (four 90° bends)", () => {
        const t = 1;
        const r = 1;
        const ba = bendAllowance(90, r, t, 0.5);
        // Sides of 100 and 60 (neutral lengths between bend centers), plus the free ends.
        const lines = [50, 50 + ba / 2 + 60 + ba / 2, 0, 0];
        lines[2] = lines[1] + ba / 2 + 100 + ba / 2;
        lines[3] = lines[2] + ba / 2 + 60 + ba / 2;
        const width = lines[3] + ba / 2 + 50;
        const shape = built(
            model({
                blank: [rect(width, 300)],
                bends: lines.map((u) => ({ a: [u, 0] as V2, b: [u, 300] as V2, angle: 90, radius: r })),
            }),
        );
        expect(shape.volume()).toBeCloseTo(width * 300 * t, 2);
    });

    test("crossing bend lines are rejected", () => {
        const result = buildSheetMetal(
            model({
                bends: [
                    { a: [100, 0], b: [100, 100], angle: 90, radius: 1 },
                    { a: [0, 50], b: [200, 50], angle: 90, radius: 1 },
                ],
            }),
        );
        expect(result.error).toMatch(/must not cross/);
    });
});

describe("edge treatments", () => {
    const edge = { a: [200, 0] as V2, b: [200, 100] as V2 };

    test.each([
        "easyEdge",
        "pittsburgh",
        "hem",
        "flange",
    ] as const)("%s keeps the developed volume", (kind) => {
        const elements = treatmentElements({
            kind,
            direction: 1,
            length: 8,
            height: 9.5,
            clearance: 0.5,
            angle: 45,
            radius: 1,
            thickness: 1,
        });
        const shape = built(model({ flanges: [{ kind, ...edge, elements }] }));
        const flat = built(model({ flanges: [{ kind, ...edge, elements }], flat: true }));
        expect(solids(shape)).toBe(1);
        // Forming does not change the material: folded and flat volumes agree.
        expect(shape.volume()).toBeCloseTo(
            flat.findSubShapes(ShapeTypes.solid).reduce((v, s) => v + s.volume(), 0),
            2,
        );
    });

    test("an easy edge stands up 90° at the edge", () => {
        const elements = treatmentElements({
            kind: "easyEdge",
            direction: 1,
            length: 6.35,
            height: 0,
            clearance: 0,
            angle: 90,
            radius: 1,
            thickness: 1,
        });
        const box = built(model({ flanges: [{ kind: "easyEdge", ...edge, elements }] })).boundingBox();
        expect(box.max.z).toBeCloseTo(1 + 1 + 6.35, 3);
        expect(box.max.x).toBeCloseTo(200 + 1 + 1, 3);
    });

    test("the flat pattern marks bend lines", () => {
        const elements = treatmentElements({
            kind: "easyEdge",
            direction: 1,
            length: 6,
            height: 0,
            clearance: 0,
            angle: 90,
            radius: 1,
            thickness: 1,
        });
        const flat = built(
            model({
                flanges: [{ kind: "easyEdge", ...edge, elements }],
                bends: [{ a: [100, 0], b: [100, 100], angle: 90, radius: 1 }],
                flat: true,
            }),
        );
        const edges = flat.findSubShapes(ShapeTypes.edge);
        expect(flat.shapeType).toBe(ShapeTypes.compound);
        // One plate (the strip unifies into the blank) plus two marks: the bend line and the easy edge's bend.
        expect(edges.length).toBe(12 + 2);
        const ba = bendAllowance(90, 1, 1, 0.5);
        expect(flat.boundingBox().max.x).toBeCloseTo(200 + ba + 6, 3);
    });
});

describe("rolling", () => {
    test("a blank rolls into a closed cylinder with the neutral circumference", () => {
        const width = 2 * Math.PI * 50.5;
        const shape = built(model({ blank: [rect(width, 300)], roll: { axis: "v", direction: 1 } }));
        expect(shape.volume()).toBeCloseTo(Math.PI * (51 ** 2 - 50 ** 2) * 300, 1);
        const box = shape.boundingBox();
        // Mesh-based bounds: the tessellation sits a hair inside the true circle.
        expect(box.max.z - box.min.z).toBeCloseTo(102, 0);
    });

    test("a partial roll curls by width / neutral radius", () => {
        const shape = built(model({ blank: [rect(100, 50)], roll: { axis: "v", direction: 1, radius: 50 } }));
        expect(shape.volume()).toBeCloseTo(100 * 50, 2);
    });

    test("crimp and ring bead on a round duct", () => {
        const width = 2 * Math.PI * 50.5;
        const shape = built(
            model({
                blank: [rect(width, 300)],
                roll: { axis: "v", direction: 1 },
                crimps: [{ end: "end", length: 40, depth: 2, count: 24 }],
                beads: [{ kind: "ring", offset: 60, from: "end", width: 8, height: 3, direction: 1 }],
            }),
        );
        expect(solids(shape)).toBeGreaterThanOrEqual(1);
        const box = shape.boundingBox();
        // The bead stands proud of the duct's outer surface.
        expect(box.max.z - box.min.z).toBeGreaterThan(102 + 2);
    });

    test("a line bead on a flat sheet", () => {
        const shape = built(
            model({
                beads: [{ kind: "line", a: [40, 50], b: [160, 50], width: 10, height: 3, direction: 1 }],
            }),
        );
        expect(solids(shape)).toBe(1);
        expect(shape.boundingBox().max.z).toBeCloseTo(4, 3);
    });
});
