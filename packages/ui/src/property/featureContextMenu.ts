// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assignActiveArm,
    configuredArmSource,
    type FeatureItem,
    I18n,
    type I18nKeys,
    type IDocument,
    type IFeatureListNode,
    type INode,
    Localize,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { div, input, span, svg } from "@chili3d/element";
import { showDialog } from "../dialog";
import { showConfigureGrid } from "./configuration/configureGrid";
import style from "./featureListProperty.module.css";
import inputStyle from "./input.module.css";

/** Where the menu opens: under an element (a row's ⋯ button), or at a pointer position. */
export type FeatureMenuAnchor = Element | { readonly x: number; readonly y: number };

interface OpenMenu {
    readonly element: HTMLElement;
    readonly owner: unknown;
    readonly close: () => void;
}

let open: OpenMenu | undefined;

/**
 * The context menu of one feature — Edit, Rename, Reselect, Suppress, Configure suppression,
 * Delete, Add comment, Where used. The feature tree's rows and the Part Studio timeline open
 * this same menu. Each action is one undo step. `owner` lets a list close only its own menu
 * when it re-renders (`closeFeatureContextMenu(owner)`).
 */
export function showFeatureContextMenu(
    document: IDocument,
    node: INode & IFeatureListNode,
    item: FeatureItem,
    anchor: FeatureMenuAnchor,
    owner?: unknown,
): HTMLElement {
    closeFeatureContextMenu();
    const run = (action: () => void) => (event: MouseEvent) => {
        event.stopPropagation();
        closeFeatureContextMenu();
        action();
    };
    const entries: [icon: string, display: I18nKeys, action: () => void][] = [
        ["icon-edit", "common.rename", () => rename(document, node, item)],
    ];
    if (item.reselectable) {
        entries.push(["icon-sync-alt", "features.reselect", () => node.reselectShapes?.(item.id)]);
    }
    entries.push(
        [
            item.suppressed ? "icon-eye" : "icon-eye-slash",
            item.suppressed ? "features.unsuppress" : "features.suppress",
            () => toggleSuppressed(document, node, item),
        ],
        [
            "icon-layer-group",
            "features.configureSuppression",
            () => configureSuppression(document, node, item),
        ],
        ["icon-delete", "common.delete", () => removeFeature(document, node, item)],
    );
    const menu = div(
        { className: style.menu },
        div({
            className: style.menuItem,
            textContent: "Edit…",
            onclick: run(() => PubSub.default.pub("editFeature", node, item.id)),
        }),
        ...entries.map(([icon, display, action]) =>
            div(
                { className: style.menuItem, onclick: run(action) },
                svg({ className: style.menuIcon, icon }),
                span({ textContent: new Localize(display) }),
            ),
        ),
    );
    const target = {
        documentId: document.id,
        nodeId: node.id,
        featureId: item.id,
        name: `${node.name} / ${item.name ?? I18n.translate(item.display)}`,
    };
    for (const [label, topic] of [
        ["Add comment", "openReviewComments"],
        ["Where used…", "openWhereUsed"],
    ] as const) {
        menu.append(
            div({
                className: style.menuItem,
                textContent: label,
                onclick: run(() => PubSub.default.pub(topic, target)),
            }),
        );
    }
    globalThis.document.body.appendChild(menu);
    const { top, left } = menuPosition(anchorRect(anchor), menu);
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;

    const outside = (event: Event) => {
        if (!menu.contains(event.target as Node)) closeFeatureContextMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") closeFeatureContextMenu();
    };
    globalThis.document.addEventListener("click", outside, true);
    globalThis.document.addEventListener("keydown", onKeyDown);
    open = {
        element: menu,
        owner,
        close: () => {
            menu.remove();
            globalThis.document.removeEventListener("click", outside, true);
            globalThis.document.removeEventListener("keydown", onKeyDown);
        },
    };
    return menu;
}

/** Closes the open feature menu — only when `owner` opened it, if given. */
export function closeFeatureContextMenu(owner?: unknown): void {
    if (open === undefined || (owner !== undefined && open.owner !== owner)) return;
    const closing = open;
    open = undefined;
    closing.close();
}

function anchorRect(anchor: FeatureMenuAnchor) {
    if (anchor instanceof Element) return anchor.getBoundingClientRect();
    return { top: anchor.y, bottom: anchor.y, left: anchor.x, right: anchor.x };
}

/**
 * Keeps the floating menu inside the viewport: flips above the anchor when it
 * would overflow the bottom edge, and clamps horizontally.
 */
function menuPosition(
    rect: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number },
    menu: HTMLElement,
) {
    const margin = 4;
    const height = menu.offsetHeight;
    const width = menu.offsetWidth;
    let top = rect.bottom + 2;
    if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - height - 2);
    }
    let left = Math.max(rect.left, rect.right - width);
    left = Math.min(left, window.innerWidth - width - margin);
    return { top, left: Math.max(margin, left) };
}

function rename(document: IDocument, node: IFeatureListNode, item: FeatureItem) {
    const box = input({ className: inputStyle.box, value: item.name ?? I18n.translate(item.display) });
    showDialog("common.rename", box, () => {
        Transaction.execute(document, "rename feature", () => {
            node.renameFeature?.(item.id, box.value.trim());
        });
    });
    setTimeout(() => {
        box.focus();
        box.select();
    });
}

function removeFeature(document: IDocument, node: IFeatureListNode, item: FeatureItem) {
    Transaction.execute(document, "remove feature", () => {
        node.removeFeature(item.id);
        document.visual.update();
    });
}

/**
 * Suppress / unsuppress. A feature whose suppression is configured changes for the active
 * configuration only — the other configurations keep theirs.
 */
function toggleSuppressed(document: IDocument, node: IFeatureListNode, item: FeatureItem) {
    let suppressed: boolean | string = !item.suppressed;
    if (item.suppressionConfigured !== undefined) {
        const scope = document.variables.evaluate().scope;
        const assigned = assignActiveArm(
            item.suppressionConfigured,
            scope,
            configuredArmSource(!item.suppressed),
        );
        if (assigned.isOk) suppressed = assigned.value;
    }
    setSuppressed(document, node, item, suppressed);
}

function setSuppressed(
    document: IDocument,
    node: IFeatureListNode,
    item: FeatureItem,
    suppressed: boolean | string,
) {
    Transaction.execute(document, "toggle feature", () => {
        node.setFeatureSuppressed(item.id, suppressed);
        document.visual.update();
    });
}

/** Suppression per configuration, edited in the same grid as a configured checkbox. */
function configureSuppression(document: IDocument, node: IFeatureListNode, item: FeatureItem) {
    showConfigureGrid(
        document,
        { kind: "boolean", stored: item.suppressionConfigured ?? item.suppressed === true },
        (value) =>
            setSuppressed(document, node, item, value === true || value === false ? value : String(value)),
    );
}
