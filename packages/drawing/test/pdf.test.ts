// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Drawing, writePdf } from "../src";

const drawing: Drawing = {
    units: "inch",
    layers: [
        { name: "Visible", aci: 7, color: "#000000" },
        { name: "Bend", aci: 1, color: "#ff0000", dashed: true },
    ],
    entities: [
        { kind: "line", layer: "Visible", a: [0, 0], b: [4, 0] },
        { kind: "arc", layer: "Bend", center: [2, 0], radius: 2, startAngle: 0, endAngle: 180 },
        { kind: "circle", layer: "Visible", center: [2, 1], radius: 0.5 },
        { kind: "text", layer: "Visible", position: [2, 2.5], height: 0.25, rotation: 0, text: "Cap (A)" },
    ],
};

const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

test("the page is the drawing's bounds plus the margin, at 72 points per inch", () => {
    const text = latin1(writePdf(drawing, { title: "End Cap", margin: 0.5 }));
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    // bounds x 0..4, y 0..2.5 plus text ≈ 2.625; one inch of margin in all → width 5 in = 360 pt
    expect(text).toContain("/MediaBox [0 0 360 ");
    expect(text).toContain("/Title (End Cap)");
    expect(text).toContain("/BaseFont /Helvetica");
    // the line from (0, 0) to (4, 0) sits at the margin: 36 pt in, 36 pt up, 324 pt long
    expect(text).toContain("36 36 m 324 36 l S");
    // the bend layer is red and dashed, the visible layer black and solid
    expect(text).toContain("1 0 0 RG 1 0 0 rg\n[");
    expect(text).toContain("0 0 0 RG 0 0 0 rg\n[] 0 d");
    // the half circle is two quarter Béziers, the circle four
    expect(text.match(/ c\n/g)?.length).toBe(2 + 4);
    expect(text).toContain("(Cap \\(A\\)) Tj");
});

test("the cross-reference table points at every object and the trailer at the table", () => {
    const bytes = writePdf(drawing);
    const text = latin1(bytes);
    expect(bytes.length).toBe(text.length);
    const xrefAt = text.lastIndexOf("\nxref\n") + 1;
    expect(text).toContain(`startxref\n${xrefAt}\n%%EOF`);
    const entries = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(6);
    entries.forEach((offset, index) => {
        expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
    const length = Number(/\/Length (\d+)/.exec(text)![1]);
    const stream = text.slice(text.indexOf("stream\n") + 7, text.indexOf("\nendstream"));
    expect(stream.length).toBe(length);
});

test("millimetre drawings scale by 72/25.4 and non-Latin text degrades to a question mark", () => {
    const text = latin1(
        writePdf({
            units: "mm",
            layers: [{ name: "0", aci: 7, color: "#123456" }],
            entities: [
                { kind: "line", layer: "0", a: [0, 0], b: [25.4, 0] },
                { kind: "text", layer: "0", position: [10, 10], height: 3, rotation: 90, text: "é→" },
            ],
        }),
    );
    // 25.4 mm plus two 5 mm margins is 35.4 mm = 100.346 pt wide
    expect(text).toContain("/MediaBox [0 0 100.346 ");
    expect(text).toContain("14.173 14.173 m 86.173 14.173 l S");
    expect(text).toContain("0.071 0.204 0.337 RG");
    expect(text).toContain("(\\351?) Tj");
    expect(text).toContain("0 1 -1 0 ");
});
