// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * 2D export: the flat pattern of a known sheet metal model and a sketch, written as DXF
 * (read back entity by entity) and SVG. The flat pattern is pure data from the flat-first
 * model, so every coordinate is predictable from the bend allowance.
 */

import { Plane } from "@chili3d/core";
import { formatNumber, readDxf, writeDxf, writeSvg } from "@chili3d/drawing";
import {
    bendLabel,
    clipLineToBlank,
    flatPatternArea,
    flatPatternDrawing,
    flatPatternOf,
} from "../../src/sheetMetal/flatPattern";
import { bendAllowance, type Loop2, type SheetMetalModel } from "../../src/sheetMetal/model";
import { sketchDrawing } from "../../src/sketch/sketchDrawing";
import type { SketchData } from "../../src/sketch/sketchModel";

const rectangle = (w: number, h: number): Loop2 => [
    { kind: "line", a: [0, 0], b: [w, 0] },
    { kind: "line", a: [w, 0], b: [w, h] },
    { kind: "line", a: [w, h], b: [0, h] },
    { kind: "line", a: [0, h], b: [0, 0] },
];

/** A hole as the blank stores a full circle: two three-point arcs. */
const hole = (cx: number, cy: number, r: number): Loop2 => [
    { kind: "arc", a: [cx + r, cy], mid: [cx, cy + r], b: [cx - r, cy] },
    { kind: "arc", a: [cx - r, cy], mid: [cx, cy - r], b: [cx + r, cy] },
];

function model(overrides: Partial<SheetMetalModel> = {}): SheetMetalModel {
    return {
        plane: Plane.XY,
        thickness: 1,
        radius: 1,
        kFactor: 0.5,
        blank: [rectangle(300, 200), hole(50, 100, 10)],
        bends: [{ a: [100, -10], b: [100, 210], angle: 90, radius: 1 }],
        flanges: [
            {
                kind: "flange",
                a: [300, 0],
                b: [300, 200],
                elements: [
                    { kind: "bend", angle: -90, radius: 1 },
                    { kind: "straight", length: 10 },
                ],
            },
        ],
        crimps: [],
        beads: [],
        flat: true,
        ...overrides,
    };
}

const BA = bendAllowance(90, 1, 1, 0.5); // π/2 · 1.5
const STRIP = BA + 10;
const n = (value: number) => Number(formatNumber(value));

