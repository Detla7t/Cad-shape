// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { sketchDrawing } from "../../src/sketch/sketchDrawing";
import type { SketchData } from "../../src/sketch/sketchModel";

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
