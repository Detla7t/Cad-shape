// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    columnIndex,
    columnName,
    type DataTable,
    dataCellValue,
    dataTableCell,
    dataTableColumn,
    EMPTY_SCOPE,
    type ExpressionFunctionContext,
    evaluateExpression,
    evaluateVariables,
    FolderNode,
    findDataTable,
    type IDataTableProvider,
    type INode,
    LENGTH_UNITS,
    notifyDataTablesChanged,
    parseCellAddress,
    parseCellRange,
    parseDataQuantity,
    Result,
    registerDataTableProvider,
    registerExpressionFunction,
    registeredExpressionFunctions,
    resolveDataTableReference,
    scopeContext,
    sliceDataTable,
    UNITLESS,
} from "../src";
import { TestDocument } from "../test-utils";

// ------------------------------------------------------------------ Registered functions

describe("registerExpressionFunction", () => {
    test("a registered function gets evaluated arguments, text included, and the document", () => {
        const seen: ExpressionFunctionContext[] = [];
        const registration = registerExpressionFunction(
            "textLength",
            (args, context) => {
                seen.push(context);
                return typeof args[0] === "string"
                    ? Result.ok({
                          value: args[0].length * (typeof args[1] === "object" ? args[1].value : 1),
                          unit: UNITLESS,
                      })
                    : Result.err("textLength() expects text");
            },
            { minArgs: 1, maxArgs: 2 },
        );
        try {
            const document = new TestDocument();
            const scope = document.variables.evaluate().scope;
            expect(evaluateExpression('textLength("abc") + 1', scope).value.value).toBe(4);
            expect(evaluateExpression("textLength('a\\'b', 2 * 5)", scope).value.value).toBe(30);
            expect(seen[0].document).toBe(document);
            expect(seen[0].scope).toBe(scope);
            expect(evaluateExpression('textLength("x")', EMPTY_SCOPE).value.value).toBe(1);
            expect(seen[2].document).toBeUndefined();
            expect(evaluateExpression("textLength()", scope).error).toBe(
                "textLength() expects 1 to 2 arguments, got 0",
            );
            expect(evaluateExpression("textLength(1)", scope).error).toBe("textLength() expects text");
            expect(registeredExpressionFunctions()).toContain("textLength");
        } finally {
            registration.dispose();
        }
        expect(evaluateExpression('textLength("abc")', EMPTY_SCOPE).error).toBe(
            "Unknown function: textLength",
        );
        expect(registeredExpressionFunctions()).not.toContain("textLength");
    });

    test.each(["sin", "pi", "max", "2bad", "a-b"])("refuses %j (built in, or not a name)", (name) => {
        expect(() =>
            registerExpressionFunction(name, () => Result.ok({ value: 0, unit: UNITLESS })),
        ).toThrow();
    });

    test("a function that throws is reported as the expression's error", () => {
        const registration = registerExpressionFunction("boom", () => {
            throw new Error("kaboom");
        });
        try {
            expect(evaluateExpression("boom()", EMPTY_SCOPE).error).toBe("boom(): kaboom");
        } finally {
            registration.dispose();
        }
    });

    test.each([
        ['abs("x")', 'abs() expects numbers, got text "x"'],
        ['"x" + 1', "Text is only allowed as a function argument"],
        ['max(1, "x" + 1)', "Text is only allowed as a whole function argument"],
        ['max(1, "x)', "Unterminated text: missing closing quote"],
    ])("%s is an error", (expression, message) => {
        expect(evaluateExpression(expression, EMPTY_SCOPE).error).toBe(message);
    });

    test("variable rows see the document through the scope they are evaluated on", () => {
        const registration = registerExpressionFunction("docName", (_args, context) =>
            context.document === undefined
                ? Result.err("no document")
                : Result.ok({ value: context.document.name.length, unit: UNITLESS }),
        );
        try {
            const document = new TestDocument();
            const base = document.variables.evaluate().scope;
            expect(scopeContext(base)?.document).toBe(document);
            const evaluated = evaluateVariables(
                [{ id: "a", name: "a", type: "unitless", expression: "docName()" }],
                base,
            );
            expect(evaluated.errors.size).toBe(0);
            expect(evaluated.values.get("a")?.value).toBe("test".length);
            expect(scopeContext(evaluated.scope)?.document).toBe(document);
        } finally {
            registration.dispose();
        }
    });
});

