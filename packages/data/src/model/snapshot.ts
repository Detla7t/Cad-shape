// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DataCell, type DataTable, Logger } from "@chili3d/core";

/**
 * The last tables a source produced, cached in the document so models rebuild offline and
 * without re-reading the source. `fetchedAt` is when the cached data last CHANGED — a refresh
 * that finds the same tables writes nothing (no undo step, no new version).
 */
export interface DataSnapshot {
    readonly fetchedAt?: string;
    readonly tables: readonly DataTable[];
}

export const EMPTY_SNAPSHOT: DataSnapshot = { tables: [] };

function normalizeCell(value: unknown): DataCell {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    return JSON.stringify(value);
}

/** A table in exactly the shape the snapshot stores: string headers, rows of plain cells. */
export function normalizeTable(table: DataTable): DataTable {
    return {
        name: String(table.name),
        columns: table.columns.map(String),
        rows: table.rows.map((row) => table.columns.map((_, i) => normalizeCell(row[i]))),
        hasHeader: table.hasHeader !== false,
    };
}

/**
 * The stored form: valid JSON with one table row per line, so the version history diffs and
 * merges a snapshot row by row (`text` part) and the `.chili3d` file shows it readably.
 */
export function serializeSnapshot(snapshot: DataSnapshot): string {
    const lines = ["{"];
    if (snapshot.fetchedAt !== undefined) lines.push(`"fetchedAt": ${JSON.stringify(snapshot.fetchedAt)},`);
    lines.push(`"tables": [`);
    snapshot.tables.forEach((raw, t) => {
        const table = normalizeTable(raw);
        lines.push(
            `{"name": ${JSON.stringify(table.name)}, "hasHeader": ${table.hasHeader}, "columns": ${JSON.stringify(table.columns)}, "rows": [`,
        );
        table.rows.forEach((row, r) => {
            lines.push(`${JSON.stringify(row)}${r < table.rows.length - 1 ? "," : ""}`);
        });
        lines.push(`]}${t < snapshot.tables.length - 1 ? "," : ""}`);
    });
    lines.push("]", "}");
    return lines.join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

/** A stored snapshot; unreadable content reads as empty (and is logged), never throws. */
export function parseSnapshot(json: string, owner: string): DataSnapshot {
    if (json.trim() === "") return EMPTY_SNAPSHOT;
    let value: unknown;
    try {
        value = JSON.parse(json);
    } catch (error) {
        Logger.error(`${owner}: the cached data is not readable`, error);
        return EMPTY_SNAPSHOT;
    }
    if (!isRecord(value) || !Array.isArray(value["tables"])) return EMPTY_SNAPSHOT;
    const tables: DataTable[] = [];
    for (const table of value["tables"]) {
        if (!isRecord(table) || !Array.isArray(table["columns"]) || !Array.isArray(table["rows"])) continue;
        tables.push(
            normalizeTable({
                name: String(table["name"] ?? `Table ${tables.length + 1}`),
                columns: (table["columns"] as unknown[]).map(String),
                rows: (table["rows"] as unknown[]).filter(Array.isArray) as DataCell[][],
                hasHeader: table["hasHeader"] !== false,
            }),
        );
    }
    const fetchedAt = typeof value["fetchedAt"] === "string" ? value["fetchedAt"] : undefined;
    return fetchedAt === undefined ? { tables } : { fetchedAt, tables };
}

/** Whether two table lists hold the same data. */
export function sameTables(a: readonly DataTable[], b: readonly DataTable[]): boolean {
    return JSON.stringify(a.map(normalizeTable)) === JSON.stringify(b.map(normalizeTable));
}

/** FNV-1a over UTF-16 code units, as hex: a cheap content revision for the scope key. */
export function hashText(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `${(hash >>> 0).toString(16)}:${text.length}`;
}
