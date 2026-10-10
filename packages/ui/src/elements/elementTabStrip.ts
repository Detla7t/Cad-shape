// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ElementKind, I18n, type I18nKeys, Localize, PubSub } from "@chili3d/core";
import { button, createCadIcon, div, input, span, svg } from "@chili3d/element";
import { type ElementMenuItem, showElementMenu } from "./elementMenu";
import style from "./elements.module.css";
import type { ElementTab, ElementWorkspace } from "./elementWorkspace";
import { unsavedMark } from "./unsavedMark";
import { setShown } from "./visibility";

/**
 * The element tabs along the bottom of the editor (Onshape's element strip): the "+"
 * button, then one tab per element of the active document — kind icon and name, the
 * active one highlighted. Click switches, double-click renames in place, right-click opens
 * Rename / Duplicate / Delete. The Part Studio's tab has no node behind it, so those three
 * are disabled there.
 *
 * Stateless apart from an in-progress rename: everything it shows comes from the
 * workspace, which calls `render` whenever the document's elements, their names or the
 * active tab change.
 */
export class ElementTabStrip extends HTMLElement {
    private readonly tabsPanel = div({ className: style.tabs });
    private readonly browse: HTMLButtonElement;
    /** The id of the tab whose name is being edited in place. */
    private renaming: string | undefined;
    /** What the tabs on screen show — the workspace asks for a render on every tree change. */
    private rendered = "";

    constructor(private readonly workspace: ElementWorkspace) {
        super();
        this.className = style.strip;
        this.browse = document.createElement("button");
        this.browse.type = "button";
        this.browse.className = style.browse;
        this.browse.title = "Tabs";
        this.browse.setAttribute("aria-label", "Tabs");
        this.browse.append(createCadIcon("tabsBrowser"));
        this.browse.onclick = () => this.workspace.toggleTabs();
        const add = button(
            {
                className: style.add,
                title: new Localize("elements.new"),
                onclick: () => this.openNewMenu(add),
            },
            svg({ className: style.addIcon, icon: "icon-plus" }),
        );
        this.append(this.browse, add, this.tabsPanel);
        this.render();
    }

    /** The active element as of the last render, to animate only a real switch. */
    private lastActive: string | undefined;

    render(): void {
        this.browse.setAttribute("aria-expanded", String(!this.workspace.tabsSidebar.hidden));
        const tabs = this.workspace.tabs();
        // No document (the home screen): nothing to list.
        setShown(this, tabs.length > 0);
        if (this.renaming !== undefined && !tabs.some((tab) => tab.id === this.renaming)) {
            this.renaming = undefined;
        }
        // Unchanged tabs keep their DOM — and a half-typed rename keeps its text.
        const shown = JSON.stringify([
            this.workspace.activeId,
            this.renaming,
            tabs.map((tab) => [tab.id, tab.name, tab.icon, tab.dirty === true]),
        ]);
        if (shown === this.rendered) return;
        this.rendered = shown;
        this.tabsPanel.replaceChildren(...tabs.map((tab) => this.tab(tab)));
        // The tab that just became active grows its bar in (see elements.module.css).
        if (this.workspace.activeId !== this.lastActive) {
            this.lastActive = this.workspace.activeId;
            this.tabsPanel.querySelector<HTMLElement>(`.${style.active}`)?.setAttribute("data-switched", "");
        }
        const editor = this.tabsPanel.querySelector("input");
        if (editor !== null && window.document.activeElement !== editor) {
            editor.focus();
            editor.select();
        }
    }

    focusTabsButton(): void {
        this.browse.focus();
    }

    /** Starts renaming `tab` in place (a no-op for the Part Studio). */
    beginRename(tab: ElementTab): void {
        if (tab.node === undefined) return;
        this.renaming = tab.id;
        this.render();
    }

