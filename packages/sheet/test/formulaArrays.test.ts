// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    FORMULA_FUNCTIONS,
    isFormulaError,
    parseStructuredSpec,
    type Scalar,
    WorkbookEvaluator,
} from "../src/formula";
import { FUNCTION_INFO } from "../src/functionInfo";
import { MORE_FUNCTION_INFO } from "../src/functionInfoMore";
import type { CellData, SheetData, WorkbookData } from "../src/model";

const shown = (value: Scalar) => (isFormulaError(value) ? value.code : value);

/** A "Sales" table on B2:E6 (header row + 4 data rows; Total is a calculated column). */
function salesBook(extra: Record<string, CellData> = {}): WorkbookData {
    const sheet: SheetData = {
        name: "Data",
        cells: {
            B2: { v: "Item" },
            C2: { v: "Qty" },
            D2: { v: "Price" },
            E2: { v: "Total" },
            B3: { v: "Bolt" },
            C3: { v: 4 },
            D3: { v: 0.5 },
            B4: { v: "Nut" },
            C4: { v: 10 },
            D4: { v: 0.25 },
            B5: { v: "Washer" },
            C5: { v: 2 },
            D5: { v: 0.1 },
            B6: { v: "Bolt" },
            C6: { v: 6 },
            D6: { v: 0.5 },
            E3: { f: "[@Qty]*[@Price]" },
            E4: { f: "Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]" },
            ...extra,
        },
        tables: [
            {
                name: "Sales",
                ref: "B2:E6",
                columns: [{ name: "Item" }, { name: "Qty" }, { name: "Price" }, { name: "Total" }],
            },
        ],
    };
    return { sheets: [sheet, { name: "Report", cells: {} }], names: [] };
}

function evaluate(book: WorkbookData, formula: string, sheet = 1): Scalar {
    return shown(new WorkbookEvaluator(book).evaluateFormula(formula, sheet));
}

describe("structured references", () => {
    test.each([
        ["SUM(Sales[Qty])", 22],
        ["COUNTA(Sales[#All])", 18],
        ["ROWS(Sales)", 4],
        ["INDEX(Sales[#Headers],1,3)", "Price"],
        ["SUM(Sales[[Qty]:[Price]])", 23.35],
        ['SUMIFS(Sales[Qty],Sales[Item],"Bolt")', 10],
        ['XLOOKUP("Nut",Sales[Item],Sales[Price])', 0.25],
        ["sales[QTY]", 4],
    ])("%s = %s", (formula, expected) => {
        const value = evaluate(salesBook(), formula);
        if (typeof expected === "number") expect(value as number).toBeCloseTo(expected, 9);
        else expect(value).toBe(expected);
    });

    test("this-row references follow the formula's row, with and without the table name", () => {
        const evaluator = new WorkbookEvaluator(salesBook());
        expect(evaluator.value(0, "E3")).toBeCloseTo(2, 9);
        expect(evaluator.value(0, "E4")).toBeCloseTo(2.5, 9);
    });

    test("a name defined by a structured reference evaluates", () => {
        const book = salesBook();
        book.names = [{ name: "Items", ranges: ["Sales[Item]"] }];
        expect(evaluate(book, 'COUNTIF(Items,"Bolt")')).toBe(2);
    });

    test("specs parse escapes, item lists and column spans", () => {
        expect(parseStructuredSpec("[#This Row],[Credit (Income)]")).toEqual({
            items: ["#This Row"],
            startColumn: "Credit (Income)",
            endColumn: undefined,
        });
        expect(parseStructuredSpec("@[Unit '[mm']]")).toEqual({
            items: ["#This Row"],
            startColumn: "Unit [mm]",
        });
        expect(parseStructuredSpec("[#Headers],[A]:[C]")).toMatchObject({
            items: ["#Headers"],
            startColumn: "A",
            endColumn: "C",
        });
    });
});

