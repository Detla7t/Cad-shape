// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    type AsyncController,
    documentParameterInput,
    documentUnit,
    formatDocumentValue,
    type IView,
    LENGTH_UNITS,
    resolveUnitSpec,
    type UnitSpec,
} from "@chili3d/core";
import style from "../editor/sketchPanel.module.css";
export function sketchToolInput(
    view: IView,
    title: string,
    fields: Record<string, string | number>,
    controller?: AsyncController,
): Promise<Record<string, string> | undefined> {
    return new Promise((resolve) => {
        const form = document.createElement("form");
        form.className = style.panel;
        form.setAttribute("aria-label", title);
        form.style.zIndex = "1200";
        const h = document.createElement("header"),
            name = document.createElement("strong");
        name.textContent = title;
        const yes = document.createElement("button"),
            no = document.createElement("button");
        yes.type = "submit";
        yes.textContent = "✓";
        yes.className = style.finish;
        yes.setAttribute("aria-label", `Apply ${title}`);
        no.type = "button";
        no.textContent = "×";
        no.className = style.cancel;
        no.setAttribute("aria-label", `Cancel ${title}`);
        h.append(name, yes, no);
        form.append(h);
        const inputs: Record<string, HTMLInputElement> = {};
        const units = new Map<string, UnitSpec>();
        for (const [label, value] of Object.entries(fields)) {
            const row = document.createElement("label"),
                input = document.createElement("input");
            const unit = label.endsWith("(mm)")
                ? LENGTH_UNITS
                : label.endsWith("(deg)")
                  ? ANGLE_UNITS
                  : undefined;
            const displayLabel = unit
                ? label.replace(/\([^)]*\)$/, `(${documentUnit(view.document, unit).suffix})`)
                : label;
            if (unit) units.set(label, unit);
            row.textContent = displayLabel;
            input.type = unit || typeof value !== "number" ? "text" : "number";
            input.step = "any";
            input.required = true;
            input.value = unit
                ? formatDocumentValue(Number(value), view.document, unit, false)
                : String(value);
            input.setAttribute("aria-label", displayLabel);
            input.oninput = () => input.setCustomValidity("");
            inputs[label] = input;
            row.style.padding = "6px 10px";
            input.style.width = "110px";
            row.append(input);
            form.append(row);
        }
        let done = false;
        const finish = (result?: Record<string, string>) => {
            if (done) return;
            done = true;
            form.remove();
            resolve(result);
        };
        no.onclick = () => finish();
        form.onsubmit = (e) => {
            e.preventDefault();
            const values: Record<string, string> = {};
            for (const [key, input] of Object.entries(inputs)) {
                const unit = units.get(key);
                if (!unit) {
                    values[key] = input.value;
                    continue;
                }
                const scope = view.document.variables.evaluate().scope,
                    parsed = documentParameterInput(input.value, view.document, unit, scope),
                    result = parsed.isOk ? resolveUnitSpec(parsed.value, scope, unit) : parsed;
                if (!result.isOk) {
                    input.setCustomValidity(result.error);
                    input.reportValidity();
                    return;
                }
                values[key] = String(result.value);
            }
            if (form.reportValidity()) finish(values);
        };
        for (const event of ["pointerdown", "pointermove", "wheel"])
            form.addEventListener(event, (e) => e.stopPropagation());
        form.onkeydown = (e) => {
            e.stopPropagation();
            if (e.key === "Escape") finish();
        };
        controller?.onCancelled(() => finish());
        view.dom?.append(form);
        Object.values(inputs)[0]?.focus();
        Object.values(inputs)[0]?.select();
    });
}
