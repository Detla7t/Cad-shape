// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ConfigurationInputData,
    type ConfigurationInputKind,
    type ConfigurationListInputData,
    type ConfigurationVariableInputData,
    defaultListOption,
    I18n,
    type I18nKeys,
    Localize,
    type VariableType,
} from "@chili3d/core";
import { button, div, input, option, select, span, svg } from "@chili3d/element";
import { activeInputControl } from "./activeControls";
import type { ConfigurationDataContent } from "./configurationDataContent";
import style from "./configurationEditor.module.css";

const KIND_LABELS: Record<ConfigurationInputKind, I18nKeys> = {
    list: "configuration.kind.list",
    checkbox: "configuration.kind.checkbox",
    variable: "configuration.kind.variable",
};

const ADD_BUTTONS: readonly { kind: ConfigurationInputKind; label: I18nKeys }[] = [
    { kind: "list", label: "configuration.addList" },
    { kind: "checkbox", label: "configuration.addCheckbox" },
    { kind: "variable", label: "configuration.addVariable" },
];

const TYPES: readonly { value: VariableType; label: I18nKeys }[] = [
    { value: "length", label: "variable.type.length" },
    { value: "angle", label: "variable.type.angle" },
    { value: "unitless", label: "variable.type.unitless" },
];

/** Four decimals, as the parameters table shows values. */
function formatValue(value: number): string {
    return String(Math.round(value * 1e4) / 1e4);
}

/**
 * The Configuration panel: the ACTIVE configuration on top — one control per input, so the
 * Part Studio can be switched between its configurations right here — and below it the
 * inputs themselves: lists with their options (and which one is the default), checkboxes,
 * configuration variables with their type, default and bounds.
 *
 * It follows the parameters table's editing rules (`VariablesEditor`): a field commits on the
 * way out, its own writes refresh only what they changed (rebuilding would take the focus out
 * of the box being typed in), and anything changed behind its back — undo, redo, another panel,
 * the configuration bar — re-renders.
 */
export class ConfigurationEditor extends HTMLElement {
    private readonly activeSection: HTMLElement;
    private readonly inputsSection: HTMLElement;
    /** Status line of each input card (its error or warning), by input id. */
    private readonly statusCells = new Map<string, HTMLElement>();
    private readonly cards = new Map<string, HTMLElement>();
    /** The resolved-value cell of each configuration variable in the active section, by id. */
    private readonly valueCells = new Map<string, HTMLElement>();
    private listening = false;

    constructor(private readonly content: ConfigurationDataContent) {
        super();
        this.className = style.root;
        this.activeSection = div({ className: style.activeList });
        this.inputsSection = div({ className: style.cards });
        this.append(
            div({ className: style.sectionTitle, textContent: new Localize("configuration.active") }),
            this.activeSection,
            div({ className: style.sectionTitle, textContent: new Localize("configuration.inputs") }),
            this.inputsSection,
            this.addBar(),
        );
        this.render();
        this.listen();
    }

    connectedCallback(): void {
        if (this.listening) return;
        this.listen();
        this.render();
    }

    disconnectedCallback(): void {
        this.dispose();
    }

    dispose(): void {
        this.listening = false;
        this.content.document.variables.removePropertyChanged(this.handleChanged);
    }

    private listen(): void {
        this.listening = true;
        this.content.document.variables.onPropertyChanged(this.handleChanged);
    }

    private readonly handleChanged = (property: string) => {
        if (property === "scope") {
            this.refreshStatus();
            return;
        }
        if (property === "configurationJson") {
            // The active section names the inputs and options, so it follows every input
            // write; the input cards only follow writes that were not this panel's own.
            if (!this.content.isWriting) this.renderInputs();
            this.renderActive();
            return;
        }
        if (property === "activeConfigurationJson" && !this.content.isWriting) this.renderActive();
    };

    render(): void {
        this.renderActive();
        this.renderInputs();
    }

    focusInput(id: string): void {
        const card = this.cards.get(id);
        card?.scrollIntoView?.({ block: "nearest" });
        card?.querySelector<HTMLInputElement>(`input.${style.nameBox}`)?.focus();
    }

    // ------------------------------------------------------------------ The active configuration

