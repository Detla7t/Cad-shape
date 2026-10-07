// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    columnName,
    type DataCell,
    type DataTable,
    I18n,
    type I18nKeys,
    type IDocument,
    type IElementView,
    Localize,
    PubSub,
} from "@chili3d/core";
import { button, div, input, label, li, option, select, span, svg, textarea, ul } from "@chili3d/element";
import type { DataSourceNode } from "../dataSourceNode";
import { type DataDependency, dependenciesOn } from "../dependencies";
import { cellText, columnTypes } from "../model/cells";
import {
    DATA_SOURCE_KINDS,
    type DataHeader,
    type DataQuery,
    type DataRefreshMode,
    type DataSourceDefinition,
    type DataSourceKind,
    DEFAULT_INTERVAL_SECONDS,
    fileFormatOf,
    isFileKind,
    isRemoteKind,
    type SheetProvider,
    type SqlDialect,
} from "../model/definition";
import { importVariablesFromTable, quoteText } from "../variables";
import style from "./dataSource.module.css";

/** Rows the preview grid renders; the rest are counted, not drawn. */
const PREVIEW_ROWS = 500;

const t = (key: I18nKeys, ...args: unknown[]) => I18n.translate(key, ...args);

/**
 * A Data Source's tab: its settings on the left (kind, file or endpoint, queries, headers,
 * refresh policy), its tables on the right as a grid with A1 row and column labels — click a
 * cell for the expression that reads it — and what in the document uses the source.
 *
 * Settings write through: an attached file or local query re-reads at once (one undo step with
 * its new tables); a remote source's settings are saved and read on Refresh.
 */
export class DataSourceView implements IElementView {
    readonly element: HTMLElement;
    private readonly title = span({ className: style.title });
    private readonly status = span({ className: style.status });
    private readonly refreshButton = button({
        className: style.button,
        textContent: new Localize("data.refresh"),
        onclick: () => void this.node.refresh(),
    });
    private readonly kindSelect: HTMLSelectElement;
    private readonly settings = div({ className: style.settings });
    private readonly preview = div({ className: style.preview });
    private activeTable = 0;
    private selected: { row: number; column: number } | undefined;
    private dependencies: DataDependency[] = [];

    constructor(
        readonly node: DataSourceNode,
        readonly document: IDocument,
    ) {
        this.kindSelect = select(
            {
                className: style.select,
                onchange: () => this.node.setKind(this.kindSelect.value as DataSourceKind),
            },
            ...DATA_SOURCE_KINDS.map((kind) =>
                option({ value: kind, textContent: new Localize(`data.kind.${kind}`) }),
            ),
        );
        this.element = div(
            { className: style.root },
            div(
                { className: style.header },
                svg({ className: style.icon, icon: "icon-layer-group" }),
                this.title,
                this.kindSelect,
                this.status,
                this.refreshButton,
            ),
            div({ className: style.hint, textContent: new Localize("data.hint") }),
            div({ className: style.body }, this.settings, this.preview),
        );
        node.onPropertyChanged(this.onNodeChanged);
        this.renderTitle();
        this.renderStatus();
        this.renderSettings();
        this.renderPreview();
    }

    activated(): void {
        this.refreshDependencies();
    }

    dispose(): void {
        this.node.removePropertyChanged(this.onNodeChanged);
    }

    private readonly onNodeChanged = (property: keyof DataSourceNode) => {
        if (property === "name") {
            this.renderTitle();
            this.renderPreview();
        } else if (property === "definitionJson") {
            this.renderSettings();
            this.renderPreview();
        } else if (property === "snapshotJson") {
            this.refreshDependencies();
        } else if (property === "status") {
            this.renderStatus();
        }
    };

    // ------------------------------------------------------------------ Header

    private renderTitle(): void {
        this.title.textContent = this.node.name;
    }

