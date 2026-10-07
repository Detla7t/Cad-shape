// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { generalNumberText, type WorkbookEvaluator } from "./formula";
import {
    addressOf,
    type CellData,
    cellFromInput,
    type SheetData,
    usedSize,
    type WorkbookData,
} from "./model";

/**
 * CSV and TSV (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes, CRLF
 * or LF). The delimiter is detected from the first lines (comma, semicolon, tab or pipe).
 * Reading types each field like typing it into the grid — numbers, booleans and "=…"
 * formulas; leading zeros ("007") stay text. Writing stores values: formulas are written
 * as their results, as Excel and LibreOffice do.
 */

export function detectDelimiter(text: string): string {
    const sample = text.split(/\r?\n/).slice(0, 10);
    let best = ",";
    let bestScore = 0;
    for (const delimiter of [",", ";", "\t", "|"]) {
        const counts = sample.map((line) => splitLine(line, delimiter).length - 1).filter((n) => n > 0);
        if (counts.length === 0) continue;
        const consistent = counts.filter((n) => n === counts[0]).length;
        const score = consistent * 10 + counts[0];
        if (score > bestScore) {
            best = delimiter;
            bestScore = score;
        }
    }
    return best;
}

function splitLine(line: string, delimiter: string): string[] {
    return parseCsv(line, delimiter)[0] ?? [];
}

/** The rows of a CSV text, fields as text. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    for (; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else quoted = false;
            } else field += char;
            continue;
        }
        if (char === '"' && field === "") quoted = true;
        else if (char === delimiter) {
            row.push(field);
            field = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[i + 1] === "\n") i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else field += char;
    }
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

function quote(field: string, delimiter: string): string {
    return /["\r\n]/.test(field) || field.includes(delimiter) || /^\s|\s$/.test(field)
        ? `"${field.replace(/"/g, '""')}"`
        : field;
}

export function writeCsv(rows: readonly (readonly string[])[], delimiter = ","): string {
    return `${rows.map((row) => row.map((field) => quote(field, delimiter)).join(delimiter)).join("\r\n")}\r\n`;
}

/** A CSV text as a one-sheet workbook. */
export function csvToWorkbook(text: string, sheetName: string, delimiter?: string): WorkbookData {
    const rows = parseCsv(text, delimiter);
    const cells: Record<string, CellData> = {};
    rows.forEach((row, r) => {
        row.forEach((field, c) => {
            // Keep leading zeros (ids, part numbers) as text.
            const cell = /^0\d+$/.test(field.trim()) ? { v: field } : cellFromInput(field);
            if (cell !== undefined) cells[addressOf(r, c)] = cell;
        });
    });
    return { sheets: [{ name: sheetName, cells }] };
}

/** The values of a sheet as CSV (formulas as their evaluated results). */
export function sheetToCsv(
    sheet: SheetData,
    evaluator: WorkbookEvaluator,
    sheetIndex: number,
    delimiter = ",",
): string {
    const { rows, cols } = usedSize(sheet);
    const out: string[][] = [];
    for (let r = 0; r < rows; r++) {
        const row: string[] = [];
        for (let c = 0; c < cols; c++) {
            const value = evaluator.value(sheetIndex, addressOf(r, c));
            row.push(
                value === null
                    ? ""
                    : typeof value === "number"
                      ? generalNumberText(value)
                      : typeof value === "boolean"
                        ? value
                            ? "TRUE"
                            : "FALSE"
                        : String(value),
            );
        }
        out.push(row);
    }
    return writeCsv(out, delimiter);
}
