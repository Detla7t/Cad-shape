// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ActiveConfigurationData,
    activeInputValue,
    type ConfigurationInputData,
    type ConfigurationInputKind,
    type ConfigurationListInputData,
    type EvaluatedVariables,
    type IDocument,
    Id,
    Transaction,
} from "@chili3d/core";

/** The prefix a new input of each kind is named after (`List1`, `Checkbox1`, …). */
const NAME_PREFIX: Record<ConfigurationInputKind, string> = {
    list: "List",
    checkbox: "Checkbox",
    variable: "Variable",
};

/** A name `prefix<n>` not taken by any of `taken`. */
function uniqueName(prefix: string, taken: readonly string[]): string {
    for (let n = 1; ; n++) {
        const name = `${prefix}${n}`;
        if (!taken.includes(name)) return name;
    }
}

/**
 * The Configuration panel's edit state, writing straight through to the document — the same
 * contract as the parameters panel (`VariablesDataContent`): no draft, one transaction (one
 * undo step) per input edit, and a row that does not resolve is stored as written and shows
 * its own error.
 *
 * Switching the ACTIVE configuration is different on purpose: it is not an edit of the
 * document but a view of it, so it runs outside any transaction and the table does not record
 * it (`IVariableTable.activeConfigurationJson`) — undo never flips configurations back.
 */
export class ConfigurationDataContent {
    private _writing = false;

    constructor(
        readonly document: IDocument,
        private readonly onApplied: () => void = () => document.visual.update(),
    ) {}

    /** True while one of this panel's own writes is in flight (see `VariablesDataContent.isWriting`). */
    get isWriting(): boolean {
        return this._writing;
    }

    get inputs(): readonly ConfigurationInputData[] {
        return this.document.variables.configurationInputs;
    }

    get active(): ActiveConfigurationData {
        return this.document.variables.activeConfiguration;
    }

    /** The document scope — each input's own value and error, by input id. */
    evaluate(): EvaluatedVariables {
        return this.document.variables.evaluate();
    }

    /** What `input` is set to in the active configuration (its default when unset). */
    activeValue(input: ConfigurationInputData): string | boolean | undefined {
        return activeInputValue(input, this.active);
    }

    // ------------------------------------------------------------------ The active configuration

    /** Switches one input of the active configuration: not recorded, but everything rebuilds. */
    setActive(name: string, value: string | boolean): void {
        if (this.active[name] === value) return;
        this._writing = true;
        try {
            this.document.variables.setActiveConfiguration({ ...this.active, [name]: value });
        } finally {
            this._writing = false;
        }
        this.onApplied();
    }

    // ------------------------------------------------------------------ The inputs

    /** Appends an input of `kind`, ready to use: a list starts with one option. Returns its id. */
    addInput(kind: ConfigurationInputKind): string {
        const id = Id.generate();
        const name = uniqueName(
            NAME_PREFIX[kind],
            this.inputs.map((x) => x.name),
        );
        let input: ConfigurationInputData;
        if (kind === "list") {
            const option = { id: Id.generate(), name: "Default" };
            input = { kind, id, name, options: [option], defaultOption: option.id };
        } else if (kind === "checkbox") {
            input = { kind, id, name, defaultValue: false };
        } else {
            input = { kind, id, name, type: "length", defaultExpression: "0" };
        }
        this.write([...this.inputs, input]);
        return id;
    }

    removeInput(id: string): void {
        this.write(this.inputs.filter((x) => x.id !== id));
    }

    /** Reorders an input; the order matters — a configuration variable may use the inputs above it. */
    moveInput(id: string, offset: -1 | 1): void {
        const index = this.inputs.findIndex((x) => x.id === id);
        const target = index + offset;
        if (index < 0 || target < 0 || target >= this.inputs.length) return;
        const next = [...this.inputs];
        [next[index], next[target]] = [next[target], next[index]];
        this.write(next);
    }

    /** Renames an input; the active choice follows it to the new name. */
    renameInput(id: string, name: string): void {
        const input = this.inputs.find((x) => x.id === id);
        if (input === undefined || input.name === name) return;
        let active: ActiveConfigurationData | undefined;
        if (Object.hasOwn(this.active, input.name)) {
            const { [input.name]: chosen, ...rest } = this.active;
            active = { ...rest, [name]: chosen };
        }
        this.write(
            this.inputs.map((x) => (x.id === id ? { ...x, name } : x)),
            active,
        );
    }

    /** Merges `patch` into one input (a checkbox's default, a variable's type, bounds or default). */
    updateInput(id: string, patch: Partial<ConfigurationInputData>): void {
        this.write(
            this.inputs.map((x) => (x.id === id ? ({ ...x, ...patch } as ConfigurationInputData) : x)),
        );
    }

    // ------------------------------------------------------------------ A list's options

    /** Appends an option to a list input. Returns its id. */
    addOption(inputId: string): string | undefined {
        const input = this.list(inputId);
        if (input === undefined) return undefined;
        const option = {
            id: Id.generate(),
            name: uniqueName(
                "Option",
                input.options.map((x) => x.name),
            ),
        };
        this.updateList(inputId, { options: [...input.options, option] });
        return option.id;
    }

    /** Renames an option; when it is the active one, the active choice follows. */
    renameOption(inputId: string, optionId: string, name: string): void {
        const input = this.list(inputId);
        const option = input?.options.find((x) => x.id === optionId);
        if (input === undefined || option === undefined || option.name === name) return;
        const active =
            this.active[input.name] === option.name ? { ...this.active, [input.name]: name } : undefined;
        this.write(
            this.inputs.map((x) =>
                x.id === inputId && x.kind === "list"
                    ? { ...x, options: x.options.map((o) => (o.id === optionId ? { ...o, name } : o)) }
                    : x,
            ),
            active,
        );
    }

    removeOption(inputId: string, optionId: string): void {
        const input = this.list(inputId);
        if (input === undefined) return;
        this.updateList(inputId, { options: input.options.filter((x) => x.id !== optionId) });
    }

    moveOption(inputId: string, optionId: string, offset: -1 | 1): void {
        const input = this.list(inputId);
        if (input === undefined) return;
        const index = input.options.findIndex((x) => x.id === optionId);
        const target = index + offset;
        if (index < 0 || target < 0 || target >= input.options.length) return;
        const options = [...input.options];
        [options[index], options[target]] = [options[target], options[index]];
        this.updateList(inputId, { options });
    }

    setDefaultOption(inputId: string, optionId: string): void {
        this.updateList(inputId, { defaultOption: optionId });
    }

    private list(id: string): ConfigurationListInputData | undefined {
        const input = this.inputs.find((x) => x.id === id);
        return input?.kind === "list" ? input : undefined;
    }

    private updateList(id: string, patch: Partial<ConfigurationListInputData>): void {
        this.write(this.inputs.map((x) => (x.id === id && x.kind === "list" ? { ...x, ...patch } : x)));
    }

    /** One write, one transaction, one undo step (`active` rides along unrecorded). */
    private write(inputs: readonly ConfigurationInputData[], active?: ActiveConfigurationData): void {
        this._writing = true;
        try {
            Transaction.execute(this.document, "edit configuration", () => {
                this.document.variables.setConfigurationInputs(inputs, active);
            });
        } finally {
            this._writing = false;
        }
        this.onApplied();
    }
}
