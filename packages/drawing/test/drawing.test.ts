// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    convertDrawing,
    type Drawing,
    type DrawingSelection,
    drawingColors,
    effectiveColor,
    filterDrawing,
    filterDrawingLayers,
    nearestAci,
    normalizeColor,
    readDxf,
    writeDxf,
    writePdf,
    writeSvg,
} from "../src";

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

/**
 * Cut (black) and Bend (red, dashed) layers; a Cut line overridden green, a Cut circle
 * overridden red (the Bend layer's colour, ByLayer there), an unknown-layer line.
 */
const colored: Drawing = {
    layers: [
        { name: "Cut", aci: 7, color: "#000000" },
        { name: "Bend", aci: 1, color: "#FF0000", dashed: true },
    ],
    entities: [
        { kind: "line", layer: "Cut", a: [0, 0], b: [10, 0] },
        { kind: "line", layer: "Cut", a: [0, 5], b: [10, 5], color: "#00FF00" },
        { kind: "circle", layer: "Cut", center: [20, 0], radius: 2, color: "#f00" },
        { kind: "arc", layer: "Bend", center: [5, 0], radius: 5, startAngle: 0, endAngle: 180 },
        { kind: "line", layer: "Loose", a: [0, -5], b: [10, -5] },
    ],
};

const summary = (drawing: Drawing) => drawing.entities.map((entity) => `${entity.kind}@${entity.layer}`);

describe("drawing colours", () => {
    test("colours normalize to lowercase #rrggbb; the nearest index maps black and white to 7", () => {
        expect(normalizeColor(" #F0a ")).toBe("#ff00aa");
        expect(normalizeColor("#ABCDEF")).toBe("#abcdef");
        expect(normalizeColor("Red")).toBe("red");
        expect([nearestAci("#ff0000"), nearestAci("#00ff00"), nearestAci("#0000ff")]).toEqual([1, 3, 5]);
        expect([nearestAci("#000000"), nearestAci("#ffffff"), nearestAci("#7f7f80")]).toEqual([7, 7, 8]);
        expect(nearestAci("red")).toBe(7);
    });

    test("the effective colour is the entity's own, else its layer's, else black", () => {
        expect(colored.entities.map((entity) => effectiveColor(entity, colored))).toEqual([
            "#000000",
            "#00ff00",
            "#ff0000",
            "#ff0000",
            "#000000",
        ]);
    });

    test("the colours present are counted in first-seen order", () => {
        expect(drawingColors(colored)).toEqual([
            { color: "#000000", count: 2 },
            { color: "#00ff00", count: 1 },
            { color: "#ff0000", count: 2 },
        ]);
        expect(drawingColors({ layers: [], entities: [] })).toEqual([]);
    });
});

describe("filterDrawing", () => {
    test.each<[string, DrawingSelection, string[], string[]]>([
        [
            "red: the override on Cut and the arc ByLayer on Bend",
            { colors: ["#FF0000"] },
            ["circle@Cut", "arc@Bend"],
            ["Cut", "Bend"],
        ],
        [
            "black: ByLayer on Cut and on an unknown layer",
            { colors: ["#000"] },
            ["line@Cut", "line@Loose"],
            ["Cut"],
        ],
        ["red AND Cut", { layers: ["Cut"], colors: ["#ff0000"] }, ["circle@Cut"], ["Cut"]],
        ["green AND Bend: nothing", { layers: ["Bend"], colors: ["#00ff00"] }, [], []],
        ["no colours", { colors: [] }, [], []],
        ["a layer list alone", { layers: ["Bend"] }, ["arc@Bend"], ["Bend"]],
    ])("%s", (_name, selection, entities, layers) => {
        const filtered = filterDrawing(colored, selection);
        expect(summary(filtered)).toEqual(entities);
        expect(filtered.layers.map((layer) => layer.name)).toEqual(layers);
    });

    test("no lists keep the drawing itself; the input is untouched", () => {
        expect(filterDrawing(colored, {})).toBe(colored);
        filterDrawing(colored, { colors: ["#00ff00"] });
        expect(colored.entities).toHaveLength(5);
    });

    test("a selected layer that had no entities keeps its record; one the colour filter emptied goes", () => {
        const withEmpty: Drawing = {
            ...colored,
            layers: [...colored.layers, { name: "Notes", aci: 3, color: "#00ff00" }],
        };
        expect(filterDrawing(withEmpty, { colors: ["#00ff00"] }).layers.map((layer) => layer.name)).toEqual([
            "Cut",
            "Notes",
        ]);
    });
});

describe("colour in the written files", () => {
    test("DXF writes group 62 only for an entity's own colour; ByLayer entities carry none", () => {
        const dxf = writeDxf(filterDrawing(colored, { colors: ["#ff0000"] }));
        const entities = readDxf(dxf).entities;
        expect(entities.map((entity) => [entity.type, entity.layer, entity.values[62]])).toEqual([
            ["CIRCLE", "Cut", 1],
            ["ARC", "Bend", undefined],
        ]);
        expect(dxf).toContain("  0\nCIRCLE\n  8\nCut\n 62\n1\n");
        expect(dxf).toContain("  0\nARC\n  8\nBend\n 10\n");
        // The removed lines are absent.
        expect(dxf).not.toContain("LINE\n");
    });

    test("SVG strokes an overridden entity in its own colour inside its layer's group", () => {
        const svg = writeSvg(filterDrawing(colored, { layers: ["Cut"] }));
        expect(svg).toMatch(/<g id="Cut"[^>]* stroke="#000000"/);
        expect(svg).toMatch(/<line x1="[^"]+" y1="[^"]+" x2="[^"]+" y2="[^"]+"\/>/);
        expect(svg).toMatch(/<line [^>]* stroke="#00ff00"\/>/);
        expect(svg).toMatch(/<circle [^>]* stroke="#ff0000"\/>/);
        expect(svg).not.toContain('id="Bend"');
        expect(svg).not.toContain("<path");
        const greenOnly = writeSvg(filterDrawing(colored, { colors: ["#00ff00"] }));
        expect(greenOnly.match(/<line /g)).toHaveLength(1);
        expect(greenOnly).not.toContain("<circle");
    });

    test("SVG text is filled in its own colour", () => {
        const svg = writeSvg({
            layers: [{ name: "Notes", aci: 7, color: "#000000" }],
            entities: [
                {
                    kind: "text",
                    layer: "Notes",
                    position: [0, 0],
                    height: 2,
                    rotation: 0,
                    text: "A",
                    color: "#0000FF",
                },
                { kind: "text", layer: "Notes", position: [0, 5], height: 2, rotation: 0, text: "B" },
            ],
        });
        expect(svg).toMatch(/fill="#0000ff" stroke="none"[^>]*>A</);
        expect(svg).toMatch(/fill="#000000" stroke="none"[^>]*>B</);
    });

    test("PDF switches to an entity's own colour and back to the layer's", () => {
        const text = String.fromCharCode(...writePdf(filterDrawing(colored, { layers: ["Cut"] })));
        const colours = [...text.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) RG/g)].map((m) =>
            m.slice(1, 4).join(" "),
        );
        expect(colours).toEqual(["0 0 0", "0 1 0", "1 0 0"]);
    });
});
