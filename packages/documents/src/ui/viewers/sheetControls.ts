// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import style from "../spreadsheet.module.css";

const ICONS: Record<string, string> = {
    Undo: "M6 4 2 8l4 4M2 8h8a4 4 0 0 1 0 8",
    Redo: "m14 4 4 4-4 4M18 8h-8a4 4 0 0 0 0 8",
    Find: "M13 13l5 5M15 8a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
    "Create or remove filter": "M2 3h16l-6 7v7l-4-2v-5Z",
    "Merge or unmerge selected cells": "M6 3H2v14h4m8-14h4v14h-4M5 10h10m-8-2 2 2-2 2m6-4-2 2 2 2",
    "Wrap text": "M2 4h16M2 8h12a4 4 0 0 1 0 8H9m2-3-3 3 3 3M2 12h3",
    "Clear formatting": "M4 3h12M10 3v10M3 17 17 3m-4 11 4 4m0-4-4 4",
    "All sheets": "M3 5h14M3 10h14M3 15h14",
};

export function sheetButton(label: string, text: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    const path = ICONS[label];
    if (path) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 20 20");
        svg.setAttribute("width", "16");
        svg.setAttribute("height", "16");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.5");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.setAttribute("aria-hidden", "true");
        const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
        line.setAttribute("d", path);
        svg.append(line);
        button.append(svg);
    } else button.textContent = text;
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", action);
    return button;
}

export interface SheetMenuItem {
    label: string;
    action: () => void;
    hint?: string;
    disabled?: boolean;
    checked?: boolean;
}

export function sheetField(label: string, value = "", multiline = false) {
    const wrapper = document.createElement("label");
    wrapper.className = style.field;
    const input = document.createElement(multiline ? "textarea" : "input");
    input.value = value;
    input.setAttribute("aria-label", label);
    wrapper.append(label, input);
    return { element: wrapper, input };
}

/** Locally owned menus/dialogs: dismiss on outside click or Escape, restore focus, and clean up on disposal. */
export function createSheetOverlays() {
    let dispose = () => {};
    function close() {
        dispose();
        dispose = () => {};
    }
    function menu(anchor: HTMLElement, items: (SheetMenuItem | null)[]) {
        close();
        const popup = document.createElement("div");
        popup.className = style.menu;
        popup.setAttribute("role", "menu");
        const buttons: HTMLButtonElement[] = [];
        for (const item of items) {
            if (!item) {
                popup.append(document.createElement("hr"));
                continue;
            }
            const button = sheetButton(item.label, `${item.checked ? "✓  " : ""}${item.label}`, () => {
                close();
                item.action();
            });
            button.setAttribute("role", "menuitem");
            button.disabled = item.disabled ?? false;
            if (item.hint) {
                const hint = document.createElement("small");
                hint.textContent = item.hint;
                button.append(hint);
            }
            popup.append(button);
            if (!button.disabled) buttons.push(button);
        }
        document.body.append(popup);
        const rect = anchor.getBoundingClientRect();
        popup.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8))}px`;
        popup.style.top = `${Math.max(4, rect.bottom + popup.offsetHeight > window.innerHeight ? rect.top - popup.offsetHeight : rect.bottom + 3)}px`;
        const outside = (e: MouseEvent) => {
            if (!popup.contains(e.target as Node)) close();
        };
        const keydown = (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === "Escape") {
                e.preventDefault();
                close();
            }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                    e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? buttons.length - 1
                          : (current + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next]?.focus();
            }
        };
        document.addEventListener("mousedown", outside);
        popup.addEventListener("keydown", keydown);
        anchor.setAttribute("aria-expanded", "true");
        dispose = () => {
            document.removeEventListener("mousedown", outside);
            popup.remove();
            anchor.setAttribute("aria-expanded", "false");
            if (anchor.isConnected) anchor.focus();
        };
        buttons[0]?.focus();
    }
    function dialog(title: string, body: HTMLElement, apply: () => string | undefined, action = "Apply") {
        close();
        const previous = document.activeElement as HTMLElement | null;
        const overlay = document.createElement("div");
        overlay.className = style.backdrop;
        const panel = document.createElement("form");
        panel.className = style.dialog;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-label", title);
        const heading = document.createElement("header");
        heading.textContent = title;
        heading.append(sheetButton("Close dialog", "×", close));
        const error = document.createElement("div");
        error.className = style.validationError;
        error.setAttribute("role", "alert");
        const actions = document.createElement("footer");
        const submit = document.createElement("button");
        submit.type = "submit";
        submit.textContent = action;
        submit.className = style.primary;
        actions.append(sheetButton("Cancel", "Cancel", close), submit);
        panel.append(heading, body, error, actions);
        overlay.append(panel);
        document.body.append(overlay);
        panel.addEventListener("submit", (event) => {
            event.preventDefault();
            const message = apply();
            if (message) error.textContent = message;
            else close();
        });
        panel.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
                event.preventDefault();
                close();
            }
            if (event.key === "Tab") {
                const inputs = [
                    ...panel.querySelectorAll<HTMLElement>("input,textarea,select,button"),
                ].filter((e) => !(e as HTMLButtonElement).disabled);
                if (event.shiftKey && document.activeElement === inputs[0]) {
                    event.preventDefault();
                    inputs.at(-1)?.focus();
                } else if (!event.shiftKey && document.activeElement === inputs.at(-1)) {
                    event.preventDefault();
                    inputs[0]?.focus();
                }
            }
        });
        dispose = () => {
            overlay.remove();
            if (previous?.isConnected) previous.focus();
        };
        (body.querySelector("input,textarea,select,button") as HTMLElement | null)?.focus();
    }
    return { menu, dialog, close };
}