    private renderStatus(): void {
        const status = this.node.status;
        this.refreshButton.disabled = status.state === "loading";
        this.status.className = status.state === "error" ? `${style.status} ${style.error}` : style.status;
        const fetchedAt = this.node.snapshot.fetchedAt;
        if (status.state === "loading") this.status.textContent = t("data.status.loading");
        else if (status.state === "error")
            this.status.textContent = t("data.status.error{0}", status.message ?? "");
        else if (status.state === "ready" && status.at !== undefined) {
            this.status.textContent = t("data.status.ready{0}", new Date(status.at).toLocaleTimeString());
        } else if (fetchedAt !== undefined) {
            this.status.textContent = t("data.status.cached{0}", new Date(fetchedAt).toLocaleString());
        } else this.status.textContent = t("data.status.idle");
    }

    // ------------------------------------------------------------------ Settings

    /** Writes a definition change: local kinds re-read now, remote kinds on Refresh. */
    private change(patch: Partial<DataSourceDefinition>): void {
        const definition = { ...this.node.definition, ...patch } as DataSourceDefinition;
        if (isFileKind(definition.kind)) void this.node.apply({ definition });
        else this.node.edit({ definition });
    }

    private renderSettings(): void {
        const definition = this.node.definition;
        this.kindSelect.value = definition.kind;
        const sections: HTMLElement[] = [];
        const options: HTMLElement[] = [];
        switch (definition.kind) {
            case "file": {
                sections.push(this.fileSection(definition.fileName, ".csv,.tsv,.txt,.xlsx,.xlsm,.ods,.json"));
                // Only the settings the attached format reads.
                const format = fileFormatOf(definition);
                if (format === undefined || format === "csv") {
                    options.push(
                        this.field(
                            "data.delimiter",
                            this.selectInput(
                                [
                                    ["", "data.delimiter.auto"],
                                    [",", "data.delimiter.comma"],
                                    [";", "data.delimiter.semicolon"],
                                    ["\t", "data.delimiter.tab"],
                                    ["|", "data.delimiter.pipe"],
                                ],
                                definition.delimiter ?? "",
                                (delimiter) => this.change({ delimiter: delimiter || undefined }),
                            ),
                        ),
                    );
                }
                if (format === "json") {
                    options.push(
                        this.field(
                            "data.jsonPath",
                            this.textInput(
                                definition.jsonPath ?? "",
                                (jsonPath) => this.change({ jsonPath }),
                                "data.items",
                            ),
                        ),
                    );
                }
                break;
            }
            case "sqlite":
                sections.push(this.fileSection(definition.fileName, ".sqlite,.sqlite3,.db,.db3"));
                sections.push(this.queriesSection(definition.queries ?? [], "SELECT * FROM parts"));
                break;
            case "http":
                sections.push(
                    this.section(
                        "data.endpoint",
                        this.field(
                            "data.url",
                            this.textInput(definition.url, (url) => this.change({ url }), "https://"),
                        ),
                        this.field(
                            "data.method",
                            this.selectInput(
                                [
                                    ["GET", "data.method.get"],
                                    ["POST", "data.method.post"],
                                ],
                                definition.method ?? "GET",
                                (method) => this.change({ method: method as "GET" | "POST" }),
                            ),
                        ),
                        this.field(
                            "data.body",
                            this.textArea(definition.body ?? "", (body) => this.change({ body })),
                        ),
                        this.field(
                            "data.format",
                            this.selectInput(
                                [
                                    ["auto", "data.format.auto"],
                                    ["json", "data.format.json"],
                                    ["csv", "data.format.csv"],
                                ],
                                definition.format ?? "auto",
                                (format) => this.change({ format: format as "auto" | "json" | "csv" }),
                            ),
                        ),
                        this.field(
                            "data.jsonPath",
                            this.textInput(
                                definition.jsonPath ?? "",
                                (jsonPath) => this.change({ jsonPath }),
                                "data.items",
                            ),
                        ),
                        this.field(
                            "data.tableName",
                            this.textInput(
                                definition.tableName ?? "",
                                (tableName) => this.change({ tableName }),
                                "data",
                            ),
                        ),
                    ),
                    this.headersSection(definition.headers ?? []),
                );
                break;
            case "sql":
                sections.push(
                    this.section(
                        "data.endpoint",
                        this.field(
                            "data.dialect",
                            this.selectInput(
                                [
                                    ["postgrest", "data.dialect.postgrest"],
                                    ["hasura", "data.dialect.hasura"],
                                    ["graphql", "data.dialect.graphql"],
                                    ["generic", "data.dialect.generic"],
                                ],
                                definition.dialect,
                                (dialect) => this.change({ dialect: dialect as SqlDialect }),
                            ),
                        ),
                        this.field(
                            "data.url",
                            this.textInput(definition.url, (url) => this.change({ url }), "https://"),
                        ),
                        // PostgREST and Hasura answer rows directly; GraphQL and generic answers nest them.
                        ...(definition.dialect === "graphql" || definition.dialect === "generic"
                            ? [
                                  this.field(
                                      "data.jsonPath",
                                      this.textInput(
                                          definition.jsonPath ?? "",
                                          (jsonPath) => this.change({ jsonPath }),
                                          "data.parts",
                                      ),
                                  ),
                              ]
                            : []),
                    ),
                    this.headersSection(definition.headers ?? []),
                    this.queriesSection(
                        definition.queries ?? [],
                        definition.dialect === "postgrest"
                            ? "parts?select=name,length"
                            : "SELECT name, length FROM parts",
                    ),
                );
                break;
            case "sheet":
                sections.push(
                    this.section(
                        "data.endpoint",
                        this.field(
                            "data.provider",
                            this.selectInput(
                                [
                                    ["google", "data.provider.google"],
                                    ["excel", "data.provider.excel"],
                                ],
                                definition.provider,
                                (provider) => this.change({ provider: provider as SheetProvider }),
                            ),
                        ),
                        this.field(
                            "data.link",
                            this.textInput(
                                definition.url,
                                (url) => this.change({ url }),
                                "https://docs.google.com/spreadsheets/d/…",
                            ),
                        ),
                        this.field(
                            "data.sheets",
                            this.textInput((definition.sheets ?? []).join(", "), (text) =>
                                this.change({
                                    sheets: text
                                        .split(",")
                                        .map((x) => x.trim())
                                        .filter((x) => x !== ""),
                                }),
                            ),
                        ),
                    ),
                );
                break;
        }
        sections.push(this.optionsSection(definition, options));
        this.settings.replaceChildren(...sections);
    }