describe("flat pattern", () => {
    test("unfolds the edge strip onto its edge, keeps the hole, clips the bend line to the blank", () => {
        const pattern = flatPatternOf(model());
        expect(pattern.isOk).toBe(true);
        const { outline, bendLines, forming } = pattern.value;

        expect(outline).toHaveLength(2);
        expect(outline[0]).toEqual([
            { kind: "line", a: [0, 0], b: [300, 0] },
            { kind: "line", a: [300, 0], b: [300 + STRIP, 0] },
            { kind: "line", a: [300 + STRIP, 0], b: [300 + STRIP, 200] },
            { kind: "line", a: [300 + STRIP, 200], b: [300, 200] },
            { kind: "line", a: [300, 200], b: [0, 200] },
            { kind: "line", a: [0, 200], b: [0, 0] },
        ]);
        expect(outline[1]).toEqual(hole(50, 100, 10));

        expect(bendLines).toEqual([
            { a: [300 + BA / 2, 0], b: [300 + BA / 2, 200], angle: -90, radius: 1, source: "flange" },
            { a: [100, 0], b: [100, 200], angle: 90, radius: 1, source: "bend" },
        ]);
        expect(forming).toEqual([]);
        expect(flatPatternArea(pattern.value)).toBeCloseTo((300 + STRIP) * 200 - Math.PI * 100, 9);
    });

    test("a bend line crossing a hole is split around it", () => {
        const pieces = clipLineToBlank([50, -5], [50, 205], [rectangle(300, 200), hole(50, 100, 10)]);
        expect(pieces).toHaveLength(2);
        expect(pieces[0][0][1]).toBeCloseTo(0, 12);
        expect(pieces[0][1][1]).toBeCloseTo(90, 9);
        expect(pieces[1][0][1]).toBeCloseTo(110, 9);
        expect(pieces[1][1][1]).toBeCloseTo(200, 12);
    });

    test("an edge treatment off the blank's straight edges is an error, not a wrong drawing", () => {
        const pattern = flatPatternOf(
            model({
                flanges: [
                    { kind: "hem", a: [10, 10], b: [20, 10], elements: [{ kind: "straight", length: 5 }] },
                ],
            }),
        );
        expect(pattern.isOk).toBe(false);
        expect(pattern.error).toMatch(/straight edge/);
    });

    test("a rolled duct gets crimp and bead marks across the blank and a roll note", () => {
        const pattern = flatPatternOf(
            model({
                blank: [rectangle(631.46, 500)],
                bends: [],
                flanges: [],
                roll: { axis: "v", direction: 1 },
                crimps: [{ end: "end", length: 38, depth: 1.5, count: 36 }],
                beads: [{ kind: "ring", offset: 60, from: "end", width: 8, height: 3, direction: 1 }],
            }),
        );
        expect(pattern.isOk).toBe(true);
        expect(pattern.value.forming).toEqual([
            { a: [0, 462], b: [631.46, 462], label: "CRIMP 38 x 1.5 (36)" },
            { a: [0, 440], b: [631.46, 440], label: "BEAD W8 H3 OUT" },
        ]);
        expect(pattern.value.notes[1]).toBe(
            `ROLL ABOUT V  INNER R ${String(Number((631.46 / (2 * Math.PI) - 0.5).toFixed(3)))}  UP`,
        );
    });

    test("bend labels give direction, angle and inner radius", () => {
        expect(bendLabel({ a: [0, 0], b: [0, 1], angle: 90, radius: 1, source: "bend" })).toBe("UP 90° R1");
        expect(bendLabel({ a: [0, 0], b: [0, 1], angle: -45.5, radius: 0.75, source: "flange" })).toBe(
            "DOWN 45.5° R0.75",
        );
    });
});

