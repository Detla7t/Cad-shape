// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DataCell } from "@chili3d/core";
import type { Database, SqlValue } from "sql.js";
import { loadSqlJs } from "../readers/sqlite";

/**
 * The database manager's SQLite operations over sql.js: open a file as a live database,
 * list its tables and columns, page through rows (by rowid, so a row can be written
 * back), run SQL, change cells, add and delete rows, and export the file again.
 */

export interface ColumnInfo {
    readonly name: string;
    readonly type: string;
    readonly primaryKey: boolean;
    readonly notNull: boolean;
    /** The column's DEFAULT expression as declared, if any. */
    readonly defaultValue?: string;
}

export interface QueryResult {
    readonly columns: string[];
    readonly rows: DataCell[][];
    /** Rows changed by the last statement, for statements that return nothing. */
    readonly changes: number;
}

export interface TableRows {
    readonly columns: string[];
    /** Each row's rowid, then its cells. */
    readonly rows: { readonly rowid: number; readonly cells: DataCell[] }[];
    readonly total: number;
}

export const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

function cell(value: SqlValue): DataCell {
    if (value === null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") return value;
    return `<blob ${value.length} bytes>`;
}

export async function openDatabase(bytes: Uint8Array | undefined): Promise<Database> {
    const SQL = await loadSqlJs();
    try {
        return bytes === undefined || bytes.length === 0 ? new SQL.Database() : new SQL.Database(bytes);
    } catch (error) {
        throw new Error(`Not a SQLite database: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function listTables(db: Database): string[] {
    const result = db.exec(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    return (result[0]?.values ?? []).map((row) => String(row[0]));
}

export function tableColumns(db: Database, table: string): ColumnInfo[] {
    const result = db.exec(`PRAGMA table_info(${quoteIdentifier(table)})`);
    return (result[0]?.values ?? []).map((row) => ({
        name: String(row[1]),
        type: String(row[2] ?? ""),
        notNull: Number(row[3]) === 1,
        primaryKey: Number(row[5]) > 0,
        ...(row[4] === null || row[4] === undefined ? {} : { defaultValue: String(row[4]) }),
    }));
}

/** A page of a table's rows, each with its rowid. */
export function readRows(db: Database, table: string, limit = 200, offset = 0): TableRows {
    const columns = tableColumns(db, table).map((column) => column.name);
    const total = Number(db.exec(`SELECT count(*) FROM ${quoteIdentifier(table)}`)[0]?.values[0]?.[0] ?? 0);
    const statement = db.prepare(
        `SELECT rowid, ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)} LIMIT ? OFFSET ?`,
    );
    const rows: TableRows["rows"] = [];
    try {
        statement.bind([limit, offset]);
        while (statement.step()) {
            const values = statement.get();
            rows.push({ rowid: Number(values[0]), cells: values.slice(1).map(cell) });
        }
    } finally {
        statement.free();
    }
    return { columns, rows, total };
}

/** Runs `sql` (several statements allowed); the last result set, or the rows changed. */
export function runSql(db: Database, sql: string): QueryResult {
    let columns: string[] = [];
    let rows: DataCell[][] = [];
    let changes = 0;
    for (const statement of db.iterateStatements(sql)) {
        const names = statement.getColumnNames();
        const values: DataCell[][] = [];
        while (statement.step()) values.push(statement.get().map(cell));
        if (names.length > 0) {
            columns = names;
            rows = values;
        } else changes += db.getRowsModified();
    }
    return { columns, rows, changes };
}

/** A cell's text as the value to store: empty is NULL, a number is a number, else the text. */
export function cellValue(text: string): SqlValue {
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.toUpperCase() === "NULL") return null;
    const number = Number(trimmed);
    return trimmed !== "" && Number.isFinite(number) && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)
        ? number
        : text;
}

export function updateCell(
    db: Database,
    table: string,
    rowid: number,
    column: string,
    value: SqlValue,
): void {
    db.run(`UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE rowid = ?`, [
        value,
        rowid,
    ]);
}

/**
 * A new row: defaults everywhere, with an empty text or a zero for a NOT NULL column that has
 * no default (an integer primary key numbers itself), so the row can be filled in afterwards.
 */
export function insertRow(db: Database, table: string): number {
    const required = tableColumns(db, table).filter(
        (column) => column.notNull && column.defaultValue === undefined && !column.primaryKey,
    );
    if (required.length === 0) db.run(`INSERT INTO ${quoteIdentifier(table)} DEFAULT VALUES`);
    else
        db.run(
            `INSERT INTO ${quoteIdentifier(table)} (${required.map((column) => quoteIdentifier(column.name)).join(", ")}) VALUES (${required.map(() => "?").join(", ")})`,
            required.map((column) => (/INT|REAL|NUM|DOUBLE|FLOAT/i.test(column.type) ? 0 : "")),
        );
    return Number(db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] ?? 0);
}

export function deleteRow(db: Database, table: string, rowid: number): void {
    db.run(`DELETE FROM ${quoteIdentifier(table)} WHERE rowid = ?`, [rowid]);
}

/** A new table with the columns given as `name type` (`id INTEGER PRIMARY KEY, name TEXT`). */
export function createTable(db: Database, name: string, columns: string): void {
    const definition = columns.trim() || "id INTEGER PRIMARY KEY";
    db.run(`CREATE TABLE ${quoteIdentifier(name)} (${definition})`);
}

export function dropTable(db: Database, name: string): void {
    db.run(`DROP TABLE ${quoteIdentifier(name)}`);
}