    private renderActive(): void {
        this.valueCells.clear();
        const inputs = this.content.inputs.filter((x) => x !== null && typeof x === "object");
        if (inputs.length === 0) {
            this.activeSection.replaceChildren(
                div({ className: style.empty, textContent: new Localize("configuration.empty") }),
            );
            return;
        }
        this.activeSection.replaceChildren(
            ...inputs.map((item) => {
                const value = span({ className: style.activeValue });
                if (item.kind === "variable") this.valueCells.set(item.id, value);
                return div(
                    { className: style.activeRow },
                    span({ className: style.activeName, textContent: item.name }),
                    activeInputControl(this.content, item, style.activeControl),
                    value,
                );
            }),
        );
        this.refreshStatus();
    }

    // ------------------------------------------------------------------ The inputs

    private renderInputs(): void {
        this.statusCells.clear();
        this.cards.clear();
        const inputs = this.content.inputs.filter((x) => x !== null && typeof x === "object");
        this.inputsSection.replaceChildren(
            ...inputs.map((item, index) => this.card(item, index, inputs.length)),
        );
        this.refreshStatus();
    }

    private card(item: ConfigurationInputData, index: number, count: number): HTMLElement {
        const status = div({ className: style.status });
        this.statusCells.set(item.id, status);
        const card = div(
            { className: style.card },
            div(
                { className: style.cardHead },
                span({ className: style.kind, textContent: new Localize(KIND_LABELS[item.kind]) }),
                this.textBox(item.name, "configuration.namePlaceholder", style.nameBox, (name) =>
                    this.content.renameInput(item.id, name),
                ),
                this.iconButton("icon-up", "variable.moveUp", index === 0, () => {
                    this.content.moveInput(item.id, -1);
                    this.renderInputs();
                }),
                this.iconButton("icon-down", "variable.moveDown", index === count - 1, () => {
                    this.content.moveInput(item.id, 1);
                    this.renderInputs();
                }),
                this.iconButton(
                    "icon-trash",
                    "configuration.deleteInput",
                    false,
                    () => {
                        this.content.removeInput(item.id);
                        this.renderInputs();
                    },
                    style.danger,
                ),
            ),
            this.cardBody(item),
            status,
        );
        this.cards.set(item.id, card);
        return card;
    }

    private cardBody(item: ConfigurationInputData): HTMLElement {
        if (item.kind === "list") return this.listBody(item);
        if (item.kind === "checkbox") {
            return div(
                { className: style.fieldRow },
                span({ className: style.fieldLabel, textContent: new Localize("configuration.default") }),
                input({
                    type: "checkbox",
                    checked: item.defaultValue === true,
                    onclick: (e: MouseEvent) =>
                        this.content.updateInput(item.id, {
                            defaultValue: (e.target as HTMLInputElement).checked,
                        }),
                }),
            );
        }
        return this.variableBody(item);
    }

    private listBody(item: ConfigurationListInputData): HTMLElement {
        const options = Array.isArray(item.options) ? item.options : [];
        const defaultId = defaultListOption(item)?.id;
        return div(
            { className: style.options },
            ...options.map((choice, index) =>
                div(
                    { className: style.optionRow },
                    input({
                        type: "radio",
                        className: style.radio,
                        name: `default-${item.id}`,
                        title: I18n.translate("configuration.default") ?? "",
                        checked: choice.id === defaultId,
                        onclick: () => this.content.setDefaultOption(item.id, choice.id),
                    }),
                    this.textBox(choice.name, "configuration.optionPlaceholder", style.optionName, (name) =>
                        this.content.renameOption(item.id, choice.id, name),
                    ),
                    this.iconButton("icon-up", "variable.moveUp", index === 0, () => {
                        this.content.moveOption(item.id, choice.id, -1);
                        this.renderInputs();
                    }),
                    this.iconButton("icon-down", "variable.moveDown", index === options.length - 1, () => {
                        this.content.moveOption(item.id, choice.id, 1);
                        this.renderInputs();
                    }),
                    this.iconButton(
                        "icon-trash",
                        "configuration.deleteOption",
                        false,
                        () => {
                            this.content.removeOption(item.id, choice.id);
                            this.renderInputs();
                        },
                        style.danger,
                    ),
                ),
            ),
            button({
                className: style.addOption,
                textContent: new Localize("configuration.addOption"),
                onclick: () => {
                    this.content.addOption(item.id);
                    this.renderInputs();
                },
            }),
        );
    }

