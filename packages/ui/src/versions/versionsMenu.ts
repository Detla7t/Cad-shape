// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { button, div, span, svg } from "@chili3d/element";
import style from "./versions.module.css";

export interface VersionsMenuItem {
    readonly label: string;
    readonly icon?: string;
    readonly disabled?: boolean;
    readonly separatorBefore?: boolean;
    readonly onSelect: () => void;
}

let current: { readonly menu: HTMLElement; readonly close: (restoreFocus: boolean) => void } | undefined;

/** Closes the open history context menu, if any. */
export function closeVersionsMenu(): void {
    current?.close(false);
}

/**
 * The context menu of a history entry: a keyboard-navigable `role="menu"` popup at a point
 * (a right-click) or under an element (the row's ⋯ button, the ContextMenu key). Arrow keys
 * move between the enabled items, Escape closes it and gives focus back to the opener, a pick
 * or a press outside closes it.
 */
export function showVersionsMenu(
    items: readonly VersionsMenuItem[],
    at: { x: number; y: number } | HTMLElement,
    label: string,
): HTMLElement {
    closeVersionsMenu();
    const opener = window.document.activeElement as HTMLElement | null;
    const buttons: HTMLButtonElement[] = [];
    const menu = div({ className: style.menu });
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", label);
    for (const item of items) {
        if (item.separatorBefore && buttons.length > 0) menu.append(div({ className: style.menuSeparator }));
        const entry = button(
            {
                className: style.menuItem,
                disabled: item.disabled ?? false,
                tabIndex: -1,
                onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    if (item.disabled) return;
                    close(false);
                    item.onSelect();
                },
            },
            svg({ className: style.menuIcon, icon: item.icon ?? "icon-check" }),
            span({ textContent: item.label }),
        );
        entry.setAttribute("role", "menuitem");
        if (item.icon === undefined) entry.firstElementChild?.setAttribute("visibility", "hidden");
        buttons.push(entry);
        menu.append(entry);
    }
    const enabled = () => buttons.filter((b) => !b.disabled);
    const move = (step: number) => {
        const list = enabled();
        if (list.length === 0) return;
        const index = list.indexOf(window.document.activeElement as HTMLButtonElement);
        const next =
            index < 0 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length;
        list[next].focus();
    };
    menu.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowUp") move(-1);
        else if (e.key === "Home") enabled()[0]?.focus();
        else if (e.key === "End") enabled().at(-1)?.focus();
        else if (e.key === "Tab") close(true);
        else return;
        e.preventDefault();
        e.stopPropagation();
    });

    const onPointerDown = (e: PointerEvent) => {
        if (!menu.contains(e.target as Node)) close(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        close(true);
    };
    const close = (restoreFocus: boolean) => {
        window.document.removeEventListener("pointerdown", onPointerDown, true);
        window.document.removeEventListener("keydown", onKeyDown, true);
        menu.remove();
        if (current?.menu === menu) current = undefined;
        if (restoreFocus && opener?.isConnected) opener.focus();
    };
    window.document.addEventListener("pointerdown", onPointerDown, true);
    window.document.addEventListener("keydown", onKeyDown, true);
    window.document.body.append(menu);
    place(menu, at);
    current = { menu, close };
    enabled()[0]?.focus();
    return menu;
}

/** Positions the menu at the point or under the element, flipped to stay inside the window. */
function place(menu: HTMLElement, at: { x: number; y: number } | HTMLElement): void {
    let x: number;
    let y: number;
    let above: number;
    if (at instanceof HTMLElement) {
        const rect = at.getBoundingClientRect();
        x = rect.right;
        y = rect.bottom + 2;
        above = rect.top - 2;
    } else {
        x = at.x;
        y = at.y;
        above = at.y;
    }
    const width = menu.offsetWidth || 200;
    const height = menu.offsetHeight || 0;
    const left = at instanceof HTMLElement ? x - width : x;
    menu.style.left = `${Math.max(4, Math.min(left, window.innerWidth - width - 4))}px`;
    const top = y + height > window.innerHeight - 4 && above - height >= 4 ? above - height : y;
    menu.style.top = `${Math.max(4, top)}px`;
}
