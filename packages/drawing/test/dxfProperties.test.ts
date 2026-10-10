// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Drawing } from "../src/drawing";
import { readDxf, writeDxf } from "../src/dxf";

const DRAWING: Drawing = {
    layers: [{ name: "SKETCH", aci: 7, color: "#000" }],
    entities: [{ kind: "line", layer: "SKETCH", a: [0, 0], b: [10, 0] }],
};

describe("DXF properties", () => {
    test("properties travel as leading comments and custom header properties, and the file still reads", () => {
        const text = writeDxf(DRAWING, {
            properties: { document: "End Cap", OD: '9 5/8"', note: "two\nlines" },
        });
        expect(text.startsWith('999\ndocument=End Cap\n999\nOD=9 5/8"\n999\nnote=two lines\n')).toBe(true);
        expect(text).toContain("$CUSTOMPROPERTYTAG\n  1\ndocument\n  9\n$CUSTOMPROPERTY\n  1\nEnd Cap");
        const back = readDxf(text);
        expect(back.entities).toHaveLength(1);
    });

    test("without properties the file is unchanged", () => {
        expect(writeDxf(DRAWING)).toBe(writeDxf(DRAWING, {}));
        expect(writeDxf(DRAWING).startsWith("  0\nSECTION")).toBe(true);
    });
});
