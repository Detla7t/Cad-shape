// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DataCell, DataTable } from "@chili3d/core";
import type { Database, SqlJsStatic, SqlValue } from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm-browser.wasm";
import { uniqueHeaders } from "../model/cells";
import type { DataQuery } from "../model/definition";

/**
 * SQLite database files, through sql.js (SQLite compiled to WebAssembly, MIT). The engine loads
 * on first use; each refresh opens the attached bytes as a fresh in-memory database, runs the
 * queries and closes it — a statement that writes changes only that throwaway copy.
 */

export interface SqlJsOptions {
    /** The engine's bytes — required under Node, where it cannot be fetched. */
    readonly wasmBinary?: ArrayBuffer | Uint8Array;
    /** Where the browser fetches `sql-wasm.wasm` from; the bundled asset by default. */
    readonly locateFile?: (file: string) => string;
}

let options: SqlJsOptions | undefined;
let engine: Promise<SqlJsStatic> | undefined;

/** Overrides how sql.js loads (tests, an embedding app); takes effect for the next load. */
export function configureSqlJs(next: SqlJsOptions): void {
    options = next;
    engine = undefined;
}

/** The sql.js engine, loaded once (see `configureSqlJs`). */
export async function loadSqlJs(): Promise<SqlJsStatic> {
    engine ??= (async () => {
        const module = (await import("sql.js")) as unknown as { default?: unknown };
        const init = (module.default ?? module) as (config?: object) => Promise<SqlJsStatic>;
        const config = options ?? { locateFile: () => sqlWasmUrl };
        return init(config);
    })();
    try {
        return await engine;
    } catch (error) {
        engine = undefined;
        throw error;
    }
}

function sqlCell(value: SqlValue): DataCell {
    if (value === null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") return value;
    return `<blob ${value.length} bytes>`;
}

/** The user tables of a database, in name order. */
function userTables(db: Database): string[] {
    const result = db.exec(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    return (result[0]?.values ?? []).map((row) => String(row[0]));
}

const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * The last result-returning statement of `sql`, columns included even when it returns no rows
 * (sql.js's `exec` drops the column names of an empty result).
 */
function runQuery(db: Database, sql: string): { columns: string[]; rows: DataCell[][] } {
    let columns: string[] = [];
    let rows: DataCell[][] = [];
    for (const statement of db.iterateStatements(sql)) {
        const names = statement.getColumnNames();
        const values: DataCell[][] = [];
        while (statement.step()) values.push(statement.get().map(sqlCell));
        if (names.length > 0) {
            columns = uniqueHeaders(names);
            rows = values;
        }
    }
    return { columns, rows };
}

/**
 * Runs `queries` against the database — or, with none, reads every table whole (`SELECT *`),
 * one table each. A query's table is its LAST statement's result; one that fails is reported by
 * name.
 */
export async function readSqlite(bytes: Uint8Array, queries: readonly DataQuery[]): Promise<DataTable[]> {
    const SQL = await loadSqlJs();
    let db: Database;
    try {
        db = new SQL.Database(bytes);
    } catch (error) {
        throw new Error(`Not a SQLite database: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        const list =
            queries.length > 0
                ? queries
                : userTables(db).map((name) => ({ name, query: `SELECT * FROM ${quoteIdentifier(name)}` }));
        return list.map((query) => {
            try {
                return { name: query.name, ...runQuery(db, query.query), hasHeader: true };
            } catch (error) {
                throw new Error(
                    `Query "${query.name}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        });
    } finally {
        db.close();
    }
}
