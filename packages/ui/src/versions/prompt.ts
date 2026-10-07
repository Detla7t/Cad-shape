// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "@chili3d/core";
import { div, input, label, textarea } from "@chili3d/element";
import { showDialog } from "../dialog";
import style from "./versions.module.css";

export interface PromptField {
    readonly label: I18nKeys;
    readonly multiline?: boolean;
    readonly value?: string;
}

/**
 * A small modal form (a version's name and description, a branch name). `onConfirm` gets the
 * values in field order; the dialog does not close while the first field is empty.
 */
export function promptFields(
    title: I18nKeys,
    fields: readonly PromptField[],
    onConfirm: (values: string[]) => void,
    hint?: string,
): void {
    const controls = fields.map((field) =>
        field.multiline
            ? textarea({ value: field.value ?? "" })
            : input({ type: "text", value: field.value ?? "", spellcheck: false }),
    );
    const form = div(
        { className: style.form },
        ...(hint === undefined ? [] : [div({ className: style.hint, textContent: hint })]),
        ...fields.map((field, index) =>
            label({ className: style.field }, I18n.translate(field.label), controls[index]),
        ),
    );
    showDialog(title, form, [
        {
            content: "common.confirm",
            shouldClose: () => controls[0].value.trim() !== "",
            onclick: () => {
                if (controls[0].value.trim() === "") return;
                onConfirm(controls.map((x) => x.value));
            },
        },
        { content: "common.cancel" },
    ]);
    setTimeout(() => controls[0]?.focus(), 0);
}
