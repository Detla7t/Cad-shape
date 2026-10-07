// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DataCell, type DataTable, Result } from "@chili3d/core";
import { gridToTable, uniqueHeaders } from "../model/cells";

/**
 * JSON as tables. Rows may be an array of objects (columns are the keys, in first-seen order),
 * an array of arrays (the first is the header row unless the source says otherwise), an array
 * of plain values (one `value` column), or a `{ columns, rows }` / `{ fields, rows }` result as
 * SQL-over-HTTP endpoints answer. Nested values arrive as their JSON text.
 */

/** Keys a REST response commonly wraps its rows in, tried when no path is given. */
const ROW_KEYS = ["rows", "data", "items", "results", "records", "value", "values"];

/**
 * Follows a path into a JSON value: `data.items`, `$.data.items`, `results[0].rows`,
 * `["odd key"].list`. An empty path is the value itself.
 */
export function followJsonPath(value: unknown, path: string | undefined): Result<unknown> {
    const source = (path ?? "").trim().replace(/^\$/, "");
    let current = value;
    const pattern =
        /\.?([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'((?:[^'\\]|\\.)*)'\s*\]/y;
    let pos = 0;
    while (pos < source.length) {
        pattern.lastIndex = pos;
        const match = pattern.exec(source);
        if (match === null) return Result.err(`Bad JSON path at "${source.slice(pos)}"`);
        pos = pattern.lastIndex;
        const key = match[1] ?? match[3] ?? match[4];
        if (key !== undefined) {
            if (
                current === null ||
                typeof current !== "object" ||
                Array.isArray(current) ||
                !(key in current)
            ) {
                return Result.err(`JSON path: no "${key}" in ${describe(current)}`);
            }
            current = (current as Record<string, unknown>)[key];
        } else {
            const index = Number(match[2]);
            if (!Array.isArray(current) || index >= current.length) {
                return Result.err(`JSON path: no [${index}] in ${describe(current)}`);
            }
            current = current[index];
        }
    }
    return Result.ok(current);
}

function describe(value: unknown): string {
    if (Array.isArray(value)) return `a list of ${value.length}`;
    if (value === null) return "null";
    return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function jsonCell(value: unknown): DataCell {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    return JSON.stringify(value);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

/** The rows of `value` (after `path`) as a table. */
export function jsonToTable(
    name: string,
    value: unknown,
    path?: string,
    hasHeader = true,
): Result<DataTable> {
    const followed = followJsonPath(value, path);
    if (!followed.isOk) return Result.err(followed.error);
    let rows = followed.value;
    if ((path ?? "").trim() === "" && isRecord(rows)) {
        const wrapped = rowsOfResult(name, rows);
        if (wrapped !== undefined) return Result.ok(wrapped);
        const key = ROW_KEYS.find((candidate) => Array.isArray((rows as Record<string, unknown>)[candidate]));
        if (key !== undefined) rows = rows[key];
    }
    if (isRecord(rows)) {
        const wrapped = rowsOfResult(name, rows);
        if (wrapped !== undefined) return Result.ok(wrapped);
        // One object is one row.
        rows = [rows];
    }
    if (!Array.isArray(rows)) return Result.err(`Expected a list of rows, got ${describe(rows)}`);
    return Result.ok(arrayToTable(name, rows, hasHeader));
}

/** `{ columns: [...], rows: [[...]] }` or `{ fields: [{ name }], rows }`. */
function rowsOfResult(name: string, value: Record<string, unknown>): DataTable | undefined {
    const rows = value["rows"];
    const columns = value["columns"] ?? value["fields"];
    if (!Array.isArray(rows) || !Array.isArray(columns)) return undefined;
    if (!rows.every(Array.isArray)) return undefined;
    const names = columns.map((column) =>
        isRecord(column) ? String(column["name"] ?? column["field"] ?? "") : String(column),
    );
    return {
        name,
        columns: uniqueHeaders(names),
        rows: (rows as unknown[][]).map((row) => names.map((_, i) => jsonCell(row[i]))),
        hasHeader: true,
    };
}

export function arrayToTable(name: string, rows: readonly unknown[], hasHeader = true): DataTable {
    if (rows.length > 0 && rows.every(Array.isArray)) {
        return gridToTable(
            name,
            (rows as unknown[][]).map((row) => row.map(jsonCell)),
            hasHeader,
        );
    }
    if (rows.length > 0 && rows.every((row) => !isRecord(row))) {
        return { name, columns: ["value"], rows: rows.map((row) => [jsonCell(row)]), hasHeader: true };
    }
    const columns: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        if (!isRecord(row)) continue;
        for (const key of Object.keys(row)) {
            if (!seen.has(key)) {
                seen.add(key);
                columns.push(key);
            }
        }
    }
    return {
        name,
        columns,
        rows: rows.map((row) => columns.map((column) => (isRecord(row) ? jsonCell(row[column]) : null))),
        hasHeader: true,
    };
}

/** JSON text as tables; a parse error is the result's error. */
export function readJson(name: string, text: string, path?: string, hasHeader = true): Result<DataTable> {
    let value: unknown;
    try {
        value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (error) {
        return Result.err(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return jsonToTable(name, value, path, hasHeader);
}
