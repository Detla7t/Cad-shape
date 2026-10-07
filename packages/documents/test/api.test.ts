// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { TestDocument, TestNode } from "@chili3d/core/test-utils";
import {
    canReadDocumentTable,
    DOCUMENT_NOT_LOADED,
    DOCUMENT_TABLE_PROVIDER,
    documentRevision,
    documentTableNames,
    loadDocumentTable,
    onDocumentTablesChanged,
    readDocumentTable,
    readDocumentText,
} from "../src/api";
import { DocumentFileNode } from "../src/documentFileNode";
import { htmlToBlocks } from "../src/richtext/blocks";
import { blocksToDocx } from "../src/richtext/docx";
import type { WorkbookData } from "../src/sheet/model";
import { writeWorkbook } from "../src/sheet/workbookIo";

const document = new TestDocument();

function csvNode(text: string, name = "parts") {
    return new DocumentFileNode({ document, fileName: `${name}.csv`, format: "csv", text });
}

async function xlsxNode(): Promise<DocumentFileNode> {
    const workbook: WorkbookData = {
        sheets: [
            {
                name: "Dims",
                cells: {
                    A1: { v: "width" },
                    B1: { v: 120 },
                    A2: { v: "height" },
                    B2: { v: 80 },
                    B3: { f: "B1*B2" },
                },
            },
            {
                name: "Cut list",
                cells: {
                    A1: { v: "part" },
                    B1: { v: "qty" },
                    A2: { v: "bolt" },
                    B2: { v: 4 },
                    A3: { v: "nut" },
                    B3: { f: "B2*2" },
                    C3: { f: "1/0" },
                },
            },
        ],
    };
    const bytes = await writeWorkbook(workbook, "xlsx");
    return new DocumentFileNode({ document, fileName: "dims.xlsx", format: "xlsx", bytes: bytes.value });
}

