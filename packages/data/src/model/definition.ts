// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * What a Data Source is: where its tables come from and how often they refresh. Stored in the
 * document as `definitionJson` — never with a secret in it: a header marked `secret` keeps only
 * its name here, its value lives in the session (see `secrets.ts`) unless the source opts in to
 * `storeSecrets`.
 */

export type DataSourceKind = "file" | "sqlite" | "http" | "sql" | "sheet";

/** Formats an attached file may have; `xls` is recognized only to say it is unsupported. */
export type DataFileFormat = "csv" | "tsv" | "xlsx" | "ods" | "json" | "xls";

export type DataRefreshMode = "manual" | "open" | "interval";

/** How a SQL-over-HTTP endpoint is spoken to (see `remote/sqlHttp.ts`). */
export type SqlDialect = "postgrest" | "hasura" | "graphql" | "generic";

export type SheetProvider = "google" | "excel";

export interface DataHeader {
    readonly name: string;
    /** Absent for a secret header — its value is in the session store. */
    readonly value?: string;
    readonly secret?: boolean;
}

/** One named query: SQL for SQLite and SQL endpoints, a resource path for PostgREST, GraphQL text. */
export interface DataQuery {
    readonly name: string;
    readonly query: string;
}

interface CommonDefinition {
    readonly refresh?: DataRefreshMode;
    /** For `refresh: "interval"`; at least `MIN_INTERVAL_SECONDS`. */
    readonly intervalSeconds?: number;
    /** Whether the first row is the header row; default true. */
    readonly hasHeader?: boolean;
    /** Keep secret header values in the saved document (off: session only). */
    readonly storeSecrets?: boolean;
}

/** An attached CSV / TSV / XLSX / ODS / JSON file, stored in the document. */
export interface FileSourceDefinition extends CommonDefinition {
    readonly kind: "file";
    readonly fileName?: string;
    /** From the file name when absent. */
    readonly format?: DataFileFormat;
    /** CSV only: one character; detected when absent. */
    readonly delimiter?: string;
    /** JSON only: where the rows are (`data.items`). */
    readonly jsonPath?: string;
}

/** An attached SQLite database file, read through SQL queries. */
export interface SqliteSourceDefinition extends CommonDefinition {
    readonly kind: "sqlite";
    readonly fileName?: string;
    /** No queries: every table, whole. */
    readonly queries?: readonly DataQuery[];
}

/** A REST endpoint answering JSON (or CSV). */
export interface HttpSourceDefinition extends CommonDefinition {
    readonly kind: "http";
    readonly url: string;
    readonly method?: "GET" | "POST";
    readonly headers?: readonly DataHeader[];
    readonly body?: string;
    readonly jsonPath?: string;
    readonly format?: "auto" | "json" | "csv";
    /** The table's name; "data" by default. */
    readonly tableName?: string;
}

/** A database behind an HTTP API: PostgREST / Supabase, Hasura, GraphQL, or a generic SQL endpoint. */
export interface SqlSourceDefinition extends CommonDefinition {
    readonly kind: "sql";
    readonly dialect: SqlDialect;
    readonly url: string;
    readonly headers?: readonly DataHeader[];
    readonly queries?: readonly DataQuery[];
    /** GraphQL / generic: where the rows are in the answer (default: found automatically). */
    readonly jsonPath?: string;
}

/** A Google Sheet or an Excel Online workbook, read through its export link. */
export interface SheetSourceDefinition extends CommonDefinition {
    readonly kind: "sheet";
    readonly provider: SheetProvider;
    /** The sheet's share (or published) link. */
    readonly url: string;
    /** Google: tab names (or `gid=123`) to read; the first tab (or the link's gid) when empty. */
    readonly sheets?: readonly string[];
}

export type DataSourceDefinition =
    | FileSourceDefinition
    | SqliteSourceDefinition
    | HttpSourceDefinition
    | SqlSourceDefinition
    | SheetSourceDefinition;

export const MIN_INTERVAL_SECONDS = 5;
export const DEFAULT_INTERVAL_SECONDS = 300;

export const DATA_SOURCE_KINDS: readonly DataSourceKind[] = ["file", "sqlite", "http", "sql", "sheet"];

/** Kinds whose tables come over the network — the ones `refresh: "open"` and intervals apply to. */
export function isRemoteKind(kind: DataSourceKind): boolean {
    return kind === "http" || kind === "sql" || kind === "sheet";
}

