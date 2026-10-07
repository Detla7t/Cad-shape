// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import JSZip from "jszip";
import {
    columnTypes,
    detectDelimiter,
    jsonToTable,
    parseDelimited,
    readCsv,
    readJson,
    readSqlite,
    readWorkbook,
    typeCell,
} from "../src";
import { sqliteFile, useNodeSqlJs } from "./_helpers";

beforeAll(() => useNodeSqlJs());

describe("CSV", () => {
    test("quoted fields, doubled quotes, embedded line breaks, CRLF and a BOM", () => {
        const text = '﻿Name,Note\r\n"Bracket, small","He said ""hi"""\r\n"Two\nlines",x\r\n';
        expect(parseDelimited(text, ",")).toEqual([
            ["Name", "Note"],
            ["Bracket, small", 'He said "hi"'],
            ["Two\nlines", "x"],
        ]);
    });

    test.each([
        ["a,b,c\n1,2,3", ","],
        ["a;b;c\n1,5;2;3", ";"],
        ["a\tb\n1\t2", "\t"],
        ["a|b\n1|2", "|"],
    ])("detects the delimiter of %j", (text, delimiter) => {
        expect(detectDelimiter(text)).toBe(delimiter);
    });

    test("cells are typed: numbers, booleans, empty, identifiers and quantities stay text", () => {
        expect([
            typeCell("12"),
            typeCell(" -1.5e3 "),
            typeCell("TRUE"),
            typeCell(""),
            typeCell("007"),
        ]).toEqual([12, -1500, true, null, "007"]);
        expect(typeCell("12 mm")).toBe("12 mm");
    });

    test("a table: header names made unique, trailing empty rows and columns dropped", () => {
        const table = readCsv("parts", "Name,Length,,Length\nBracket,12 mm,,3\nPlate,30,,\n,,,\n");
        expect(table).toEqual({
            name: "parts",
            columns: ["Name", "Length", "C", "Length (2)"],
            rows: [
                ["Bracket", "12 mm", null, 3],
                ["Plate", 30, null, null],
            ],
            hasHeader: true,
        });
        expect(columnTypes(table)).toEqual(["text", "length", "empty", "number"]);
    });

    test("without a header row the columns are named by their letters", () => {
        expect(readCsv("raw", "1;2\n3;4", { hasHeader: false })).toEqual({
            name: "raw",
            columns: ["A", "B"],
            rows: [
                [1, 2],
                [3, 4],
            ],
            hasHeader: false,
        });
    });
});

describe("JSON", () => {
    test("a list of objects: keys in first-seen order, nested values as JSON text", () => {
        const table = readJson(
            "api",
            JSON.stringify([
                { a: 1, b: "x" },
                { b: "y", c: { d: true } },
            ]),
        );
        expect(table.isOk).toBe(true);
        expect(table.value).toEqual({
            name: "api",
            columns: ["a", "b", "c"],
            rows: [
                [1, "x", null],
                [null, "y", '{"d":true}'],
            ],
            hasHeader: true,
        });
    });

    test("a path to the rows, the common wrapper keys, and SQL-style { columns, rows }", () => {
        const nested = { result: { items: [{ n: 1 }, { n: 2 }] } };
        expect(jsonToTable("t", nested, "$.result.items").value.rows).toEqual([[1], [2]]);
        expect(jsonToTable("t", { data: [{ n: 3 }] }).value.rows).toEqual([[3]]);
        expect(
            jsonToTable("t", {
                columns: ["id", "w"],
                rows: [
                    [1, 4.5],
                    [2, null],
                ],
            }).value,
        ).toEqual({
            name: "t",
            columns: ["id", "w"],
            rows: [
                [1, 4.5],
                [2, null],
            ],
            hasHeader: true,
        });
        expect(
            jsonToTable("t", [
                ["k", "v"],
                ["w", 10],
            ]).value,
        ).toEqual({
            name: "t",
            columns: ["k", "v"],
            rows: [["w", 10]],
            hasHeader: true,
        });
    });

    test("a bad path or bad JSON is an error, not a throw", () => {
        expect(jsonToTable("t", { a: [] }, "b.c").error).toMatch(/no "b"/);
        expect(readJson("t", "{nope").error).toMatch(/^Not valid JSON/);
    });
});

// ------------------------------------------------------------------ Workbooks

