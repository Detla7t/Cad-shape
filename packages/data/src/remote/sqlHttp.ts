// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DataTable, Result } from "@chili3d/core";
import { gridToTable, typeCell } from "../model/cells";
import type { DataQuery, SqlSourceDefinition } from "../model/definition";
import { arrayToTable, followJsonPath, jsonToTable } from "../readers/json";
import { checkUrl, fetchChecked, type RemoteContext, requestHeaders, responseJson } from "./request";

/**
 * Real databases from a browser, through the HTTP APIs that front them — a browser cannot open
 * a database socket. Each named query becomes one table:
 *
 * - `postgrest` (PostgREST, Supabase's `/rest/v1`): the query is a resource path with its
 *   filters, `parts?select=name,length&order=name`, read with GET;
 * - `hasura`: SQL through Hasura's `run_sql` (`/v2/query`), read-only;
 * - `graphql` (Hasura GraphQL, PostGraphile, …): the query is GraphQL; the rows are the first
 *   list in `data`, or at `jsonPath`;
 * - `generic`: `POST { "sql": <query> }` to the URL; the answer may be a list of rows,
 *   `{ rows }`, or `{ columns, rows }`.
 *
 * Credentials go in headers (`Authorization`, Supabase's `apikey`), kept for the session only
 * unless the source opts in to storing them.
 */
export async function fetchSqlTables(
    definition: SqlSourceDefinition,
    context: RemoteContext,
): Promise<Result<DataTable[]>> {
    const url = checkUrl(definition.url);
    if (!url.isOk) return Result.err(url.error);
    const headers = requestHeaders(definition.headers ?? [], context.secrets);
    if (!headers.isOk) return Result.err(headers.error);
    const queries = (definition.queries ?? []).filter((query) => query.query.trim() !== "");
    if (queries.length === 0) return Result.err("Add a query to read");
    const tables: DataTable[] = [];
    for (const query of queries) {
        const table = await runQuery(definition, url.value, headers.value, query, context);
        if (!table.isOk) return Result.err(`Query "${query.name}": ${table.error}`);
        tables.push(table.value);
    }
    return Result.ok(tables);
}

function runQuery(
    definition: SqlSourceDefinition,
    url: URL,
    headers: Record<string, string>,
    query: DataQuery,
    context: RemoteContext,
): Promise<Result<DataTable>> {
    const hasHeader = definition.hasHeader ?? true;
    switch (definition.dialect) {
        case "postgrest":
            return postgrest(url, headers, query, context);
        case "hasura":
            return post(
                url,
                headers,
                { type: "run_sql", args: { source: "default", sql: query.query, read_only: true } },
                context,
                (json) => hasuraTable(query.name, json),
            );
        case "graphql":
            return post(url, headers, { query: query.query }, context, (json) =>
                graphqlTable(query.name, json, definition.jsonPath),
            );
        default:
            return post(url, headers, { sql: query.query }, context, (json) =>
                jsonToTable(query.name, json, definition.jsonPath, hasHeader),
            );
    }
}

async function postgrest(
    base: URL,
    headers: Record<string, string>,
    query: DataQuery,
    context: RemoteContext,
): Promise<Result<DataTable>> {
    const path = query.query.trim().replace(/^\/+/, "");
    const url = `${base.href.replace(/\/+$/, "")}/${path}`;
    const response = await fetchChecked(
        url,
        { method: "GET", headers: { Accept: "application/json", ...headers } },
        context,
    );
    if (!response.isOk) return Result.err(response.error);
    const json = await responseJson(response.value);
    if (!json.isOk) return Result.err(json.error);
    if (!Array.isArray(json.value))
        return Result.err("PostgREST answered something other than a list of rows");
    return Result.ok(arrayToTable(query.name, json.value));
}

async function post(
    url: URL,
    headers: Record<string, string>,
    body: unknown,
    context: RemoteContext,
    toTable: (json: unknown) => Result<DataTable>,
): Promise<Result<DataTable>> {
    const response = await fetchChecked(
        url.href,
        {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
        },
        context,
    );
    if (!response.isOk) return Result.err(response.error);
    const json = await responseJson(response.value);
    return json.isOk ? toTable(json.value) : Result.err(json.error);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

/** `run_sql`'s answer: `result` is the header row then the rows, every value as text. */
export function hasuraTable(name: string, json: unknown): Result<DataTable> {
    if (!isRecord(json)) return Result.err("Hasura answered something other than a result");
    if (typeof json["error"] === "string") return Result.err(json["error"]);
    const result = json["result"];
    if (!Array.isArray(result)) return Result.ok({ name, columns: [], rows: [], hasHeader: true });
    const grid = (result as unknown[]).filter(Array.isArray).map((row, index) =>
        (row as unknown[]).map((cell) => {
            if (cell === null || cell === undefined) return null;
            // The header row is names; the values arrive as text and are typed like CSV fields.
            return index === 0 ? String(cell) : typeCell(String(cell));
        }),
    );
    return Result.ok(gridToTable(name, grid, true));
}

/** A GraphQL answer's rows: at `path`, else the first list found under `data`. */
export function graphqlTable(name: string, json: unknown, path?: string): Result<DataTable> {
    if (!isRecord(json)) return Result.err("The GraphQL endpoint answered something other than a result");
    const errors = json["errors"];
    if (Array.isArray(errors) && errors.length > 0) {
        return Result.err(
            errors.map((error) => (isRecord(error) ? String(error["message"]) : String(error))).join("; "),
        );
    }
    if (path !== undefined && path.trim() !== "") {
        const rows = followJsonPath(json, path);
        if (!rows.isOk) return Result.err(rows.error);
        if (!Array.isArray(rows.value)) return Result.err(`${path} is not a list of rows`);
        return Result.ok(arrayToTable(name, rows.value));
    }
    const rows = firstList(json["data"]);
    if (rows === undefined) return Result.err("The answer has no list of rows under data");
    return Result.ok(arrayToTable(name, rows));
}

function firstList(value: unknown): unknown[] | undefined {
    if (Array.isArray(value)) return value;
    if (!isRecord(value)) return undefined;
    for (const child of Object.values(value)) {
        const found = firstList(child);
        if (found !== undefined) return found;
    }
    return undefined;
}
