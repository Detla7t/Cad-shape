// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    EMPTY_SCOPE,
    evaluateExpression,
    LENGTH_UNITS,
    resolveUnitSpec,
    type Scope,
    UNITLESS,
} from "@chili3d/core";
import type { TestDocument } from "@chili3d/core/test-utils";
import { extractDataReferences, extractFeatureScriptReferences } from "../src";
import { csvSource, newDoc, sourceOf, sqliteFile, useNodeSqlJs } from "./_helpers";

const PARTS = [
    "Name,Length,Angle,Qty,Note",
    "Bracket,12 mm,30 deg,4,",
    "Plate,2 in,0.5 rad,1,thin",
    "Rod,40,90,2,",
].join("\n");

const PRICES = ["Item,Price", "Bolt,0.25", "Nut,0.1", "Washer,abc"].join("\n");

let doc: TestDocument;
const scope = (): Scope => doc.variables.evaluate().scope;
const value = (expression: string) => evaluateExpression(expression, scope());

beforeAll(async () => {
    useNodeSqlJs();
    doc = newDoc();
    await csvSource(doc, "Parts", PARTS);
    await csvSource(doc, "Prices", PRICES);
});

describe("data(table, cell)", () => {
    test.each([
        ['data("Prices", "B2")', 0.25, UNITLESS],
        ['data("Prices", "$B$3")', 0.1, UNITLESS],
        ['data("parts", "b2")', 12, LENGTH_UNITS],
        ['data("Parts", "B3")', 50.8, LENGTH_UNITS],
        ['data("Parts", "C2")', 30, ANGLE_UNITS],
        ['data("Parts", "D4") * 2', 4, UNITLESS],
    ])("%s", (expression, expected, unit) => {
        const result = value(expression);
        expect(result.isOk).toBe(true);
        expect(result.value.value).toBeCloseTo(expected, 9);
        expect(result.value.unit).toEqual(unit);
    });

    test("an angle cell in radians arrives in degrees", () => {
        expect(value('data("Parts", "C3")').value.value).toBeCloseTo(0.5 * (180 / Math.PI), 9);
    });

    test.each([
        ['data("Nope", "A1")', /^Unknown data table "Nope" \(available: Parts, Prices\)$/],
        ['data("Prices", "Z9")', /^Prices!Z9 is outside the table$/],
        ['data("Prices", "B5")', /^Prices!B5 is outside the table$/],
        ['data("Parts", "E2")', /^Parts!E2: the cell is empty$/],
        ['data("Prices", "B4")', /^Prices!B4: "abc" is not a number$/],
        ['data("Prices", "A1")', /^Prices!A1: "Item" is not a number$/],
        ['data("Prices", "Price")', /is not a cell like "B3"/],
        ['data(Prices, "B2")', /^Unknown identifier: Prices$/],
        ['data(1, "B2")', /^data\(\) expects a table name in quotes$/],
        ['data("Prices")', /^data\(\) expects 2 to 3 arguments, got 1$/],
        ['"Prices"', /^Text is only allowed as a function argument$/],
        ['data("Prices", "B2" + 1)', /^Text is only allowed as a whole function argument$/],
        ['data("Prices, "B2")', /^Text is only allowed as a whole function argument$/],
        ['data("Prices", "B2)', /^Unterminated text: missing closing quote$/],
    ])("%s is an error", (expression, message) => {
        const result = value(expression);
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(message);
    });

    test("without a document there are no tables", () => {
        expect(evaluateExpression('data("Prices", "B2")', EMPTY_SCOPE).error).toMatch(
            /only available in a document/,
        );
    });
});

describe("data(table, column, row)", () => {
    test.each([
        ['data("Parts", "Length", 1)', 12],
        ['data("Parts", "length", 3)', 40],
        ['data("Parts", "B", 2)', 50.8],
        ['data("Parts", 4, 1)', 4],
        ['data("Prices", "Price", 1 + 1)', 0.1],
    ])("%s", (expression, expected) => {
        expect(value(expression).value.value).toBeCloseTo(expected, 9);
    });

    test.each([
        [
            'data("Parts", "Width", 1)',
            /^Parts has no column "Width" \(columns: Name, Length, Angle, Qty, Note\)$/,
        ],
        ['data("Parts", "Length", 4)', /^Parts!Length\[4\]: the table has 3 rows$/],
        ['data("Parts", "Length", 0)', /the row must be a whole number from 1/],
        ['data("Parts", "Length", 1.5)', /the row must be a whole number from 1/],
        ['data("Parts", 9, 1)', /column 9 is not a column of Parts/],
    ])("%s is an error", (expression, message) => {
        expect(value(expression).error).toMatch(message);
    });
});

