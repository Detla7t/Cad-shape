// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DocumentPanels,
    type FeatureParameter,
    I18n,
    type IDocument,
    type INode,
    PubSub,
    ShapeNode,
    type UnitSpec,
} from "@chili3d/core";
import type { FeatureScriptParameterValue } from "../../features/feature";
import { syncNodeWatches } from "../../nodeWatch";
import {
    type CustomTableEntry,
    customTableParameters,
    customTables,
    evaluateCustomTable,
} from "../customTables";
import { FeatureStudioNode } from "../featureStudioNode";
import type { TableData, TableRunResult } from "../tableRuntime";
import style from "./tablesPanel.module.css";

/**
 * The custom tables panel (Onshape's Tables panel): pick one of the tables the
 * document's Feature Studios export, set its parameters (the same rows a custom
 * feature's panel shows, so numbers take expressions over the document's variables),
 * and read the table(s) it computes over the Part Studio. It follows the document —
 * a studio edit, a part's shape, placement or visibility, or the variables recompute it
 * (debounced). Parameter values live per document for the session.
 */

const open = new WeakSet<IDocument>();
/** document → `studioId \0 tableName` → the parameter values the user set. */
const storedValues = new WeakMap<IDocument, Map<string, Record<string, FeatureScriptParameterValue>>>();

export function showTablesPanel(document: IDocument): void {
    if (DocumentPanels.open("tables", document)) return;
    if (open.has(document)) return;
    open.add(document);
    const panel = new TablesPanel(document);
    const width = 560;
    const height = 420;
    PubSub.default.pub("showFloatPanel", {
        title: "featurescript.tables.title",
        content: panel.root,
        x: Math.max(20, window.innerWidth - width - 40),
        y: Math.max(20, Math.min(150, window.innerHeight - height - 20)),
        width,
        height,
        minWidth: 320,
        minHeight: 200,
        document,
        onClose: () => {
            open.delete(document);
            panel.dispose();
        },
    });
}

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function translate(key: Parameters<typeof I18n.translate>[0]): string {
    return I18n.translate(key) ?? String(key);
}

function entryKey(entry: CustomTableEntry): string {
    return `${entry.studio.id}\u0000${entry.tableName}`;
}

function unitLabel(unit: UnitSpec | undefined): string {
    if (unit?.length === 1 && unit.angle === 0) return "mm";
    if (unit?.angle === 1 && unit.length === 0) return "deg";
    return "";
}

/** Node properties that change what a table sees. */
const WATCHED = new Set(["shape", "transform", "visible", "parentVisible", "name", "source"]);
const RECOMPUTE_DELAY = 150;

export class TablesPanel {
    readonly root = element("div", style.root);
    readonly select = element("select", style.select);
    readonly parameters = element("div", style.parameters);
    readonly output = element("div", style.output);
    private entries: CustomTableEntry[] = [];
    private selected: string | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly watched = new Map<string, INode>();
    private parametersSignature: string | undefined;
    private selectSignature: string | undefined;
    private disposed = false;

    constructor(readonly document: IDocument) {
        const toolbar = element("div", style.toolbar);
        toolbar.append(element("span", undefined, translate("featurescript.tables.table")), this.select);
        this.root.append(toolbar, this.parameters, this.output);
        this.select.addEventListener("change", () => {
            this.selected = this.select.value;
            this.compute();
        });
        document.modelManager.addNodeObserver(this.onNodesChanged);
        document.variables.onPropertyChanged(this.onVariablesChanged);
        PubSub.default.sub("documentUnitsChanged", this.unitsChanged);
        this.compute();
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        this.document.modelManager.removeNodeObserver(this.onNodesChanged);
        this.document.variables.removePropertyChanged(this.onVariablesChanged);
        PubSub.default.remove("documentUnitsChanged", this.unitsChanged);
        syncNodeWatches(this.document, this.watched, new Set(), this.onNodeChanged);
    }

    /** The parameter values of the selected table (created on first use). */
    private values(key: string): Record<string, FeatureScriptParameterValue> {
        let byTable = storedValues.get(this.document);
        if (byTable === undefined) {
            byTable = new Map();
            storedValues.set(this.document, byTable);
        }
        let values = byTable.get(key);
        if (values === undefined) {
            values = {};
            byTable.set(key, values);
        }
        return values;
    }

