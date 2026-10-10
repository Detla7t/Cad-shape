// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Drawing, drawingBounds } from "@chili3d/drawing";
import { fittingScale, SHEET_SIZES, scaleLabel, sheetDrawing } from "../src/cad/sheetDrawing";

const texts = (drawing: Drawing) =>
    drawing.entities.flatMap((entity) => (entity.kind === "text" ? [entity.text] : []));

describe("sheet drawing", () => {
    test("an empty sheet has the frame inside the sheet and a complete title block", () => {
        const sheet = sheetDrawing(undefined, { title: "Bracket", date: "2026-10-09", drawnBy: "AB" });
        // The lines (the bounds of a text are an estimate that overshoots vertically).
        const bounds = drawingBounds({
            layers: sheet.layers,
            entities: sheet.entities.filter((entity) => entity.kind !== "text"),
        })!;
        expect(bounds.min[0]).toBeGreaterThanOrEqual(0);
        expect(bounds.min[1]).toBeGreaterThanOrEqual(0);
        expect(bounds.max[0]).toBeLessThanOrEqual(SHEET_SIZES.A4.width);
        expect(bounds.max[1]).toBeLessThanOrEqual(SHEET_SIZES.A4.height);
        const words = texts(sheet);
        expect(words).toEqual(
            expect.arrayContaining([
                "TITLE",
                "Bracket",
                "DRAWN",
                "AB 2026-10-09",
                "SCALE",
                "1:1",
                "SHEET",
                "1 of 1",
            ]),
        );
        expect(words).toContain("UNLESS OTHERWISE SPECIFIED, DIMENSIONS ARE IN MILLIMETERS");
        expect(sheet.layers.map((layer) => layer.name)).toEqual(["FRAME", "TITLE", "TEXT"]);
    });

    test("views are placed at the largest standard scale that fits, centred in the drawing area", () => {
        const views: Drawing = {
            layers: [{ name: "VISIBLE", aci: 7, color: "#000" }],
            entities: [
                { kind: "line", layer: "VISIBLE", a: [0, 0], b: [600, 0] },
                { kind: "line", layer: "VISIBLE", a: [600, 0], b: [600, 300] },
                { kind: "circle", layer: "VISIBLE", center: [300, 150], radius: 100 },
            ],
        };
        const sheet = sheetDrawing(views, { size: SHEET_SIZES.ansiA, units: "inch" });
        expect(texts(sheet)).toContain("1:5");
        expect(texts(sheet)).toContain("UNLESS OTHERWISE SPECIFIED, DIMENSIONS ARE IN INCHES");
        const circle = sheet.entities.find((entity) => entity.kind === "circle");
        expect(circle?.kind).toBe("circle");
        expect(circle?.kind === "circle" ? circle.radius : undefined).toBe(20);
        const placed = sheet.entities.filter((entity) => entity.layer === "VISIBLE");
        const bounds = drawingBounds({ layers: views.layers, entities: placed })!;
        // Inside the frame and above the title block.
        expect(bounds.min[0]).toBeGreaterThan(10);
        expect(bounds.max[0]).toBeLessThan(SHEET_SIZES.ansiA.width - 10);
        expect(bounds.min[1]).toBeGreaterThan(50);
        expect(bounds.max[1]).toBeLessThan(SHEET_SIZES.ansiA.height - 10);
        expect(bounds.max[0] - bounds.min[0]).toBeCloseTo(120, 6);
        expect(sheet.layers[0].name).toBe("VISIBLE");
    });

    test.each([
        [100, 50, 200, 100, 2],
        [100, 50, 100, 50, 1],
        [1000, 500, 250, 100, 1 / 5],
        [1e6, 1e6, 100, 100, 1 / 100],
    ])("fittingScale(%s × %s in %s × %s) = %s", (w, h, aw, ah, expected) => {
        expect(fittingScale(w, h, aw, ah)).toBe(expected);
    });

    test("scale labels read 2:1 and 1:2", () => {
        expect(scaleLabel(2)).toBe("2:1");
        expect(scaleLabel(1)).toBe("1:1");
        expect(scaleLabel(1 / 2)).toBe("1:2");
    });
});