    private fileSection(fileName: string | undefined, accept: string): HTMLElement {
        const picker = input({ type: "file", accept });
        picker.style.display = "none";
        picker.onchange = async () => {
            const file = picker.files?.[0];
            if (file === undefined) return;
            await this.node.attachFile(file.name, new Uint8Array(await file.arrayBuffer()));
        };
        return this.section(
            "data.file",
            div(
                { className: style.row },
                span({ className: fileName ? "" : style.muted, textContent: fileName ?? t("data.noFile") }),
                button({
                    className: style.button,
                    textContent: new Localize("data.attach"),
                    onclick: () => picker.click(),
                }),
                picker,
            ),
        );
    }

    private queriesSection(queries: readonly DataQuery[], example: string): HTMLElement {
        const write = (next: DataQuery[]) => this.change({ queries: next });
        return this.section(
            "data.queries",
            ...queries.map((query, index) =>
                div(
                    { className: style.section },
                    div(
                        { className: style.row },
                        this.textInput(query.name, (name) =>
                            write(queries.map((q, i) => (i === index ? { ...q, name: name || q.name } : q))),
                        ),
                        button({
                            className: style.button,
                            textContent: new Localize("data.remove"),
                            onclick: () => write(queries.filter((_, i) => i !== index)),
                        }),
                    ),
                    this.textArea(
                        query.query,
                        (text) => write(queries.map((q, i) => (i === index ? { ...q, query: text } : q))),
                        example,
                    ),
                ),
            ),
            button({
                className: style.button,
                textContent: new Localize("data.addQuery"),
                onclick: () =>
                    write([
                        ...queries,
                        {
                            name: uniqueName(
                                queries.map((q) => q.name),
                                "Query",
                            ),
                            query: "",
                        },
                    ]),
            }),
        );
    }