async function xlsxBytes(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file(
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    );
    zip.file(
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dims" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    );
    zip.file(
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    );
    zip.file(
        "xl/sharedStrings.xml",
        `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>Name</t></si><si><t>Value</t></si><si><r><t>Dep</t></r><r><t xml:space="preserve">th</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si></sst>`,
    );
    zip.file(
        "xl/worksheets/sheet1.xml",
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
            `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
            `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>25</v></c></row>` +
            `<row r="3"><c r="A3" t="inlineStr"><is><t>Angle</t></is></c><c r="B3" t="str"><f>CONCAT(30," deg")</f><v>30 deg</v></c></row>` +
            `<row r="4"><c r="A4" t="b"><v>1</v></c><c r="B4" t="e"><v>#DIV/0!</v></c></row>` +
            `<row r="6"><c r="C6"><f>B2*2</f><v>50</v></c></row>` +
            `</sheetData></worksheet>`,
    );
    zip.file(
        "xl/worksheets/sheet2.xml",
        `<?xml version="1.0" encoding="UTF-8"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:t>Note &lt;1&gt;</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`,
    );
    return zip.generateAsync({ type: "uint8array" });
}

async function odsBytes(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("mimetype", "application/vnd.oasis.opendocument.spreadsheet");
    zip.file(
        "content.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:spreadsheet>
<table:table table:name="Parts">
<table:table-column table:number-columns-repeated="3"/>
<table:table-row><table:table-cell office:value-type="string"><text:p>Name</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Length</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Ok</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1020"/></table:table-row>
<table:table-row><table:table-cell office:value-type="string"><text:p>Bracket<text:s text:c="2"/>A</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="12.5"><text:p>12.5</text:p></table:table-cell><table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>TRUE</text:p></table:table-cell></table:table-row>
<table:table-row table:number-rows-repeated="2"><table:table-cell office:value-type="string"><text:p>Plate</text:p></table:table-cell><table:table-cell office:value-type="percentage" office:value="0.5"><text:p>50%</text:p></table:table-cell></table:table-row>
<table:table-row table:number-rows-repeated="1048572"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
</table:table>
</office:spreadsheet></office:body></office:document-content>`,
    );
    return zip.generateAsync({ type: "uint8array" });
}

describe("spreadsheets", () => {
    test("XLSX: every sheet, shared / inline / rich strings, numbers, booleans, errors, cached formulas", async () => {
        const tables = await readWorkbook(await xlsxBytes());
        expect(tables).toEqual([
            {
                name: "Dims",
                columns: ["Name", "Value", "C"],
                rows: [
                    ["Depth", 25, null],
                    ["Angle", "30 deg", null],
                    [true, "#DIV/0!", null],
                    [null, null, null],
                    [null, null, 50],
                ],
                hasHeader: true,
            },
            { name: "Notes & more", columns: ["Note <1>"], rows: [], hasHeader: true },
        ]);
    });

    test("ODS: repeated cells and rows expand, trailing empties are trimmed", async () => {
        const tables = await readWorkbook(await odsBytes());
        expect(tables).toEqual([
            {
                name: "Parts",
                columns: ["Name", "Length", "Ok"],
                rows: [
                    ["Bracket  A", 12.5, true],
                    ["Plate", 0.5, null],
                    ["Plate", 0.5, null],
                ],
                hasHeader: true,
            },
        ]);
    });

    test("legacy .xls and non-spreadsheets are refused with a reason", async () => {
        const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        await expect(readWorkbook(xls)).rejects.toThrow(/Legacy \.xls/);
        await expect(readWorkbook(new TextEncoder().encode("a,b"))).rejects.toThrow(/Not a spreadsheet/);
    });
});

describe("SQLite", () => {
    const SCHEMA = `
        CREATE TABLE parts (name TEXT, length REAL, qty INTEGER);
        INSERT INTO parts VALUES ('Bracket', 12.5, 4), ('Plate', 30, NULL);
        CREATE TABLE empty (id INTEGER);
    `;

    test("named queries become tables; an empty result keeps its columns", async () => {
        const tables = await readSqlite(await sqliteFile(SCHEMA), [
            { name: "Long", query: "SELECT name, length FROM parts WHERE length > 20" },
            { name: "Totals", query: "SELECT count(*) AS n, sum(length) AS total FROM parts" },
            { name: "None", query: "SELECT id FROM empty" },
        ]);
        expect(tables).toEqual([
            { name: "Long", columns: ["name", "length"], rows: [["Plate", 30]], hasHeader: true },
            { name: "Totals", columns: ["n", "total"], rows: [[2, 42.5]], hasHeader: true },
            { name: "None", columns: ["id"], rows: [], hasHeader: true },
        ]);
    });

    test("no queries: every table, whole; a bad query names itself", async () => {
        const bytes = await sqliteFile(SCHEMA);
        const tables = await readSqlite(bytes, []);
        expect(tables.map((table) => table.name)).toEqual(["empty", "parts"]);
        expect(tables[1].rows).toEqual([
            ["Bracket", 12.5, 4],
            ["Plate", 30, null],
        ]);
        await expect(readSqlite(bytes, [{ name: "Oops", query: "SELECT nope FROM parts" }])).rejects.toThrow(
            /^Query "Oops": .*no such column/,
        );
    });

    test("a statement that writes changes only the throwaway copy", async () => {
        const bytes = await sqliteFile(SCHEMA);
        await readSqlite(bytes, [{ name: "Drop", query: "DELETE FROM parts; SELECT 1 AS x" }]);
        const tables = await readSqlite(bytes, [{ name: "All", query: "SELECT count(*) AS n FROM parts" }]);
        expect(tables[0].rows).toEqual([[2]]);
    });
});
