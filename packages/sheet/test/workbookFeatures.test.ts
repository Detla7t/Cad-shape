// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FormulaError, WorkbookEvaluator } from "../src/formula";
import { acceptFormulaCompletion, formulaCompletion } from "../src/formulaSuggestions";
import { cloneWorkbook, type WorkbookData } from "../src/model";
import { adjustDecimalPlaces } from "../src/numberFormat";
import {
    alternateColors,
    dropdownValues,
    setValidation,
    sortRange,
    translateFormula,
} from "../src/operations";
import { renameWorkbookSheet, resolveRanges, validRangeName, validSheetName } from "../src/ranges";
import { readXlsx, writeXlsx } from "../src/xlsx";

const workbook: WorkbookData = {
    sheets: [
        {
            name: "Bank Transactions",
            cells: {
                A1: { v: "Category" },
                B1: { v: "Amount" },
                C1: { v: "Double" },
                A2: { v: "Food" },
                B2: { v: 10 },
                C2: { f: "B2*2+$F$1", z: "0.00" },
                A3: { v: "Rent" },
                B3: { v: 50 },
                C3: { f: "B3*2+$F$1", z: "0.00" },
                A4: { v: "Fuel" },
                B4: { v: 20 },
                C4: { f: "B4*2+$F$1", z: "0.00" },
                F1: { v: 1 },
            },
            validations: {
                "A2:A4": {
                    type: "list",
                    formulae: ['"Food,Rent,Fuel"'],
                    showErrorMessage: true,
                    allowBlank: true,
                },
            },
            autoFilter: "A1:C4",
            frozen: { rows: 1, cols: 1 },
            hiddenRows: [2],
            hiddenCols: [4],
        },
        { name: "Report", cells: { A1: { f: "SUM(Expenses)" }, A2: { f: '"Bank Transactions!B2"' } } },
    ],
    names: [{ name: "Expenses", ranges: ["'Bank Transactions'!$B$2:$B$4"] }],
};

