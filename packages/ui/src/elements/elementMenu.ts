// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type I18nKeys, Localize } from "@chili3d/core";
import { createCadIcon, div, span, svg } from "@chili3d/element";
import style from "./elements.module.css";

export interface ElementMenuItem {
    readonly label: I18nKeys;
    readonly icon?: string;
    readonly cadIcon?: string;
    readonly disabled?: boolean;
    /** Why a disabled item is disabled. */
    readonly tooltip?: I18nKeys;
    readonly onSelect: () => void;
}

let current: { readonly menu: HTMLElement; readonly close: () => void } | undefined;

/** Closes the open element menu, if any. */
export function closeElementMenu(): void {
    current?.close();
}

/**
 * A small popup menu anchored at a point of the element strip. The strip sits at the bottom
 * of the window, so the menu opens UPWARD from the anchor. One menu at a time; it closes on
 * a pick, Escape, or a pointer press anywhere outside it.
 */
export function showElementMenu(
    items: readonly ElementMenuItem[],
    at: { x: number; y: number },
): HTMLElement {
    closeElementMenu();
    const menu = div(
        { className: style.menu },
        ...items.map((item) =>
            div(
                {
                    className: item.disabled ? `${style.menuItem} ${style.disabled}` : style.menuItem,
                    title: item.disabled && item.tooltip ? new Localize(item.tooltip) : "",
                    onclick: (e: MouseEvent) => {
                        e.stopPropagation();
                        if (item.disabled) return;
                        close();
                        item.onSelect();
                    },
                },
                item.cadIcon
                    ? createCadIcon(item.cadIcon, item.icon)
                    : svg({ className: style.menuIcon, icon: item.icon ?? "icon-check" }),
                span({ textContent: new Localize(item.label) }),
            ),
        ),
    );
    menu.dataset["menu"] = "element";
    menu.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - 200))}px`;
    menu.style.bottom = `${Math.max(4, window.innerHeight - at.y)}px`;

    const onPointerDown = (e: PointerEvent) => {
        if (!menu.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") close();
    };
    const close = () => {
        window.document.removeEventListener("pointerdown", onPointerDown, true);
        window.document.removeEventListener("keydown", onKeyDown, true);
        menu.remove();
        if (current?.menu === menu) current = undefined;
    };
    window.document.addEventListener("pointerdown", onPointerDown, true);
    window.document.addEventListener("keydown", onKeyDown, true);
    window.document.body.append(menu);
    current = { menu, close };
    return menu;
}
