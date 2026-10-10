// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type INode,
    Node as ModelNode,
    NodeActions,
    type NodeMenuAction,
    type NodeMenuContext,
    PubSub,
    ReferencePlaneNode,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import style from "./nodeContextMenu.module.css";

let closeMenu: (() => void) | undefined;
export function showNodeContextMenu(node: INode, x: number, y: number, context?: NodeMenuContext): void {
    // Providers registered later replace an earlier action of the same id (a module that
    // loads after another refines its entry — the documents module's export dialog).
    let actions = NodeActions.forNode(node, context).filter(
        (action, index, all) => all.findLastIndex((other) => other.id === action.id) === index,
    );
    const doc = node instanceof ModelNode ? node.document : context?.view.document;
    const isPlane = node instanceof ReferencePlaneNode;
    if (doc && !isPlane) {
        const target = { documentId: doc.id, nodeId: node.id, name: node.name };
        actions = actions.filter((action) => action.id !== "comment");
        actions.push(
            {
                id: "comment",
                label: "Add comment",
                icon: "comments",
                run: () => PubSub.default.pub("openReviewComments", target),
            },
            {
                id: "whereUsed",
                label: "Where used…",
                icon: "where-used",
                run: () => PubSub.default.pub("openWhereUsed", target),
            },
        );
    }
    if (context && !isPlane) {
        const order = [
            "editFeature",
            "editSourceSketch",
            "showDimensions",
            "dependencies",
            "hide",
            "analysis",
            "isolate",
            "transparent",
            "section",
            "copy",
            "drawing",
            "export",
            "selectEntities",
            "selectOther",
            "comment",
            "fit",
            "zoom",
            "normal",
            "delete",
            "deleteFeature",
            "material",
            "appearance",
            "faceAppearance",
        ];
        const index = (id: string) => {
            const at = order.indexOf(id.startsWith("editSourceSketch") ? "editSourceSketch" : id);
            return at < 0 ? order.length : at;
        };
        actions = actions
            .filter(
                (action) =>
                    !["rename", "properties", "copyHere", "paste", "release", "unisolate"].includes(
                        action.id,
                    ),
            )
            .sort((a, b) => index(a.id) - index(b.id))
            .map((action) => ({
                ...action,
                separatorBefore: ["hide", "copy", "comment", "delete", "material"].includes(action.id),
            }));
    }
    if (!actions.length) return;
    showActionMenu(actions, x, y, { className: isPlane ? style.planeMenu : undefined });
}

/** A menu of actions at a screen point (the tree's and the document tabs' context menus). */
export function showActionMenu(
    actions: readonly NodeMenuAction[],
    x: number,
    y: number,
    options: { readonly className?: string; readonly label?: string } = {},
): void {
    if (!actions.length) return;
    closeMenu?.();
    const menu = document.createElement("div");
    menu.className = options.className ? `${style.menu} ${options.className}` : style.menu;
    menu.setAttribute("role", "menu");
    if (options.label) menu.setAttribute("aria-label", options.label);
    const controller = new AbortController();
    const close = () => {
        controller.abort();
        menu.remove();
        closeMenu = undefined;
    };
    closeMenu = close;
    const render = (items: readonly NodeMenuAction[], back?: () => void) => {
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
