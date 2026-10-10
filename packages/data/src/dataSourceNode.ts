// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    bytesToBase64,
    type DataTable,
    type IDocument,
    Id,
    type INode,
    type INodeIcon,
    type INodeSceneless,
    Node,
    notifyDataTablesChanged,
    type Result,
    serializable,
    serialize,
    Transaction,
} from "@chili3d/core";
import { type LoadContext, loadTables } from "./load";
import {
    type DataSourceDefinition,
    type DataSourceKind,
    defaultDefinition,
    formatOfFile,
    inlineSecrets,
    isBinaryAttachment,
    isFileKind,
    isSqliteFileName,
    parseDefinition,
    withoutSecrets,
} from "./model/definition";
import {
    type DataSnapshot,
    EMPTY_SNAPSHOT,
    hashText,
    parseSnapshot,
    sameTables,
    serializeSnapshot,
} from "./model/snapshot";
import { clearSessionSecrets, mergeSessionSecrets, sessionSecrets, setSessionSecret } from "./secrets";

export interface DataSourceNodeOptions {
    document: IDocument;
    name?: string;
    id?: string;
    /** The stored definition, as a loaded document hands it back. */
    definitionJson?: string;
    /** Or the definition itself (secret header values in it go to the session store). */
    definition?: DataSourceDefinition;
    fileText?: string;
    fileBase64?: string;
    snapshotJson?: string;
    /** Stored secrets — present only when the source opted in to `storeSecrets`. */
    secretsJson?: string;
}

export type DataSourceState = "idle" | "loading" | "ready" | "error";

/** What the source's tab shows about the last read; session state, never saved. */
export interface DataSourceStatus {
    readonly state: DataSourceState;
    readonly message?: string;
    /** `Date.now()` of the last successful read this session. */
    readonly at?: number;
}

/** One edit of a source: any of its definition and attachment. */
export interface DataSourceChange {
    readonly definition?: DataSourceDefinition;
    readonly fileText?: string;
    readonly fileBase64?: string;
}

export interface DataLoadOptions {
    /** For tests and embedders; the global `fetch` otherwise. */
    readonly fetch?: typeof fetch;
}

const SQLITE_MAGIC = "SQLite format 3\u0000";

function startsWithText(bytes: Uint8Array, text: string): boolean {
    if (bytes.length < text.length) return false;
    for (let i = 0; i < text.length; i++) if (bytes[i] !== text.charCodeAt(i)) return false;
    return true;
}

