// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectFileFormat } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { type DrawingEntity, SketchNode, writeDxf } from "@chili3d/parametric";
import { drawingToSketchData } from "../src/cad/drawingToSketch";
import { readDxfFile } from "../src/cad/dxfReader";
import { aciColor, decodeDxfText, importDxf, mtextLines } from "../src/cad/dxfToDrawing";
import { DocumentFileNode } from "../src/documentFileNode";
import { DRAWING_IMPORTER } from "../src/importers";

const here = path.dirname(fileURLToPath(import.meta.url));
const plate = readFileSync(path.join(here, "fixtures/plate.dxf"));

/** A DXF text from [code, value] pairs. */
function dxf(entities: (string | number)[][], header: (string | number)[][] = [], extra = ""): string {
    const pairs = (list: (string | number)[][]) =>
        list.map(([code, value]) => `${code}\n${value}`).join("\n");
    return [
        "0\nSECTION\n2\nHEADER",
        pairs(header),
        "0\nENDSEC",
        extra,
        "0\nSECTION\n2\nENTITIES",
        pairs(entities),
        "0\nENDSEC\n0\nEOF\n",
    ]
        .filter((part) => part !== "")
        .join("\n");
}

const close = (actual: readonly number[], expected: readonly number[]) => {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((value, i) => {
        expect(value).toBeCloseTo(expected[i], 9);
    });
};

