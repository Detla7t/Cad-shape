// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ConfigurationCheckboxInputData,
    type ConfigurationListInputData,
    type ConfiguredValue,
    configuredArmSource,
    type DialogButton,
    type FeatureParameterOption,
    formatConfiguredValue,
    type IDocument,
    isConfiguredValue,
    isSelectorInput,
    Localize,
    type ParameterValue,
    PubSub,
    parseConfiguredValue,
    quoteConfiguredString,
    selectConfiguredArm,
    selectorOptions,
} from "@chili3d/core";
import { div, input, option, select, span } from "@chili3d/element";
import { showDialog } from "../../dialog";
import style from "./configureGrid.module.css";

/** How each arm of the grid is edited: an expression box, a checkbox, a dropdown, free text. */
export type ConfigureGridKind = "expression" | "boolean" | "options" | "text";

export interface ConfigureGridTarget {
    readonly kind: ConfigureGridKind;
    /** What the slot stores now: a plain value, or a `configure(…)` to edit. */
    readonly stored: number | string | boolean;
    /** The choices of an `options` slot. */
    readonly options?: readonly FeatureParameterOption[];
}

/** An arm value as the grid shows it: the source of an expression, the text of a literal. */
export function armDisplay(kind: ConfigureGridKind, source: string): string | boolean {
    const trimmed = source.trim();
    if (kind === "expression") return trimmed;
    const literal = /^"(?:[^"\\]|\\.)*"$/.test(trimmed)
        ? trimmed.slice(1, -1).replace(/\\(.)/g, "$1")
        : trimmed;
    if (kind === "boolean") return literal === "true" || literal === "1";
    return literal;
}

/**
 * The Configure grid: which list or checkbox input the slot switches on, and the value it takes
 * for each of that input's options. `value()` is the `configure(…)` to store — written through
 * the slot's ordinary apply path, so configuring a parameter is one transaction like any edit.
 */
export class ConfigureGrid extends HTMLElement {
    private readonly inputSelect: HTMLSelectElement;
    private readonly rows: HTMLElement;
    /** The arm editors of the current input, by option name. */
    private readonly editors = new Map<string, HTMLInputElement | HTMLSelectElement>();
    /** What each option was set to, kept across a switch of input. */
    private readonly drafts = new Map<string, string | boolean>();
    /** What an option without a draft starts at: the slot's value in the active configuration. */
    private readonly fallback: string | boolean;
    private readonly initial: ConfiguredValue | undefined;

    constructor(
        readonly document: IDocument,
        readonly target: ConfigureGridTarget,
    ) {
        super();
        this.className = style.root;
        const scope = document.variables.evaluate().scope;
        const parsed = isConfiguredValue(target.stored) ? parseConfiguredValue(target.stored) : undefined;
        this.initial = parsed?.isOk ? parsed.value : undefined;
        for (const arm of this.initial?.arms ?? [])
            this.drafts.set(arm.option, armDisplay(target.kind, arm.value));
        const selected = selectConfiguredArm(
            typeof target.stored === "boolean" ? String(target.stored) : target.stored,
            scope,
        );
        this.fallback = this.displayOf(selected.isOk ? selected.value : "");

        const selectors = this.selectors();
        this.inputSelect = select(
            { className: style.inputSelect, onchange: () => this.renderRows() },
            ...selectors.map((x) =>
                option({ value: x.name, textContent: x.name, selected: x.name === this.initial?.input }),
            ),
        );
        if (this.initial !== undefined && selectors.some((x) => x.name === this.initial?.input)) {
            this.inputSelect.value = this.initial.input;
        }
        this.rows = div({ className: style.rows });
        if (selectors.length === 0) {
            this.append(
                div({ className: style.empty, textContent: new Localize("configuration.noSelectors") }),
            );
        } else {
            this.append(
                div(
                    { className: style.inputRow },
                    span({ className: style.label, textContent: new Localize("configuration.input") }),
                    this.inputSelect,
                ),
                div(
                    { className: style.header },
                    span({ textContent: new Localize("configuration.option") }),
                    span({ textContent: new Localize("configuration.value") }),
                ),
                this.rows,
            );
        }
        this.renderRows();
    }

    /** True when the slot already holds a configured value. */
    get configured(): boolean {
        return this.initial !== undefined;
    }