    /** Recomputes later, once a burst of changes settles. */
    schedule(): void {
        if (this.disposed) return;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.compute(), RECOMPUTE_DELAY);
    }

    private readonly unitsChanged = (document: IDocument) => {
        if (document === this.document) this.schedule();
    };

    /** Re-reads the tables on offer, redraws the parameters and recomputes the selected table. */
    compute(): void {
        this.timer = undefined;
        if (this.disposed) return;
        this.syncWatches();
        this.entries = customTables(this.document);
        if (!this.entries.some((entry) => entryKey(entry) === this.selected))
            this.selected = this.entries[0] === undefined ? undefined : entryKey(this.entries[0]);
        this.renderSelect();
        const entry = this.entries.find((candidate) => entryKey(candidate) === this.selected);
        if (entry === undefined) {
            this.parametersSignature = undefined;
            this.parameters.replaceChildren();
            this.output.replaceChildren(
                element("div", style.message, translate("featurescript.tables.none")),
            );
            return;
        }
        const values = this.values(entryKey(entry));
        const parameters = customTableParameters(this.document, entry.studio.id, entry.tableName, values);
        // The rows only change with the parameter set (or its visibility): redrawing them on
        // every recompute would take the focus from the field being edited.
        const signature = JSON.stringify([
            entryKey(entry),
            ...parameters.map((p) => [p.key, p.label, p.options, typeof p.value, p.text]),
        ]);
        if (signature !== this.parametersSignature) {
            this.parametersSignature = signature;
            this.renderParameters(entry, parameters, values);
        }
        this.renderResult(evaluateCustomTable(this.document, entry.studio.id, entry.tableName, values));
    }

    private renderSelect(): void {
        const many = new Set(this.entries.map((entry) => entry.studio.id)).size > 1;
        const signature = JSON.stringify([
            this.selected,
            ...this.entries.map((entry) => [entryKey(entry), entry.studio.name, entry.displayName]),
        ]);
        if (signature === this.selectSignature) return;
        this.selectSignature = signature;
        this.select.replaceChildren(
            ...this.entries.map((entry) => {
                const label = many ? `${entry.studio.name} › ${entry.displayName}` : entry.displayName;
                const option = element("option", undefined, label);
                option.value = entryKey(entry);
                option.selected = option.value === this.selected;
                return option;
            }),
        );
        this.select.disabled = this.entries.length === 0;
    }

    private renderParameters(
        entry: CustomTableEntry,
        parameters: readonly FeatureParameter[],
        values: Record<string, FeatureScriptParameterValue>,
    ): void {
        const set = (key: string, value: FeatureScriptParameterValue) => {
            values[key] = value;
            // Visibility may follow the new value: redraw the rows, then the table.
            if (this.selected === entryKey(entry)) this.compute();
        };
        const rows = parameters.flatMap((parameter) => {
            const label = element("label", undefined, parameter.label ?? parameter.key);
            const control = this.control(parameter, set);
            control.addEventListener("keydown", (e) => e.stopPropagation());
            return [label, control, element("span", style.unit, unitLabel(parameter.unit))];
        });
        this.parameters.replaceChildren(...rows);
    }

    private control(
        parameter: FeatureParameter,
        set: (key: string, value: FeatureScriptParameterValue) => void,
    ): HTMLElement {
        if (typeof parameter.value === "boolean") {
            const checkbox = element("input");
            checkbox.type = "checkbox";
            checkbox.checked = parameter.value;
            checkbox.addEventListener("change", () => set(parameter.key, checkbox.checked));
            return checkbox;
        }
        if (parameter.options !== undefined) {
            const select = element("select", style.select);
            for (const option of parameter.options) {
                const item = element("option", undefined, option.label);
                item.value = option.value;
                item.selected = option.value === String(parameter.value);
                select.append(item);
            }
            select.addEventListener("change", () => set(parameter.key, select.value));
            return select;
        }
        const input = element("input", style.input);
        input.type = "text";
        input.value = String(parameter.value);
        input.addEventListener("change", () => {
            const text = input.value.trim();
            // Plain numbers are stored as numbers; anything else is an expression (or text).
            const number = Number(text);
            set(
                parameter.key,
                parameter.text || text === "" || !Number.isFinite(number) ? input.value : number,
            );
        });
        return input;
    }

    private renderResult(result: TableRunResult): void {
        const children: HTMLElement[] = [];
        if (result.error !== undefined) children.push(element("div", style.error, result.error));
        for (const table of result.tables) children.push(...this.renderTable(table));
        this.output.replaceChildren(...children);
    }

    private renderTable(table: TableData): HTMLElement[] {
        const title = element("div", style.title, table.title);
        if (table.rows.length === 0) {
            return [title, element("div", style.message, translate("featurescript.tables.noRows"))];
        }
        const align = (alignment: string | undefined) =>
            alignment === "CENTER" ? style.alignCenter : alignment === "RIGHT" ? style.alignRight : undefined;
        const grid = element("table", style.table);
        const head = element("tr");
        for (const column of table.columns) head.append(element("th", align(column.alignment), column.name));
        const body = element("tbody");
        for (const row of table.rows) {
            const tr = element("tr");
            for (const column of table.columns) {
                const cell = row.cells[column.id];
                const classes = [align(column.alignment)];
                if (cell?.error !== undefined) classes.push(style.errorCell);
                if (cell?.info !== undefined) classes.push(style.infoCell);
                const td = element("td", classes.filter((c) => c !== undefined).join(" "), cell?.text ?? "");
                const tip = cell?.error ?? cell?.info;
                if (tip !== undefined) td.title = tip;
                tr.append(td);
            }
            body.append(tr);
        }
        const thead = element("thead");
        thead.append(head);
        grid.append(thead, body);
        return [title, grid];
    }

    // ------------------------------------------------------------------ Following the document

    /** Watches every studio and shape node: their edits change what tables are on offer, or compute. */
    private syncWatches(): void {
        const ids = new Set(
            this.document.modelManager
                .findNodes((node) => node instanceof ShapeNode || node instanceof FeatureStudioNode)
                .map((node) => node.id),
        );
        syncNodeWatches(this.document, this.watched, ids, this.onNodeChanged);
    }

    private readonly onNodeChanged = (property: string) => {
        if (WATCHED.has(property)) this.schedule();
    };

    private readonly onNodesChanged = () => this.schedule();

    private readonly onVariablesChanged = (property: string) => {
        if (property === "variablesJson") this.schedule();
    };
}

DocumentPanels.register({
    id: "tables",
    title: "featurescript.tables.title",
    icon: "tables",
    create(document) {
        const panel = new TablesPanel(document);
        return { element: panel.root, dispose: () => panel.dispose() };
    },
});