// ------------------------------------------------------------------ Providers

/** Tables kept beside plain folder nodes, standing in for a module's own node class. */
const tablesOf = new WeakMap<INode, { tables: DataTable[]; revision: number }>();

const provider: IDataTableProvider = {
    canRead: (node) => tablesOf.has(node),
    tableNames: (node) => tablesOf.get(node)?.tables.map((table) => table.name) ?? [],
    readTable(node, sheet, range) {
        const tables = tablesOf.get(node)?.tables ?? [];
        const table = sheet === undefined ? tables[0] : tables.find((x) => x.name === sheet);
        if (table === undefined) return Result.err(`no table ${sheet}`);
        const cells = range === undefined ? undefined : parseCellRange(range);
        return Result.ok(cells === undefined ? table : sliceDataTable(table, cells));
    },
    revision: (node) => tablesOf.get(node)?.revision ?? 0,
};

const table = (name: string, rows: DataTable["rows"], columns = ["Name", "Value"]): DataTable => ({
    name,
    columns,
    rows,
});

function sourceNode(document: TestDocument, name: string, tables: DataTable[]): FolderNode {
    const node = new FolderNode({ document, name });
    tablesOf.set(node, { tables, revision: 1 });
    document.modelManager.addNode(node);
    return node;
}

describe("data table providers", () => {
    let registration: { dispose(): void };
    beforeAll(() => {
        registration = registerDataTableProvider(provider);
    });
    afterAll(() => registration.dispose());

    test("references: a source's default table, Source/Table, a unique table name; errors name the choices", () => {
        const document = new TestDocument();
        sourceNode(document, "Book", [table("Sheet1", [["a", 1]]), table("Prices", [["b", 2]])]);
        sourceNode(document, "Other", [table("Prices", [["c", 3]]), table("Only", [["d", 4]])]);
        expect(findDataTable(document, "Book").value.name).toBe("Sheet1");
        expect(findDataTable(document, " book ").value.name).toBe("Sheet1");
        expect(findDataTable(document, "Other/Prices").value.rows).toEqual([["c", 3]]);
        expect(findDataTable(document, "Only").value.rows).toEqual([["d", 4]]);
        expect(findDataTable(document, "Prices").error).toBe(
            'Data table "Prices" is ambiguous: Book/Prices, Other/Prices',
        );
        expect(findDataTable(document, "Nope").error).toBe(
            'Unknown data table "Nope" (available: Book, Other)',
        );
        expect(findDataTable(document, "Book/Nope").error).toBe("no table Nope");
        expect(resolveDataTableReference(document, "Other/Prices").value.sheet).toBe("Prices");
        expect(findDataTable(new TestDocument(), "Book").error).toMatch(/the document has no data sources/);
    });

    test("a range reads part of a table, its first row the header", () => {
        const document = new TestDocument();
        sourceNode(document, "Grid", [
            table(
                "Sheet1",
                [
                    [1, 2, 3],
                    [4, 5, 6],
                ],
                ["A", "B", "C"],
            ),
        ]);
        expect(findDataTable(document, "Grid", "B2:C3").value).toEqual({
            name: "Sheet1",
            columns: ["2", "3"],
            rows: [[5, 6]],
            hasHeader: true,
        });
    });

    test("a changed table re-scopes the document; an unchanged one does not", () => {
        const document = new TestDocument();
        const node = sourceNode(document, "Dims", [table("Sheet1", [["w", 1]])]);
        const scopes: unknown[] = [];
        document.variables.onPropertyChanged((property) => {
            if (property === "scope") scopes.push(property);
        });
        const revision = document.variables.revision;
        const token = scopeContext(document.variables.evaluate().scope)?.token;
        expect(token).toMatch(/Dims/);

        notifyDataTablesChanged(document);
        expect(document.variables.revision).toBe(revision);
        expect(scopes).toHaveLength(0);

        tablesOf.set(node, { tables: [table("Sheet1", [["w", 2]])], revision: 2 });
        notifyDataTablesChanged(document);
        expect(document.variables.revision).toBe(revision + 1);
        expect(scopes).toHaveLength(1);
        expect(scopeContext(document.variables.evaluate().scope)?.token).not.toBe(token);
    });

    test("a document without data tables has no token, so feature cache keys are unchanged", () => {
        const document = new TestDocument();
        expect(scopeContext(document.variables.evaluate().scope)).toEqual({ document });
    });
});

