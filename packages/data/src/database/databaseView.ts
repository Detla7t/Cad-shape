// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    base64ToBytes,
    bytesToBase64,
    type DataCell,
    type EditorBufferRegistration,
    EditorBuffers,
    I18n,
    type IDocument,
    type IEditorBuffer,
    type IElementView,
    Logger,
    PubSub,
    Result,
    Transaction,
} from "@chili3d/core";
import { EditorBufferControls, mountIsland, type ReactIsland } from "@chili3d/react";
import { createElement } from "react";
import type { Database } from "sql.js";
import style from "./database.module.css";
import type { DatabaseNode } from "./databaseNode";
import {
    cellValue,
    createTable,
    deleteRow,
    dropTable,
    insertRow,
    listTables,
    openDatabase,
    readRows,
    runSql,
    updateCell,
} from "./sqlite";

const PAGE = 200;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function formatBytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The database manager: the tables of a SQLite file on the left, the selected table's rows
 * on the right (cells edited in place, rows added and deleted), and a SQL console. Edits
 * change the live database; Save (Ctrl+S) writes the file back into the node as one undo
 * step. The live copy is the element's editor buffer (`database` in `EditorBuffers`): its tab
 * is marked while it differs, closing asks about it, and the recovery autosave keeps the
 * database file. Keystrokes stay inside the view, so the Part Studio's hotkeys never act
 * behind it.
 */
export class DatabaseView implements IElementView {
    readonly element: HTMLElement;
    private db: Database | undefined;
    private table: string | undefined;
    private offset = 0;
    private dirty = false;
    private readonly tables = element("div", style.tables);
    private readonly main = element("div", style.main);
    /** The shared save bar (unsaved mark, Discard, Save). */
    private readonly controls: ReactIsland;
    private readonly info = element("span", style.info);
    private readonly title = element("span", style.title);
    /** The open (or reopen) in progress. */
    private loading: Promise<void>;
    private readonly registration: EditorBufferRegistration;
    /** The live copy as an editor buffer: commit is Save, revert reopens the node's file. */
    readonly buffer: IEditorBuffer;

