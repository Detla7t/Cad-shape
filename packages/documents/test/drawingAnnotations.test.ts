// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { writeDxf } from "@chili3d/drawing";
import {
    ANNOTATION_LAYERS,
    dimensionEntities,
    noteEntity,
    parseScale,
    readSheetProperties,
    splitSheet,
    withEntities,
} from "../src/cad/drawingAnnotations";
import { sheetDrawing } from "../src/cad/sheetDrawing";

describe("drawing annotations", () => {
    test("a dimension is extension lines, a dimension line with arrowheads and an upright label", () => {
        const entities = dimensionEntities([0, 0], [100, 0], 8, "100 mm");
        expect(entities).toHaveLength(8);
        const lines = entities.filter((entity) => entity.kind === "line");
        expect(lines).toHaveLength(7);
        const text = entities.find((entity) => entity.kind === "text");
        expect(text?.kind === "text" && text.text).toBe("100 mm");
        expect(text?.kind === "text" && text.position[0]).toBeCloseTo(50, 9);
        expect(text?.kind === "text" && text.position[1]).toBeGreaterThan(8);
        expect(text?.kind === "text" && text.rotation).toBe(0);
        // The label of a right-to-left dimension reads the right way up.
        const back = dimensionEntities([100, 0], [0, 0], 8, "100 mm").find(
            (entity) => entity.kind === "text",
        );
        expect(back?.kind === "text" && back.rotation).toBe(0);
        expect(dimensionEntities([3, 3], [3, 3], 8, "0")).toEqual([]);
    });

    test("notes and dimensions sit on their own layers, apart from the sheet and the views", () => {
        const sheet = sheetDrawing(
            {
                layers: [{ name: "VISIBLE", aci: 7, color: "#000" }],
                entities: [{ kind: "line", layer: "VISIBLE", a: [0, 0], b: [50, 0] }],
            },
            { title: "T", date: "2026-10-09" },
        );
        let drawing = withEntities(sheet, [noteEntity([20, 20], "Deburr")], ANNOTATION_LAYERS.notes);
        drawing = withEntities(
            drawing,
            dimensionEntities([20, 60], [120, 60], 8, "400 mm"),
            ANNOTATION_LAYERS.dimensions,
        );
        const parts = splitSheet(drawing);
        expect(parts.views).toHaveLength(1);
        expect(parts.annotations).toHaveLength(9);
        expect(parts.sheet.length).toBeGreaterThan(10);
        expect(drawing.layers.map((layer) => layer.name)).toEqual([
            "VISIBLE",
            "FRAME",
            "TITLE",
            "TEXT",
            "NOTES",
            "DIMENSIONS",
        ]);
    });

    test("the sheet's properties travel in the DXF's comments and come back", () => {
        const text = writeDxf(
            { layers: [], entities: [] },
            { properties: { sheet: "A4", scale: "1:4", title: "End Cap" } },
        );
        expect(readSheetProperties(text)).toEqual({ sheet: "A4", scale: "1:4", title: "End Cap" });
        expect(parseScale("1:4")).toBe(0.25);
        expect(parseScale("2:1")).toBe(2);
        expect(parseScale("full")).toBeUndefined();
    });
});