describe("arrays and spills", () => {
    test("a FILTER result spills below its formula, and A1# names the whole spill", () => {
        const book = salesBook();
        book.sheets[1].cells = {
            A1: { f: "FILTER(Sales[Item],Sales[Qty]>3)" },
            C1: { f: "ROWS(A1#)" },
            D1: { f: "SUM(LEN(A1#))" },
        };
        const evaluator = new WorkbookEvaluator(book);
        expect([1, 2, 3].map((r) => evaluator.value(1, `A${r}`))).toEqual(["Bolt", "Nut", "Bolt"]);
        expect(evaluator.value(1, "A4")).toBeNull();
        expect(evaluator.spillArea(1, "A1")).toBe("A1:A3");
        expect(evaluator.spillAnchor(1, "A2")).toBe("A1");
        expect(evaluator.value(1, "C1")).toBe(3);
        expect(evaluator.value(1, "D1")).toBe(11);
    });

    test("a value in the spill area blocks it with #SPILL!; a cached spill output does not", () => {
        const blocked = salesBook();
        blocked.sheets[1].cells = { A1: { f: "SEQUENCE(3)" }, A3: { v: "x" } };
        expect(shown(new WorkbookEvaluator(blocked).value(1, "A1"))).toBe("#SPILL!");
        const cached = salesBook();
        cached.sheets[1].cells = {
            A1: { f: "SEQUENCE(3)", a: "A1:A3" },
            A2: { v: 9, sp: true },
            A3: { v: 9, sp: true },
        };
        const evaluator = new WorkbookEvaluator(cached);
        expect([1, 2, 3].map((r) => evaluator.value(1, `A${r}`))).toEqual([1, 2, 3]);
    });

    test("a spill shrinking under the file's cached area leaves the rest empty", () => {
        const book = salesBook();
        book.sheets[1].cells = {
            A1: { f: "SEQUENCE(2)", a: "A1:A4" },
            A2: { v: 7, sp: true },
            A3: { v: 7, sp: true },
            A4: { v: 7, sp: true },
        };
        const evaluator = new WorkbookEvaluator(book);
        expect([1, 2, 3, 4].map((r) => evaluator.value(1, `A${r}`))).toEqual([1, 2, null, null]);
    });

    test.each([
        ['SUM((Sales[Item]="Bolt")*Sales[Qty])', 10],
        ["SUM(IF(Sales[Qty]>3,Sales[Qty],0))", 20],
        ["SUM(MONTH({45000,45100}))", 3 + 6],
        ["SUM({1,2;3,4}*{10;100})", 30 + 700],
        ["INDEX(SORT(Sales[Qty],1,-1),1)", 10],
        ["ROWS(UNIQUE(Sales[Item]))", 3],
        ['TEXTJOIN(",",TRUE,SORTBY(Sales[Item],Sales[Qty]))', "Washer,Bolt,Bolt,Nut"],
        ["SUM(TAKE(SEQUENCE(10),-2))", 19],
        ["COLUMNS(HSTACK(Sales[Item],Sales[Qty]))", 2],
        ['INDEX(XLOOKUP("Nut",Sales[Item],Sales[[Item]:[Price]]),3)', 0.25],
        ["XMATCH(6,Sales[Qty])", 4],
        ['IFERROR(FILTER(Sales[Item],Sales[Qty]>100),"none")', "none"],
        ["SUM(IFERROR(1/(Sales[Qty]-2),0))", 0.5 + 0.125 + 0.25],
    ])("%s = %s", (formula, expected) => {
        const value = evaluate(salesBook(), formula);
        if (typeof expected === "number") expect(value as number).toBeCloseTo(expected, 9);
        else expect(value).toBe(expected);
    });

    test("FILTER with no match and no fallback is #CALC!", () => {
        expect(evaluate(salesBook(), "FILTER(Sales[Item],Sales[Qty]>100)")).toBe("#CALC!");
    });
});

describe("LET, LAMBDA and references", () => {
    test.each([
        ["LET(x,2,y,x*3,x+y)", 8],
        ["LET(sq,LAMBDA(n,n*n),sq(4)+sq(3))", 25],
        ["SUM(MAP(Sales[Qty],LAMBDA(q,q*2)))", 44],
        ["REDUCE(0,Sales[Qty],LAMBDA(acc,q,acc+q))", 22],
        ["SUM(BYROW(Sales[[Qty]:[Price]],LAMBDA(r,INDEX(r,1)*INDEX(r,2))))", 2 + 2.5 + 0.2 + 3],
        ["SUM(OFFSET(Data!C3,1,0,2,1))", 12],
        ['INDIRECT("Data!B"&5)', "Washer"],
        ["ROW(Data!C4)+COLUMN(Data!C4)", 4 + 3],
        ["ADDRESS(2,28,4)", "AB2"],
        ['SWITCH(3,1,"a",3,"c","z")', "c"],
        ['CHOOSE(2,"a","b")', "b"],
    ])("%s = %s", (formula, expected) => {
        const value = evaluate(salesBook(), formula);
        if (typeof expected === "number") expect(value as number).toBeCloseTo(expected, 9);
        else expect(value).toBe(expected);
    });

    test("an uncalled LAMBDA in a cell is #CALC!", () => {
        expect(evaluate(salesBook(), "LAMBDA(x,x+1)")).toBe("#CALC!");
    });
});

