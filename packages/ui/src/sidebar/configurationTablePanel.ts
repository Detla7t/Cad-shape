// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    activeInputValue,
    type ConfigurationInputData,
    type ConfigurationVariableInputData,
    configuredArmSource,
    defaultListOption,
    expressionIdentifiers,
    formatConfiguredValue,
    I18n,
    type IDocument,
    type INode,
    isConfiguredValue,
    isSelectorInput,
    isVariableFeatureNode,
    type ModelParameter,
    modelParameters,
    parseConfiguredValue,
    selectConfiguredArm,
    selectorOptions,
    Transaction,
    unitSpecEquals,
    unitSpecOfType,
    type VariableData,
} from "@chili3d/core";
import { option as makeOption } from "@chili3d/element";
import { activeInputControl } from "../property/configuration/activeControls";
import { ConfigurationDataContent } from "../property/configuration/configurationDataContent";
import { ConfigurationEditor } from "../property/configuration/configurationEditor";
import { armDisplay } from "../property/configuration/configureGrid";
import { ConfigurationInputMenu } from "./configurationInputMenu";
import style from "./modelTable.module.css";

/**
 * A variable whose expression is `configure(<input>, …)` — the document table's row or a
 * variable feature's — shown as a `#name` column of the input's table (Onshape's configured
 * variables), each arm editable in place.
 */
interface ConfiguredVariable {
    readonly name: string;
    readonly expression: string;
    write(expression: string): void;
}

function configuredVariables(doc: IDocument, inputName: string): ConfiguredVariable[] {
    const result: ConfiguredVariable[] = [];
    const matches = (item: VariableData) => {
        const parsed = parseConfiguredValue(item.expression);
        return parsed.isOk && parsed.value.input === inputName;
    };
    for (const node of doc.modelManager.findNodes(isVariableFeatureNode).filter(isVariableFeatureNode)) {
        if (node.updateVariable === undefined) continue;
        for (const item of node.items) {
            if (!matches(item)) continue;
            result.push({
                name: item.name,
                expression: item.expression,
                write: (expression) =>
                    Transaction.execute(doc, "Edit configured variable", () =>
                        node.updateVariable?.({ ...item, expression }),
                    ),
            });
        }
    }
    for (const item of doc.variables.items) {
        if (!matches(item)) continue;
        result.push({
            name: item.name,
            expression: item.expression,
            write: (expression) =>
                Transaction.execute(doc, "Edit configured variable", () =>
                    doc.variables.setItems(
                        doc.variables.items.map((row) => (row.id === item.id ? { ...row, expression } : row)),
                    ),
                ),
        });
    }
    return result;
}

/** Every variable and slot reading a configuration variable by name — its "Usages". */
function usagesOf(doc: IDocument, inputName: string, slots: readonly ModelParameter[]): string[] {
    const usages: string[] = [];
    const reads = (expression: unknown) =>
        typeof expression === "string" && expressionIdentifiers(expression).has(inputName);
    for (const node of doc.modelManager.findNodes(isVariableFeatureNode).filter(isVariableFeatureNode))
        for (const item of node.items) if (reads(item.expression)) usages.push(`#${item.name}`);
    for (const item of doc.variables.items) if (reads(item.expression)) usages.push(`#${item.name}`);
    for (const slot of slots) if (reads(slot.value)) usages.push(`${slot.node.name} / ${slot.label}`);
    return usages;
}

