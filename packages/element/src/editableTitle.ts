// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createCadIcon } from "./cadIcon";
import style from "./editableTitle.module.css";

/** A fixed-width title slot: its pencil appears on hover/focus without moving neighboring controls. */
export function createEditableTitle(name: () => string, rename: (value: string) => void) {
    const element = document.createElement("div");
    element.className = style.title;
    const label = document.createElement("strong");
    const pencil = document.createElement("button");
    pencil.type = "button";
    pencil.className = style.pencil;
    pencil.title = "Rename feature";
    pencil.setAttribute("aria-label", "Rename feature");
    pencil.append(createCadIcon("rename"));
    const input = document.createElement("input");
    input.className = style.input;
    input.setAttribute("aria-label", "Feature name");
    input.hidden = true;
    let editing = false;
    const refresh = () => {
        label.textContent = name();
        label.title = name();
    };
    const finish = (save: boolean) => {
        if (!editing) return;
        editing = false;
        const value = input.value.trim();
        if (save && value && value !== name()) rename(value);
        input.hidden = true;
        label.hidden = false;
        pencil.hidden = false;
        refresh();
    };
    const start = () => {
        editing = true;
        input.value = name();
        label.hidden = true;
        pencil.hidden = true;
        input.hidden = false;
        input.focus();
        input.select();
    };
    pencil.onclick = (event) => {
        event.stopPropagation();
        start();
    };
    label.ondblclick = (event) => {
        event.stopPropagation();
        start();
    };
    input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            finish(event.key === "Enter");
            pencil.focus();
        }
    });
    input.addEventListener("blur", () => finish(true));
    element.addEventListener("pointerdown", (event) => event.stopPropagation());
    element.append(label, input, pencil);
    refresh();
    return { element, refresh, commit: () => finish(true) };
}
