// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "@chili3d/core";
import { button, div, input, label, option, select, span, svg } from "@chili3d/element";
import type { CamParameterSpec } from "../model/operation";
import style from "./camStudio.module.css";

/**
 * Small DOM builders for the CAM Studio panels: labelled rows, inputs that commit on
 * `change` (Enter or leaving the field — one undo step per committed value), icon buttons.
 * Every input carries a `data-field` key so a re-render can give the focus back.
 */

export const t = (key: I18nKeys, ...args: unknown[]) => I18n.translate(key, ...args);

export function row(text: string, control: HTMLElement, unit?: string): HTMLElement {
    return label(
        { className: style.row },
        span({ className: style.rowLabel, textContent: text }),
        div(
            { className: style.rowControl },
            control,
            ...(unit ? [span({ className: style.unit, textContent: unit })] : []),
        ),
    );
}

export function section(title: string, ...children: HTMLElement[]): HTMLElement {
    return div(
        { className: style.section },
        div({ className: style.sectionTitle, textContent: title }),
        ...children,
    );
}

export function textField(field: string, value: string, commit: (value: string) => void): HTMLInputElement {
    const element = input({ className: style.input, type: "text", value });
    element.dataset["field"] = field;
    element.addEventListener("change", () => commit(element.value));
    return element;
}

export interface NumberFieldOptions {
    readonly integer?: boolean;
    readonly min?: number;
    readonly max?: number;
    /** Empty input commits `undefined` instead of being refused. */
    readonly optional?: boolean;
}

export function formatValue(value: number): string {
    return String(Number(value.toFixed(6)));
}

export function numberField(
    field: string,
    value: number | undefined,
    commit: (value: number | undefined) => void,
    options: NumberFieldOptions = {},
): HTMLInputElement {
    const element = input({
        className: style.input,
        type: "number",
        step: options.integer ? "1" : "any",
        value: value === undefined ? "" : formatValue(value),
    });
    element.dataset["field"] = field;
    element.addEventListener("change", () => {
        const text = element.value.trim();
        if (text === "" && options.optional) {
            commit(undefined);
            return;
        }
        let parsed = Number(text);
        if (text === "" || !Number.isFinite(parsed)) {
            element.value = value === undefined ? "" : formatValue(value);
            return;
        }
        if (options.integer) parsed = Math.round(parsed);
        if (options.min !== undefined) parsed = Math.max(options.min, parsed);
        if (options.max !== undefined) parsed = Math.min(options.max, parsed);
        commit(parsed);
    });
    return element;
}

export function checkField(
    field: string,
    value: boolean,
    commit: (value: boolean) => void,
): HTMLInputElement {
    const element = input({ className: style.check, type: "checkbox" });
    element.checked = value;
    element.dataset["field"] = field;
    element.addEventListener("change", () => commit(element.checked));
    return element;
}

export interface Choice {
    readonly value: string;
    readonly label: string;
    readonly group?: string;
}

export function selectField(
    field: string,
    choices: readonly Choice[],
    value: string | undefined,
    commit: (value: string) => void,
    placeholder?: string,
): HTMLSelectElement {
    const element = select({ className: style.select });
    element.dataset["field"] = field;
    if (placeholder !== undefined) {
        const first = option({ value: "", textContent: placeholder });
        first.disabled = value !== "" && value !== undefined;
        element.append(first);
    }
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const choice of choices) {
        const item = option({ value: choice.value, textContent: choice.label });
        if (choice.group === undefined) {
            element.append(item);
            continue;
        }
        let group = groups.get(choice.group);
        if (group === undefined) {
            group = document.createElement("optgroup");
            group.label = choice.group;
            groups.set(choice.group, group);
            element.append(group);
        }
        group.append(item);
    }
    element.value = value ?? "";
    element.addEventListener("change", () => commit(element.value));
    return element;
}

export function textButton(
    text: string,
    onclick: () => void,
    primary = false,
    action?: string,
): HTMLButtonElement {
    const element = button({
        className: primary ? `${style.button} ${style.primary}` : style.button,
        textContent: text,
    });
    element.type = "button";
    if (action) element.dataset["action"] = action;
    element.addEventListener("click", (event) => {
        event.stopPropagation();
        onclick();
    });
    return element;
}

export function iconButton(
    icon: string,
    title: string,
    onclick: () => void,
    action?: string,
): HTMLButtonElement {
    const element = button({ className: style.iconButton, title }, svg({ className: style.icon, icon }));
    element.type = "button";
    if (action) element.dataset["action"] = action;
    element.addEventListener("click", (event) => {
        event.stopPropagation();
        onclick();
    });
    return element;
}

/** Three numbers in one row (a point or a vector). */
export function vectorField(
    field: string,
    value: readonly [number, number, number],
    commit: (value: [number, number, number]) => void,
): HTMLElement {
    const inputs = [0, 1, 2].map((i) =>
        numberField(`${field}.${i}`, value[i], (v) => {
            const next: [number, number, number] = [value[0], value[1], value[2]];
            next[i] = v ?? 0;
            commit(next);
        }),
    );
    return div({ className: style.vector }, ...inputs);
}

const UNITS: Partial<Record<CamParameterSpec["kind"], string>> = { length: "mm", angle: "°" };

/** A parameter row from a handler's spec; undefined when its `visibleWhen` hides it. */
export function parameterRow(
    spec: CamParameterSpec,
    values: Readonly<Record<string, unknown>>,
    commit: (key: string, value: unknown) => void,
    prefix = "param",
): HTMLElement | undefined {
    if (spec.visibleWhen !== undefined && !spec.visibleWhen.values.includes(values[spec.visibleWhen.key])) {
        return undefined;
    }
    const value = values[spec.key];
    const field = `${prefix}.${spec.key}`;
    let control: HTMLElement;
    switch (spec.kind) {
        case "boolean":
            control = checkField(field, value === true, (v) => commit(spec.key, v));
            break;
        case "enum":
            control = selectField(
                field,
                (spec.options ?? []).map((x) => ({ value: x.value, label: x.label })),
                typeof value === "string" ? value : undefined,
                (v) => commit(spec.key, v),
            );
            break;
        case "string":
            control = textField(field, typeof value === "string" ? value : "", (v) => commit(spec.key, v));
            break;
        default:
            control = numberField(
                field,
                typeof value === "number" ? value : undefined,
                (v) => commit(spec.key, v),
                {
                    integer: spec.kind === "integer",
                    min: spec.min,
                    max: spec.max,
                    optional: true,
                },
            );
    }
    const element = row(spec.label, control, UNITS[spec.kind]);
    if (spec.description) element.title = spec.description;
    return element;
}

/** Remembers the focused field of `root` and gives it back after `render`. */
export function keepFocus(root: HTMLElement, render: () => void): void {
    const active = root.ownerDocument.activeElement as HTMLElement | null;
    const field = active && root.contains(active) ? active.dataset["field"] : undefined;
    render();
    if (field === undefined) return;
    const next = root.querySelector<HTMLElement>(`[data-field="${field.replace(/["\\]/g, "\\$&")}"]`);
    next?.focus();
}
