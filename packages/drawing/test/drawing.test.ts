// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { convertDrawing, type Drawing, filterDrawingLayers, readDxf, writeDxf, writeSvg } from "../src";

const inchDrawing: Drawing = {
    units: "inch",
    layers: [
        { name: "Cut", aci: 7, color: "#000000" },
        { name: "Bend", aci: 1, color: "#ff0000", dashed: true },
    ],
    entities: [
        { kind: "line", layer: "Cut", a: [0, 0], b: [2, 0] },
        { kind: "arc", layer: "Bend", center: [1, 0], radius: 1, startAngle: 0, endAngle: 180 },
        { kind: "text", layer: "Cut", position: [1, 1], height: 0.25, rotation: 0, text: "A" },
    ],
};

describe("drawing units", () => {
    test("an inch drawing is written as an inch DXF with a quarter-inch dash", () => {
        const dxf = readDxf(writeDxf(inchDrawing));
        expect(dxf.header["$INSUNITS"]).toBe(1);
        expect(dxf.header["$MEASUREMENT"]).toBe(0);
        expect(writeDxf(inchDrawing)).toContain(" 40\n0.25\n 49\n0.166666667\n 49\n-0.083333333");
    });

    test("a drawing without units stays a millimetre DXF", () => {
        const dxf = readDxf(writeDxf({ ...inchDrawing, units: undefined }));
        expect(dxf.header["$INSUNITS"]).toBe(4);
        expect(dxf.header["$MEASUREMENT"]).toBe(1);
    });

    test("the SVG page is sized in the drawing's units", () => {
        const svg = writeSvg({ ...inchDrawing, entities: inchDrawing.entities.slice(0, 2) }, { margin: 0.5 });
        expect(svg).toContain('width="3in" height="2in" viewBox="0 0 3 2"');
    });

    test("converting scales lengths and keeps angles", () => {
        const mm = convertDrawing(inchDrawing, "mm");
        expect(mm.units).toBe("mm");
        expect(mm.entities[0]).toEqual({ kind: "line", layer: "Cut", a: [0, 0], b: [50.8, 0] });
        expect(mm.entities[1]).toMatchObject({
            center: [25.4, 0],
            radius: 25.4,
            startAngle: 0,
            endAngle: 180,
        });
        expect(mm.entities[2]).toMatchObject({ position: [25.4, 25.4], height: 6.35 });
        const back = convertDrawing(mm, "inch").entities[0];
        expect(back.kind === "line" ? back.b[0] : Number.NaN).toBeCloseTo(2, 12);
    });
});

describe("filterDrawingLayers", () => {
    test("keeps the named layers and their entities, in order; unknown names are ignored", () => {
        const cut = filterDrawingLayers(inchDrawing, ["Cut", "Nope"]);
        expect(cut.units).toBe("inch");
        expect(cut.layers.map((layer) => layer.name)).toEqual(["Cut"]);
        expect(cut.entities.map((entity) => entity.kind)).toEqual(["line", "text"]);
        expect(filterDrawingLayers(inchDrawing, []).entities).toEqual([]);
        // The input is untouched.
        expect(inchDrawing.entities).toHaveLength(3);
    });
});