describe("readDocumentTable (synchronous)", () => {
    test("a CSV at once: header row detected, values typed, formulas evaluated", () => {
        const node = csvNode("part,qty,each,total\nbolt,4,0.5,=B2*C2\nnut,8,0.1,=B3*C3\n");
        const table = readDocumentTable(node);
        expect(table.isOk).toBe(true);
        expect(table.value).toEqual({
            name: "parts",
            range: "A1:D3",
            columns: ["part", "qty", "each", "total"],
            rows: [
                ["bolt", 4, 0.5, 2],
                ["nut", 8, 0.1, 0.8],
            ],
            hasHeader: true,
        });
    });

    test("without a header row the columns are the column letters", () => {
        const table = readDocumentTable(csvNode("1,2\n3,4\n")).value;
        expect(table).toMatchObject({
            columns: ["A", "B"],
            rows: [
                [1, 2],
                [3, 4],
            ],
            hasHeader: false,
        });
    });

    test("a binary workbook answers 'not loaded', parses, notifies, then reads synchronously", async () => {
        const node = await xlsxNode();
        const changed: DocumentFileNode[] = [];
        const subscription = onDocumentTablesChanged((which) => changed.push(which));
        try {
            expect(readDocumentTable(node, 0, "B3").error).toBe(DOCUMENT_NOT_LOADED);
            expect(documentTableNames(node)).toEqual([]);
            await loadDocumentTable(node);
            expect(changed).toEqual([node]);
            expect(readDocumentTable(node, 0, "B3").value).toEqual({
                name: "Dims",
                range: "B3",
                columns: ["B"],
                rows: [[9600]],
                hasHeader: false,
            });
            expect(documentTableNames(node)).toEqual(["Dims", "Cut list"]);
        } finally {
            subscription.dispose();
        }
    });

    test("sheets by name or index, ranges, whole columns, sheet-prefixed ranges and errors as text", async () => {
        const node = await xlsxNode();
        await loadDocumentTable(node);
        expect(readDocumentTable(node, "dims", "B3").value.rows).toEqual([[9600]]);
        expect(readDocumentTable(node, 1).value).toMatchObject({
            columns: ["part", "qty", "C"],
            rows: [
                ["bolt", 4, null],
                ["nut", 8, "#DIV/0!"],
            ],
            hasHeader: true,
        });
        expect(readDocumentTable(node, 0, "'Cut list'!B:B").value).toMatchObject({
            name: "Cut list",
            range: "B1:B3",
            rows: [["qty"], [4], [8]],
        });
        expect(readDocumentTable(node, 0, "'Cut list'!B:B", { header: true }).value).toMatchObject({
            columns: ["qty"],
            rows: [[4], [8]],
        });
    });

    test("errors: not a spreadsheet, no such sheet, a bad range", async () => {
        const node = await xlsxNode();
        await loadDocumentTable(node);
        expect(readDocumentTable(node, "Missing").error).toBe('No sheet "Missing"');
        expect(readDocumentTable(node, 0, "A1:??").isOk).toBe(false);
        expect(readDocumentTable(new TestNode("plain")).isOk).toBe(false);
        const markdown = new DocumentFileNode({
            document,
            fileName: "a.md",
            format: "markdown",
            text: "# A",
        });
        expect(readDocumentTable(markdown).error).toBe("a is not a spreadsheet document");
        expect(canReadDocumentTable(markdown)).toBe(false);
        expect(canReadDocumentTable(node)).toBe(true);
    });

    test("an edit changes the revision and the values read", () => {
        const node = csvNode("x,1\n");
        const before = documentRevision(node);
        expect(readDocumentTable(node, 0, "B1").value.rows).toEqual([[1]]);
        node.setText("x,2\n");
        expect(documentRevision(node)).not.toBe(before);
        expect(documentRevision(node)).toBe(documentRevision(node));
        expect(readDocumentTable(node, 0, "B1").value.rows).toEqual([[2]]);
    });

    test("the data-table provider bundles the same functions", () => {
        const node = csvNode("a,b\nx,1\n");
        expect(DOCUMENT_TABLE_PROVIDER.canRead(node)).toBe(true);
        expect(DOCUMENT_TABLE_PROVIDER.tableNames(node)).toEqual(["parts"]);
        expect(DOCUMENT_TABLE_PROVIDER.readTable(node).value).toMatchObject({
            columns: ["a", "b"],
            rows: [["x", 1]],
        });
        expect(DOCUMENT_TABLE_PROVIDER.revision(node)).toBe(documentRevision(node));
    });
});

describe("readDocumentText", () => {
    test("text formats as they are, HTML and Word documents as plain text, spreadsheets tab-separated", async () => {
        const markdown = new DocumentFileNode({
            document,
            fileName: "n.md",
            format: "markdown",
            text: "# Notes\n\n- a",
        });
        expect((await readDocumentText(markdown)).value).toBe("# Notes\n\n- a");
        const html = new DocumentFileNode({
            document,
            fileName: "p.html",
            format: "html",
            text: "<h1>T</h1><p>x <b>y</b></p>",
        });
        expect((await readDocumentText(html)).value).toBe("T\nx y");
        const root = window.document.createElement("div");
        root.innerHTML = "<h1>Report</h1><p>Duct <strong>run</strong></p>";
        const docx = new DocumentFileNode({
            document,
            fileName: "r.docx",
            format: "docx",
            bytes: await blocksToDocx(htmlToBlocks(root)),
        });
        expect((await readDocumentText(docx)).value).toBe("Report\nDuct run");
        expect((await readDocumentText(await xlsxNode())).value).toBe("width\t120\nheight\t80\n\t9600");
    });

    test("a document without text is an error", async () => {
        const image = new DocumentFileNode({
            document,
            fileName: "i.png",
            format: "png",
            bytes: new Uint8Array([1]),
        });
        expect((await readDocumentText(image)).isOk).toBe(false);
    });
});
