// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FORMULA_FUNCTIONS } from "../src/formula";
import { insertFunctionCall } from "../src/formulaSuggestions";
import { FUNCTION_INFO, functionCategory, functionDoc, searchFunctions } from "../src/functionInfo";

describe("function reference data", () => {
    const docs = ["SUM", "SUMIF", "SUMSQ", "ISNUMBER", "VLOOKUP", "NORM.DIST", "SQRT", "TODAY"].map(
        functionDoc,
    );

    test("every evaluated function has an explicit category and a description", () => {
        const uncategorized = FORMULA_FUNCTIONS.filter((name) => functionCategory(name) === "Other");
        expect(uncategorized).toEqual([]);
        expect(FORMULA_FUNCTIONS.filter((name) => functionDoc(name).description === "")).toEqual([]);
    });

    test("the engine's arity metadata keeps its tuple layout", () => {
        expect(FUNCTION_INFO["ROUND"][2]).toBe(1);
        expect(FUNCTION_INFO["ROUND"][3]).toBe(2);
    });

    test("arguments carry optional/repeating flags and notes", () => {
        const sumif = functionDoc("SUMIF");
        expect(sumif.category).toBe("Math & trig");
        expect(sumif.args.map((a) => [a.name, a.optional])).toEqual([
            ["range", false],
            ["criteria", false],
            ["sum_range", true],
        ]);
        expect(sumif.args[1].description).toContain("wildcards");
        const sum = functionDoc("SUM");
        expect(sum.args[1]).toMatchObject({ name: "number2", optional: true, repeating: true });
        expect(sum.example).toBe("=SUM(A1:A10)");
        expect(functionDoc("TODAY").zeroArgs).toBe(true);
        expect(functionDoc("SUM").zeroArgs).toBe(false);
    });

    test.each([
        ["SUM", ["SUM", "SUMIF", "SUMSQ"]],
        ["vlk", ["VLOOKUP"]],
        ["dist", ["NORM.DIST"]],
        ["square root", ["SQRT"]],
        ["number", ["ISNUMBER"]],
    ])("search %s ranks names before descriptions", (query, expected) => {
        expect(
            searchFunctions(docs, query)
                .map((d) => d.name)
                .slice(0, expected.length),
        ).toEqual(expected);
    });

    test("the category filter combines with the search", () => {
        expect(searchFunctions(docs, "", "Information").map((d) => d.name)).toEqual(["ISNUMBER"]);
        expect(searchFunctions(docs, "sum", "Information")).toEqual([]);
        expect(searchFunctions(docs, "").map((d) => d.name)).toEqual([...docs.map((d) => d.name)].sort());
    });

    test.each([
        ["=", 1, "SUM", {}, "=SUM()", 5],
        ["=VL", 3, "VLOOKUP", { names: ["VLOOKUP"] }, "=VLOOKUP()", 9],
        ["=SU(A1)", 3, "SUM", { names: ["SUM"] }, "=SUM(A1)", 5],
        ["=A1+", 4, "ROUND", { names: ["ROUND"] }, "=A1+ROUND()", 10],
        ["=12", 1, "ROUND", { wrapRest: true }, "=ROUND(12)", 9],
        ["=", 1, "TODAY", { zeroArgs: true }, "=TODAY()", 8],
        ["=A1", 3, "ABS", { names: ["ABS"] }, "=A1ABS()", 7],
    ])("insert into %s at %i: %s", (text, cursor, name, options, expected, caret) => {
        expect(insertFunctionCall(text, cursor, name, options)).toEqual({ text: expected, cursor: caret });
    });
});
