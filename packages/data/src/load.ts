// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { base64ToBytes, type DataTable, Result } from "@chili3d/core";
import { type DataSourceDefinition, fileExtension, fileFormatOf } from "./model/definition";
import { readCsv } from "./readers/csv";
import { readJson } from "./readers/json";
import { readWorkbook } from "./readers/spreadsheet";
import { readSqlite } from "./readers/sqlite";
import { fetchHttpTables } from "./remote/http";
import type { RemoteContext } from "./remote/request";
import { fetchSheetTables } from "./remote/sheets";
import { fetchSqlTables } from "./remote/sqlHttp";

/** What a load reads besides the definition. */
export interface LoadContext extends RemoteContext {
    /** A text attachment (CSV, TSV, JSON). */
    readonly fileText: string;
    /** A binary attachment (XLSX, ODS, SQLite) as base64. */
    readonly fileBase64: string;
}

/** The base of a file name, for the table of a single-table file: "parts.csv" → "parts". */
function baseName(fileName: string | undefined): string {
    const name = (fileName ?? "").split(/[\\/]/).pop() ?? "";
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    return base.trim() === "" ? "data" : base;
}

function attachedBytes(context: LoadContext): Result<Uint8Array> {
    if (context.fileBase64 === "") return Result.err("Attach a file to read");
    const bytes = base64ToBytes(context.fileBase64);
    return bytes === undefined ? Result.err("The attached file is damaged") : Result.ok(bytes);
}

/**
 * Reads a source's tables. Never throws: a parse error, a failed request or a bad query comes
 * back as the result's error, for the source's tab to show.
 */
export async function loadTables(
    definition: DataSourceDefinition,
    context: LoadContext,
): Promise<Result<DataTable[]>> {
    try {
        return await load(definition, context);
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

async function load(definition: DataSourceDefinition, context: LoadContext): Promise<Result<DataTable[]>> {
    const hasHeader = definition.hasHeader ?? true;
    switch (definition.kind) {
        case "file": {
            const format = fileFormatOf(definition);
            const name = baseName(definition.fileName);
            switch (format) {
                case "csv":
                case "tsv": {
                    if (context.fileText === "" && definition.fileName === undefined) {
                        return Result.err("Attach a file to read");
                    }
                    const delimiter = format === "tsv" ? "\t" : definition.delimiter;
                    return Result.ok([readCsv(name, context.fileText, { delimiter, hasHeader })]);
                }
                case "json": {
                    const table = readJson(name, context.fileText, definition.jsonPath, hasHeader);
                    return table.isOk ? Result.ok([table.value]) : Result.err(table.error);
                }
                case "xlsx":
                case "ods":
                case "xls": {
                    const bytes = attachedBytes(context);
                    if (!bytes.isOk) return Result.err(bytes.error);
                    return Result.ok(await readWorkbook(bytes.value, hasHeader));
                }
                default:
                    return definition.fileName === undefined
                        ? Result.err("Attach a file to read")
                        : Result.err(`Unsupported file type ".${fileExtension(definition.fileName)}"`);
            }
        }
        case "sqlite": {
            const bytes = attachedBytes(context);
            if (!bytes.isOk) return Result.err(bytes.error);
            const queries = (definition.queries ?? []).filter((query) => query.query.trim() !== "");
            return Result.ok(await readSqlite(bytes.value, queries));
        }
        case "http":
            return fetchHttpTables(definition, context);
        case "sql":
            return fetchSqlTables(definition, context);
        case "sheet":
            return fetchSheetTables(definition, context);
    }
}