    private headersSection(headers: readonly DataHeader[]): HTMLElement {
        const write = (next: DataHeader[]) => this.change({ headers: next } as Partial<DataSourceDefinition>);
        const secrets = this.node.secrets();
        const definition = this.node.definition;
        return this.section(
            "data.headers",
            ...headers.map((header, index) => {
                const value = input({
                    className: style.input,
                    type: header.secret ? "password" : "text",
                    value: header.secret ? "" : (header.value ?? ""),
                    placeholder: header.secret
                        ? secrets[header.name]
                            ? t("data.secret.set")
                            : t("data.secret.placeholder")
                        : t("data.headerValue"),
                    onchange: () => {
                        if (header.secret) {
                            this.node.setSecret(header.name, value.value);
                            value.value = "";
                            this.renderSettings();
                        } else write(headers.map((h, i) => (i === index ? { ...h, value: value.value } : h)));
                    },
                });
                return div(
                    { className: style.row },
                    this.textInput(
                        header.name,
                        (name) => {
                            if (header.secret && secrets[header.name]) {
                                this.node.setSecret(name, secrets[header.name]);
                                this.node.setSecret(header.name, "");
                            }
                            write(headers.map((h, i) => (i === index ? { ...h, name } : h)));
                        },
                        t("data.headerName"),
                    ),
                    value,
                    label(
                        { className: style.check, title: new Localize("data.secret.hint") },
                        input({
                            type: "checkbox",
                            checked: header.secret === true,
                            onchange: (e: Event) => {
                                const secret = (e.target as HTMLInputElement).checked;
                                if (secret && header.value) this.node.setSecret(header.name, header.value);
                                const restored = secret ? undefined : (secrets[header.name] ?? "");
                                if (!secret) this.node.setSecret(header.name, "");
                                write(
                                    headers.map((h, i) =>
                                        i !== index
                                            ? h
                                            : secret
                                              ? { name: h.name, secret: true }
                                              : { name: h.name, value: restored },
                                    ),
                                );
                            },
                        }),
                        span({ textContent: new Localize("data.secret") }),
                    ),
                    button({
                        className: style.button,
                        textContent: new Localize("data.remove"),
                        onclick: () => {
                            if (header.secret) this.node.setSecret(header.name, "");
                            write(headers.filter((_, i) => i !== index));
                        },
                    }),
                );
            }),
            div(
                { className: style.row },
                button({
                    className: style.button,
                    textContent: new Localize("data.addHeader"),
                    onclick: () => write([...headers, { name: "", value: "" }]),
                }),
                button({
                    className: style.button,
                    textContent: new Localize("data.addAuthorization"),
                    onclick: () => write([...headers, { name: "Authorization", secret: true }]),
                }),
            ),
            this.check("data.storeSecrets", definition.storeSecrets === true, (storeSecrets) =>
                this.change({ storeSecrets }),
            ),
            div({ className: style.warning, textContent: new Localize("data.storeSecrets.hint") }),
        );
    }

    private optionsSection(definition: DataSourceDefinition, extra: readonly HTMLElement[]): HTMLElement {
        const children: HTMLElement[] = [
            ...extra,
            this.check("data.hasHeader", definition.hasHeader !== false, (hasHeader) =>
                this.change({ hasHeader }),
            ),
        ];
        if (isRemoteKind(definition.kind)) {
            children.push(
                this.field(
                    "data.refreshMode",
                    this.selectInput(
                        [
                            ["manual", "data.refreshMode.manual"],
                            ["open", "data.refreshMode.open"],
                            ["interval", "data.refreshMode.interval"],
                        ],
                        definition.refresh ?? "manual",
                        (refresh) => this.change({ refresh: refresh as DataRefreshMode }),
                    ),
                ),
            );
            if (definition.refresh === "interval") {
                children.push(
                    this.field(
                        "data.intervalSeconds",
                        this.textInput(
                            String(definition.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS),
                            (text) => {
                                const seconds = Number(text);
                                if (Number.isFinite(seconds) && seconds > 0)
                                    this.change({ intervalSeconds: seconds });
                            },
                        ),
                    ),
                );
            }
        }
        return this.section("data.options", ...children);
    }