function parseSecrets(json: string): Record<string, string> {
    try {
        const value: unknown = JSON.parse(json);
        if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
        return Object.fromEntries(
            Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
    } catch {
        return {};
    }
}

/**
 * A Data Source: a document element (a bottom tab) whose tables — the sheets of an attached
 * workbook, the results of SQL queries, the rows of a REST answer — every expression can read
 * (`data("Prices", "B3")`, see `resolver.ts`) and FeatureScript too (`getDataTable`).
 *
 * The node stores the definition (`definitionJson`), the attached file (`fileText` for CSV / TSV
 * / JSON, `fileBase64` for XLSX / ODS / SQLite) and the last tables read (`snapshotJson`), all
 * recorded properties: an edit is one undo step, and the cached tables let the model rebuild
 * offline. A new snapshot re-scopes the document, so everything that reads the data rebuilds —
 * undo and redo included. Secret header values are session-only (see `secrets.ts`).
 */
@serializable({ id: "DataSourceNode" })
export class DataSourceNode extends Node implements INodeIcon, INodeSceneless {
    readonly sceneless = true as const;

    private _status: DataSourceStatus = { state: "idle" };
    private _loads = 0;
    private _definition: { readonly json: string; readonly value: DataSourceDefinition } | undefined;
    private _snapshot:
        | { readonly json: string; readonly value: DataSnapshot; readonly revision: string }
        | undefined;

    get icon(): string {
        return "icon-layer-group";
    }

    constructor(options: DataSourceNodeOptions) {
        super(options.document, options.name ?? "Data Source", options.id ?? Id.generate());
        const definition =
            options.definitionJson === undefined
                ? (options.definition ?? defaultDefinition("file"))
                : parseDefinition(options.definitionJson);
        mergeSessionSecrets(this.id, inlineSecrets(definition));
        if (options.secretsJson) mergeSessionSecrets(this.id, parseSecrets(options.secretsJson));
        this.setPrivateValue("definitionJson", JSON.stringify(withoutSecrets(definition)));
        this.setPrivateValue("fileText", options.fileText ?? "");
        this.setPrivateValue("fileBase64", options.fileBase64 ?? "");
        this.setPrivateValue("snapshotJson", options.snapshotJson ?? serializeSnapshot(EMPTY_SNAPSHOT));
        this.onPropertyChanged(this.handleOwnChange);
    }

    @serialize()
    get definitionJson(): string {
        return this.getPrivateValue("definitionJson");
    }
    set definitionJson(value: string) {
        this.setProperty("definitionJson", value);
    }

    @serialize()
    get fileText(): string {
        return this.getPrivateValue("fileText");
    }
    set fileText(value: string) {
        this.setProperty("fileText", value);
    }

    @serialize()
    get fileBase64(): string {
        return this.getPrivateValue("fileBase64");
    }
    set fileBase64(value: string) {
        this.setProperty("fileBase64", value);
    }

    @serialize()
    get snapshotJson(): string {
        return this.getPrivateValue("snapshotJson");
    }
    set snapshotJson(value: string) {
        // After the write: the source's own view sees the new tables before the document
        // re-scopes and the models that read them rebuild.
        if (this.setProperty("snapshotJson", value)) notifyDataTablesChanged(this.document);
    }

    /** Secret values in the saved document — only when the source opted in; empty otherwise. */
    @serialize()
    get secretsJson(): string {
        return this.definition.storeSecrets === true ? JSON.stringify(sessionSecrets(this.id)) : "";
    }

    get definition(): DataSourceDefinition {
        const json = this.definitionJson;
        if (this._definition?.json !== json) this._definition = { json, value: parseDefinition(json) };
        return this._definition.value;
    }

    get snapshot(): DataSnapshot {
        return this.parsedSnapshot().value;
    }

    get tables(): readonly DataTable[] {
        return this.snapshot.tables;
    }

    /** Changes whenever the cached tables do — the data-table provider's revision. */
    get revision(): string {
        return this.parsedSnapshot().revision;
    }

    get status(): DataSourceStatus {
        return this._status;
    }

    /** A table by name (exactly, then ignoring case); the first table when `name` is undefined. */
    table(name?: string): DataTable | undefined {
        const tables = this.tables;
        if (name === undefined) return tables[0];
        return (
            tables.find((table) => table.name === name) ??
            tables.find((table) => table.name.trim().toLowerCase() === name.trim().toLowerCase())
        );
    }

    /** Secret header values for this session (plus any the definition still carries inline). */
    secrets(definition: DataSourceDefinition = this.definition): Readonly<Record<string, string>> {
        return { ...sessionSecrets(this.id), ...inlineSecrets(definition) };
    }

    /** Sets a secret header value for this session; an empty value clears it. */
    setSecret(name: string, value: string): void {
        setSessionSecret(this.id, name, value);
        this.emitPropertyChanged("secretsJson", "");
    }

    /** Re-reads the source as it is defined now; caches the tables when they changed. */
    refresh(options: DataLoadOptions = {}): Promise<Result<readonly DataTable[]>> {
        return this.apply({}, options);
    }

    /**
     * Applies a change and re-reads the source with it, then writes the change and the new
     * tables as ONE undo step. A failed read still writes the change: an attached file's error
     * leaves the source with no tables (the file is the truth), a remote source keeps its last
     * tables (it may just be offline). The status reports the failure either way.
     */
    async apply(
        change: DataSourceChange,
        options: DataLoadOptions = {},
    ): Promise<Result<readonly DataTable[]>> {
        const definition = change.definition ?? this.definition;
        mergeSessionSecrets(this.id, inlineSecrets(definition));
        const load = ++this._loads;
        this.setStatus({ state: "loading", at: this._status.at });
        const context: LoadContext = {
            fileText: change.fileText ?? this.fileText,
            fileBase64: change.fileBase64 ?? this.fileBase64,
            secrets: this.secrets(definition),
            fetch: options.fetch,
        };
        const result = await loadTables(definition, context);
        // A newer read started meanwhile, or the source went away: this one is stale.
        if (load !== this._loads || this._isDisposed) return result;
        const tables = result.isOk ? result.value : isFileKind(definition.kind) ? [] : undefined;
        this.write(change, tables);
        this.setStatus(
            result.isOk
                ? { state: "ready", at: Date.now() }
                : { state: "error", message: result.error, at: this._status.at },
        );
        return result;
    }

    /** Writes a change without reading — a remote source's settings, before a refresh. */
    edit(change: DataSourceChange): void {
        if (change.definition !== undefined) mergeSessionSecrets(this.id, inlineSecrets(change.definition));
        this.write(change, undefined);
    }

    /** Switches the source's kind: a new definition, no attachment, no tables until it is read. */
    setKind(kind: DataSourceKind): void {
        const current = this.definition;
        if (current.kind === kind) return;
        const definition = { ...defaultDefinition(kind), ...commonSettings(current) } as DataSourceDefinition;
        // A read still in flight belongs to the old kind.
        this._loads++;
        this.write({ definition, fileText: "", fileBase64: "" }, []);
        this.setStatus({ state: "idle" });
    }

    /**
     * Attaches a file — CSV / TSV / XLSX / ODS / JSON, or a SQLite database (by extension or
     * content) — and reads it.
     */
    attachFile(
        fileName: string,
        bytes: Uint8Array,
        options: DataLoadOptions = {},
    ): Promise<Result<readonly DataTable[]>> {
        const current = this.definition;
        const sqlite = isSqliteFileName(fileName) || startsWithText(bytes, SQLITE_MAGIC);
        const definition: DataSourceDefinition = sqlite
            ? {
                  ...(current.kind === "sqlite" ? current : defaultDefinition("sqlite")),
                  ...commonSettings(current),
                  kind: "sqlite",
                  fileName,
              }
            : {
                  ...(current.kind === "file" ? current : defaultDefinition("file")),
                  ...commonSettings(current),
                  kind: "file",
                  fileName,
                  format: formatOfFile(fileName),
              };
        const binary = isBinaryAttachment(definition);
        return this.apply(
            {
                definition,
                fileText: binary ? "" : new TextDecoder("utf-8").decode(bytes),
                fileBase64: binary ? bytesToBase64(bytes) : "",
            },
            options,
        );
    }

    private write(change: DataSourceChange, tables: readonly DataTable[] | undefined): void {
        Transaction.execute(this.document, "edit data source", () => {
            if (change.definition !== undefined) {
                this.definitionJson = JSON.stringify(withoutSecrets(change.definition));
            }
            if (change.fileText !== undefined) this.fileText = change.fileText;
            if (change.fileBase64 !== undefined) this.fileBase64 = change.fileBase64;
            if (tables !== undefined && !sameTables(tables, this.tables)) {
                this.snapshotJson = serializeSnapshot({ fetchedAt: new Date().toISOString(), tables });
            }
        });
    }

    private setStatus(status: DataSourceStatus): void {
        const old = this._status;
        this._status = status;
        this.emitPropertyChanged("status", old);
    }

    private parsedSnapshot() {
        const json = this.snapshotJson;
        if (this._snapshot?.json !== json) {
            this._snapshot = {
                json,
                value: parseSnapshot(json, `data source "${this.name}"`),
                revision: hashText(json),
            };
        }
        return this._snapshot;
    }

    private readonly handleOwnChange = (property: keyof this) => {
        // A table is found by its source's name: a rename changes what `data("…")` resolves.
        if (property === "name") notifyDataTablesChanged(this.document);
    };

    override disposeInternal(): void {
        clearSessionSecrets(this.id);
        super.disposeInternal();
    }

    protected onVisibleChanged(): void {}

    protected onParentVisibleChanged(): void {}
}

/** The settings every kind shares, carried across a change of kind. */
function commonSettings(definition: DataSourceDefinition): Partial<DataSourceDefinition> {
    const { refresh, intervalSeconds, hasHeader, storeSecrets } = definition;
    return Object.fromEntries(
        Object.entries({ refresh, intervalSeconds, hasHeader, storeSecrets }).filter(
            ([, v]) => v !== undefined,
        ),
    );
}

export function isDataSourceNode(node: INode | undefined): node is DataSourceNode {
    return node instanceof DataSourceNode;
}

/** The Data Sources of a document, in model-tree order. */
export function dataSourcesOf(document: IDocument): DataSourceNode[] {
    return document.modelManager.findNodes(isDataSourceNode).filter(isDataSourceNode);
}