    private variableBody(item: ConfigurationVariableInputData): HTMLElement {
        const types = select({
            className: style.field,
            onchange: (e: Event) =>
                this.content.updateInput(item.id, {
                    type: (e.target as HTMLSelectElement).value as VariableType,
                }),
        });
        for (const type of TYPES) {
            types.append(
                option({
                    value: type.value,
                    textContent: new Localize(type.label),
                    selected: type.value === item.type,
                }),
            );
        }
        const bound = (key: "min" | "max", label: I18nKeys) =>
            div(
                { className: style.field },
                span({ className: style.fieldLabel, textContent: new Localize(label) }),
                this.textBox(
                    item[key] === undefined ? "" : String(item[key]),
                    label,
                    style.boundBox,
                    (text) => {
                        const number = Number(text);
                        const value = text === "" || !Number.isFinite(number) ? undefined : number;
                        this.content.updateInput(item.id, { [key]: value });
                    },
                ),
            );
        return div(
            { className: style.fieldRow },
            types,
            div(
                { className: style.field },
                span({ className: style.fieldLabel, textContent: new Localize("configuration.default") }),
                this.textBox(
                    item.defaultExpression,
                    "variable.expressionPlaceholder",
                    style.expressionBox,
                    (text) => this.content.updateInput(item.id, { defaultExpression: text }),
                ),
            ),
            bound("min", "configuration.min"),
            bound("max", "configuration.max"),
        );
    }

    /** The add bar: one button per input kind. */
    private addBar(): HTMLElement {
        return div(
            { className: style.addBar },
            span({ className: style.fieldLabel, textContent: new Localize("configuration.add") }),
            ...ADD_BUTTONS.map(({ kind, label }) =>
                button({
                    className: style.addButton,
                    textContent: new Localize(label),
                    onclick: () => {
                        this.content.addInput(kind);
                        this.renderInputs();
                    },
                }),
            ),
        );
    }

    /** A text field committed on the way out (blur or Enter), never per keystroke. */
    private textBox(
        value: string,
        placeholder: I18nKeys,
        className: string,
        commit: (value: string) => void,
    ): HTMLInputElement {
        let committed = value;
        return input({
            className,
            value,
            placeholder: I18n.translate(placeholder) ?? "",
            spellcheck: false,
            onblur: (e: FocusEvent) => {
                const text = (e.target as HTMLInputElement).value.trim();
                if (text === committed) return;
                committed = text;
                commit(text);
            },
            onkeydown: (e: KeyboardEvent) => {
                e.stopPropagation();
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            },
        });
    }

    private iconButton(
        icon: string,
        title: I18nKeys,
        disabled: boolean,
        onclick: () => void,
        className = "",
    ): HTMLButtonElement {
        return button(
            {
                className: className === "" ? style.iconButton : `${style.iconButton} ${className}`,
                title: new Localize(title),
                disabled,
                onclick,
            },
            svg({ icon }),
        );
    }

    /** Errors and warnings on the cards, resolved values next to the configuration variables. */
    private refreshStatus(): void {
        const evaluated = this.content.evaluate();
        for (const item of this.content.inputs) {
            if (item === null || typeof item !== "object") continue;
            const error = evaluated.errors.get(item.id);
            const warning = evaluated.warnings.get(item.id);
            const status = this.statusCells.get(item.id);
            if (status !== undefined) status.textContent = error ?? warning ?? "";
            const card = this.cards.get(item.id);
            if (card !== undefined)
                card.className = error === undefined ? style.card : `${style.card} ${style.cardError}`;
            const cell = this.valueCells.get(item.id);
            if (cell !== undefined) {
                const value = evaluated.values.get(item.id)?.value;
                cell.textContent = error ?? (value === undefined ? "" : formatValue(value));
                cell.className =
                    error === undefined ? style.activeValue : `${style.activeValue} ${style.valueError}`;
            }
        }
    }
}

customElements.define("chili-configuration-editor", ConfigurationEditor);
