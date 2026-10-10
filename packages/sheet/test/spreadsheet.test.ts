// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { detectFileFormat } from "@chili3d/core";
import { detectDelimiter, parseCsv, writeCsv } from "../src/csv";
import { FormulaError, parseFormula, WorkbookEvaluator } from "../src/formula";
import { cellFromInput, columnIndex, columnName, parseRange, type WorkbookData } from "../src/model";
import { formatCellValue } from "../src/numberFormat";
import { excelToOdfFormula, odfToExcelFormula } from "../src/ods";
import { readWorkbook, writeWorkbook, XLS_UNSUPPORTED } from "../src/workbookIo";

function book(
    cells: Record<string, string>,
    more: Record<string, Record<string, string>> = {},
): WorkbookData {
    const sheet = (name: string, input: Record<string, string>) => ({
        name,
        cells: Object.fromEntries(
            Object.entries(input).map(([address, text]) => [address, cellFromInput(text)!]),
        ),
    });
    return {
        sheets: [sheet("Sheet1", cells), ...Object.entries(more).map(([name, input]) => sheet(name, input))],
    };
}

const value = (workbook: WorkbookData, address: string, sheet = 0) =>
    new WorkbookEvaluator(workbook).value(sheet, address);

describe("formula engine", () => {
    test.each([
        ["=1+2*3", 7],
        ["=(1+2)*3", 9],
        ["=-2^2", 4],
        ["=2^3^2", 64],
        ["=10/4", 2.5],
        ["=50%", 0.5],
        ['="a"&1&TRUE', "a1TRUE"],
        ["=1<2", true],
        ['="abc"="ABC"', true],
        ["=ROUND(2.345, 2)", 2.35],
        ["=ROUNDDOWN(-2.7)", -2],
        ["=MOD(-7, 3)", 2],
        ['=IF(1>2, 1/0, "no")', "no"],
        ["=IFERROR(1/0, -1)", -1],
        ["=AND(TRUE, 1)", true],
        ['=CONCATENATE("x", 2)', "x2"],
        ['=LEN(TRIM("  a  b "))', 3],
        ['=LEFT("chili", 3)&RIGHT("chili", 2)', "chili"],
        ["=SQRT(16)+ABS(-1)+INT(2.9)", 7],
        ["=POWER(2, 10)", 1024],
    ] as const)("%s = %s", (formula, expected) => {
        expect(value(book({ A1: formula }), "A1")).toBe(expected);
    });

    test("references, ranges and aggregates", () => {
        const workbook = book({
            A1: "1",
            A2: "2",
            A3: "3",
            A4: "text",
            B1: "=A1+A2",
            B2: "=SUM(A1:A4)",
            B3: "=AVERAGE(A1:A3)",
            B4: "=MIN(A1:A3)*10+MAX(A1:A3)",
            B5: '=COUNT(A1:A4)&"/"&COUNTA(A1:A4)',
            B6: "=SUM(A:A)",
            B7: "=$A$1+A$2",
            B8: "=PRODUCT(A1:A3)",
            B9: "=MEDIAN(A1:A3, 10)",
        });
        expect(
            ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9"].map((address) => value(workbook, address)),
        ).toEqual([3, 6, 2, 13, "3/4", 6, 3, 6, 2.5]);
    });

    test("cross-sheet references, quoted sheet names and lookups", () => {
        const workbook = book(
            {
                A1: "='Cut list'!B2*2",
                A2: "=VLOOKUP(\"bolt\", 'Cut list'!A1:B3, 2, FALSE)",
                A3: "=INDEX('Cut list'!A1:B3, 3, 1)",
            },
            { "Cut list": { A1: "nut", B1: "4", A2: "bolt", B2: "12", A3: "washer", B3: "8" } },
        );
        expect(value(workbook, "A1")).toBe(24);
        expect(value(workbook, "A2")).toBe(12);
        expect(value(workbook, "A3")).toBe("washer");
        expect(value(book({ A1: "=Missing!A1" }), "A1")).toEqual(new FormulaError("#REF!"));
    });

    test("SUMIF, COUNTIF and MATCH", () => {
        const workbook = book({
            A1: "3",
            A2: "8",
            A3: "12",
            B1: "a",
            B2: "b",
            B3: "a",
            C1: '=SUMIF(A1:A3, ">5")',
            C2: '=COUNTIF(B1:B3, "a")',
            C3: '=SUMIF(B1:B3, "a", A1:A3)',
            C4: "=MATCH(8, A1:A3, 0)",
        });
        expect(["C1", "C2", "C3", "C4"].map((address) => value(workbook, address))).toEqual([20, 2, 15, 2]);
    });

    test("errors: division by zero, bad values, unknown functions, cycles", () => {
        const workbook = book({
            A1: "=1/0",
            A2: '="x"+1',
            A3: "=NOPE(1)",
            A4: "=A5",
            A5: "=A4+1",
            A6: "=A1+1",
        });
        expect(value(workbook, "A1")).toEqual(new FormulaError("#DIV/0!"));
        expect(value(workbook, "A2")).toEqual(new FormulaError("#VALUE!"));
        expect(value(workbook, "A3")).toEqual(new FormulaError("#NAME?"));
        expect(value(workbook, "A4")).toEqual(new FormulaError("#CIRC!"));
        expect(value(workbook, "A6")).toEqual(new FormulaError("#DIV/0!"));
        expect(() => parseFormula("SUM(1,")).toThrow();
    });

    test("an unsupported function keeps the value the file stored", () => {
        const workbook: WorkbookData = {
            sheets: [{ name: "S", cells: { A1: { f: 'GETPIVOTDATA("Income",B1)', v: 0.125 } } }],
        };
        expect(value(workbook, "A1")).toBe(0.125);
    });
});

