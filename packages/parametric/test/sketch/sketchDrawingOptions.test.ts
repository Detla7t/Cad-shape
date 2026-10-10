// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DownloadedFile, Plane, setDownloadDelivery } from "@chili3d/core";
import { createMockApplication, TestDocument } from "@chili3d/core/test-utils";
import { readDxf, writeDxf, writeSvg } from "@chili3d/drawing";
import { ExportSketchCommand } from "../../src/commands/exportCommands";
import { sketchDrawing } from "../../src/sketch/sketchDrawing";
import type { SketchData } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";

/** A profile line on layer 0, a construction line, and a circle on a "Guides" layer. */
const DATA: SketchData = {
    entities: [
        { id: 1, type: "line", params: [0, 0, 10, 0] },
        { id: 2, type: "line", params: [0, 5, 10, 5], construction: true },
        { id: 3, type: "circle", params: [20, 0, 4], layer: "guide" },
    ],
    constraints: [],
    layers: [
        { id: "0", name: "0", color: "#4a9eff" },
        { id: "guide", name: "Guides", color: "#ff00ff" },
    ],
    externalRefs: [
        {
            entityId: -1,
            nodeId: "src",
            edge: { kind: "line", start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 9, z: 0 } },
            role: "reference",
            snapshot: [0, 0, 0, 9],
            type: "line",
        },
    ],
};

const kinds = (data: SketchData, options?: Parameters<typeof sketchDrawing>[1]) =>
    sketchDrawing(data, options).entities.map((entity) => `${entity.kind}@${entity.layer}`);

test("by default every entity is written, construction on its own dashed layer, externals on theirs", () => {
    const drawing = sketchDrawing(DATA);
    expect(kinds(DATA)).toEqual(["line@0", "line@0_CONSTRUCTION", "circle@Guides", "line@EXTERNAL"]);
    expect(drawing.layers.find((layer) => layer.name === "0_CONSTRUCTION")?.dashed).toBe(true);
});

test("construction geometry and external references can be left out", () => {
    expect(kinds(DATA, { construction: false })).toEqual(["line@0", "circle@Guides", "line@EXTERNAL"]);
    expect(kinds(DATA, { construction: false, external: false })).toEqual(["line@0", "circle@Guides"]);
});

test("a layer filter keeps the named sketch layers only (construction rides with its layer)", () => {
    expect(kinds(DATA, { layers: ["Guides"], external: false })).toEqual(["circle@Guides"]);
    expect(kinds(DATA, { layers: ["0"], external: false })).toEqual(["line@0", "line@0_CONSTRUCTION"]);
    expect(kinds(DATA, { layers: ["0"], construction: false, external: false })).toEqual(["line@0"]);
    expect(kinds(DATA, { layers: ["Nope"], external: false })).toEqual([]);
});

/**
 * DATA plus colour overrides: a green line on layer 0, and a magenta line on layer 0 — the
 * colour the Guides layer gives its circle ByLayer.
 */
const COLORED: SketchData = {
    ...DATA,
    entities: [
        ...DATA.entities,
        { id: 4, type: "line", params: [0, 10, 10, 10], color: "#00ff00" },
        { id: 5, type: "line", params: [0, 15, 10, 15], color: "#FF00FF" },
    ],
};