    /** The list and checkbox inputs a value can switch on. */
    private selectors(): (ConfigurationListInputData | ConfigurationCheckboxInputData)[] {
        return this.document.variables.configurationInputs.filter(
            (x): x is ConfigurationListInputData | ConfigurationCheckboxInputData =>
                x !== null && typeof x === "object" && isSelectorInput(x),
        );
    }

    /** The input the grid configures over. */
    get inputName(): string | undefined {
        return this.selectors().length === 0 ? undefined : this.inputSelect.value || this.selectors()[0].name;
    }

    private displayOf(value: ParameterValue | boolean): string | boolean {
        if (this.target.kind === "boolean") return value === true || value === "true" || value === 1;
        return String(value);
    }

    private renderRows(): void {
        this.keepDrafts();
        this.editors.clear();
        const name = this.inputName;
        const selector = this.selectors().find((x) => x.name === name);
        if (selector === undefined) {
            this.rows.replaceChildren();
            return;
        }
        this.rows.replaceChildren(
            ...selectorOptions(selector).map((choice) => {
                const editor = this.editor(this.drafts.get(choice) ?? this.fallback);
                this.editors.set(choice, editor);
                return div(
                    { className: style.row },
                    span({ className: style.option, textContent: choice }),
                    editor,
                );
            }),
        );
    }

    private keepDrafts(): void {
        for (const [choice, editor] of this.editors) this.drafts.set(choice, this.editorValue(editor));
    }

    private editor(value: string | boolean): HTMLInputElement | HTMLSelectElement {
        if (this.target.kind === "boolean") return input({ type: "checkbox", checked: value === true });
        if (this.target.kind === "options") {
            const box = select(
                { className: style.field },
                ...(this.target.options ?? []).map((choice) =>
                    option({
                        value: choice.value,
                        textContent: choice.label,
                        selected: choice.value === value,
                    }),
                ),
            );
            box.value = String(value);
            return box;
        }
        return input({ className: style.field, value: String(value), spellcheck: false });
    }

    private editorValue(editor: HTMLInputElement | HTMLSelectElement): string | boolean {
        if (this.target.kind === "boolean") return (editor as HTMLInputElement).checked;
        return editor.value;
    }

    /** The arm source of one option's editor; undefined for an expression left empty. */
    private armSource(value: string | boolean): string | undefined {
        switch (this.target.kind) {
            case "boolean":
                return configuredArmSource(value === true);
            case "expression": {
                const text = String(value).trim();
                return text === "" ? undefined : configuredArmSource(text);
            }
            default:
                return quoteConfiguredString(String(value));
        }
    }

    /** The `configure(…)` the grid describes, or undefined when there is no input to configure over. */
    value(): string | undefined {
        const name = this.inputName;
        if (name === undefined) return undefined;
        const arms = [...this.editors].flatMap(([choice, editor]) => {
            const source = this.armSource(this.editorValue(editor));
            return source === undefined ? [] : [{ option: choice, value: source }];
        });
        return formatConfiguredValue({ input: name, arms });
    }

    /** The plain value the slot keeps when its configuration is removed: the active one. */
    plainValue(): number | string | boolean {
        const fallback = this.fallback;
        if (this.target.kind === "expression" && typeof fallback === "string") {
            const number = Number(fallback);
            return fallback.trim() !== "" && Number.isFinite(number) ? number : fallback;
        }
        return fallback;
    }
}

customElements.define("chili-configure-grid", ConfigureGrid);

/**
 * Opens the Configure grid for one slot. `apply` receives what to store — the `configure(…)`
 * on confirm, or the active configuration's plain value on "Remove configuration".
 */
export function showConfigureGrid(
    document: IDocument,
    target: ConfigureGridTarget,
    apply: (value: number | string | boolean) => void,
): ConfigureGrid {
    const grid = new ConfigureGrid(document, target);
    const buttons: DialogButton[] = [];
    if (grid.inputName === undefined) {
        buttons.push({
            content: "command.configuration.edit",
            onclick: () => PubSub.default.pub("editConfiguration", document),
        });
    } else {
        buttons.push({
            content: "common.confirm",
            onclick: () => {
                const value = grid.value();
                if (value !== undefined) apply(value);
            },
        });
        if (grid.configured) {
            buttons.push({ content: "configuration.unconfigure", onclick: () => apply(grid.plainValue()) });
        }
    }
    buttons.push({ content: "common.cancel" });
    showDialog("configuration.configureTitle", grid, buttons);
    return grid;
}
