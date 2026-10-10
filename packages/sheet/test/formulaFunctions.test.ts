// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FORMULA_FUNCTIONS, FormulaError, WorkbookEvaluator } from "../src/formula";
import { acceptFormulaCompletion, formulaArgumentHelp, formulaCompletion } from "../src/formulaSuggestions";
import { FUNCTION_INFO } from "../src/functionInfo";
import { cloneWorkbook, usedSize, type WorkbookData } from "../src/model";
import { readWorkbook, writeWorkbook } from "../src/workbookIo";

const fixture: WorkbookData = {
    sheets: [
        {
            name: "Budget",
            cells: {
                A1: { v: "Food" },
                A2: { v: "Rent" },
                A3: { v: "Food" },
                A4: { v: "Food*" },
                B1: { v: 10 },
                B2: { v: 50 },
                B3: { v: 30 },
                B4: { v: 20 },
                C1: { v: 2025 },
                C2: { v: 2025 },
                C3: { v: 2026 },
                C4: { v: 2025 },
            },
        },
    ],
};

const evalFormula = (formula: string) => new WorkbookEvaluator(fixture).evaluateFormula(formula);

describe("Excel function additions", () => {
    test.each([
        ['SUMIFS(B1:B4,A1:A4,"Food",C1:C4,2025)', 10],
        ['COUNTIFS(A1:A4,"Food",B1:B4,">15")', 1],
        ['AVERAGEIF(A1:A4,"Food",B1:B4)', 20],
        ['AVERAGEIFS(B1:B4,A1:A4,"Food",C1:C4,">2025")', 30],
        ['MINIFS(B1:B4,A1:A4,"Food*")', 10],
        ['MAXIFS(B1:B4,A1:A4,"Food")', 30],
        ['SUMIF(A1:A4,"Food~*",B1:B4)', 20],
        ["SUMPRODUCT(B1:B2,B3:B4)", 1300],
        ['XLOOKUP("Rent",A1:A4,B1:B4)', 50],
        ['XLOOKUP("Missing",A1:A4,B1:B4,"Absent")', "Absent"],
        ['XLOOKUP("Food",A1:A4,B1:B4,"",0,-1)', 30],
        ['XLOOKUP(25,B1:B4,A1:A4,"",-1)', "Food*"],
        ['XLOOKUP("Ren*",A1:A4,B1:B4,"",2)', 50],
        ['_xlfn.XLOOKUP("Rent",A1:A4,B1:B4)', 50],
        ["HLOOKUP(10,B1:C4,3,FALSE)", 30],
        ["IFNA(NA(),42)", 42],
        ["IFS(FALSE,1/0,TRUE,7)", 7],
        ["ISNUMBER(B1)&ISTEXT(A1)&ISBLANK(D1)&ISERROR(1/0)", "TRUETRUETRUETRUE"],
        ['TEXT(1234.5,"$#,##0.00")', "$1,234.50"],
        ['VALUE("$1,234.50")', 1234.5],
        ['TEXTJOIN(", ",TRUE,A1:A3)', "Food, Rent, Food"],
        ['SUBSTITUTE("a-b-b","b","x",2)', "a-b-x"],
        ['SEARCH("f?o","Seafood")', 4],
        ['FIND("o","Food",3)', 3],
        ['EXACT("Food","food")', false],
        ["TRUNC(-4.57,1)", -4.5],
        ["DATE(2025,1,1)", 45658],
        ["DATE(1900,2,29)", 60],
        ['TEXT(DATE(2025,1,31),"yyyy-mm-dd")', "2025-01-31"],
        ["DAY(EOMONTH(DATE(2024,1,31),1))", 29],
        ["DAY(EDATE(DATE(2025,1,31),1))", 28],
        ["YEAR(DATE(2025,1,1))", 2025],
        ["MONTH(DATE(2025,13,1))", 1],
        ["TIME(18,0,0)", 0.75],
        ["HOUR(TIME(18,15,20))", 18],
        ["MINUTE(TIME(18,15,20))", 15],
        ["SECOND(TIME(18,15,20))", 20],
        ["DAYS(DATE(2025,2,1),DATE(2025,1,1))", 31],
    ] as const)("%s", (formula, expected) => {
        expect(evalFormula(formula)).toBe(expected);
    });

    test.each([
        ['AVERAGEIFS(B1:B4,A1:A4,"Nope")', "#DIV/0!"],
        ['SUMIFS(B1:B4,A1:A2,"Food")', "#VALUE!"],
        ["COUNTIFS(A1:A4)", "#VALUE!"],
        ['XLOOKUP("Rent",A1:A4,B1:B2)', "#VALUE!"],
        ["IFNA(1/0,42)", "#DIV/0!"],
        ['SUBSTITUTE("a")', "#VALUE!"],
        ["DATE(-2,1,1)", "#NUM!"],
        ['FIND("absent","Food")', "#VALUE!"],
    ] as const)("%s propagates %s", (formula, code) => {
        expect(evalFormula(formula)).toEqual(new FormulaError(code));
    });

    test("every offered function has a documented signature and every signature is executable", () => {
        expect(Object.keys(FUNCTION_INFO).sort()).toEqual(FORMULA_FUNCTIONS);
    });
});

