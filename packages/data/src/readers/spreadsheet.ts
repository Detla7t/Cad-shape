// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DataCell, type DataTable, parseCellAddress } from "@chili3d/core";
import { gridToTable } from "../model/cells";
import {
    attribute,
    childElements,
    findElements,
    firstChild,
    parseXml,
    textContent,
    type XmlElement,
} from "./xml";

/**
 * Spreadsheet workbooks — Office Open XML (`.xlsx`, `.xlsm`) and OpenDocument (`.ods`) — read
 * straight from their zip parts: every sheet becomes a table of its cell VALUES (a formula's
 * cached result, not the formula). Styles are not read, so a date shows as its serial number.
 * Legacy binary `.xls` is not supported.
 */

type Zip = Awaited<ReturnType<typeof loadZip>>;

async function loadZip(bytes: Uint8Array) {
    const { default: JSZip } = await import("jszip");
    return JSZip.loadAsync(bytes);
}

async function zipText(zip: Zip, path: string): Promise<string | undefined> {
    const entry = zip.file(path) ?? zip.file(path.replace(/^\//, ""));
    return entry === null ? undefined : entry.async("string");
}

/** Repeated cells and rows beyond this many are trimmed (ODS writes a million empty rows). */
const MAX_REPEAT = 10_000;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

export function isZip(bytes: Uint8Array): boolean {
    return ZIP_MAGIC.every((byte, i) => bytes[i] === byte);
}

/** Every sheet of a workbook, detected from its content (zip parts), not its file name. */
export async function readWorkbook(bytes: Uint8Array, hasHeader = true): Promise<DataTable[]> {
    if (CFB_MAGIC.every((byte, i) => bytes[i] === byte)) {
        throw new Error("Legacy .xls workbooks are not supported — save the file as .xlsx or .ods");
    }
    if (!isZip(bytes)) throw new Error("Not a spreadsheet: the file is not an .xlsx or .ods workbook");
    const zip = await loadZip(bytes);
    if (zip.file("content.xml") !== null && zip.file("xl/workbook.xml") === null) {
        return readOdsZip(zip, hasHeader);
    }
    return readXlsxZip(zip, hasHeader);
}

// ------------------------------------------------------------------ Office Open XML

/** Resolves a relationship target against the folder of the part that names it. */
function resolveTarget(base: string, target: string): string {
    if (target.startsWith("/")) return target.slice(1);
    const parts = base.split("/").slice(0, -1);
    for (const segment of target.split("/")) {
        if (segment === "..") parts.pop();
        else if (segment !== ".") parts.push(segment);
    }
    return parts.join("/");
}

/**
 * The relationships of `part` (its `_rels/<name>.rels`), targets resolved against the part's
 * folder; `""` names the package itself (`_rels/.rels`).
 */
async function relationships(zip: Zip, part: string): Promise<Map<string, { target: string; type: string }>> {
    const slash = part.lastIndexOf("/");
    const relsPath = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
    const text = await zipText(zip, relsPath);
    const rels = new Map<string, { target: string; type: string }>();
    if (text === undefined) return rels;
    for (const rel of findElements(parseXml(text), "Relationship")) {
        const id = attribute(rel, "Id");
        const target = attribute(rel, "Target");
        if (id !== undefined && target !== undefined) {
            rels.set(id, { target: resolveTarget(part, target), type: attribute(rel, "Type") ?? "" });
        }
    }
    return rels;
}

async function workbookPath(zip: Zip): Promise<string> {
    for (const rel of (await relationships(zip, "")).values()) {
        if (rel.type.endsWith("/officeDocument")) return rel.target;
    }
    return "xl/workbook.xml";
}

/** A shared-string item: its text runs joined, phonetic hints (`rPh`) left out. */
function stringItem(item: XmlElement): string {
    return findElements(item, "t", (element) => element.name !== "rPh")
        .map(textContent)
        .join("");
}

async function readXlsxZip(zip: Zip, hasHeader: boolean): Promise<DataTable[]> {
    const workbookPart = await workbookPath(zip);
    const workbookText = await zipText(zip, workbookPart);
    if (workbookText === undefined) throw new Error("Not a spreadsheet: the workbook part is missing");
    const workbook = parseXml(workbookText);
    const rels = await relationships(zip, workbookPart);

    let shared: string[] = [];
    const sharedRel = [...rels.values()].find((rel) => rel.type.endsWith("/sharedStrings"));
    const sharedText = await zipText(zip, sharedRel?.target ?? "xl/sharedStrings.xml");
    if (sharedText !== undefined) shared = childElements(parseXml(sharedText), "si").map(stringItem);

    const tables: DataTable[] = [];
    for (const sheet of findElements(workbook, "sheet")) {
        const name = attribute(sheet, "name") ?? `Sheet${tables.length + 1}`;
        const relId = attribute(sheet, "id");
        const target = relId === undefined ? undefined : rels.get(relId)?.target;
        if (target === undefined) continue;
        const text = await zipText(zip, target);
        // A chart sheet or a missing part has no cells — skip it rather than fail the workbook.
        if (text === undefined) continue;
        const root = parseXml(text);
        if (root.name !== "worksheet") continue;
        tables.push(gridToTable(name, xlsxGrid(root, shared), hasHeader));
    }
    return tables;
}

function xlsxGrid(sheet: XmlElement, shared: readonly string[]): DataCell[][] {
    const grid: DataCell[][] = [];
    const data = firstChild(sheet, "sheetData");
    if (data === undefined) return grid;
    let rowIndex = -1;
    for (const row of childElements(data, "row")) {
        const r = Number(attribute(row, "r"));
        rowIndex = Number.isInteger(r) && r > 0 ? r - 1 : rowIndex + 1;
        if (rowIndex >= 1_048_576) break;
        grid[rowIndex] ??= [];
        const cells = grid[rowIndex];
        let columnIndex = -1;
        for (const cell of childElements(row, "c")) {
            const address = parseCellAddress(attribute(cell, "r") ?? "");
            columnIndex = address === undefined ? columnIndex + 1 : address.column;
            cells[columnIndex] = xlsxCellValue(cell, shared);
        }
    }
    for (let i = 0; i < grid.length; i++) grid[i] ??= [];
    return grid;
}

function xlsxCellValue(cell: XmlElement, shared: readonly string[]): DataCell {
    const type = attribute(cell, "t") ?? "n";
    if (type === "inlineStr") {
        const inline = firstChild(cell, "is");
        return inline === undefined ? null : stringItem(inline);
    }
    const valueElement = firstChild(cell, "v");
    if (valueElement === undefined) return null;
    const raw = textContent(valueElement);
    switch (type) {
        case "s":
            return shared[Number(raw)] ?? null;
        case "b":
            return raw.trim() === "1";
        case "str":
        case "e":
        case "d":
            return raw;
        default: {
            const value = Number(raw);
            return raw.trim() === "" || !Number.isFinite(value) ? null : value;
        }
    }
}

// ------------------------------------------------------------------ OpenDocument

async function readOdsZip(zip: Zip, hasHeader: boolean): Promise<DataTable[]> {
    const text = await zipText(zip, "content.xml");
    if (text === undefined) throw new Error("Not a spreadsheet: content.xml is missing");
    const content = parseXml(text);
    const spreadsheet = findElements(content, "spreadsheet")[0];
    if (spreadsheet === undefined) throw new Error("Not a spreadsheet: the document has no spreadsheet body");
    return findElements(spreadsheet, "table").map((table, index) =>
        gridToTable(attribute(table, "name") ?? `Sheet${index + 1}`, odsGrid(table), hasHeader),
    );
}

const repeatCount = (element: XmlElement, name: string) => {
    const count = Number(attribute(element, name) ?? "1");
    return Number.isInteger(count) && count > 0 ? count : 1;
};

function odsGrid(table: XmlElement): DataCell[][] {
    // Rows sit directly in the table or in header-row and row groups; never in a nested table.
    const rows = findElements(table, "table-row", (element) => element.name !== "table");
    const runs: { cells: DataCell[]; repeat: number }[] = rows.map((row) => ({
        cells: odsRow(row),
        repeat: repeatCount(row, "number-rows-repeated"),
    }));
    while (runs.length > 0 && runs[runs.length - 1].cells.length === 0) runs.pop();
    const grid: DataCell[][] = [];
    for (const run of runs) {
        for (let i = 0; i < Math.min(run.repeat, MAX_REPEAT); i++) grid.push([...run.cells]);
    }
    return grid;
}

function odsRow(row: XmlElement): DataCell[] {
    const runs: { value: DataCell; repeat: number }[] = [];
    for (const cell of childElements(row)) {
        if (cell.name !== "table-cell" && cell.name !== "covered-table-cell") continue;
        runs.push({ value: odsCellValue(cell), repeat: repeatCount(cell, "number-columns-repeated") });
    }
    while (runs.length > 0 && runs[runs.length - 1].value === null) runs.pop();
    const cells: DataCell[] = [];
    for (const run of runs) {
        for (let i = 0; i < Math.min(run.repeat, MAX_REPEAT); i++) cells.push(run.value);
    }
    return cells;
}

function odsCellValue(cell: XmlElement): DataCell {
    const type = attribute(cell, "value-type");
    switch (type) {
        case "float":
        case "percentage":
        case "currency": {
            const value = Number(attribute(cell, "value"));
            return Number.isFinite(value) ? value : null;
        }
        case "boolean":
            return attribute(cell, "boolean-value") === "true";
        case "date":
            return attribute(cell, "date-value") ?? odsText(cell);
        case "time":
            return attribute(cell, "time-value") ?? odsText(cell);
        case undefined:
            return null;
        default:
            return odsText(cell);
    }
}

/** A cell's paragraphs, `text:s` runs as spaces, `text:tab` as tabs, lines joined by newlines. */
function odsText(cell: XmlElement): string {
    const inline = (element: XmlElement): string =>
        element.children
            .map((child) => {
                if (typeof child === "string") return child;
                if (child.name === "s") return " ".repeat(repeatCount(child, "c"));
                if (child.name === "tab") return "\t";
                if (child.name === "line-break") return "\n";
                return inline(child);
            })
            .join("");
    return childElements(cell, "p").map(inline).join("\n");
}