describe("DXF", () => {
    test("writes the flat pattern as R12 entities on their layers, in millimetres", () => {
        const pattern = flatPatternOf(model()).value;
        const dxf = readDxf(writeDxf(flatPatternDrawing(pattern, { labels: false })));

        expect(dxf.header["$ACADVER"]).toBe("AC1009");
        expect(dxf.header["$INSUNITS"]).toBe(4);
        expect(dxf.layers).toEqual(["0", "OUTLINE", "BEND_UP", "BEND_DOWN", "FORMING", "ANNOTATION"]);

        const line = (layer: string, x1: number, y1: number, x2: number, y2: number) => ({
            type: "LINE",
            layer,
            values: { 8: layer, 10: n(x1), 20: n(y1), 30: 0, 11: n(x2), 21: n(y2), 31: 0 },
        });
        const f = 300 + STRIP;
        expect(dxf.entities).toEqual([
            line("OUTLINE", 0, 0, 300, 0),
            line("OUTLINE", 300, 0, f, 0),
            line("OUTLINE", f, 0, f, 200),
            line("OUTLINE", f, 200, 300, 200),
            line("OUTLINE", 300, 200, 0, 200),
            line("OUTLINE", 0, 200, 0, 0),
            { type: "CIRCLE", layer: "OUTLINE", values: { 8: "OUTLINE", 10: 50, 20: 100, 30: 0, 40: 10 } },
            line("BEND_DOWN", 300 + BA / 2, 0, 300 + BA / 2, 200),
            line("BEND_UP", 100, 0, 100, 200),
        ]);
    });

    test("labels the bend lines along the line and writes the shop note", () => {
        const pattern = flatPatternOf(model()).value;
        const dxf = readDxf(writeDxf(flatPatternDrawing(pattern, { textHeight: 3 })));
        const texts = dxf.entities.filter((entity) => entity.type === "TEXT");
        expect(texts.map((text) => [text.layer, text.values[1], text.values[50], text.values[40]])).toEqual([
            ["ANNOTATION", "DOWN 90%%d R1", 90, 3],
            ["ANNOTATION", "UP 90%%d R1", 90, 3],
            ["ANNOTATION", "FLAT PATTERN  T 1  K 0.5  R 1  (mm)", 0, 3],
        ]);
        // Beside the line (on its left, reading upward), not on top of it.
        expect(texts[1].values[10]).toBeCloseTo(100 - 2.7, 9);
        expect(texts[1].values[20]).toBeCloseTo(100, 9);
    });

    test("writes a sketch's lines, circles and counter-clockwise arcs", () => {
        const data: SketchData = {
            entities: [
                { id: 1, type: "line", params: [0, 0, 40, 0] },
                { id: 2, type: "circle", params: [20, 20, 5] },
                { id: 3, type: "arc", params: [0, 0, 10, 0, 0, 10] },
            ],
            constraints: [],
            externalRefs: [
                {
                    entityId: -100,
                    nodeId: "part",
                    edge: {} as never,
                    role: "reference",
                    snapshot: [0, -5, 40, -5],
                    type: "line",
                },
            ],
        };
        const dxf = readDxf(writeDxf(sketchDrawing(data)));
        expect(dxf.entities).toEqual([
            {
                type: "LINE",
                layer: "SKETCH",
                values: { 8: "SKETCH", 10: 0, 20: 0, 30: 0, 11: 40, 21: 0, 31: 0 },
            },
            { type: "CIRCLE", layer: "SKETCH", values: { 8: "SKETCH", 10: 20, 20: 20, 30: 0, 40: 5 } },
            {
                type: "ARC",
                layer: "SKETCH",
                values: { 8: "SKETCH", 10: 0, 20: 0, 30: 0, 40: 10, 50: 0, 51: 90 },
            },
            {
                type: "LINE",
                layer: "EXTERNAL",
                values: { 8: "EXTERNAL", 10: 0, 20: -5, 30: 0, 11: 40, 21: -5, 31: 0 },
            },
        ]);
        expect(readDxf(writeDxf(sketchDrawing(data, { external: false }))).entities).toHaveLength(3);
    });
});

describe("SVG", () => {
    test("is sized in millimetres with the y axis flipped and one group per used layer", () => {
        const pattern = flatPatternOf(model({ flanges: [], bends: [] })).value;
        const svg = writeSvg(flatPatternDrawing(pattern, { labels: false }), { margin: 5 });
        expect(svg).toContain(`width="310mm" height="210mm" viewBox="0 0 310 210"`);
        // The bottom edge y = 0 lands at the bottom of the page (210 − 5).
        expect(svg).toContain(`<line x1="5" y1="205" x2="305" y2="205"/>`);
        expect(svg).toContain(`<circle cx="55" cy="105" r="10"/>`);
        expect(svg).toContain(`<g id="OUTLINE"`);
        expect(svg).not.toContain(`<g id="BEND_UP"`);
    });

    test("draws an arc counter-clockwise on screen and escapes text", () => {
        const svg = writeSvg(
            {
                layers: [{ name: "A&B", aci: 7, color: "#000000" }],
                entities: [
                    { kind: "arc", layer: "A&B", center: [0, 0], radius: 10, startAngle: 0, endAngle: 270 },
                    {
                        kind: "text",
                        layer: "A&B",
                        position: [0, 0],
                        height: 2,
                        rotation: 90,
                        text: "<UP 90°>",
                    },
                ],
            },
            { margin: 0 },
        );
        // From (10, 0) to (0, −10) the long way round: large-arc 1, sweep-flag 0.
        expect(svg).toContain(`<path d="M 20 10 A 10 10 0 1 0 10 20"/>`);
        expect(svg).toContain(`&lt;UP 90°&gt;</text>`);
        expect(svg).toContain(`transform="rotate(-90 10 10)"`);
        expect(svg).toContain(`id="A&amp;B"`);
    });
});
