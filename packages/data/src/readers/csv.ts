// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DataTable } from "@chili3d/core";
import { gridToTable, typeCell } from "../model/cells";

const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;

/**
 * Splits delimited text into rows of fields (RFC 4180): fields may be quoted, a quote inside a
 * quoted field is doubled, quoted fields may span lines; CRLF, LF and CR all end a record, a
 * leading byte-order mark is dropped, and a final line break does not make an empty row.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    let fieldStarted = false;
    const endField = () => {
        row.push(field);
        field = "";
        fieldStarted = false;
    };
    const endRow = () => {
        endField();
        rows.push(row);
        row = [];
    };
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (quoted) {
            if (ch !== '"') field += ch;
            else if (source[i + 1] === '"') {
                field += '"';
                i++;
            } else quoted = false;
            continue;
        }
        if (ch === '"' && !fieldStarted) {
            quoted = true;
            fieldStarted = true;
        } else if (ch === delimiter) endField();
        else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && source[i + 1] === "\n") i++;
            endRow();
        } else {
            field += ch;
            fieldStarted = true;
        }
    }
    if (fieldStarted || field !== "" || row.length > 0) endRow();
    return rows;
}

/** The delimiter of the first few lines: whichever candidate splits them most consistently. */
export function detectDelimiter(text: string): string {
    const sample = text
        .split(/\r\n|\n|\r/)
        .slice(0, 10)
        .join("\n");
    let best: string = ",";
    let bestScore = 0;
    for (const delimiter of CANDIDATE_DELIMITERS) {
        const counts = parseDelimited(sample, delimiter)
            .map((row) => row.length - 1)
            .filter((count) => count > 0);
        if (counts.length === 0) continue;
        const consistent = counts.filter((count) => count === counts[0]).length;
        const score = consistent * 1000 + counts[0];
        if (score > bestScore) {
            best = delimiter;
            bestScore = score;
        }
    }
    return best;
}

export interface CsvOptions {
    /** A single character; detected from the text when absent. */
    readonly delimiter?: string;
    readonly hasHeader?: boolean;
}

/** Delimited text as a table of typed cells (see `typeCell`). */
export function readCsv(name: string, text: string, options: CsvOptions = {}): DataTable {
    const delimiter = options.delimiter || detectDelimiter(text);
    const grid = parseDelimited(text, delimiter).map((row) => row.map(typeCell));
    return gridToTable(name, grid, options.hasHeader ?? true);
}
