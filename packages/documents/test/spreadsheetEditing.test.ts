// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { TestDocument } from "@chili3d/core/test-utils";
import { DocumentFileNode } from "../src/documentFileNode";
import { FORMULA_FUNCTIONS, FormulaError, WorkbookEvaluator } from "../src/sheet/formula";
import {
    acceptFormulaCompletion,
    formulaArgumentHelp,
    formulaCompletion,
} from "../src/sheet/formulaSuggestions";
import { FUNCTION_INFO } from "../src/sheet/functionInfo";
import { cloneWorkbook, usedSize, type WorkbookData } from "../src/sheet/model";
import { readWorkbook, writeWorkbook } from "../src/sheet/workbookIo";
import { createFormulaAssist } from "../src/ui/viewers/formulaAssist";
import { createSpreadsheetViewer } from "../src/ui/viewers/spreadsheetViewer";

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
    test("Tab accepts, arrows select, Escape dismisses, and no suggestion commits a cell", () => {
        const assist = createFormulaAssist();
        const input = document.createElement("input");
        document.body.append(input);
        assist.bind(input);
        try {
            input.value = "=su";
            input.setSelectionRange(3, 3);
            input.focus();
            input.dispatchEvent(new Event("input"));
            const list = document.querySelector('[role="listbox"]');
            expect(list).not.toBeNull();
            expect(list!.textContent).toContain("SUMIFS");
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
            const selected = document.querySelector('[role="option"][aria-selected="true"]');
            expect(selected).not.toBeNull();
            expect(selected!.textContent).toBe("SUMIF");
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
            expect(input.value).toBe("=SUMIF(");
            expect(input.selectionStart).toBe(7);
            expect(document.querySelector('[role="listbox"]')).toBeNull();
            expect(document.body.textContent).toContain("range, criteria, [sum_range]");
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
            expect(input.getAttribute("aria-expanded")).toBe("false");
        } finally {
            assist.dispose();
            input.remove();
        }
    });
});

describe("spreadsheet style round trips and editor", () => {
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

    test("format a range, edit its contents, and export the styled formula workbook", async () => {
        const doc = new TestDocument();
        const node = new DocumentFileNode({
            document: doc,
            fileName: "Budget.csv",
            format: "csv",
            text: "10\n20",
        });
        let changed = 0;
        const viewer = createSpreadsheetViewer({ node, document: doc, changed: () => changed++ });
        document.body.append(viewer.element);
        await Promise.resolve();
        try {
            const cellName = viewer.element.querySelector<HTMLInputElement>('[aria-label="Cell or range"]')!;
            const bar = viewer.element.querySelector<HTMLInputElement>('[aria-label="Formula bar"]')!;
            const bold = viewer.element.querySelector<HTMLButtonElement>('[aria-label="Bold"]')!;
            expect(bold).not.toBeNull();
            cellName.value = "A1:B2";
            cellName.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            bold.click();
            expect(bold.getAttribute("aria-pressed")).toBe("true");
            cellName.value = "B1";
            cellName.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            bar.value = "=sum";
            bar.focus();
            bar.setSelectionRange(4, 4);
            bar.dispatchEvent(new Event("input"));
            bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
            expect(bar.value).toBe("=SUM(");
            bar.value = "=SUM(A1:A2)";
            bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
            const cell = viewer.element.querySelector<HTMLElement>('td[data-row="0"][data-col="1"]');
            expect(cell).not.toBeNull();
            expect(cell!.textContent).toBe("30");
            expect(cell!.style.fontWeight).toBe("700");
            const xlsx = viewer.exports!().find((e) => e.extension === ".xlsx")!;
            const bytes = await xlsx.produce();
            expect(bytes).toBeInstanceOf(Uint8Array);
            const back = await readWorkbook(bytes as Uint8Array, "xlsx");
            expect(back.value.sheets[0].cells["B1"]).toMatchObject({
                f: "SUM(A1:A2)",
                v: 30,
                s: { font: { bold: true } },
            });
            expect(back.value.sheets[0].cells["B2"].s?.font?.bold).toBe(true);
            expect(changed).toBeGreaterThan(1);
            // Save must bubble to the document shell while the formula bar has focus.
            let saves = 0;
            viewer.element.addEventListener("keydown", (event) => {
                if (event.ctrlKey && event.key === "s") saves++;
            });
            bar.focus();
            bar.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
            expect(saves).toBe(1);
            // Export flushes a pending formula-bar edit even before Enter.
            bar.value = "=SUM(A1:A2)*2";
            const editedBytes = await xlsx.produce();
            const edited = await readWorkbook(editedBytes as Uint8Array, "xlsx");
            expect(edited.value.sheets[0].cells["B2"]).toMatchObject({ f: "SUM(A1:A2)*2", v: 60 });
        } finally {
            viewer.dispose();
            viewer.element.remove();
        }
    });
});
