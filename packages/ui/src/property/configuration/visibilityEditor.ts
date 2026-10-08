// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    activeInputValue,
    type ConfigurationInputData,
    type ConfigurationVisibility,
    type ConfigurationVisibilityCondition,
    configurationVisible,
    type IDocument,
    Transaction,
} from "@chili3d/core";
import { activeInputControl } from "./activeControls";
import style from "./visibilityEditor.module.css";

function selectControl(
    label: string,
    options: [string, string][],
    value: string,
    change: (value: string) => void,
) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    for (const [id, text] of options) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = text;
        select.append(option);
    }
    select.value = value;
    select.onchange = () => change(select.value);
    return select;
}
function button(label: string, action: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = action;
    return button;
}

/** Draft-only editor: experimenting with preview inputs never rebuilds or edits the model. */
export function showConfigurationVisibility(model: IDocument): HTMLDialogElement {
    let inputs = structuredClone(model.variables.configurationInputs) as ConfigurationInputData[];
    let active = { ...model.variables.activeConfiguration };
    let showHidden = true;
    let filter = "all";
    const original = model.variables.configurationJson;
    const dialog = document.createElement("dialog");
    dialog.className = style.dialog;
    dialog.setAttribute("aria-label", "Configuration visibility conditions");
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "Configuration visibility conditions";
    const close = () => {
        dialog.close();
        dialog.remove();
    };
    header.append(
        title,
        selectControl(
            "Filter inputs",
            [
                ["all", "All inputs"],
                ["conditional", "Inputs with conditions"],
            ],
            filter,
            (value) => {
                filter = value;
                renderRules();
            },
        ),
        button("×", close),
    );
    const body = document.createElement("div");
    body.className = style.body;
    const rules = document.createElement("div");
    rules.className = style.rules;
    const preview = document.createElement("aside");
    preview.className = style.preview;
    body.append(rules, preview);
    const footer = document.createElement("footer");
    const error = document.createElement("span");
    error.setAttribute("role", "alert");
    const save = button("Save", () => {
        if (model.variables.configurationJson !== original) {
            error.textContent = "Configuration inputs changed. Reopen this editor to use the latest inputs.";
            return;
        }
        Transaction.execute(model, "modify configuration visibility conditions", () =>
            model.variables.setConfigurationInputs(inputs),
        );
        close();
    });
    footer.append(error, save, button("Cancel", close));
    dialog.append(header, body, footer);
    dialog.onkeydown = (e) => e.stopPropagation();
    dialog.oncancel = (e) => {
        e.preventDefault();
        close();
    };
    const patch = (id: string, values: Partial<ConfigurationInputData>) => {
        inputs = inputs.map((input) =>
            input.id === id ? ({ ...input, ...values } as ConfigurationInputData) : input,
        );
        renderPreview();
    };
    function renderPreview() {
        preview.replaceChildren();
        const heading = document.createElement("strong");
        heading.textContent = "Configurations";
        preview.append(heading);
        const content = {
            inputs,
            active,
            activeValue: (input: ConfigurationInputData) => activeInputValue(input, active),
            setActive: (name: string, value: string | boolean) => {
                active = { ...active, [name]: value };
                renderPreview();
            },
        };
        for (const input of inputs) {
            const visible = configurationVisible(input.visibility, inputs, active);
            if (!visible && !showHidden) continue;
            const row = document.createElement("label");
            row.dataset["visible"] = String(visible);
            const name = document.createElement("span");
            name.textContent = input.name + (visible ? "" : " (hidden)");
            row.append(name, activeInputControl(content, input, style.control));
            if (
                input.kind === "variable" &&
                (input.min !== undefined || input.max !== undefined) &&
                configurationVisible(input.rangeVisibility, inputs, active)
            ) {
                const range = document.createElement("small");
                range.textContent = `Range: ${input.min ?? "−∞"} – ${input.max ?? "∞"}`;
                row.append(range);
            }
            preview.append(row);
        }
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = showHidden;
        checkbox.onchange = () => {
            showHidden = checkbox.checked;
            renderPreview();
        };
        label.append(checkbox, "Show hidden inputs");
        preview.append(label);
        validate();
    }
    function validate() {
        const invalid = inputs.some((input) =>
            [
                input.visibility,
                input.rangeVisibility,
                ...(input.kind === "list" ? input.options.map((option) => option.visibility) : []),
            ].some((rule) =>
                rule?.conditions.some(
                    (condition) =>
                        !inputs.some((source) => source.id === condition.inputId) ||
                        !condition.values.length ||
                        condition.values.some((value) => typeof value === "string" && !value.trim()),
                ),
            ),
        );
        save.disabled = invalid;
        error.textContent = invalid ? "Complete each condition before saving." : "";
    }
    function ruleEditor(
        input: ConfigurationInputData,
        label: string,
        rule: ConfigurationVisibility | undefined,
        write: (rule: ConfigurationVisibility | undefined) => void,
    ) {
        const block = document.createElement("section");
        block.className = style.rule;
        const heading = document.createElement("div");
        heading.textContent = `Show ${label}`;
        block.append(heading);
        const conditions = [...(rule?.conditions ?? [])];
        const update = (next: ConfigurationVisibilityCondition[], match = rule?.match ?? "all") => {
            write(next.length ? { match, conditions: next } : undefined);
            renderRules();
            renderPreview();
        };
        if (conditions.length > 1)
            block.append(
                selectControl(
                    `Match conditions for ${label}`,
                    [
                        ["all", "All conditions"],
                        ["any", "Any condition"],
                    ],
                    rule?.match ?? "all",
                    (value) => update(conditions, value as "all" | "any"),
                ),
            );
        conditions.forEach((condition, index) => {
            const row = document.createElement("div");
            row.className = style.condition;
            const source = inputs.find((item) => item.id === condition.inputId);
            const change = (value: Partial<ConfigurationVisibilityCondition>) =>
                update(conditions.map((item, i) => (i === index ? { ...item, ...value } : item)));
            row.append(
                "When",
                selectControl(
                    `Condition input for ${label}`,
                    inputs.filter((item) => item.id !== input.id).map((item) => [item.id, item.name]),
                    condition.inputId,
                    (id) => change({ inputId: id, values: [], operator: "is" }),
                ),
                selectControl(
                    `Condition operator for ${label}`,
                    [
                        ["is", "is"],
                        ["isNot", "is not"],
                        ...(source?.kind === "variable"
                            ? ([
                                  ["lt", "less than"],
                                  ["lte", "at most"],
                                  ["gt", "greater than"],
                                  ["gte", "at least"],
                              ] as [string, string][])
                            : []),
                    ],
                    condition.operator,
                    (value) => change({ operator: value as ConfigurationVisibilityCondition["operator"] }),
                ),
            );
            if (source?.kind === "variable") {
                const value = document.createElement("input");
                value.placeholder = "Value or expression";
                value.setAttribute("aria-label", `Condition value for ${label}`);
                value.value = String(condition.values[0] ?? "");
                value.onchange = () => change({ values: [value.value] });
                row.append(value);
            } else if (source) {
                const choices: [string | boolean, string][] =
                    source.kind === "checkbox"
                        ? [
                              [true, "Checked"],
                              [false, "Unchecked"],
                          ]
                        : source.options.map((option) => [option.id, option.name]);
                const menu = document.createElement("details");
                const summary = document.createElement("summary");
                summary.textContent =
                    choices
                        .filter(([id]) => condition.values.includes(id))
                        .map(([, name]) => name)
                        .join(", ") || "Select condition";
                menu.append(summary);
                const all = document.createElement("label");
                const allCheck = document.createElement("input");
                allCheck.type = "checkbox";
                allCheck.checked = choices.every(([id]) => condition.values.includes(id));
                allCheck.onchange = () =>
                    change({ values: allCheck.checked ? choices.map(([id]) => id) : [] });
                all.append(allCheck, "Select all");
                menu.append(all);
                for (const [id, name] of choices) {
                    const option = document.createElement("label");
                    const check = document.createElement("input");
                    check.type = "checkbox";
                    check.checked = condition.values.includes(id);
                    check.onchange = () =>
                        change({
                            values: check.checked
                                ? [...condition.values, id]
                                : condition.values.filter((value) => value !== id),
                        });
                    option.append(check, name);
                    menu.append(option);
                }
                row.append(menu);
            }
            row.append(button("Remove condition", () => update(conditions.filter((_, i) => i !== index))));
            block.append(row);
        });
        const add = button("＋ Add condition", () => {
            const source = inputs.find((item) => item.id !== input.id);
            if (source) update([...conditions, { inputId: source.id, operator: "is", values: [] }]);
        });
        add.disabled = inputs.length < 2;
        block.append(add);
        return block;
    }
    function renderRules() {
        rules.replaceChildren();
        for (const input of inputs) {
            if (
                filter === "conditional" &&
                !input.visibility &&
                !input.rangeVisibility &&
                !(input.kind === "list" && input.options.some((option) => option.visibility))
            )
                continue;
            const section = document.createElement("details");
            section.open = true;
            const summary = document.createElement("summary");
            summary.textContent = input.name;
            section.append(
                summary,
                ruleEditor(input, input.name, input.visibility, (visibility) =>
                    patch(input.id, { visibility }),
                ),
            );
            if (input.kind === "list")
                for (const option of input.options)
                    section.append(
                        ruleEditor(input, `option “${option.name}”`, option.visibility, (visibility) =>
                            patch(input.id, {
                                options: input.options.map((item) =>
                                    item.id === option.id ? { ...item, visibility } : item,
                                ),
                            }),
                        ),
                    );
            if (input.kind === "variable" && (input.min !== undefined || input.max !== undefined))
                section.append(
                    ruleEditor(input, "range", input.rangeVisibility, (rangeVisibility) =>
                        patch(input.id, { rangeVisibility }),
                    ),
                );
            rules.append(section);
        }
        if (!inputs.length)
            rules.textContent = "Add configuration inputs before setting visibility conditions.";
    }
    renderRules();
    renderPreview();
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
}