// ------------------------------------------------------------------ A1 and values

describe("A1 addressing", () => {
    test.each([
        [0, "A"],
        [25, "Z"],
        [26, "AA"],
        [701, "ZZ"],
        [702, "AAA"],
    ])("column %i is %s and back", (index, name) => {
        expect(columnName(index)).toBe(name);
        expect(columnIndex(name)).toBe(index);
        expect(columnIndex(name.toLowerCase())).toBe(index);
    });

    test("cells and ranges", () => {
        expect(parseCellAddress("B3")).toEqual({ column: 1, row: 2 });
        expect(parseCellAddress(" $b$3 ")).toEqual({ column: 1, row: 2 });
        expect(parseCellAddress("B0")).toBeUndefined();
        expect(parseCellAddress("3B")).toBeUndefined();
        expect(parseCellRange("C5:A1")).toEqual({ start: { column: 0, row: 0 }, end: { column: 2, row: 4 } });
        expect(parseCellRange("A1:B2:C3")).toBeUndefined();
    });

    test("the grid: row 1 is the header row, unless the table has none", () => {
        const withHeader = table("t", [["w", 10]]);
        expect(dataTableCell(withHeader, { column: 1, row: 0 })).toBe("Value");
        expect(dataTableCell(withHeader, { column: 1, row: 1 })).toBe(10);
        expect(dataTableCell(withHeader, { column: 2, row: 1 })).toBeUndefined();
        expect(dataTableCell({ ...withHeader, hasHeader: false }, { column: 1, row: 0 })).toBe(10);
        expect(dataTableColumn(withHeader, "value")).toBe(1);
        expect(dataTableColumn(withHeader, "B")).toBe(1);
        expect(dataTableColumn(withHeader, "C")).toBeUndefined();
    });
});

describe("data values with units", () => {
    test.each([
        ["12", 12, UNITLESS],
        ["12 mm", 12, LENGTH_UNITS],
        ["1.5cm", 15, LENGTH_UNITS],
        ["0.5 m", 500, LENGTH_UNITS],
        ["2 in", 50.8, LENGTH_UNITS],
        ['2"', 50.8, LENGTH_UNITS],
        ["1 ft", 304.8, LENGTH_UNITS],
        ["30 deg", 30, ANGLE_UNITS],
        ["30°", 30, ANGLE_UNITS],
        ["-1e1 MM", -10, LENGTH_UNITS],
        ["50%", 0.5, UNITLESS],
    ])("%j", (text, value, unit) => {
        const parsed = parseDataQuantity(text);
        expect(parsed?.value).toBeCloseTo(value, 9);
        expect(parsed?.unit).toEqual(unit);
    });

    test("a radian is converted to degrees; unknown units and words are not quantities", () => {
        expect(parseDataQuantity("1 rad")?.value).toBeCloseTo(180 / Math.PI, 9);
        expect(parseDataQuantity("12 parsecs")).toBeUndefined();
        expect(parseDataQuantity("twelve")).toBeUndefined();
        expect(parseDataQuantity("12 mm 3")).toBeUndefined();
    });

    test("cells: booleans are 1 / 0, empty and text cells say why they are not numbers", () => {
        expect(dataCellValue(true).value).toEqual({ value: 1, unit: UNITLESS });
        expect(dataCellValue(null).error).toBe("the cell is empty");
        expect(dataCellValue("  ").error).toBe("the cell is empty");
        expect(dataCellValue("abc").error).toBe('"abc" is not a number');
    });
});