describe("DXF import", () => {
    test("the fixture is recognized as DXF by its content", () => {
        expect(detectFileFormat("drawing.bin", plate)).toMatchObject({ id: "dxf", by: "content" });
    });

    test("a plate with a bulged corner, a hole, an arc and a block becomes exact sketch entities", () => {
        const imported = importDxf(plate);
        expect(imported.isOk).toBe(true);
        const { drawing, sources, units } = imported.value;
        expect(units).toMatchObject({ name: "mm", toMm: 1, assumed: false });

        const { data, omitted } = drawingToSketchData(drawing, sources);
        expect(omitted).toBe(1); // the label
        expect(data.constraints).toEqual([]);
        expect(data.entities.map((entity) => entity.type)).toEqual([
            "line",
            "arc",
            "line",
            "line",
            "line",
            "circle",
            "arc",
            "circle",
            "line",
        ]);
        const params = data.entities.map((entity) => entity.params);
        close(params[0], [0, 0, 90, 0]);
        // Bulge tan(22.5°): a counter-clockwise quarter circle around (90, 10).
        close(params[1], [90, 10, 90, 0, 100, 10]);
        close(params[2], [100, 10, 100, 50]);
        close(params[3], [100, 50, 0, 50]);
        close(params[4], [0, 50, 0, 0]);
        close(params[5], [25, 25, 5]);
        close(params[6], [50, 70, 60, 70, 40, 70]);
        // BOLT inserted at (75, 25), rotated 90°: its circle and its horizontal line turned vertical.
        close(params[7], [75, 25, 2]);
        close(params[8], [75, 22, 75, 28]);
        expect(data.entities.map((entity) => entity.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(data.entityIdSeq).toBe(10);
    });

    test("layers keep their colors and line types; block entities on layer 0 take the insert's layer", () => {
        const { drawing } = importDxf(plate).value;
        const layers = Object.fromEntries(drawing.layers.map((layer) => [layer.name, layer]));
        expect(layers["OUTLINE"]).toMatchObject({ aci: 1, color: "#ff0000", dashed: false });
        expect(layers["HOLES"]).toMatchObject({ aci: 5, color: "#0000ff", dashed: true });
        expect(
            drawing.entities.filter((entity) => entity.layer === "HOLES").map((entity) => entity.kind),
        ).toEqual(["circle", "circle", "line"]);
        expect(layers["0"]).toBeUndefined();
    });

    test("TEXT becomes a drawing text with DXF control codes decoded", () => {
        const { drawing, sources } = importDxf(plate).value;
        const index = drawing.entities.findIndex((entity) => entity.kind === "text");
        const text = drawing.entities[index] as Extract<DrawingEntity, { kind: "text" }>;
        expect(sources[index]).toBe("TEXT");
        expect(text).toMatchObject({ layer: "NOTES", text: "Plate Ø5", height: 5, rotation: 0 });
        // Left-aligned on the baseline at (10, 60): the middle lies to the right and up.
        expect(text.position[0]).toBeGreaterThan(10);
        expect(text.position[1]).toBeCloseTo(62.5, 9);
    });

    test("$INSUNITS scales to millimetres; a unitless file is taken as millimetres", () => {
        const line = [
            [0, "LINE"],
            [8, "0"],
            [10, 0],
            [20, 0],
            [11, 2],
            [21, 0],
        ];
        const inches = importDxf(
            dxf(line, [
                [9, "$INSUNITS"],
                [70, 1],
            ]),
        ).value;
        expect(inches.units).toMatchObject({ name: "in", toMm: 25.4, assumed: false });
        expect(inches.drawing.entities[0]).toMatchObject({ kind: "line", a: [0, 0], b: [50.8, 0] });
        const unitless = importDxf(dxf(line)).value;
        expect(unitless.units).toMatchObject({ toMm: 1, assumed: true });
        const overridden = importDxf(dxf(line), { toMm: 10 }).value;
        expect(overridden.drawing.entities[0]).toMatchObject({ b: [20, 0] });
    });

    test("an arc extruded along -Z (mirrored OCS) is mirrored into world coordinates", () => {
        const arc = [
            [0, "ARC"],
            [8, "0"],
            [10, 10],
            [20, 0],
            [40, 5],
            [50, 0],
            [51, 90],
            [210, 0],
            [220, 0],
            [230, -1],
        ];
        const entity = importDxf(dxf(arc)).value.drawing.entities[0] as Extract<
            DrawingEntity,
            { kind: "arc" }
        >;
        // OCS (10, 0) is world (-10, 0); the quarter from 0° to 90° becomes 90° to 180°.
        expect(entity.center[0]).toBeCloseTo(-10, 9);
        expect(entity.center[1]).toBeCloseTo(0, 9);
        expect(entity.radius).toBeCloseTo(5, 9);
        expect(entity.startAngle).toBeCloseTo(90, 9);
        expect(entity.endAngle).toBeCloseTo(180, 9);
    });

    test("a rational spline is sampled on the curve it describes", () => {
        const w = Math.SQRT1_2;
        const spline = [
            [0, "SPLINE"],
            [8, "0"],
            [70, 12],
            [71, 2],
            [72, 6],
            [73, 3],
            ...[0, 0, 0, 1, 1, 1].map((knot) => [40, knot]),
            ...[1, w, 1].map((weight) => [41, weight]),
            ...[
                [100, 0],
                [100, 100],
                [0, 100],
            ].flatMap(([x, y]) => [
                [10, x],
                [20, y],
                [30, 0],
            ]),
        ];
        const { drawing } = importDxf(dxf(spline), { tolerance: 0.01 }).value;
        expect(drawing.entities.length).toBeGreaterThan(8);
        for (const entity of drawing.entities) {
            expect(entity.kind).toBe("line");
            if (entity.kind !== "line") continue;
            for (const point of [entity.a, entity.b])
                expect(Math.hypot(point[0], point[1])).toBeCloseTo(100, 6);
        }
        const first = drawing.entities[0] as Extract<DrawingEntity, { kind: "line" }>;
        const last = drawing.entities.at(-1) as Extract<DrawingEntity, { kind: "line" }>;
        close([...first.a], [100, 0]);
        close([...last.b], [0, 100]);
    });

    test("an ellipse becomes lines on the ellipse; a circular one stays an arc", () => {
        const ellipse = (ratio: number) => [
            [0, "ELLIPSE"],
            [8, "0"],
            [10, 0],
            [20, 0],
            [11, 20],
            [21, 0],
            [40, ratio],
            [41, 0],
            [42, Math.PI],
        ];
        const flat = importDxf(dxf(ellipse(0.5))).value.drawing.entities;
        expect(flat.every((entity) => entity.kind === "line")).toBe(true);
        for (const entity of flat) {
            if (entity.kind !== "line") continue;
            const [x, y] = entity.b;
            expect((x / 20) ** 2 + (y / 10) ** 2).toBeCloseTo(1, 9);
            expect(y).toBeGreaterThanOrEqual(-1e-9);
        }
        const round = importDxf(dxf(ellipse(1))).value.drawing.entities;
        expect(round).toEqual([
            { kind: "arc", layer: "0", center: [0, 0], radius: 20, startAngle: 0, endAngle: 180 },
        ]);
    });

    test("POLYLINE with VERTEX/SEQEND and bulges, and a MINSERT array", () => {
        const polyline = [
            [0, "POLYLINE"],
            [8, "0"],
            [66, 1],
            [70, 0],
            [0, "VERTEX"],
            [8, "0"],
            [10, 0],
            [20, 0],
            [42, 1],
            [0, "VERTEX"],
            [8, "0"],
            [10, 10],
            [20, 0],
            [0, "SEQEND"],
            [8, "0"],
        ];
        const semicircle = importDxf(dxf(polyline)).value.drawing.entities;
        expect(semicircle).toHaveLength(1);
        expect(semicircle[0]).toMatchObject({ kind: "arc", center: [5, 0], radius: 5 });

        const blocks =
            "0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\nDOT\n70\n0\n10\n0\n20\n0\n0\nCIRCLE\n8\n0\n10\n0\n20\n0\n40\n1\n0\nENDBLK\n0\nENDSEC";
        const array = [
            [0, "INSERT"],
            [8, "0"],
            [2, "DOT"],
            [10, 0],
            [20, 0],
            [70, 2],
            [71, 2],
            [44, 10],
            [45, 20],
        ];
        const circles = importDxf(dxf(array, [], blocks)).value.drawing.entities;
        expect(circles.map((entity) => (entity.kind === "circle" ? entity.center : undefined))).toEqual([
            [0, 0],
            [10, 0],
            [0, 20],
            [10, 20],
        ]);
    });

    test("entities on frozen or switched-off layers are left out and counted", () => {
        const tables =
            "0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n0\nLAYER\n2\nHIDDEN\n70\n1\n62\n7\n0\nLAYER\n2\nOFF\n70\n0\n62\n-3\n0\nENDTAB\n0\nENDSEC";
        const entities = ["HIDDEN", "OFF", "SHOWN"].flatMap((layer) => [
            [0, "LINE"],
            [8, layer],
            [10, 0],
            [20, 0],
            [11, 1],
            [21, 1],
        ]);
        const imported = importDxf(dxf(entities, [], tables)).value;
        expect(imported.drawing.entities.map((entity) => entity.layer)).toEqual(["SHOWN"]);
        expect(imported.skipped).toEqual({ "LINE (hidden layer)": 2 });
    });

    test("binary DXF (R13+) reads like ASCII", () => {
        const parts: number[] = [...new TextEncoder().encode("AutoCAD Binary DXF\r\n\x1a\0")];
        const code = (c: number) => parts.push(c & 0xff, (c >> 8) & 0xff);
        const text = (c: number, value: string) => {
            code(c);
            parts.push(...new TextEncoder().encode(value), 0);
        };
        const real = (c: number, value: number) => {
            code(c);
            const view = new DataView(new ArrayBuffer(8));
            view.setFloat64(0, value, true);
            parts.push(...new Uint8Array(view.buffer));
        };
        text(0, "SECTION");
        text(2, "ENTITIES");
        text(0, "LINE");
        text(8, "0");
        real(10, 1.5);
        real(20, 2);
        real(11, 3);
        real(21, 4);
        text(0, "ENDSEC");
        text(0, "EOF");
        const bytes = new Uint8Array(parts);
        expect(detectFileFormat("binary.dxf", bytes)).toMatchObject({ id: "dxf", version: "binary" });
        expect(importDxf(bytes).value.drawing.entities).toEqual([
            { kind: "line", layer: "0", a: [1.5, 2], b: [3, 4] },
        ]);
    });

    test("not a DXF file: an error, no exception", () => {
        expect(importDxf("hello\nworld\n").isOk).toBe(false);
        expect(readDxfFile("0\nLINE\n").isOk).toBe(false);
    });

    test("an imported drawing written back as DXF R12 reads to the same entities", () => {
        const { drawing } = importDxf(plate).value;
        const again = importDxf(writeDxf(drawing)).value.drawing;
        expect(again.entities.map((entity) => entity.kind)).toEqual(
            drawing.entities.map((entity) => entity.kind),
        );
    });

    test("text helpers: control codes, MTEXT formatting, colors", () => {
        expect(decodeDxfText("45%%d %%p0.1 %%c10 \\U+00B5m")).toBe("45° ±0.1 Ø10 µm");
        expect(mtextLines("{\\fArial|b1;Bold}\\Pline \\~two\\P\\S1/2;")).toEqual([
            "Bold",
            "line  two",
            "1/2",
        ]);
        expect(aciColor(1)).toBe("#ff0000");
        expect(aciColor(7)).toBe("#000000");
        expect(aciColor(10)).toBe("#ff0000");
        expect(aciColor(250)).toBe("#333333");
    });

    test("the importer adds a sketch on XY and a drawing element holding the original file", async () => {
        const document = new TestDocument();
        const format = detectFileFormat("Plate.dxf", plate);
        const result = await DRAWING_IMPORTER.import(document, { name: "Plate.dxf", bytes: plate, format });
        expect(result.isOk).toBe(true);
        const [sketch, element] = result.value;
        expect(sketch).toBeInstanceOf(SketchNode);
        expect((sketch as SketchNode).data.entities).toHaveLength(9);
        expect(sketch.name).toBe("Plate");
        expect(element).toBeInstanceOf(DocumentFileNode);
        const file = element as DocumentFileNode;
        expect(file.format).toBe("dxf");
        expect(file.encoding).toBe("text");
        expect(file.bytes).toEqual(new Uint8Array(plate));
        expect(document.modelManager.findNodes()).toContain(file);
        expect(file.name).not.toBe(sketch.name);
    });
});
