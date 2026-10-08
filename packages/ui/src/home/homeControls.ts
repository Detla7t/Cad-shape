// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createCadIcon } from "@chili3d/element";
import style from "./home.module.css";

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text = "",
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    element.className = className;
    if (text) element.textContent = text;
    return element;
}
export function button(text: string, run: () => void, className = "", icon?: string): HTMLButtonElement {
    const result = el("button", className);
    result.type = "button";
    if (icon) result.append(createCadIcon(icon));
    result.append(el("span", "", text));
    result.onclick = run;
    return result;
}
export function iconButton(name: string, icon: string, run: () => void): HTMLButtonElement {
    const result = button("", run, style.iconButton, icon);
    result.title = name;
    result.setAttribute("aria-label", name);
    return result;
}
export function homeForm(title: string) {
    const dialog = el("dialog", style.dialog);
    const form = el("form");
    const heading = el("h2", "", title);
    const content = el("div", style.formContent);
    const error = el("p", style.formError);
    error.setAttribute("role", "alert");
    const footer = el("footer", style.formFooter);
    footer.append(button("Cancel", () => dialog.close(), style.secondary));
    form.append(heading, content, error, footer);
    dialog.append(form);
    dialog.setAttribute("aria-label", title);
    dialog.onclose = () => dialog.remove();
    dialog.onkeydown = (event) => event.stopPropagation();
    document.body.append(dialog);
    dialog.showModal();
    form.onsubmit = (event) => event.preventDefault();
    const action = (name: string, run: () => Promise<void>, close = true) => {
        const control = button(
            name,
            async () => {
                control.disabled = true;
                error.textContent = "";
                try {
                    await run();
                    if (close) dialog.close();
                } catch (cause) {
                    error.textContent = cause instanceof Error ? cause.message : String(cause);
                } finally {
                    control.disabled = false;
                }
            },
            style.primary,
        );
        footer.append(control);
        form.onsubmit = (event) => {
            event.preventDefault();
            control.click();
        };
        return control;
    };
    return { dialog, content, action, error };
}