    // ------------------------------------------------------------------ Preview

    /** The reference a formula uses for the shown table: the source, or `Source/Table`. */
    private tableReference(table: DataTable): string {
        return this.activeTable === 0 ? this.node.name : `${this.node.name}/${table.name}`;
    }

    private renderPreview(): void {
        const tables = this.node.tables;
        if (tables.length === 0) {
            this.preview.replaceChildren(
                div({ className: style.muted, textContent: new Localize("data.noTables") }),
            );
            return;
        }
        if (this.activeTable >= tables.length) this.activeTable = 0;
        const table = tables[this.activeTable];
        const tabs = div(
            { className: style.tabs },
            ...tables.map((x, index) =>
                span({
                    className: index === this.activeTable ? `${style.tab} ${style.activeTab}` : style.tab,
                    textContent: `${x.name} (${x.rows.length})`,
                    onclick: () => {
                        this.activeTable = index;
                        this.selected = undefined;
                        this.renderPreview();
                    },
                }),
            ),
            button({
                className: style.button,
                textContent: new Localize("data.importVariables"),
                title: new Localize("data.importVariables.hint"),
                onclick: () => this.importVariables(table),
            }),
        );
        this.preview.replaceChildren(
            tabs,
            div({ className: style.gridWrap }, this.grid(table)),
            this.referenceBox(table),
            this.dependencyList(),
        );
    }

    private grid(table: DataTable): HTMLTableElement {
        const types = columnTypes(table);
        const headerRows = table.hasHeader === false ? 0 : 1;
        const element = document.createElement("table");
        element.className = style.grid;
        const head = element.createTHead().insertRow();
        head.append(document.createElement("th"));
        table.columns.forEach((_, c) => {
            const th = document.createElement("th");
            th.textContent = columnName(c);
            head.append(th);
        });
        const body = element.createTBody();
        const addRow = (cells: readonly DataCell[], gridRow: number, header: boolean) => {
            const tr = body.insertRow();
            const number = document.createElement("th");
            number.className = style.rowNumber;
            number.textContent = String(gridRow + 1);
            tr.append(number);
            table.columns.forEach((_, c) => {
                const td = tr.insertCell();
                const selected = this.selected?.row === gridRow && this.selected.column === c;
                td.className = [header ? style.headerCell : style.cell, selected ? style.selected : ""].join(
                    " ",
                );
                td.textContent = cellText(cells[c]);
                if (header)
                    td.append(
                        span({
                            className: style.columnType,
                            textContent: new Localize(`data.type.${types[c]}`),
                        }),
                    );
                td.onclick = () => {
                    this.selected = { row: gridRow, column: c };
                    this.renderPreview();
                };
            });
        };
        if (headerRows === 1) addRow(table.columns, 0, true);
        for (const [r, row] of table.rows.slice(0, PREVIEW_ROWS).entries())
            addRow(row, r + headerRows, false);
        if (table.rows.length > PREVIEW_ROWS) {
            const tr = body.insertRow();
            const td = tr.insertCell();
            td.colSpan = table.columns.length + 1;
            td.className = style.muted;
            td.textContent = t("data.moreRows{0}", table.rows.length - PREVIEW_ROWS);
        }
        return element;
    }

