// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type INode, NodeActions, type NodeMenuAction, PubSub } from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import style from "./nodeContextMenu.module.css";

let closeMenu: (() => void) | undefined;
export function showNodeContextMenu(node: INode, x: number, y: number): void {
    const actions = NodeActions.forNode(node);
    if (!actions.length) return;
    closeMenu?.();
    const menu = document.createElement("div");
    menu.className = style.menu;
    menu.setAttribute("role", "menu");
    const controller = new AbortController();
    const close = () => {
        controller.abort();
        menu.remove();
        closeMenu = undefined;
    };
    closeMenu = close;
    const render = (items: NodeMenuAction[], back?: () => void) => {
        menu.replaceChildren();
        if (back) {
            const b = document.createElement("button");
            b.textContent = "‹ Back";
            b.onclick = back;
            menu.append(b);
        }
        for (const action of items) {
            if (action.separatorBefore) menu.append(document.createElement("hr"));
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = action.label + (action.children ? "  ›" : "");
            if (action.icon) b.prepend(createCadIcon(action.icon));
            b.disabled = action.disabled ?? false;
            b.setAttribute("role", "menuitem");
            b.onclick = () => {
                if (action.children) {
                    render(action.children, () => render(actions));
                    return;
                }
                close();
                Promise.resolve()
                    .then(() => action.run?.())
                    .catch((e) => PubSub.default.pub("displayError", String(e)));
            };
            menu.append(b);
        }
    };
    render(actions);
    document.body.append(menu);
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    document.addEventListener(
        "pointerdown",
        (e) => {
            if (!menu.contains(e.target as Node)) close();
        },
        { capture: true, signal: controller.signal },
    );
    menu.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
            close();
            return;
        }
        if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
        e.preventDefault();
        const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
    menu.querySelector<HTMLButtonElement>("button")?.focus();
}
