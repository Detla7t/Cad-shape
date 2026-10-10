// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    closeParentheses,
    cycleAbsolute,
    formulaReferences,
    insertReference,
    referenceAt,
    referenceInsertion,
    referenceRange,
    referenceText,
    sheetPrefix,
} from "../src/formulaPointing";

test("a reference may follow the =, an operator, a parenthesis or a separator — not typed text", () => {
    expect(referenceInsertion("=", 1)).toEqual({ start: 1, end: 1 });
    expect(referenceInsertion("=A1+", 4)).toEqual({ start: 4, end: 4 });
    expect(referenceInsertion("=SUM(", 5)).toEqual({ start: 5, end: 5 });
    expect(referenceInsertion("=SUM(A1, ", 9)).toEqual({ start: 9, end: 9 });
    expect(referenceInsertion("=A1*2", 5)).toBeUndefined();
    expect(referenceInsertion("=A1", 3)).toBeUndefined();
    expect(referenceInsertion("hello", 5)).toBeUndefined();
    // a selection is replaced as a whole
    expect(referenceInsertion("=(A1)", 2, 4)).toEqual({ start: 2, end: 4 });
});

test("reference text names a cell, a range, and another sheet (quoted when it must be)", () => {
    expect(referenceText({ row: 0, col: 0 })).toBe("A1");
    expect(referenceText({ row: 2, col: 1 }, { row: 0, col: 3 })).toBe("B1:D3");
    expect(referenceText({ row: 0, col: 0 }, undefined, "Sheet2")).toBe("Sheet2!A1");
    expect(referenceText({ row: 0, col: 0 }, { row: 1, col: 0 }, "My sheet")).toBe("'My sheet'!A1:A2");
    expect(sheetPrefix("Bob's")).toBe("'Bob''s'");
    expect(sheetPrefix("A1")).toBe("'A1'");
    expect(insertReference("=SUM(A1)+", { start: 9, end: 9 }, "B2:B4")).toEqual({
        text: "=SUM(A1)+B2:B4",
        span: { start: 9, end: 14 },
    });
    expect(insertReference("=A1+B2", { start: 4, end: 6 }, "C3")).toEqual({
        text: "=A1+C3",
        span: { start: 4, end: 6 },
    });
});

test("the range finder lists every reference, skipping strings, names and function names", () => {
    const refs = formulaReferences(`=SUM(a1:b2, Sheet2!C3, 'My sheet'!$D$4)+LOG10(rate)+"E5"+E6`);
    expect(refs.map((ref) => [ref.text, ref.sheet ?? null, ref.cells])).toEqual([
        ["a1:b2", null, "A1:B2"],
        ["Sheet2!C3", "Sheet2", "C3"],
        ["'My sheet'!$D$4", "My sheet", "$D$4"],
        ["E6", null, "E6"],
    ]);
    expect(refs[0]).toMatchObject({ start: 5, end: 10 });
    expect(referenceAt("=A1+B2", 5)?.text).toBe("B2");
    expect(referenceAt("=A1+B2", 3)?.text).toBe("A1");
    // the caret touching a reference's first character is that reference's
    expect(referenceAt("=A1+B2", 4)?.text).toBe("B2");
    expect(referenceAt("=A1+B2", 0)).toBeUndefined();
    expect(formulaReferences("A1+B2")).toEqual([]);
    expect(referenceRange("$B$2:A1")).toEqual({ start: { row: 0, col: 0 }, end: { row: 1, col: 1 } });
    expect(referenceRange("ZZZZ1")).toBeUndefined();
});

test("F4 cycles the anchors and Enter closes what was left open", () => {
    const cycle = ["A1", "$A$1", "A$1", "$A1", "A1"];
    for (let i = 0; i < 4; i++) expect(cycleAbsolute(cycle[i])).toBe(cycle[i + 1]);
    expect(cycleAbsolute("A1:B2")).toBe("$A$1:$B$2");
    expect(closeParentheses("=SUM(A1:A2")).toBe("=SUM(A1:A2)");
    expect(closeParentheses("=IF(A1>0, SUM(B1:B2")).toBe("=IF(A1>0, SUM(B1:B2))");
    expect(closeParentheses('=LEN("(")')).toBe('=LEN("(")');
    expect(closeParentheses("(not a formula")).toBe("(not a formula");
    expect(closeParentheses("=A1)")).toBe("=A1)");
});
