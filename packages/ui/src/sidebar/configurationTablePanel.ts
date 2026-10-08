// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    activeInputValue,
    formatConfiguredValue,
    type IDocument,
    type INode,
    isSelectorInput,
    type ModelParameter,
    modelParameters,
    parseConfiguredValue,
    selectorOptions,
} from "@chili3d/core";
import { ConfigurationDataContent } from "../property/configuration/configurationDataContent";
import { ConfigurationEditor } from "../property/configuration/configurationEditor";
import style from "./modelTable.module.css";

/** The same live slots as the feature/sketch editors, arranged in configuration rows. */
export class ConfigurationTablePanel {
    readonly element = document.createElement("div");
    private readonly grid = document.createElement("div");
    private readonly filter = document.createElement("input");
    private readonly status = document.createElement("div");
    private readonly inputs: ConfigurationEditor;
    private readonly watches = new Set<INode>();
    private scheduled = false;
    private disposed = false;
    private writing = false;
    private readonly data: ConfigurationDataContent;
    constructor(private readonly doc: IDocument) {
        this.element.className = style.root;
        this.data = new ConfigurationDataContent(doc);
        this.inputs = new ConfigurationEditor(this.data);
        this.inputs.dataset["docked"] = "true";
        const tabs = document.createElement("div");
        tabs.className = style.tabs;
        for (const [label, showGrid] of [
            ["Configurations", true],
            ["Inputs", false],
        ] as const) {
            const button = document.createElement("button");
            button.textContent = label;
            button.setAttribute("role", "tab");
            button.setAttribute("aria-selected", String(showGrid));
            button.onclick = () => {
                this.inputs.hidden = showGrid;
                this.grid.hidden = !showGrid;
                this.filter.hidden = !showGrid;
                for (const child of tabs.children)
                    child.setAttribute("aria-selected", String(child === button));
            };
            tabs.append(button);
        }
        this.inputs.hidden = true;
        this.filter.type = "search";
        this.filter.placeholder = "Filter inputs or dimensions";
        this.filter.setAttribute("aria-label", this.filter.placeholder);
        this.filter.oninput = () => this.render();
        this.status.className = style.error;
        this.status.setAttribute("role", "status");
        this.element.append(tabs, this.filter, this.grid, this.inputs, this.status);
        doc.modelManager.addNodeObserver(this.changed);
        doc.variables.onPropertyChanged(this.changed);
        this.render();
    }
    private readonly changed = () => {
        if (this.writing || this.scheduled || this.disposed) return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            if (!this.disposed) this.render();
        });
    };
    private render() {
        for (const node of this.watches) node.removePropertyChanged(this.changed);
        this.watches.clear();
        for (const node of this.doc.modelManager.findNodes()) {
            node.onPropertyChanged(this.changed);
            this.watches.add(node);
        }
        const slots = modelParameters(this.doc);
        const sections: HTMLElement[] = [];
        const query = this.filter.value.toLowerCase();
        for (const input of this.data.inputs.filter(isSelectorInput)) {
            const configured = slots.filter((s) => {
                const p = typeof s.value === "string" ? parseConfiguredValue(s.value) : undefined;
                return p?.isOk && p.value.input === input.name;
            });
            if (
                query &&
                !input.name.toLowerCase().includes(query) &&
                !configured.some((s) => `${s.node.name} ${s.label}`.toLowerCase().includes(query))
            )
                continue;
            const section = document.createElement("section");
            section.className = style.root;
            const toolbar = document.createElement("div");
            toolbar.className = style.toolbar;
            const title = document.createElement("strong");
            title.textContent = input.name;
            const choose = document.createElement("select");
            choose.setAttribute("aria-label", `Configure ${input.name} parameter`);
            choose.add(new Option("Choose a dimension or feature parameter…", ""));
            slots
                .filter((s) => !configured.some((item) => item.id === s.id))
                .forEach((s) => choose.add(new Option(`${s.node.name} / ${s.label}`, s.id)));
            const add = document.createElement("button");
            add.textContent = "Configure";
            add.onclick = () => {
                const slot = slots.find((s) => s.id === choose.value);
                if (!slot) return;
                const value = formatConfiguredValue({
                    input: input.name,
                    arms: selectorOptions(input).map((option) => ({ option, value: String(slot.value) })),
                });
                this.apply(slot, value);
                this.render();
            };
            toolbar.append(title, choose, add);
            const table = document.createElement("table");
            table.className = style.table;
            const head = table.createTHead().insertRow();
            for (const name of ["Name", ...configured.map((s) => `${s.node.name} / ${s.label}`)]) {
                const th = document.createElement("th");
                th.textContent = name;
                head.append(th);
            }
            for (const option of selectorOptions(input)) {
                const row = table.insertRow();
                row.dataset["active"] = String(String(activeInputValue(input, this.data.active)) === option);
                const activate = document.createElement("button");
                activate.textContent = option;
                activate.title = "Activate configuration";
                activate.onclick = () =>
                    this.data.setActive(input.name, input.kind === "checkbox" ? option === "true" : option);
                row.insertCell().append(activate);
                for (const slot of configured) {
                    const field = document.createElement("input");
                    const parsed = parseConfiguredValue(String(slot.value));
                    if (!parsed.isOk) continue;
                    field.value = parsed.value.arms.find((a) => a.option === option)?.value ?? "";
                    field.setAttribute("aria-label", `${option}: ${slot.node.name} / ${slot.label}`);
                    field.onchange = () => {
                        // Refresh the slot after another cell's edit; never overwrite its latest arms.
                        const fresh = modelParameters(this.doc).find((s) => s.id === slot.id);
                        if (!fresh) return;
                        const current = parseConfiguredValue(String(fresh.value));
                        if (!current.isOk) return;
                        const arms = current.value.arms.filter((a) => a.option !== option);
                        arms.push({ option, value: field.value });
                        this.apply(fresh, formatConfiguredValue({ ...current.value, arms }));
                    };
                    row.insertCell().append(field);
                }
            }
            const scroll = document.createElement("div");
            scroll.className = style.scroll;
            scroll.append(table);
            section.append(toolbar, scroll);
            sections.push(section);
        }
        const add = document.createElement("button");
        add.textContent = "Add configuration input";
        add.onclick = () => {
            this.data.addInput("list");
            this.render();
        };
        if (!sections.length) {
            const empty = document.createElement("div");
            empty.className = style.empty;
            empty.textContent =
                "Add a configuration input, then choose a sketch dimension or feature parameter. Each row defines a configuration.";
            sections.push(empty);
        }
        this.grid.replaceChildren(...sections, add);
    }
    private apply(slot: ModelParameter, value: string) {
        this.writing = true;
        try {
            const result = slot.apply(value);
            this.status.textContent = result.isOk ? "" : result.error;
        } finally {
            this.writing = false;
        }
        this.doc.visual.update();
    }
    dispose() {
        this.disposed = true;
        this.inputs.dispose();
        this.doc.modelManager.removeNodeObserver(this.changed);
        this.doc.variables.removePropertyChanged(this.changed);
        for (const node of this.watches) node.removePropertyChanged(this.changed);
        this.watches.clear();
    }
}