/** Kinds that read an attached file. */
export function isFileKind(kind: DataSourceKind): kind is "file" | "sqlite" {
    return kind === "file" || kind === "sqlite";
}

/** A new source of `kind` with its defaults. */
export function defaultDefinition(kind: DataSourceKind): DataSourceDefinition {
    switch (kind) {
        case "file":
            return { kind };
        case "sqlite":
            return { kind, queries: [] };
        case "http":
            return { kind, url: "", method: "GET", headers: [], format: "auto" };
        case "sql":
            return { kind, dialect: "postgrest", url: "", headers: [], queries: [] };
        case "sheet":
            return { kind, provider: "google", url: "", sheets: [] };
    }
}

const FORMAT_BY_EXTENSION: Record<string, DataFileFormat> = {
    csv: "csv",
    txt: "csv",
    tsv: "tsv",
    tab: "tsv",
    xlsx: "xlsx",
    xlsm: "xlsx",
    ods: "ods",
    json: "json",
    geojson: "json",
    xls: "xls",
};

const SQLITE_EXTENSIONS = new Set(["sqlite", "sqlite3", "db", "db3"]);

export function fileExtension(fileName: string | undefined): string {
    const match = /\.([^./\\]+)$/.exec(fileName ?? "");
    return match === null ? "" : match[1].toLowerCase();
}

export function formatOfFile(fileName: string | undefined): DataFileFormat | undefined {
    return FORMAT_BY_EXTENSION[fileExtension(fileName)];
}

/** Whether an attachment is a SQLite database (`.sqlite`, `.db`, …). */
export function isSqliteFileName(fileName: string | undefined): boolean {
    return SQLITE_EXTENSIONS.has(fileExtension(fileName));
}

/** Formats stored in the document as text; the others are stored as base64 of their bytes. */
export function isTextFormat(format: DataFileFormat | undefined): boolean {
    return format === "csv" || format === "tsv" || format === "json";
}

/** The format of a file source: declared, else from its file name. */
export function fileFormatOf(definition: FileSourceDefinition): DataFileFormat | undefined {
    return definition.format ?? formatOfFile(definition.fileName);
}

/** Whether the source's attachment (`fileData`) is base64 of binary content. */
export function isBinaryAttachment(definition: DataSourceDefinition): boolean {
    if (definition.kind === "sqlite") return true;
    if (definition.kind === "file") return !isTextFormat(fileFormatOf(definition));
    return false;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A stored definition as a definition: JSON from a document may be anything, so an unknown
 * kind or a missing field falls back to defaults rather than throwing out of every reader.
 */
export function parseDefinition(json: string): DataSourceDefinition {
    let value: unknown;
    try {
        value = JSON.parse(json);
    } catch {
        return defaultDefinition("file");
    }
    if (!isRecord(value) || !DATA_SOURCE_KINDS.includes(value["kind"] as DataSourceKind)) {
        return defaultDefinition("file");
    }
    const kind = value["kind"] as DataSourceKind;
    return { ...defaultDefinition(kind), ...value } as DataSourceDefinition;
}

/** The headers of a remote source (none for file kinds). */
export function headersOf(definition: DataSourceDefinition): readonly DataHeader[] {
    return definition.kind === "http" || definition.kind === "sql" ? (definition.headers ?? []) : [];
}

/** The definition as stored: secret header values removed (they belong to the session store). */
export function withoutSecrets(definition: DataSourceDefinition): DataSourceDefinition {
    if (definition.kind !== "http" && definition.kind !== "sql") return definition;
    const headers = (definition.headers ?? []).map((header) =>
        header.secret === true ? { name: header.name, secret: true } : header,
    );
    return { ...definition, headers };
}

/** Secret header values a definition carries inline (before `withoutSecrets` strips them). */
export function inlineSecrets(definition: DataSourceDefinition): Record<string, string> {
    const secrets: Record<string, string> = {};
    for (const header of headersOf(definition)) {
        if (header.secret === true && header.value !== undefined && header.value !== "") {
            secrets[header.name] = header.value;
        }
    }
    return secrets;
}

export function refreshIntervalMs(definition: DataSourceDefinition): number {
    const seconds = Number(definition.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);
    return (
        Math.max(MIN_INTERVAL_SECONDS, Number.isFinite(seconds) ? seconds : DEFAULT_INTERVAL_SECONDS) * 1000
    );
}
