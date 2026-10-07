// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    columnName,
    type DataCell,
    type DataTable,
    LENGTH_UNITS,
    parseDataQuantity,
    unitSpecEquals,
} from "@chili3d/core";

/** What a column holds, for the preview's header and the variable import's guess. */
export type DataColumnType = "number" | "length" | "angle" | "boolean" | "text" | "mixed" | "empty";

const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A text cell (a CSV field, a SQLite text value) as a typed cell: empty is `null`, a plain number
 * a number, `true`/`false` a boolean, anything else trimmed text — "12 mm" stays text and is read
 * as a quantity where a number is wanted. A number written with a leading zero ("007") is an
 * identifier, not a quantity, and stays text.
 */
export function typeCell(text: string): DataCell {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    if (NUMBER_TEXT.test(trimmed) && !/^[+-]?0\d/.test(trimmed)) return Number(trimmed);
    const lower = trimmed.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    return trimmed;
}

/** One cell's type; `undefined` for an empty one. */
export function cellType(cell: DataCell | undefined): Exclude<DataColumnType, "mixed" | "empty"> | undefined {
    if (cell === null || cell === undefined) return undefined;
    if (typeof cell === "number") return "number";
    if (typeof cell === "boolean") return "boolean";
    if (cell.trim() === "") return undefined;
    const quantity = parseDataQuantity(cell);
    if (quantity === undefined) return "text";
    if (unitSpecEquals(quantity.unit, LENGTH_UNITS)) return "length";
    if (unitSpecEquals(quantity.unit, ANGLE_UNITS)) return "angle";
    return "number";
}

/** The type every non-empty cell of a column shares; `mixed` when they differ. */
export function columnType(table: DataTable, column: number): DataColumnType {
    let type: DataColumnType = "empty";
    for (const row of table.rows) {
        const cell = cellType(row[column]);
        if (cell === undefined) continue;
        type = type === "empty" ? cell : mergeTypes(type, cell);
        if (type === "mixed") return type;
    }
    return type;
}

/** Plain numbers adopt the unit of the quantities beside them, as a literal does in an expression. */
function mergeTypes(a: DataColumnType, b: DataColumnType): DataColumnType {
    if (a === b) return a;
    const quantity = (type: DataColumnType) => type === "length" || type === "angle";
    if (a === "number" && quantity(b)) return b;
    if (b === "number" && quantity(a)) return a;
    return "mixed";
}

export function columnTypes(table: DataTable): DataColumnType[] {
    return table.columns.map((_, index) => columnType(table, index));
}

/**
 * A grid of cells as a table: trailing empty rows and columns dropped, and — with a header row —
 * the first row as unique, non-empty column names (`A`, `B`, … for blanks, `Name (2)` for repeats).
 */
export function gridToTable(
    name: string,
    grid: readonly (readonly DataCell[])[],
    hasHeader = true,
): DataTable {
    const isEmpty = (cell: DataCell | undefined) => cell === null || cell === undefined || cell === "";
    let height = grid.length;
    while (height > 0 && grid[height - 1].every(isEmpty)) height--;
    let width = 0;
    for (let r = 0; r < height; r++) {
        const row = grid[r];
        for (let c = row.length - 1; c >= width; c--) {
            if (!isEmpty(row[c])) {
                width = c + 1;
                break;
            }
        }
    }
    const rows = grid
        .slice(0, height)
        .map((row) => Array.from({ length: width }, (_, c) => (row[c] === undefined ? null : row[c])));
    if (!hasHeader) {
        return {
            name,
            columns: Array.from({ length: width }, (_, c) => columnName(c)),
            rows,
            hasHeader: false,
        };
    }
    const [header = [], ...data] = rows;
    return { name, columns: uniqueHeaders(header), rows: data, hasHeader: true };
}

/** Header cells as column names: text, blanks named by their letters, repeats numbered. */
export function uniqueHeaders(header: readonly DataCell[]): string[] {
    const seen = new Map<string, number>();
    return header.map((cell, index) => {
        const base = cell === null || String(cell).trim() === "" ? columnName(index) : String(cell).trim();
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        return count === 1 ? base : `${base} (${count})`;
    });
}

/** A cell as the preview grid shows it. */
export function cellText(cell: DataCell | undefined): string {
    if (cell === null || cell === undefined) return "";
    if (typeof cell === "number") return String(Math.round(cell * 1e12) / 1e12);
    return String(cell);
}