describe("function library", () => {
    test.each([
        // Financial (values from Excel).
        ["PMT(0.05/12,360,200000)", -1073.6432460242797],
        ["FV(0.06/12,10,-200,-500,1)", 2581.4033740601185],
        ["PV(0.08/12,240,500)", -59777.14585118638],
        ["NPER(0.01,-100,1000)", 10.588644459423524],
        ["RATE(48,-200,8000)", 0.007701472915571132],
        ["IPMT(0.1/12,1,36,8000)", -66.66666666666667],
        ["PPMT(0.1/12,1,24,2000)", -75.62318600836664],
        ["NPV(0.1,-10000,3000,4200,6800)", 1188.4434123352207],
        ["IRR({-70000,12000,15000,18000,21000,26000})", 0.08663094803653171],
        ["SLN(30000,7500,10)", 2250],
        ["DDB(2400,300,10,1)", 480],
        ["EFFECT(0.0525,4)", 0.053542667370758],
        // Statistics and math.
        ["STDEV.S({2,4,4,4,5,5,7,9})", 2.138089935299395],
        ["STDEV.P({2,4,4,4,5,5,7,9})", 2],
        ["LARGE({3,9,1,7},2)", 7],
        ["PERCENTILE.INC({1,2,3,4},0.25)", 1.75],
        ["RANK.EQ(7,{3,9,1,7})", 2],
        ["MROUND(17,5)", 15],
        ["CEILING.MATH(-4.5)", -4],
        ["FLOOR(7.8,2)", 6],
        ["GCD(24,36)", 12],
        ["SUBTOTAL(9,{1,2,3})", 6],
        ["NORM.S.DIST(1.96,TRUE)", 0.9750021048517795],
        // Dates (1-Mar-2024 is serial 45352, a Friday).
        ["WEEKDAY(45352)", 6],
        ["WEEKDAY(45352,2)", 5],
        ["NETWORKDAYS(45352,45366)", 11],
        ["WORKDAY(45352,5)", 45359],
        ['DATEDIF(45000,45352,"m")', 11],
        ['DATEVALUE("2024-03-01")', 45352],
        ["ISOWEEKNUM(45352)", 9],
        // Text and information.
        ['TEXTBEFORE("a-b-c","-",2)', "a-b"],
        ['TEXTAFTER("a-b-c","-")', "b-c"],
        ['INDEX(TEXTSPLIT("1,2;3,4",",",";"),2,1)', "3"],
        ['REPLACE("abcdef",2,3,"X")', "aXef"],
        ["FIXED(1234.567,1)", "1,234.6"],
        ['CHAR(65)&CODE("a")', "A97"],
        ["DEC2BIN(5,4)", "0101"],
        ['HEX2DEC("FF")', 255],
        ["ISEVEN(4)", 1],
        ['TYPE("x")', 2],
        ["XOR(TRUE,FALSE,TRUE)", false],
    ])("%s = %s", (formula, expected) => {
        const value = evaluate(salesBook(), formula);
        if (typeof expected === "number") expect(value as number).toBeCloseTo(expected, 6);
        else expect(value).toBe(expected);
    });

    test("prefixed storage names evaluate like the plain ones", () => {
        expect(evaluate(salesBook(), "_xlfn._xlws.SORT({3;1;2})")).toBe(1);
        expect(evaluate(salesBook(), "_xlfn.LET(_xlpm.a,2,_xlpm.a*5)")).toBe(10);
    });

    test("every evaluated function has metadata with argument counts", () => {
        const missing = FORMULA_FUNCTIONS.filter(
            (name) => FUNCTION_INFO[name] === undefined && MORE_FUNCTION_INFO[name] === undefined,
        );
        expect(missing).toEqual([]);
    });
});