/** What an input is set to when a configuration says nothing about it. */
function defaultOf(input: ConfigurationInputData): string {
    if (input.kind === "list") return defaultListOption(input)?.name ?? "";
    if (input.kind === "checkbox") return String(input.defaultValue);
    return input.defaultExpression;
}

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
    /** Inputs whose "Configure features" chooser is open. */
    private readonly choosing = new Set<string>();
    constructor(private readonly doc: IDocument) {
        this.element.className = `${style.root} ${style.configuration}`;
        this.data = new ConfigurationDataContent(doc);
        this.inputs = new ConfigurationEditor(this.data);
        this.inputs.dataset["docked"] = "true";
        const tabs = this.tabs;
        tabs.className = style.tabs;
        for (const [label, showGrid] of [
            [I18n.translate("configuration.configurations"), true],
            [I18n.translate("configuration.inputs"), false],
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
        this.filter.placeholder = I18n.translate("configuration.filter");
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

    /**
     * Onshape's input header: the name, its default, "Configure features" and the edit
     * menu. `onConfigure` opens the chooser of what the input is to configure.
     */
    private inputSection(input: ConfigurationInputData, onConfigure?: () => void): HTMLDetailsElement {
        const { id, name } = input;
        const section = document.createElement("details");
        section.className = style.inputSection;
        section.dataset["inputId"] = id;
        section.open = !this.collapsed.has(id);
        section.ontoggle = () => {
            if (section.open) this.collapsed.delete(id);
            else this.collapsed.add(id);
        };
        const summary = document.createElement("summary");
        const title = document.createElement("strong");
        title.textContent = input.kind === "variable" ? `${name} (#${name})` : name;
        const fallback = document.createElement("span");
        fallback.className = style.defaultValue;
        fallback.textContent = I18n.translate("configuration.default{0}", defaultOf(input));
        summary.append(title, fallback);
        if (onConfigure !== undefined) {
            const configure = document.createElement("button");
            configure.className = style.configureFeatures;
            configure.textContent = `+ ${I18n.translate("configuration.configureFeatures")}`;
            configure.setAttribute(
                "aria-label",
                `${I18n.translate("configuration.configureFeatures")}: ${name}`,
            );
            configure.onclick = (event) => {
                event.preventDefault();
                onConfigure();
            };
            summary.append(configure);
        }
        const edit = document.createElement("button");
        edit.className = style.more;
        edit.textContent = "⋯";
        edit.title = I18n.translate("configuration.editInput{0}", name);
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
        const section = this.inputSection(input);
        const controls = document.createElement("div");
        controls.className = style.toolbar;
        const value = activeInputControl(this.data, input, style.variableValue);
        value.setAttribute("aria-label", `${input.name} value`);
        const choose = document.createElement("select");
        choose.setAttribute("aria-label", `Use ${input.name} for parameter`);
        choose.append(
            makeOption({ textContent: I18n.translate("configuration.chooseDimension"), value: "" }),
        );
        const eligible = slots.filter(
            (s) => !s.boolean && !s.options && !s.text && unitSpecEquals(s.unit, unitSpecOfType(input.type)),
        );
        for (const slot of eligible)
            choose.append(makeOption({ textContent: `${slot.node.name} / ${slot.label}`, value: slot.id }));
        const use = document.createElement("button");
        use.textContent = I18n.translate("configuration.useVariable");
        use.onclick = () => {
            const slot = eligible.find((s) => s.id === choose.value);
            if (slot) this.apply(slot, input.name);
        };
        const label = document.createElement("label");
        label.textContent = `${input.type} `;
        label.append(value);
        controls.append(label, choose, use);
        const bounds = document.createElement("small");
        bounds.textContent = `${I18n.translate("configuration.default{0}", input.defaultExpression)}${input.min === undefined ? "" : ` · ${I18n.translate("configuration.min")}: ${input.min}`}${input.max === undefined ? "" : ` · ${I18n.translate("configuration.max")}: ${input.max}`}`;
        section.append(controls, bounds);
        const usages = usagesOf(this.doc, input.name, slots);
        if (usages.length) {
            // Onshape's "Usages": what reads the configuration variable.
            const table = document.createElement("table");
            table.className = style.table;
            const head = table.createTHead().insertRow();
            const th = document.createElement("th");
            th.textContent = `Usages ${usages.length}`;
            head.append(th);
            for (const usage of usages) table.insertRow().insertCell().textContent = usage;
            const scroll = document.createElement("div");
            scroll.className = style.scroll;
            scroll.append(table);
            section.append(scroll);
        }
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
            const variables = configuredVariables(this.doc, input.name);
            if (
                query &&
                !input.name.toLowerCase().includes(query) &&
                !configured.some((s) => `${s.node.name} ${s.label}`.toLowerCase().includes(query)) &&
                !variables.some((v) => v.name.toLowerCase().includes(query))
            )
                continue;
            const section = this.inputSection(input, () => {
                if (this.choosing.has(input.id)) this.choosing.delete(input.id);
                else this.choosing.add(input.id);
                this.render();
            });
            const toolbar = document.createElement("div");
            toolbar.className = style.toolbar;
            const choose = document.createElement("select");
            choose.setAttribute("aria-label", `Configure ${input.name} parameter`);
            choose.append(
                makeOption({ textContent: I18n.translate("configuration.chooseParameter"), value: "" }),
            );
            slots
                .filter((s) => !isConfiguredValue(s.value))
                .forEach((s) =>
                    choose.append(makeOption({ textContent: `${s.node.name} / ${s.label}`, value: s.id })),
                );
            const add = document.createElement("button");
            add.textContent = I18n.translate("configuration.configure");
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
                this.choosing.delete(input.id);
                this.render();
            };
            toolbar.append(choose, add);
            // The chooser shows while nothing is configured yet, or when asked for.
            toolbar.hidden = !(
                this.choosing.has(input.id) ||
                (configured.length === 0 && variables.length === 0)
            );
            const table = document.createElement("table");
            table.className = style.table;
            const head = table.createTHead().insertRow();
            const nameHeader = document.createElement("th");
            nameHeader.textContent = I18n.translate("configuration.name");
            head.append(nameHeader);
            for (const variable of variables) {
                const th = document.createElement("th");
                th.textContent = `#${variable.name}`;
                head.append(th);
            }
            for (const slot of configured) {
                const th = document.createElement("th");
                th.textContent = `${slot.node.name} / ${slot.label}`;
                const remove = document.createElement("button");
                remove.className = style.remove;
                remove.textContent = "×";
                remove.title = I18n.translate(
                    "configuration.stopConfiguring{0}",
                    `${slot.node.name} / ${slot.label}`,
                );
                remove.setAttribute("aria-label", remove.title);
                remove.onclick = () => {
                    const fresh = modelParameters(this.doc).find((s) => s.id === slot.id);
                    if (!fresh) return;
                    const selected = selectConfiguredArm(fresh.value, this.doc.variables.evaluate().scope);
                    if (!selected.isOk) {
                        this.status.textContent = selected.error;
                        return;
                    }
                    this.apply(fresh, String(selected.value));
                    this.render();
                };
                th.append(remove);
                head.append(th);
            }
            for (const option of selectorOptions(input)) {
                const row = table.insertRow();
                row.dataset["active"] = String(String(activeInputValue(input, this.data.active)) === option);
                const activate = document.createElement("button");
                activate.className = style.optionName;
                activate.textContent = option;
                activate.title = I18n.translate("configuration.activate");
                activate.onclick = () =>
                    this.data.setActive(input.name, input.kind === "checkbox" ? option === "true" : option);
                row.insertCell().append(activate);
                for (const variable of variables) {
                    const parsed = parseConfiguredValue(variable.expression);
                    if (!parsed.isOk) continue;
                    const source = parsed.value.arms.find((a) => a.option === option)?.value ?? "";
                    const field = document.createElement("input");
                    field.value = source;
                    field.setAttribute("aria-label", `${option}: #${variable.name}`);
                    field.onchange = () => {
                        const current = parseConfiguredValue(variable.expression);
                        if (!current.isOk) return;
                        const arms = current.value.arms.filter((a) => a.option !== option);
                        arms.push({ option, value: configuredArmSource(field.value) });
                        this.writing = true;
                        try {
                            variable.write(formatConfiguredValue({ ...current.value, arms }));
                        } finally {
                            this.writing = false;
                        }
                        this.render();
                    };
                    row.insertCell().append(field);
                }
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
            empty.textContent = I18n.translate("configuration.tableEmpty");
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
