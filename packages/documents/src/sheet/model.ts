// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The workbook model shared by the spreadsheet readers/writers, the formula engine, the
 * grid editor and `readDocumentTable`: plain, structured-clone friendly data (it crosses
 * into the parsing worker), cells keyed by A1 address.
 */

import type { DataValidation, DefinedNamesModel, Style } from "exceljs";

export type CellValue = number | string | boolean;
/** Excel's serializable style data; ExcelJS remains a lazy runtime dependency. */
export type CellStyle = Partial<Omit<Style, "numFmt">>;

export interface CellData {
    /** The literal value, or a formula's cached result. */
    v?: CellValue;
    /** A formula without the leading "=", e.g. "SUM(A1:A3)". */
    f?: string;
    /** Number format code ("0.00", "0%", "yyyy-mm-dd"); absent for General. */
    z?: string;
    /** The cell holds an error value (`v` is its code, e.g. "#N/A"). */
    e?: boolean;
    s?: CellStyle;
}

export interface SheetData {
    name: string;
    /** By A1 address ("B3"). */
    cells: Record<string, CellData>;
    /** Column widths in pixels by column index (absent: default width). */
    cols?: (number | null)[];
    /** Row heights in pixels, keyed by zero-based row index. */
    rows?: Record<number, number>;
    /** Merged ranges, e.g. "A1:C1". */
    merges?: string[];
    /** Excel validation rules keyed by a cell or rectangular range. */
    validations?: Record<string, DataValidation>;
    /** Header and data range for the column filter controls. */
    autoFilter?: string;
    hiddenRows?: number[];
    hiddenCols?: number[];
    frozen?: { rows: number; cols: number };
}

export interface WorkbookData {
    sheets: SheetData[];
    /** Workbook-scoped names, with Excel-qualified absolute references. */
    names?: DefinedNamesModel;
}

export interface CellAddress {
    /** 0-based. */
    readonly row: number;
    readonly col: number;
}

export interface CellRange {
    readonly start: CellAddress;
    readonly end: CellAddress;
}

/** "A", "B", …, "Z", "AA", … for a 0-based column index. */
export function columnName(col: number): string {
    let name = "";
    for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    }
    return name;
}

/** 0-based index of a column name ("A" → 0, "AA" → 26); -1 when invalid. */
export function columnIndex(name: string): number {
    if (!/^[A-Za-z]{1,3}$/.test(name)) return -1;
    let index = 0;
    for (const char of name.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
    return index - 1;
}

export function addressOf(row: number, col: number): string {
    return `${columnName(col)}${row + 1}`;
}

/** "B3" or "$B$3" → { row: 2, col: 1 }; undefined when not an address. */
export function parseAddress(text: string): CellAddress | undefined {
    const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text.trim());
    if (!match) return undefined;
    const row = Number.parseInt(match[2], 10) - 1;
    const col = columnIndex(match[1]);
    if (row < 0 || col < 0) return undefined;
    return { row, col };
}

/** "A1:C3", a single "B2", a column span "A:C" or a row span "2:5" (within `bounds`). */
export function parseRange(text: string, bounds?: { rows: number; cols: number }): CellRange | undefined {
    const parts = text.trim().split(":");
    if (parts.length === 1) {
        const at = parseAddress(parts[0]);
        return at === undefined ? undefined : { start: at, end: at };
    }
    if (parts.length !== 2) return undefined;
    const [a, b] = parts.map((part) => part.replace(/\$/g, ""));
    const rows = Math.max(1, bounds?.rows ?? 1);
    const cols = Math.max(1, bounds?.cols ?? 1);
    if (/^[A-Za-z]{1,3}$/.test(a) && /^[A-Za-z]{1,3}$/.test(b)) {
        return normalizeRange({ row: 0, col: columnIndex(a) }, { row: rows - 1, col: columnIndex(b) });
    }
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
        return normalizeRange({ row: Number(a) - 1, col: 0 }, { row: Number(b) - 1, col: cols - 1 });
    }
    const start = parseAddress(a);
    const end = parseAddress(b);
    if (start === undefined || end === undefined) return undefined;
    return normalizeRange(start, end);
}

export function normalizeRange(a: CellAddress, b: CellAddress): CellRange {
    return {
        start: { row: Math.min(a.row, b.row), col: Math.min(a.col, b.col) },
        end: { row: Math.max(a.row, b.row), col: Math.max(a.col, b.col) },
    };
}

export function rangeText(range: CellRange): string {
    const start = addressOf(range.start.row, range.start.col);
    const end = addressOf(range.end.row, range.end.col);
    return start === end ? start : `${start}:${end}`;
}

/** Rows and columns up to the last non-empty cell. */
export function usedSize(sheet: SheetData, includeFormatting = false): { rows: number; cols: number } {
    let rows = 0;
    let cols = 0;
    for (const [key, cell] of Object.entries(sheet.cells)) {
        if (
            cell.v === undefined &&
            cell.f === undefined &&
            (!includeFormatting || (cell.s === undefined && cell.z === undefined))
        )
            continue;
        const at = parseAddress(key);
        if (at === undefined) continue;
        rows = Math.max(rows, at.row + 1);
        cols = Math.max(cols, at.col + 1);
    }
    for (const merge of includeFormatting ? (sheet.merges ?? []) : []) {
        const range = parseRange(merge);
        if (range) {
            rows = Math.max(rows, range.end.row + 1);
            cols = Math.max(cols, range.end.col + 1);
        }
    }
    return { rows, cols };
}

export function emptyWorkbook(sheetName = "Sheet1"): WorkbookData {
    return { sheets: [{ name: sheetName, cells: {} }] };
}

/** A deep copy (the editor's draft). */
export function cloneWorkbook(workbook: WorkbookData): WorkbookData {
    return structuredClone(workbook);
}

/**
 * Parses what a user types into a cell: "=…" is a formula, numbers (also "12%",
 * "1e3") are numbers, TRUE/FALSE booleans, anything else text. Empty clears the value.
 */
export function cellFromInput(input: string, keepFormat?: string): CellData | undefined {
    const text = input.trim();
    const z = keepFormat === undefined ? {} : { z: keepFormat };
    if (input === "") return keepFormat === undefined ? undefined : { z: keepFormat };
    if (text.startsWith("=") && text.length > 1) return { f: text.slice(1), ...z };
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?%$/.test(text)) {
        return { v: Number.parseFloat(text.slice(0, -1)) / 100, z: keepFormat ?? "0%" };
    }
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return { v: Number.parseFloat(text), ...z };
    if (/^(true|false)$/i.test(text)) return { v: text.toUpperCase() === "TRUE", ...z };
    return { v: input, ...z };
}

/** What the formula bar shows for a cell: "=formula" or the raw value. */
export function cellInputText(cell: CellData | undefined): string {
    if (cell === undefined) return "";
    if (cell.f !== undefined) return `=${cell.f}`;
    if (cell.v === undefined) return "";
    if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
    return String(cell.v);
}