describe("colour filter", () => {
    test.each<[string, Parameters<typeof sketchDrawing>[1], string[]]>([
        [
            "every colour",
            {},
            [
                "line@0",
                "line@0_CONSTRUCTION",
                "circle@Guides",
                "line@0_00ff00",
                "line@0_FF00FF",
                "line@EXTERNAL",
            ],
        ],
        [
            "magenta: the override on 0 and the circle ByLayer on Guides",
            { colors: ["#ff00ff"] },
            ["circle@Guides", "line@0_FF00FF"],
        ],
        [
            "layer 0's colour keeps its construction line too",
            { colors: ["#4A9EFF"] },
            ["line@0", "line@0_CONSTRUCTION"],
        ],
        ["… unless construction is off", { colors: ["#4a9eff"], construction: false }, ["line@0"]],
        ["external references are grey", { colors: ["#808080"] }, ["line@EXTERNAL"]],
        ["grey AND external off", { colors: ["#808080"], external: false }, []],
        ["magenta AND layer 0", { colors: ["#ff00ff"], layers: ["0"], external: false }, ["line@0_FF00FF"]],
        ["magenta AND layer Guides", { colors: ["#ff00ff"], layers: ["Guides"] }, ["circle@Guides"]],
        ["green or grey", { colors: ["#00ff00", "#808080"] }, ["line@0_00ff00", "line@EXTERNAL"]],
        ["no colours", { colors: [] }, []],
    ])("%s", (_name, options, expected) => {
        expect(kinds(COLORED, options)).toEqual(expected);
    });

    test("the DXF keeps only the chosen colour's geometry, on layers of that colour", () => {
        const text = writeDxf(sketchDrawing(COLORED, { colors: ["#ff00ff"] }));
        const dxf = readDxf(text);
        expect(dxf.entities.map((entity) => `${entity.type}@${entity.layer}`)).toEqual([
            "CIRCLE@Guides",
            "LINE@0_FF00FF",
        ]);
        // Both layers are written in magenta's index (6); the emptied layers are gone (the
        // always-empty SKETCH layer stays, as without a filter).
        expect(dxf.layers).toEqual(["0", "SKETCH", "Guides", "0_FF00FF"]);
        expect(text).toContain("LAYER\n  2\nGuides\n 70\n0\n 62\n6\n");
        expect(text).toContain("LAYER\n  2\n0_FF00FF\n 70\n0\n 62\n6\n");
    });

    test("the SVG keeps only the chosen colour's geometry, stroked in it", () => {
        const svg = writeSvg(sketchDrawing(COLORED, { colors: ["#00ff00", "#808080"] }));
        expect(svg).toMatch(/<g id="0_00ff00"[^>]* stroke="#00ff00"/);
        expect(svg).toMatch(/<g id="EXTERNAL"[^>]* stroke="#808080"[^>]*stroke-dasharray/);
        expect(svg.match(/<line /g)).toHaveLength(2);
        expect(svg).not.toContain("<circle");
        expect(svg).not.toContain('id="Guides"');
        expect(svg).not.toContain("#4a9eff");
    });
});

describe("ExportSketchCommand", () => {
    const files: DownloadedFile[] = [];

    beforeEach(() => {
        files.length = 0;
        setDownloadDelivery((file) => {
            files.push(file);
            return true;
        });
    });
    afterEach(() => setDownloadDelivery(undefined));

    type Settings = Pick<ExportSketchCommand, "format" | "layers" | "colors">;
    type Switches = Pick<ExportSketchCommand, "includeConstruction" | "includeExternal">;

    async function exportSketch(settings: Settings & Partial<Switches>) {
        const document = new TestDocument({ application: createMockApplication() });
        const sketch = new SketchNode({ document, plane: Plane.XY, data: COLORED });
        sketch.name = "Plate";
        const command = Object.assign(new ExportSketchCommand(), settings);
        (command as any).stepDatas = [{ nodes: [sketch] }];
        (command as any).executeMainTask();
        expect(files).toHaveLength(1);
        expect(files[0].name).toBe(`Plate${settings.format}`);
        return await files[0].blob.text();
    }

    test.each<[string, string, string, string[]]>([
        [
            "every colour",
            "",
            "",
            ["LINE@0", "CIRCLE@Guides", "LINE@0_00ff00", "LINE@0_FF00FF", "LINE@EXTERNAL"],
        ],
        ["magenta", "#FF00FF", "", ["CIRCLE@Guides", "LINE@0_FF00FF"]],
        ["magenta on Guides", " #ff00ff ,", "Guides", ["CIRCLE@Guides"]],
        ["green and grey", "#00ff00, #808080", "", ["LINE@0_00ff00", "LINE@EXTERNAL"]],
    ])("writes the DXF filtered by its colour list: %s", async (_name, colors, layers, expected) => {
        const text = await exportSketch({ format: ".dxf", colors, layers });
        expect(readDxf(text).entities.map((entity) => `${entity.type}@${entity.layer}`)).toEqual(expected);
    });

    test("writes the SVG filtered by colour together with construction and external", async () => {
        const svg = await exportSketch({
            format: ".svg",
            layers: "",
            colors: "#4a9eff,#808080",
            includeConstruction: true,
            includeExternal: false,
        });
        expect(svg).toMatch(/<g id="0"[^>]* stroke="#4a9eff"/);
        expect(svg).toMatch(/<g id="0_CONSTRUCTION"[^>]* stroke="#4a9eff"/);
        expect(svg).not.toContain('id="EXTERNAL"');
        expect(svg).not.toContain("<circle");
        expect(svg.match(/<line /g)).toHaveLength(2);
    });
});