describe("formula suggestions", () => {
    test("completes nested functions and preserves the text after the cursor", () => {
        const text = "=IF(A1>0,su(A1:A4),0)";
        const completion = formulaCompletion(text, 11)!;
        expect(completion.names).toContain("SUMIFS");
        expect(acceptFormulaCompletion(text, completion, "SUM")).toEqual({
            text: "=IF(A1>0,SUM(A1:A4),0)",
            cursor: 13,
        });
        expect(formulaArgumentHelp("=IF(A1>0,SUM(B1:B4),")).toEqual({ name: "IF", argument: 2 });
        expect(formulaArgumentHelp('=TEXTJOIN(",",TRUE,')).toEqual({ name: "TEXTJOIN", argument: 2 });
    });
    test.each([
        "sum",
        "=A12",
        "=Sheet!",
        '=SUM("su',
        "='su",
        '=A1+"SUM"',
        "='Sales'!SU",
    ])("does not complete literals or references: %s", (text) => {
        expect(formulaCompletion(text)).toBeUndefined();
    });
});

describe("spreadsheet style round trips", () => {
    const styled = (): WorkbookData => ({
        sheets: [
            {
                name: "Styled",
                cells: {
                    A1: {
                        v: "Report",
                        s: {
                            font: {
                                name: "Arial",
                                size: 16,
                                bold: true,
                                italic: true,
                                underline: true,
                                color: { argb: "FF17365D" },
                            },
                            fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEEFF" } },
                            alignment: { horizontal: "center", vertical: "middle", wrapText: true },
                            border: { bottom: { style: "double", color: { argb: "FF000000" } } },
                        },
                    },
                    A2: { v: 1234.5, z: '"$"#,##0.00' },
                    D8: { s: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } } } },
                },
                merges: ["A1:C1"],
                rows: { 0: 42 },
            },
        ],
    });

    test("formatting extends the visible grid without adding empty rows to CSV data", () => {
        const workbook = styled();
        expect(usedSize(workbook.sheets[0])).toEqual({ rows: 2, cols: 1 });
        expect(usedSize(workbook.sheets[0], true)).toEqual({ rows: 8, cols: 4 });
    });

    test("XLSX preserves styling on values and empty cells, row height and merges; drafts are isolated", async () => {
        const workbook = styled();
        const draft = cloneWorkbook(workbook);
        draft.sheets[0].cells["A1"].s!.font!.bold = false;
        expect(workbook.sheets[0].cells["A1"].s!.font!.bold).toBe(true);
        const bytes = await writeWorkbook(workbook, "xlsx");
        expect(bytes.isOk).toBe(true);
        const back = await readWorkbook(bytes.value, "xlsx");
        expect(back.isOk).toBe(true);
        expect(back.value.sheets[0].cells["A1"]).toMatchObject(workbook.sheets[0].cells["A1"]);
        expect(back.value.sheets[0].cells["D8"].s?.fill).toEqual(workbook.sheets[0].cells["D8"].s?.fill);
        expect(back.value.sheets[0].rows?.[0]).toBe(42);
        expect(back.value.sheets[0].merges).toEqual(["A1:C1"]);
    });
});