    constructor(
        readonly node: DatabaseNode,
        readonly document: IDocument,
    ) {
        this.buffer = {
            document,
            node,
            editor: "database",
            isDirty: () => this.dirty,
            commit: async () => {
                try {
                    await this.save();
                    return Result.ok(undefined);
                } catch (error) {
                    return Result.err(error instanceof Error ? error.message : String(error));
                }
            },
            revert: () => {
                this.loading = this.open();
            },
            snapshot: () =>
                this.dirty && this.db !== undefined ? { data: bytesToBase64(this.db.export()) } : undefined,
            restore: async (draft) => {
                await this.loading;
                const bytes = base64ToBytes(draft.data);
                if (bytes === undefined) return;
                this.loading = this.open(bytes, true);
                await this.loading;
            },
        };
        const header = element("div", style.header);
        const controls = element("span");
        header.append(this.title, this.info, element("span", style.spacer), controls);
        const sidebar = element("div", style.sidebar);
        const sidebarTitle = element("div", style.sidebarTitle);
        sidebarTitle.append(element("span", undefined, I18n.translate("data.database.tables")));
        const add = element("button", style.button, `+ ${I18n.translate("data.database.newTable")}`);
        add.onclick = () => this.newTable();
        sidebarTitle.append(add);
        sidebar.append(sidebarTitle, this.tables);
        const body = element("div", style.body);
        body.append(sidebar, this.main);
        this.element = element("div", style.root);
        this.element.append(header, body);
        this.element.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                void this.save();
            }
            e.stopPropagation();
        });
        node.onPropertyChanged(this.nodeChanged);
        this.registration = EditorBuffers.register(this.buffer);
        this.controls = mountIsland(
            controls,
            createElement(EditorBufferControls, { buffer: this.buffer, onSave: () => this.save() }),
        );
        this.refreshHeader();
        this.loading = this.open();
    }

    /** Resolves once the database is open (tests wait for it). */
    get ready(): Promise<void> {
        return this.loading;
    }

    private readonly nodeChanged = (property: keyof DatabaseNode) => {
        if (property === "name" || property === "fileName") this.refreshHeader();
        else if (property === "content" && !this.dirty) this.loading = this.open();
    };

    private refreshHeader(): void {
        this.title.textContent = this.node.name;
        this.info.textContent = `SQLite · ${formatBytes(this.node.size)}`;
        this.registration?.changed();
    }

    private markDirty(): void {
        this.dirty = true;
        this.refreshHeader();
    }

    /** Opens `bytes` (the node's file by default) as the live database; `dirty` for a recovered draft. */
    private async open(bytes = this.node.bytes, dirty = false): Promise<void> {
        this.main.replaceChildren(element("div", style.message, I18n.translate("data.database.loading")));
        try {
            this.db?.close();
            this.db = undefined;
            this.db = await openDatabase(bytes);
        } catch (error) {
            this.main.replaceChildren(
                element("div", style.error, error instanceof Error ? error.message : String(error)),
            );
            return;
        }
        this.dirty = dirty;
        this.refreshHeader();
        this.renderTables();
        const tables = listTables(this.db);
        this.select(tables.includes(this.table ?? "") ? this.table : tables[0]);
    }

    private renderTables(): void {
        if (this.db === undefined) return;
        const tables = listTables(this.db);
        this.tables.replaceChildren(
            ...tables.map((name) => {
                const row = element("button", style.tableRow, name);
                row.setAttribute("role", "option");
                row.setAttribute("aria-selected", String(name === this.table));
                row.onclick = () => this.select(name);
                return row;
            }),
        );
        if (tables.length === 0)
            this.tables.append(element("div", style.message, I18n.translate("data.database.noTables")));
    }

    private select(table: string | undefined): void {
        this.table = table;
        this.offset = 0;
        this.renderTables();
        this.renderMain();
    }

    private renderMain(): void {
        const db = this.db;
        this.main.replaceChildren();
        if (db === undefined) return;
        const toolbar = element("div", style.toolbar);
        const console = this.console(db);
        if (this.table === undefined) {
            this.main.append(
                toolbar,
                element("div", style.message, I18n.translate("data.database.noTables")),
                console,
            );
            return;
        }
        const table = this.table;
        const page = readRows(db, table, PAGE, this.offset);
        const label = element("span", style.muted, I18n.translate("data.database.rows{0}", page.total));
        const addRow = element("button", style.button, `+ ${I18n.translate("data.database.addRow")}`);
        addRow.onclick = () => {
            try {
                insertRow(db, table);
                this.markDirty();
                this.renderMain();
            } catch (error) {
                this.report(error);
            }
        };
        const drop = element("button", style.button, I18n.translate("data.database.dropTable"));
        drop.onclick = () => {
            if (!window.confirm(I18n.translate("data.database.dropConfirm{0}", table))) return;
            try {
                dropTable(db, table);
                this.markDirty();
                this.select(listTables(db)[0]);
            } catch (error) {
                this.report(error);
            }
        };
        const pager = element("span", style.muted);
        const prev = element("button", style.button, "‹");
        const next = element("button", style.button, "›");
        prev.disabled = this.offset === 0;
        next.disabled = this.offset + PAGE >= page.total;
        prev.onclick = () => {
            this.offset = Math.max(0, this.offset - PAGE);
            this.renderMain();
        };
        next.onclick = () => {
            this.offset += PAGE;
            this.renderMain();
        };
        pager.textContent = `${this.offset + 1}–${Math.min(this.offset + PAGE, page.total)}`;
        toolbar.append(
            element("strong", undefined, table),
            label,
            element("span", style.spacer),
            prev,
            pager,
            next,
            addRow,
            drop,
        );
        const wrap = element("div", style.gridWrap);
        wrap.append(this.grid(db, table, page.columns, page.rows));
        this.main.append(toolbar, wrap, console);
    }

    private grid(
        db: Database,
        table: string,
        columns: string[],
        rows: { rowid: number; cells: DataCell[] }[],
    ) {
        const grid = element("table", style.grid);
        const head = grid.createTHead().insertRow();
        for (const column of ["", ...columns]) head.append(element("th", undefined, column));
        head.append(element("th"));
        const body = grid.createTBody();
        for (const row of rows) {
            const tr = body.insertRow();
            tr.insertCell().append(element("span", style.muted, String(row.rowid)));
            row.cells.forEach((value, index) => {
                const td = tr.insertCell();
                const box = element("input");
                box.value = value === null ? "" : String(value);
                box.placeholder = value === null ? "NULL" : "";
                box.setAttribute("aria-label", `${table} ${row.rowid} ${columns[index]}`);
                box.onchange = () => {
                    try {
                        updateCell(db, table, row.rowid, columns[index], cellValue(box.value));
                        this.markDirty();
                    } catch (error) {
                        this.report(error);
                    }
                };
                td.append(box);
            });
            const remove = element("button", style.button, "×");
            remove.title = I18n.translate("data.database.deleteRow");
            remove.setAttribute("aria-label", `${I18n.translate("data.database.deleteRow")} ${row.rowid}`);
            remove.onclick = () => {
                try {
                    deleteRow(db, table, row.rowid);
                    this.markDirty();
                    this.renderMain();
                } catch (error) {
                    this.report(error);
                }
            };
            tr.insertCell().append(remove);
        }
        return grid;
    }

    private console(db: Database): HTMLElement {
        const box = element("div", style.console);
        const sql = element("textarea", style.sql);
        sql.placeholder = "SELECT * FROM …";
        sql.setAttribute("aria-label", I18n.translate("data.database.sql"));
        const run = element("button", style.button, I18n.translate("data.database.run"));
        const output = element("div");
        run.onclick = () => {
            try {
                const result = runSql(db, sql.value);
                if (result.columns.length === 0) {
                    this.markDirty();
                    this.renderTables();
                    output.replaceChildren(
                        element(
                            "div",
                            style.muted,
                            I18n.translate("data.database.changed{0}", result.changes),
                        ),
                    );
                    if (this.table !== undefined && listTables(db).includes(this.table)) this.renderMain();
                    return;
                }
                const grid = element("table", style.grid);
                const head = grid.createTHead().insertRow();
                for (const column of result.columns) head.append(element("th", undefined, column));
                const body = grid.createTBody();
                for (const row of result.rows.slice(0, PAGE)) {
                    const tr = body.insertRow();
                    for (const value of row) {
                        const td = tr.insertCell();
                        td.append(
                            value === null
                                ? element("span", style.null, "NULL")
                                : element("span", undefined, ` ${String(value)} `),
                        );
                    }
                }
                const wrap = element("div", style.gridWrap);
                wrap.style.maxHeight = "200px";
                wrap.append(grid);
                output.replaceChildren(
                    element("div", style.muted, I18n.translate("data.database.rows{0}", result.rows.length)),
                    wrap,
                );
            } catch (error) {
                output.replaceChildren(
                    element("div", style.error, error instanceof Error ? error.message : String(error)),
                );
            }
        };
        const row = element("div", style.toolbar);
        row.append(
            element("span", undefined, I18n.translate("data.database.sql")),
            element("span", style.spacer),
            run,
        );
        box.append(row, sql, output);
        return box;
    }

    private newTable(): void {
        const db = this.db;
        if (db === undefined) return;
        const name = window.prompt(I18n.translate("data.database.newTableName"), "table1");
        if (!name) return;
        const columns = window.prompt(
            I18n.translate("data.database.newTableColumns"),
            "id INTEGER PRIMARY KEY, name TEXT",
        );
        if (columns === null) return;
        try {
            createTable(db, name, columns);
            this.markDirty();
            this.select(name);
        } catch (error) {
            this.report(error);
        }
    }

    private report(error: unknown): void {
        Logger.error(error);
        PubSub.default.pub(
            "showToast",
            "error.default:{0}",
            error instanceof Error ? error.message : String(error),
        );
    }

    isDirty(): boolean {
        return this.dirty;
    }

    async save(): Promise<void> {
        const db = this.db;
        if (db === undefined || !this.dirty) return;
        const bytes = db.export();
        Transaction.execute(this.document, "save database", () => this.node.setBytes(bytes));
        this.dirty = false;
        this.refreshHeader();
        PubSub.default.pub("showToast", "data.database.saved{0}", this.node.name);
    }

    dispose(): void {
        this.registration.dispose();
        this.controls.dispose();
        this.node.removePropertyChanged(this.nodeChanged);
        this.db?.close();
        this.db = undefined;
    }
}
