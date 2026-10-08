// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    activeInputValue,
    type ConfigurationVariableInputData,
    configuredArmSource,
    formatConfiguredValue,
    type IDocument,
    type INode,
    isConfiguredValue,
    isSelectorInput,
    type ModelParameter,
    modelParameters,
    parseConfiguredValue,
    selectConfiguredArm,
    selectorOptions,
    unitSpecEquals,
    unitSpecOfType,
} from "@chili3d/core";
import { option as makeOption } from "@chili3d/element";
import { activeInputControl } from "../property/configuration/activeControls";
import { ConfigurationDataContent } from "../property/configuration/configurationDataContent";
import { ConfigurationEditor } from "../property/configuration/configurationEditor";
import { armDisplay } from "../property/configuration/configureGrid";
import { ConfigurationInputMenu } from "./configurationInputMenu";
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
    private readonly tabs = document.createElement("div");
    private readonly addMenu: ConfigurationInputMenu;
    private readonly collapsed = new Set<string>();
    constructor(private readonly doc: IDocument) {
        this.element.className = `${style.root} ${style.configuration}`;
        this.data = new ConfigurationDataContent(doc);
        this.inputs = new ConfigurationEditor(this.data);
        this.inputs.dataset["docked"] = "true";
        const tabs = this.tabs;
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
                this.showGrid(showGrid);
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
        this.addMenu = new ConfigurationInputMenu((kind) => {
            const id = this.data.addInput(kind);
            this.render();
            this.editInput(id);
        });
        this.grid.className = style.configurationSections;
        this.element.append(tabs, this.filter, this.grid, this.inputs, this.status, this.addMenu.element);
        doc.modelManager.addNodeObserver(this.changed);
        doc.variables.onPropertyChanged(this.changed);
        this.render();
    }
    private showGrid(show: boolean) {
        this.inputs.hidden = show;
        this.grid.hidden = !show;
        this.filter.hidden = !show;
        for (const [index, child] of Array.from(this.tabs.children).entries())
            child.setAttribute("aria-selected", String(show === (index === 0)));
    }

    private editInput(id: string) {
        this.showGrid(false);
        this.inputs.render();
        this.inputs.focusInput(id);
    }

    private inputSection(id: string, name: string, kind: string): HTMLDetailsElement {
        const section = document.createElement("details");
        section.className = style.inputSection;
        section.dataset["inputId"] = id;
        section.open = !this.collapsed.has(id);
        section.ontoggle = () => {
            if (section.open) this.collapsed.delete(id);
            else this.collapsed.add(id);
        };
        const summary = document.createElement("summary");
        summary.textContent = `${name} · ${kind}`;
        const edit = document.createElement("button");
        edit.textContent = "⋯";
        edit.title = `Edit ${name} input`;
        edit.setAttribute("aria-label", edit.title);
        edit.onclick = (event) => {
            event.preventDefault();
            this.editInput(id);
        };
        summary.append(edit);
        section.append(summary);
        return section;
    }

    private variableSection(input: ConfigurationVariableInputData, slots: ModelParameter[]): HTMLElement {
        const section = this.inputSection(input.id, input.name, "Configuration variable");
        const controls = document.createElement("div");
        controls.className = style.toolbar;
        const value = activeInputControl(this.data, input, style.variableValue);
        value.setAttribute("aria-label", `${input.name} value`);
        const choose = document.createElement("select");
        choose.setAttribute("aria-label", `Use ${input.name} for parameter`);
        choose.append(makeOption({ textContent: "Choose a dimension or feature parameter…", value: "" }));
        const eligible = slots.filter(
            (s) => !s.boolean && !s.options && !s.text && unitSpecEquals(s.unit, unitSpecOfType(input.type)),
        );
        for (const slot of eligible)
            choose.append(makeOption({ textContent: `${slot.node.name} / ${slot.label}`, value: slot.id }));
        const use = document.createElement("button");
        use.textContent = "Use variable";
        use.onclick = () => {
            const slot = eligible.find((s) => s.id === choose.value);
            if (slot) this.apply(slot, input.name);
        };
        const label = document.createElement("label");
        label.textContent = `${input.type} `;
        label.append(value);
        controls.append(label, choose, use);
        const bounds = document.createElement("small");
        bounds.textContent = `Default: ${input.defaultExpression}${input.min === undefined ? "" : ` · Minimum: ${input.min}`}${input.max === undefined ? "" : ` · Maximum: ${input.max}`}`;
        section.append(controls, bounds);
        return section;
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
        for (const input of this.data.inputs) {
            if (!isSelectorInput(input)) {
                if (!query || input.name.toLowerCase().includes(query))
                    sections.push(this.variableSection(input, slots));
                continue;
            }
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
            const section = this.inputSection(
                input.id,
                input.name,
                input.kind === "checkbox" ? "Checkbox" : "List",
            );
            const toolbar = document.createElement("div");
            toolbar.className = style.toolbar;
            const title = document.createElement("strong");
            title.textContent = input.name;
            const choose = document.createElement("select");
            choose.setAttribute("aria-label", `Configure ${input.name} parameter`);
            choose.append(makeOption({ textContent: "Choose a parameter or suppression state…", value: "" }));
            slots
                .filter((s) => !isConfiguredValue(s.value))
                .forEach((s) =>
                    choose.append(makeOption({ textContent: `${s.node.name} / ${s.label}`, value: s.id })),
                );
            const add = document.createElement("button");
            add.textContent = "Configure";
            add.onclick = () => {
                const slot = slots.find((s) => s.id === choose.value);
                if (!slot) return;
                const value = formatConfiguredValue({
                    input: input.name,
                    arms: selectorOptions(input).map((option) => ({
                        option,
                        value: configuredArmSource(slot.value, { text: slot.text || !!slot.options }),
                    })),
                });
                this.apply(slot, value);
                this.render();
            };
            toolbar.append(title, choose, add);
            const table = document.createElement("table");
            table.className = style.table;
            const head = table.createTHead().insertRow();
            for (const [index, name] of [
                "Name",
                ...configured.map((s) => `${s.node.name} / ${s.label}`),
            ].entries()) {
                const th = document.createElement("th");
                th.textContent = name;
                if (index > 0) {
                    const slot = configured[index - 1];
                    const remove = document.createElement("button");
                    remove.textContent = "×";
                    remove.title = `Stop configuring ${slot.node.name} / ${slot.label}`;
                    remove.setAttribute("aria-label", remove.title);
                    remove.onclick = () => {
                        const fresh = modelParameters(this.doc).find((s) => s.id === slot.id);
                        if (!fresh) return;
                        const selected = selectConfiguredArm(
                            fresh.value,
                            this.doc.variables.evaluate().scope,
                        );
                        if (!selected.isOk) {
                            this.status.textContent = selected.error;
                            return;
                        }
                        this.apply(fresh, String(selected.value));
                        this.render();
                    };
                    th.append(remove);
                }
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
                    const parsed = parseConfiguredValue(String(slot.value));
                    if (!parsed.isOk) continue;
                    const source = parsed.value.arms.find((a) => a.option === option)?.value ?? "";
                    const kind = slot.boolean
                        ? "boolean"
                        : slot.options
                          ? "options"
                          : slot.text
                            ? "text"
                            : "expression";
                    const field = slot.options
                        ? document.createElement("select")
                        : document.createElement("input");
                    if (slot.options) {
                        for (const choice of slot.options)
                            field.append(makeOption({ textContent: choice.label, value: choice.value }));
                    }
                    field.value = String(armDisplay(kind, source));
                    if (slot.boolean) {
                        (field as HTMLInputElement).type = "checkbox";
                        (field as HTMLInputElement).checked =
                            (armDisplay(kind, source) === true) !== (slot.inverted === true);
                    }
                    field.setAttribute("aria-label", `${option}: ${slot.node.name} / ${slot.label}`);
                    field.onchange = () => {
                        // Refresh the slot after another cell's edit; never overwrite its latest arms.
                        const fresh = modelParameters(this.doc).find((s) => s.id === slot.id);
                        if (!fresh) return;
                        const current = parseConfiguredValue(String(fresh.value));
                        if (!current.isOk) return;
                        const arms = current.value.arms.filter((a) => a.option !== option);
                        arms.push({
                            option,
                            value: slot.boolean
                                ? String((field as HTMLInputElement).checked !== (slot.inverted === true))
                                : configuredArmSource(field.value, { text: slot.text || !!slot.options }),
                        });
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
        if (!sections.length) {
            const empty = document.createElement("div");
            empty.className = style.empty;
            empty.textContent =
                "Add a configuration input, then choose a sketch dimension or feature parameter. Each row defines a configuration.";
            sections.push(empty);
        }
        this.grid.replaceChildren(...sections);
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
        this.addMenu.close();
        this.disposed = true;
        this.inputs.dispose();
        this.doc.modelManager.removeNodeObserver(this.changed);
        this.doc.variables.removePropertyChanged(this.changed);
        for (const node of this.watches) node.removePropertyChanged(this.changed);
        this.watches.clear();
    }
}
