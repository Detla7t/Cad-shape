// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DataTable, Result } from "@chili3d/core";
import type { HttpSourceDefinition } from "../model/definition";
import { readCsv } from "../readers/csv";
import { readJson } from "../readers/json";
import { checkUrl, fetchChecked, type RemoteContext, requestHeaders } from "./request";

/**
 * A REST endpoint: one request, its JSON answer's rows (at `jsonPath`, or found under the usual
 * wrapper keys) as one table — or CSV, when the answer says so or the source asks for it.
 */
export async function fetchHttpTables(
    definition: HttpSourceDefinition,
    context: RemoteContext,
): Promise<Result<DataTable[]>> {
    const url = checkUrl(definition.url);
    if (!url.isOk) return Result.err(url.error);
    const headers = requestHeaders(definition.headers ?? [], context.secrets);
    if (!headers.isOk) return Result.err(headers.error);
    const method = definition.method ?? "GET";
    const init: RequestInit = { method, headers: { ...headers.value } };
    if (method === "POST" && definition.body !== undefined && definition.body !== "") {
        init.body = definition.body;
        const hasType = Object.keys(headers.value).some((name) => name.toLowerCase() === "content-type");
        if (!hasType && /^\s*[[{]/.test(definition.body)) {
            init.headers = { ...headers.value, "Content-Type": "application/json" };
        }
    }
    const response = await fetchChecked(url.value.href, init, context);
    if (!response.isOk) return Result.err(response.error);
    const text = await response.value.text();
    const name = definition.tableName?.trim() || "data";
    const hasHeader = definition.hasHeader ?? true;
    const type = response.value.headers.get("content-type") ?? "";
    const csv =
        definition.format === "csv" ||
        (definition.format !== "json" &&
            (/csv|tab-separated/i.test(type) || /\.(csv|tsv)$/i.test(url.value.pathname)));
    if (csv) return Result.ok([readCsv(name, text, { hasHeader })]);
    const table = readJson(name, text, definition.jsonPath, hasHeader);
    return table.isOk ? Result.ok([table.value]) : Result.err(table.error);
}
