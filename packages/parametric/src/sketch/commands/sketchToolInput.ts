// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { AsyncController, IView } from "@chili3d/core";
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
        for (const [label, value] of Object.entries(fields)) {
            const row = document.createElement("label"),
                input = document.createElement("input");
            row.textContent = label;
            input.type = typeof value === "number" ? "number" : "text";
            input.step = "any";
            input.required = true;
            input.value = String(value);
            input.setAttribute("aria-label", label);
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
            if (form.reportValidity())
                finish(Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])));
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