describe("cell input and addresses", () => {
    test("typed input becomes numbers, percentages, booleans, formulas or text", () => {
        expect(cellFromInput("42")).toEqual({ v: 42 });
        expect(cellFromInput("-1.5e3")).toEqual({ v: -1500 });
        expect(cellFromInput("12.5%")).toEqual({ v: 0.125, z: "0%" });
        expect(cellFromInput("true")).toEqual({ v: true });
        expect(cellFromInput("=A1*2")).toEqual({ f: "A1*2" });
        expect(cellFromInput("M8 bolt")).toEqual({ v: "M8 bolt" });
        expect(cellFromInput("")).toBeUndefined();
    });

    test("column names and ranges", () => {
        expect([0, 25, 26, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
        expect(columnIndex("AB")).toBe(27);
        expect(parseRange("$B$2:A1")).toEqual({ start: { row: 0, col: 0 }, end: { row: 1, col: 1 } });
        expect(parseRange("B:C", { rows: 5, cols: 9 })).toEqual({
            start: { row: 0, col: 1 },
            end: { row: 4, col: 2 },
        });
        expect(parseRange("nonsense")).toBeUndefined();
    });
});

describe("number formats", () => {
    test.each([
        [1234.5, "#,##0.00", "1,234.50"],
        [0.256, "0.0%", "25.6%"],
        [-3, "0.00", "-3.00"],
        [-3, '0.00;"("0.00")"', "(3.00)"],
        [1234567, "#,##0,", "1,235"],
        [12345.678, "0.00E+00", "1.23E+04"],
        [3.5, '0.0" mm"', "3.5 mm"],
        [45658, "yyyy-mm-dd", "2025-01-01"],
        [0.75, "hh:mm", "18:00"],
        [0.75, "h:mm AM/PM", "6:00 PM"],
        [0.5, "General", "0.5"],
        [1 / 3, undefined, "0.333333333333333"],
    ] as const)("%s with %s is %s", (input, format, expected) => {
        expect(formatCellValue(input, format)).toBe(expected);
    });

    test("text sections and booleans", () => {
        expect(formatCellValue("abc", '0;-0;0;"Part "@')).toBe("Part abc");
        expect(formatCellValue(true, "0.00")).toBe("TRUE");
    });
});

describe("CSV", () => {
    test("quotes, doubled quotes, embedded delimiters and line breaks", () => {
        const text = 'name,note\r\n"Smith, J.","said ""hi""\nthen left"\r\nplain,\r\n';
        expect(parseCsv(text)).toEqual([
            ["name", "note"],
            ["Smith, J.", 'said "hi"\nthen left'],
            ["plain", ""],
        ]);
        expect(parseCsv(writeCsv(parseCsv(text)))).toEqual(parseCsv(text));
    });

    test("the delimiter is detected", () => {
        expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
        expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
        expect(detectDelimiter("a,b\n1,2\n")).toBe(",");
    });

    test("a CSV round trip evaluates formulas and keeps leading zeros", async () => {
        const csv = new TextEncoder().encode("part,qty,price,total\n007,2,1.5,=B2*C2\nbolt,10,0.25,=B3*C3\n");
        const workbook = await readWorkbook(csv, "csv", "Parts");
        expect(workbook.isOk).toBe(true);
        const sheet = workbook.value.sheets[0];
        expect(sheet.name).toBe("Parts");
        expect(sheet.cells["A2"]).toEqual({ v: "007" });
        expect(sheet.cells["D2"]).toEqual({ f: "B2*C2" });
        expect(value(workbook.value, "D3")).toBe(2.5);
        const written = await writeWorkbook(workbook.value, "csv");
        expect(new TextDecoder().decode(written.value)).toBe(
            "part,qty,price,total\r\n007,2,1.5,3\r\nbolt,10,0.25,2.5\r\n",
        );
    });
});

describe("workbook files (XLSX through ExcelJS, ODS)", () => {
    const sample = (): WorkbookData => ({
        sheets: [
            {
                name: "Dims",
                cells: {
                    A1: { v: "width" },
                    B1: { v: 120, z: "0.00" },
                    A2: { v: "height" },
                    B2: { v: 80 },
                    A3: { v: "area" },
                    B3: { f: "B1*B2", z: "#,##0" },
                    A4: { v: "ratio" },
                    B4: { f: "B1/B2", z: "0.0%" },
                    A5: { v: "ok" },
                    B5: { v: true },
                },
                cols: [140, null, 60],
            },
            { name: "Other sheet", cells: { A1: { f: "Dims!B3/100" } } },
        ],
    });

    test("XLSX round trip keeps values, formulas, number formats, widths and sheets", async () => {
        const bytes = await writeWorkbook(sample(), "xlsx");
        expect(bytes.isOk).toBe(true);
        expect(detectFileFormat("dims.bin", bytes.value)).toMatchObject({ id: "xlsx", by: "content" });
        const back = await readWorkbook(bytes.value, "xlsx");
        expect(back.isOk).toBe(true);
        const [dims, other] = back.value.sheets;
        expect(back.value.sheets.map((sheet) => sheet.name)).toEqual(["Dims", "Other sheet"]);
        expect(dims.cells["B1"]).toMatchObject({ v: 120, z: "0.00" });
        // Formulas come back with the evaluated result cached, for readers that do not recalculate.
        expect(dims.cells["B3"]).toMatchObject({ f: "B1*B2", v: 9600, z: "#,##0" });
        expect(dims.cells["B4"]).toMatchObject({ f: "B1/B2", v: 1.5 });
        expect(dims.cells["B5"]).toMatchObject({ v: true });
        expect(other.cells["A1"]).toMatchObject({ f: "Dims!B3/100", v: 96 });
        expect(dims.cols?.[0]).toBe(140);
        expect(dims.cols?.[2]).toBe(60);
        const evaluator = new WorkbookEvaluator(back.value);
        expect(formatCellValue(evaluator.value(0, "B3") as number, dims.cells["B3"].z)).toBe("9,600");
        expect(formatCellValue(evaluator.value(0, "B4") as number, dims.cells["B4"].z)).toBe("150.0%");
    });

    test("ODS round trip keeps values and formulas", async () => {
        const bytes = await writeWorkbook(sample(), "ods");
        expect(detectFileFormat("dims.ods", bytes.value)).toMatchObject({ id: "ods", by: "content" });
        const back = await readWorkbook(bytes.value, "ods");
        expect(back.isOk).toBe(true);
        expect(back.value.sheets[0].cells["B3"]).toMatchObject({ f: "B1*B2", v: 9600 });
        expect(new WorkbookEvaluator(back.value).value(1, "A1")).toBe(96);
    });

    test("ODS keeps number formats, column widths and merges; dates and booleans by type", async () => {
        const workbook: WorkbookData = {
            sheets: [
                {
                    name: "Plan",
                    cells: {
                        A1: { v: "Title" },
                        A2: { v: 0.25, z: "0.0%" },
                        B2: { v: 1234.5, z: "#,##0.00" },
                        C2: { v: 45658, z: "yyyy-mm-dd" },
                        D2: { v: false },
                        E2: { v: "line one\nline two" },
                    },
                    cols: [150, 80],
                    merges: ["A1:C1"],
                },
            ],
        };
        const back = await readWorkbook((await writeWorkbook(workbook, "ods")).value, "ods");
        expect(back.isOk).toBe(true);
        const sheet = back.value.sheets[0];
        expect(sheet.cells["A2"]).toEqual({ v: 0.25, z: "0.0%" });
        expect(sheet.cells["B2"]).toEqual({ v: 1234.5, z: "#,##0.00" });
        expect(sheet.cells["C2"]).toEqual({ v: 45658, z: "yyyy-mm-dd" });
        expect(sheet.cells["D2"]).toEqual({ v: false });
        expect(sheet.cells["E2"]).toEqual({ v: "line one\nline two" });
        expect(sheet.cols?.slice(0, 2)).toEqual([150, 80]);
        expect(sheet.merges).toEqual(["A1:C1"]);
    });

    test("ODS text with control characters XML cannot carry still writes a readable file", async () => {
        const workbook: WorkbookData = {
            sheets: [
                { name: "Tab\u0001", cells: { A1: { v: "bell\u0007 & <tag>" }, A2: { v: "tab\tkept" } } },
            ],
        };
        const back = await readWorkbook((await writeWorkbook(workbook, "ods")).value, "ods");
        expect(back.isOk).toBe(true);
        expect(back.value.sheets[0].name).toBe("Tab");
        expect(back.value.sheets[0].cells["A1"]).toEqual({ v: "bell & <tag>" });
        expect(back.value.sheets[0].cells["A2"]).toEqual({ v: "tab\tkept" });
    });

    test("OpenFormula and Excel formula syntax translate both ways", () => {
        expect(odfToExcelFormula("of:=SUM([.A1:.B2];[Sheet2.C3])*2")).toBe("SUM(A1:B2,Sheet2!C3)*2");
        expect(odfToExcelFormula("of:=['My Sheet'.$A$1]&\";[.X1]\"")).toBe("'My Sheet'!$A$1&\";[.X1]\"");
        expect(excelToOdfFormula("SUM(A1:B2,Sheet2!C3)*2")).toBe("of:=SUM([.A1:.B2];[Sheet2.C3])*2");
        expect(excelToOdfFormula("IF(A1>0,\"a,b\",'Cut list'!B$2)")).toBe(
            "of:=IF([.A1]>0;\"a,b\";['Cut list'.B$2])",
        );
        expect(odfToExcelFormula(excelToOdfFormula("ROUND(AVERAGE(A1:A9),2)"))).toBe(
            "ROUND(AVERAGE(A1:A9),2)",
        );
    });

    test("Excel 97–2003 workbooks are refused with an explanation", async () => {
        expect((await readWorkbook(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), "xls")).error).toBe(
            XLS_UNSUPPORTED,
        );
        expect((await writeWorkbook(sample(), "xls")).error).toBe(XLS_UNSUPPORTED);
    });

    test("a damaged workbook is an error, not an exception", async () => {
        const result = await readWorkbook(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]), "xlsx");
        expect(result.isOk).toBe(false);
    });
});