    private referenceBox(table: DataTable): HTMLElement {
        if (this.selected === undefined) {
            return div({ className: style.muted, textContent: new Localize("data.reference.hint") });
        }
        const { row, column } = this.selected;
        const reference = quoteText(this.tableReference(table));
        const dataRow = row - (table.hasHeader === false ? 0 : 1) + 1;
        const expression =
            dataRow >= 1 && table.hasHeader !== false
                ? `data(${reference}, ${quoteText(table.columns[column])}, ${dataRow})`
                : `data(${reference}, "${columnName(column)}${row + 1}")`;
        const byAddress = `data(${reference}, "${columnName(column)}${row + 1}")`;
        const copy = (text: string) => () => {
            navigator.clipboard?.writeText(text).catch(() => {});
            PubSub.default.pub("showToast", "data.copied");
        };
        return div(
            { className: style.reference },
            span({ textContent: new Localize("data.reference") }),
            div({ textContent: expression, className: style.input }),
            button({
                className: style.button,
                textContent: new Localize("data.copy"),
                onclick: copy(expression),
            }),
            ...(byAddress === expression
                ? []
                : [button({ className: style.button, textContent: byAddress, onclick: copy(byAddress) })]),
        );
    }

    private refreshDependencies(): void {
        try {
            this.dependencies = dependenciesOn(this.document, this.node);
        } catch {
            this.dependencies = [];
        }
        this.renderPreview();
        this.renderStatus();
    }

    private dependencyList(): HTMLElement {
        const items = this.dependencies.map((dependency) =>
            li(
                {},
                span({ textContent: dependency.reference.label }),
                span({
                    className: style.muted,
                    textContent: ` — ${dependency.nodeName}${dependency.location ? ` › ${dependency.location}` : ""}`,
                }),
            ),
        );
        return div(
            { className: style.dependencies },
            div({ className: style.sectionTitle, textContent: new Localize("data.usedBy") }),
            items.length === 0
                ? div({ className: style.muted, textContent: new Localize("data.usedBy.none") })
                : ul({}, ...items),
        );
    }

    private importVariables(table: DataTable): void {
        const result = importVariablesFromTable(this.document, table, this.tableReference(table));
        if (!result.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", result.error);
            return;
        }
        PubSub.default.pub(
            "showToast",
            "data.imported{0}{1}",
            result.value.added + result.value.updated,
            result.value.studio.name,
        );
        this.refreshDependencies();
    }

    // ------------------------------------------------------------------ Controls

    private section(title: I18nKeys, ...children: HTMLElement[]): HTMLElement {
        return div(
            { className: style.section },
            div({ className: style.sectionTitle, textContent: new Localize(title) }),
            ...children,
        );
    }

    private field(title: I18nKeys, control: HTMLElement): HTMLElement {
        return label({ className: style.field }, span({ textContent: new Localize(title) }), control);
    }

    private check(title: I18nKeys, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
        return label(
            { className: style.check },
            input({
                type: "checkbox",
                checked,
                onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
            }),
            span({ textContent: new Localize(title) }),
        );
    }

    private textInput(value: string, onCommit: (value: string) => void, placeholder = ""): HTMLInputElement {
        const element = input({ className: style.input, value, placeholder });
        element.onchange = () => onCommit(element.value);
        return element;
    }

    private textArea(
        value: string,
        onCommit: (value: string) => void,
        placeholder = "",
    ): HTMLTextAreaElement {
        const element = textarea({ className: style.textarea, value, placeholder, spellcheck: false });
        element.onchange = () => onCommit(element.value);
        return element;
    }

    private selectInput(
        options: readonly (readonly [string, I18nKeys])[],
        value: string,
        onChange: (value: string) => void,
    ): HTMLSelectElement {
        const element = select(
            { className: style.select },
            ...options.map(([key, text]) => option({ value: key, textContent: new Localize(text) })),
        );
        element.value = value;
        element.onchange = () => onChange(element.value);
        return element;
    }
}

function uniqueName(taken: readonly string[], base: string): string {
    for (let n = taken.length + 1; ; n++) {
        const name = `${base} ${n}`;
        if (!taken.includes(name)) return name;
    }
}
