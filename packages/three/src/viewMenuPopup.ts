// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createCadIcon } from "@chili3d/element";
import style from "./viewGizmo.module.css";

export type ViewMenuItem =
    | {
          name: string;
          action?: () => void;
          checked?: boolean;
          keepOpen?: boolean;
          disabled?: boolean;
          icon?: string;
          children?: ViewMenuItem[];
      }
    | "separator";

/** Real adjacent flyouts, clamped to the viewport and accessible without a mouse. */
export function openViewMenu(anchor: Element, items: ViewMenuItem[], onClose: () => void): () => void {
    const menus: HTMLElement[] = [];
    const events = new AbortController();
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        for (const menu of menus) menu.remove();
        events.abort();
        onClose();
    };
    const trim = (level: number) => {
        for (const menu of menus.splice(level)) menu.remove();
        const expanded = menus[level - 1]?.querySelectorAll('[aria-expanded="true"]') ?? [];
        for (const button of expanded) button.setAttribute("aria-expanded", "false");
    };
    const create = (entries: ViewMenuItem[], level: number, parent?: HTMLButtonElement): HTMLElement => {
        trim(level);
        const menu = document.createElement("div");
        menu.className = level === 0 ? style.menu : `${style.menu} ${style.flyout}`;
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", parent?.getAttribute("aria-label") ?? "View options");
        menus.push(menu);
        for (const item of entries) {
            if (item === "separator") {
                menu.append(document.createElement("hr"));
                continue;
            }
            const button = document.createElement("button");
            button.type = "button";
            button.disabled = !!item.disabled;
            button.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
            button.setAttribute("aria-label", item.name);
            if (item.checked !== undefined) button.setAttribute("aria-checked", String(item.checked));
            const mark = document.createElement("span"),
                label = document.createElement("span"),
                arrow = document.createElement("span");
            mark.className = style.menuMark;
            if (item.checked) mark.textContent = "✓";
            else if (item.icon) mark.append(createCadIcon(item.icon));
            label.textContent = item.name;
            arrow.textContent = item.children ? "▸" : "";
            button.append(mark, label, arrow);
            const expand = (focus = false) => {
                if (!item.children) {
                    trim(level + 1);
                    return;
                }
                const child = create(item.children, level + 1, button);
                button.setAttribute("aria-expanded", "true");
                if (focus) child.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
            };
            if (item.children) {
                button.setAttribute("aria-haspopup", "menu");
                button.setAttribute("aria-expanded", "false");
            }
            button.onmouseenter = () => expand();
            button.onclick = () => {
                if (item.children) expand(true);
                else {
                    if (!item.keepOpen) close();
                    item.action?.();
                    if (item.keepOpen && item.checked !== undefined) {
                        item.checked = !item.checked;
                        button.setAttribute("aria-checked", String(item.checked));
                        mark.textContent = item.checked ? "✓" : "";
                    }
                }
            };
            menu.append(button);
        }
        document.body.append(menu);
        const rect = (parent ?? anchor).getBoundingClientRect();
        let left = parent
            ? menus[level - 1].getBoundingClientRect().right - 1
            : rect.right - menu.offsetWidth;
        if (parent && left + menu.offsetWidth > window.innerWidth - 4)
            left = menus[level - 1].getBoundingClientRect().left - menu.offsetWidth + 1;
        menu.style.left = `${Math.max(4, Math.min(left, window.innerWidth - menu.offsetWidth - 4))}px`;
        menu.style.top = `${Math.max(4, Math.min(parent ? rect.top - 4 : rect.bottom, window.innerHeight - menu.offsetHeight - 4))}px`;
        menu.onkeydown = (event) => {
            event.stopPropagation();
            const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
            const current = document.activeElement as HTMLButtonElement;
            const index = buttons.indexOf(current);
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const next =
                    event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? buttons.length - 1
                          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next]?.focus();
                trim(level + 1);
            } else if (event.key === "ArrowRight" && current.hasAttribute("aria-haspopup")) {
                event.preventDefault();
                current.click();
            } else if ((event.key === "ArrowLeft" || event.key === "Escape") && parent) {
                event.preventDefault();
                trim(level);
                parent.focus();
            } else if (event.key === "Escape" || event.key === "Tab") {
                close();
                if (event.key === "Escape") (anchor as HTMLElement).focus?.();
            }
        };
        return menu;
    };
    create(items, 0).querySelector<HTMLButtonElement>("button")?.focus();
    document.addEventListener(
        "pointerdown",
        (event) => {
            if (!menus.some((menu) => menu.contains(event.target as Node))) close();
        },
        { capture: true, signal: events.signal },
    );
    window.addEventListener("resize", close, { signal: events.signal });
    return close;
}