    private tab(tab: ElementTab): HTMLElement {
        const active = tab.id === this.workspace.activeId;
        const element = div(
            {
                className: active ? `${style.tab} ${style.active}` : style.tab,
                onclick: () => this.workspace.activate(tab.id),
                ondblclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    this.beginRename(tab);
                },
                oncontextmenu: (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.openContextMenu(tab, e.clientX, e.clientY);
                },
            },
            createCadIcon(tab.kind, tab.icon),
            this.renaming === tab.id ? this.nameEditor(tab) : this.label(tab),
        );
        if (tab.dirty) element.append(unsavedMark());
        element.dataset["elementId"] = tab.id;
        element.dataset["kind"] = tab.kind;
        return element;
    }

    private label(tab: ElementTab): HTMLElement {
        const label = span({ className: style.name });
        if (tab.node === undefined) {
            // One Part Studio per document for now — Onshape's "Part Studio 1".
            I18n.set(label, "textContent", "elements.partStudio{0}", 1);
            I18n.set(label, "title", "elements.partStudio{0}", 1);
        } else {
            label.textContent = tab.name;
            label.title = tab.name;
        }
        return label;
    }

    private nameEditor(tab: ElementTab): HTMLInputElement {
        let finished = false;
        const finish = (commit: boolean) => {
            if (finished) return;
            finished = true;
            this.renaming = undefined;
            if (commit && tab.node !== undefined) this.workspace.rename(tab.node, box.value);
            this.render();
        };
        const box = input({
            className: style.rename,
            value: tab.name,
            spellcheck: false,
            onclick: (e: MouseEvent) => e.stopPropagation(),
            ondblclick: (e: MouseEvent) => e.stopPropagation(),
            onkeydown: (e: KeyboardEvent) => {
                // Keep keystrokes away from the app's hotkeys (Delete, Ctrl+Z, …).
                e.stopPropagation();
                if (e.key === "Enter") finish(true);
                else if (e.key === "Escape") finish(false);
            },
            onblur: () => finish(true),
        });
        return box;
    }

    private openContextMenu(tab: ElementTab, x: number, y: number): void {
        const node = tab.node;
        const fixed: I18nKeys | undefined = node === undefined ? "elements.partStudio.fixed" : undefined;
        const item = (label: I18nKeys, icon: string, onSelect: () => void): ElementMenuItem => ({
            label,
            icon,
            disabled: node === undefined,
            tooltip: fixed,
            onSelect,
        });
        showElementMenu(
            [
                item("common.rename", "icon-edit", () => this.beginRename(tab)),
                item("elements.duplicate", "icon-clone", () => node && this.workspace.duplicate(node)),
                item("common.delete", "icon-trash", () => node && this.workspace.confirmDelete(node)),
            ],
            { x, y },
        );
    }

    /**
     * Onshape's "+" menu: the applications first (Feature Studio, CAM Studio, …), then the
     * core elements — Part Studio (one per document, so disabled), Assembly, Variable Studio,
     * Drawing, a folder, Import.
     */
    private openNewMenu(anchor: HTMLElement): void {
        const rect = anchor.getBoundingClientRect();
        const core = new Set(["assembly", "variableStudio", "drawingDocument"]);
        const create = (kind: ElementKind, ellipsis = false): ElementMenuItem => ({
            label: `command.${kind.newCommand}` as I18nKeys,
            text: `${I18n.translate("elements.create{0}", I18n.translate(kind.display))}${ellipsis ? "…" : ""}`,
            icon: kind.icon,
            cadIcon: kind.kind,
            onSelect: () => {
                if (kind.newCommand !== undefined) PubSub.default.pub("executeCommand", kind.newCommand);
            },
        });
        const kinds = this.workspace.creatableKinds();
        const applications = kinds.filter((kind) => !core.has(kind.kind)).map((kind) => create(kind));
        const coreKinds = [...core]
            .map((id) => kinds.find((kind) => kind.kind === id))
            .filter((kind): kind is ElementKind => kind !== undefined)
            .map((kind) => create(kind, kind.kind === "drawingDocument"));
        showElementMenu(
            [
                ...applications,
                {
                    label: "elements.partStudio{0}",
                    text: I18n.translate(
                        "elements.create{0}",
                        I18n.translate("elements.partStudio{0}", ""),
                    ).trim(),
                    cadIcon: "partStudio",
                    disabled: true,
                    tooltip: "elements.partStudio.one",
                    separator: applications.length > 0,
                    onSelect: () => {},
                },
                ...coreKinds,
                {
                    label: "command.create.folder",
                    text: I18n.translate(
                        "elements.create{0}",
                        I18n.translate("command.create.folder").toLowerCase(),
                    ),
                    cadIcon: "folder",
                    onSelect: () => PubSub.default.pub("executeCommand", "create.folder"),
                },
                {
                    label: "command.file.import",
                    text: `${I18n.translate("command.file.import")}…`,
                    cadIcon: "file.import",
                    onSelect: () => PubSub.default.pub("executeCommand", "file.import"),
                },
            ],
            { x: rect.left, y: rect.top },
        );
    }
}

customElements.define("chili-element-tabs", ElementTabStrip);