describe("lookup, count, sum", () => {
    test.each([
        ['lookup("Parts", "Name", "Plate", "Length")', 50.8],
        ['lookup("Parts", "Name", "rod", "Length")', 40],
        ['lookup("Prices", "Item", "Nut", "Price")', 0.1],
        ['lookup("Parts", "Qty", 1, "Length")', 50.8],
        ['count("Parts")', 3],
        ['count("Parts", "Note")', 1],
        ['sum("Parts", "Qty")', 7],
        ['sum("Parts", "Length")', 12 + 50.8 + 40],
    ])("%s", (expression, expected) => {
        const result = value(expression);
        expect(result.isOk).toBe(true);
        expect(result.value.value).toBeCloseTo(expected, 9);
    });

    test("a column total carries the unit its quantities share", () => {
        expect(value('sum("Parts", "Length")').value.unit).toEqual(LENGTH_UNITS);
        expect(value('count("Parts")').value.unit).toEqual(UNITLESS);
    });

    test.each([
        ['lookup("Parts", "Name", "Gear", "Length")', /^Parts!Length\[Name=Gear\]: no row has Name = Gear$/],
        ['sum("Prices", "Price")', /^Prices!Price\[3\]: "abc" is not a number$/],
        ['lookup("Parts", "Qty", 2, "Name")', /^Parts!Name\[Qty=2\]: "Rod" is not a number$/],
        ['count("Parts", "Nope")', /has no column "Nope"/],
    ])("%s is an error", (expression, message) => {
        expect(value(expression).error).toMatch(message);
    });

    test("mixed units in a column total are refused", async () => {
        const local = newDoc();
        await csvSource(local, "Mixed", "v\n1 mm\n2 deg");
        expect(evaluateExpression('sum("Mixed", "v")', local.variables.evaluate().scope).error).toMatch(
            /mixes length with angle/,
        );
    });
});

describe("units in slots", () => {
    test("a plain number takes the slot's unit; a suffixed one must fit it", () => {
        expect(resolveUnitSpec('data("Parts", "D2")', scope(), LENGTH_UNITS).value).toBe(4);
        expect(resolveUnitSpec('data("Parts", "D2")', scope(), ANGLE_UNITS).value).toBe(4);
        expect(resolveUnitSpec('data("Parts", "B2") * 2', scope(), LENGTH_UNITS).value).toBe(24);
        expect(resolveUnitSpec('data("Parts", "C2")', scope(), ANGLE_UNITS).value).toBe(30);
        expect(resolveUnitSpec('data("Parts", "B2")', scope(), ANGLE_UNITS).error).toMatch(
            /^Dimension mismatch: expected angle, got length$/,
        );
    });
});

describe("tables of a multi-table source", () => {
    test('"Source/Table" names a table; a unique table name alone works too', async () => {
        const local = newDoc();
        const source = await sourceOf(local, "Shop", {
            kind: "sqlite",
            queries: [
                { name: "Bolts", query: "SELECT * FROM bolts" },
                { name: "Sizes", query: "SELECT size, pitch FROM bolts ORDER BY size DESC" },
            ],
        });
        const bytes = await sqliteFile(
            "CREATE TABLE bolts (size TEXT, pitch REAL); INSERT INTO bolts VALUES ('M6', 1.0), ('M8', 1.25);",
        );
        const read = await source.attachFile("shop.sqlite", bytes);
        expect(read.isOk).toBe(true);
        const local$ = (expression: string) =>
            evaluateExpression(expression, local.variables.evaluate().scope);
        expect(local$('data("Shop", "B3")').value.value).toBe(1.25);
        expect(local$('data("Shop/Sizes", "B2")').value.value).toBe(1.25);
        expect(local$('lookup("Sizes", "size", "M6", "pitch")').value.value).toBe(1);
        expect(local$('data("Shop/Nope", "B2")').error).toMatch(
            /^Data source "Shop" has no table "Nope" \(tables: Bolts, Sizes\)$/,
        );
    });
});

describe("static references", () => {
    test("expressions name their tables and cells", () => {
        expect(
            extractDataReferences(
                'data("Prices", "B3") * 2 + lookup("Parts", "Name", "Bracket", "Length") + count("Parts") + sum("Parts", "Qty") + data("Parts", "Length", 3) + data(w, "A1")',
            ).map((x) => x.label),
        ).toEqual([
            "Prices!B3",
            "Parts!Length[Name=Bracket]",
            "Parts (count)",
            "Parts!Qty (sum)",
            "Parts!Length[3]",
        ]);
        expect(extractDataReferences("w * 2")).toEqual([]);
    });

    test("FeatureScript getDataTable calls are references too", () => {
        expect(extractFeatureScriptReferences('const rows = getDataTable(context, "Parts");')).toEqual([
            { fn: "getDataTable", table: "Parts", label: "Parts (FeatureScript)" },
        ]);
    });
});