describe("spreadsheet workbook features", () => {
    test("decimal controls preserve scientific notation and literal unit labels", () => {
        expect(adjustDecimalPlaces("0.00E+00", 1)).toBe("0.000E+00");
        expect(adjustDecimalPlaces('0.00" 0 mm"', -1)).toBe('0.0" 0 mm"');
        expect(adjustDecimalPlaces("0", -1)).toBe("0");
    });
    test("named ranges evaluate in formulas, resolve case-insensitively, and detect circular references", () => {
        expect(new WorkbookEvaluator(workbook).value(1, "A1")).toBe(80);
        expect(resolveRanges(workbook, "expenses", 1)).toEqual([
            { sheet: 0, range: { start: { row: 1, col: 1 }, end: { row: 3, col: 1 } } },
        ]);
        const cyclic = cloneWorkbook(workbook);
        cyclic.sheets[0].cells["B2"] = { f: "SUM(Expenses)" };
        expect(new WorkbookEvaluator(cyclic).value(1, "A1")).toEqual(new FormulaError("#CIRC!"));
    });
    test("named-range suggestions insert a reference instead of a function call", () => {
        const completion = formulaCompletion("=SUM(Exp", 8, ["Expenses"]);
        expect(completion?.names).toEqual(["EXP", "EXPAND", "Expenses"]);
        expect(acceptFormulaCompletion("=SUM(Exp", completion!, "Expenses").text).toBe("=SUM(Expenses");
    });
    test.each(["A1", "R", "C", "R2C3", "1abc", "Some name", "TRUE"])("invalid name %s is rejected", (name) =>
        expect(validRangeName(name)).toBe(false));
    test("valid names and sheet names follow Excel rules", () => {
        expect(validRangeName("Expenses_2026")).toBe(true);
        expect(validSheetName("Bank Transactions")).toBe(true);
        expect(validSheetName("Bank/Transactions")).toBe(false);
        expect(validSheetName("a".repeat(32))).toBe(false);
    });
    test("renaming a sheet updates names, formulas and validation sources, but not string literals", () => {
        const draft = cloneWorkbook(workbook);
        draft.sheets[1].cells["B1"] = { f: "'Bank Transactions'!B2" };
        draft.sheets[1].validations = { A3: { type: "list", formulae: ["'Bank Transactions'!A2:A4"] } };
        renameWorkbookSheet(draft, 0, "Owner's expenses");
        expect(draft.sheets[1].cells["B1"].f).toBe("'Owner''s expenses'!B2");
        expect(draft.sheets[1].cells["A2"].f).toBe('"Bank Transactions!B2"');
        expect(draft.sheets[1].validations["A3"].formulae).toEqual(["'Owner''s expenses'!A2:A4"]);
        expect(new WorkbookEvaluator(draft).value(1, "A1")).toBe(80);
        expect(dropdownValues(draft, 1, 2, 0)).toEqual(["Food", "Rent", "Fuel"]);
    });
    test("sort keeps complete rows and adjusts only relative formula references", () => {
        const draft = cloneWorkbook(workbook);
        expect(sortRange(draft, 0, { start: { row: 1, col: 0 }, end: { row: 3, col: 2 } }, 1, false)).toBe(
            true,
        );
        expect(draft.sheets[0].cells["A2"].v).toBe("Rent");
        expect(draft.sheets[0].cells["C2"]).toMatchObject({ f: "B2*2+$F$1", z: "0.00" });
        expect(new WorkbookEvaluator(draft).value(0, "C2")).toBe(101);
        expect(translateFormula("SUM(A2,$A2,A$2,$A$2,\"A2\",'A2'!B2)", 3, 1)).toBe(
            "SUM(B5,$A5,B$2,$A$2,\"A2\",'A2'!C5)",
        );
    });
    test("sorting a merged range is refused without modifying data", () => {
        const draft = cloneWorkbook(workbook);
        draft.sheets[0].merges = ["A2:B2"];
        const before = cloneWorkbook(draft);
        expect(sortRange(draft, 0, { start: { row: 1, col: 0 }, end: { row: 3, col: 2 } }, 1, true)).toBe(
            false,
        );
        expect(draft).toEqual(before);
    });
    test("replacing or removing part of a dropdown range preserves the surrounding rules in XLSX", async () => {
        const draft = cloneWorkbook(workbook);
        setValidation(
            draft.sheets[0],
            { start: { row: 2, col: 0 }, end: { row: 2, col: 0 } },
            { type: "list", formulae: ['"New,Other"'] },
        );
        const back = await readXlsx(await writeXlsx(draft));
        expect(dropdownValues(back, 0, 1, 0)).toEqual(["Food", "Rent", "Fuel"]);
        expect(dropdownValues(back, 0, 2, 0)).toEqual(["New", "Other"]);
        expect(dropdownValues(back, 0, 3, 0)).toEqual(["Food", "Rent", "Fuel"]);
        setValidation(back.sheets[0], { start: { row: 2, col: 0 }, end: { row: 2, col: 0 } });
        expect(dropdownValues(back, 0, 2, 0)).toBeUndefined();
        expect(dropdownValues(back, 0, 3, 0)).toEqual(["Food", "Rent", "Fuel"]);
    });
    test("XLSX round trip retains named ranges, dropdowns, banding, hidden rows/columns and frozen panes", async () => {
        const draft = cloneWorkbook(workbook);
        alternateColors(draft.sheets[0], { start: { row: 0, col: 0 }, end: { row: 3, col: 2 } }, "Rose");
        const back = await readXlsx(await writeXlsx(draft));
        expect(new WorkbookEvaluator(back).value(1, "A1")).toBe(80);
        expect(dropdownValues(back, 0, 1, 0)).toEqual(["Food", "Rent", "Fuel"]);
        expect(back.sheets[0]).toMatchObject({
            autoFilter: "A1:C4",
            hiddenRows: [2],
            hiddenCols: [4],
            frozen: { rows: 1, cols: 1 },
        });
        expect(back.sheets[0].cells["A1"].s?.fill).toEqual({
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFCA91A6" },
        });
        expect(back.sheets[0].cells["A2"].s?.fill).not.toEqual(back.sheets[0].cells["A3"].s?.fill);
    });
});
