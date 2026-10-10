// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentElements, I18n, type IDocument, type INode } from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import style from "./elementTabsSidebar.module.css";
import type { ElementTab, ElementWorkspace } from "./elementWorkspace";
import { unsavedMark } from "./unsavedMark";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
    const result = document.createElement(tag);
    result.className = className;
    if (text) result.textContent = text;
    return result;
}
function iconButton(title: string, icon: string, run: () => void) {
    const button = element("button", style.iconButton);
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.append(createCadIcon(icon));
    button.onclick = run;
    return button;
}
const PRIMARY_KINDS = ["partStudio", "assembly", "drawingDocument", "featureStudio", "variableStudio"];
const KIND_NAMES: Record<string, string> = {
    partStudio: "Part Studio",
    assembly: "Assembly",
    drawingDocument: "Drawing",
    featureStudio: "Feature Studio",
    variableStudio: "Variable Studio",
};
export function tabName(tab: ElementTab): string {
    return tab.node ? tab.name : I18n.translate("elements.partStudio{0}", 1);
}
function kindName(tab: ElementTab): string {
    const kind = DocumentElements.kinds.find((kind) => kind.kind === tab.kind);
    return KIND_NAMES[tab.kind] ?? (kind ? I18n.translate(kind.display) : tab.kind);
}

/** A document's tab browser. Navigation previews a row; Enter (or a click) opens its existing view. */
export class ElementTabsSidebar extends HTMLElement {
    private readonly search = element("input", style.search);
    private readonly filters = element("div", style.filters);
    private readonly list = element("div", style.list);
    private readonly preview = element("section", style.preview);
    private readonly searchButton: HTMLButtonElement;
    private readonly filterButton: HTMLButtonElement;
    private readonly compactButton: HTMLButtonElement;
    private readonly detailedButton: HTMLButtonElement;
    private readonly sortButton: HTMLButtonElement;
    private selected?: string;
    private lastActive?: string;
    private owner?: IDocument;
    private readonly kinds = new Set<string>();
    private compact = false;
    private sort: "order" | "name" | "type" = "order";
    private sortMenu?: HTMLElement;
    private width = 330;
    private stopResize?: () => void;
    private images = new Map<string, Promise<string | undefined>>();
    private imageRevision = 0;
    private readonly watched = new Set<INode>();

    constructor(
        private readonly workspace: ElementWorkspace,
        private readonly close: () => void,
    ) {
        super();
        this.className = style.root;
        this.hidden = true;
        this.setAttribute("aria-label", "Tabs");
        this.setAttribute("role", "complementary");
        const header = element("header", style.header);
        header.append(element("strong", style.title, "Tabs"));
        this.searchButton = iconButton("Search tabs", "tabsSearch", () => {
            this.search.hidden = !this.search.hidden;
            this.searchButton.setAttribute("aria-pressed", String(!this.search.hidden));
            if (!this.search.hidden) this.search.focus();
        });
        this.searchButton.setAttribute("aria-pressed", "true");
        this.sortButton = iconButton("Sort tabs", "tabsSort", () => this.toggleSort());
        this.sortButton.setAttribute("aria-haspopup", "menu");
        this.sortButton.setAttribute("aria-expanded", "false");
        this.filterButton = iconButton("Filter tabs", "tabsFilter", () => {
            this.filters.hidden = !this.filters.hidden;
            this.filterButton.setAttribute("aria-pressed", String(!this.filters.hidden));
        });
        this.filterButton.setAttribute("aria-pressed", "true");
        this.compactButton = iconButton("Compact list", "tabsList", () => this.layout(true));
        this.detailedButton = iconButton("Detailed list", "tabsDetails", () => this.layout(false));
        this.compactButton.setAttribute("aria-pressed", "false");
        this.detailedButton.setAttribute("aria-pressed", "true");
        header.append(
            this.searchButton,
            this.sortButton,
            this.filterButton,
            this.compactButton,
            this.detailedButton,
            iconButton("Close Tabs", "close", close),
        );
        this.search.type = "search";
        this.search.placeholder = "Search tabs";
        this.search.setAttribute("aria-label", "Search tabs");
        this.search.oninput = () => this.render();
        this.list.setAttribute("role", "listbox");
        this.list.setAttribute("aria-label", "Document tabs");
        this.list.tabIndex = 0;
        this.filters.setAttribute("role", "group");
        this.filters.setAttribute("aria-label", "Tab type filters");
        const footer = element("footer", style.footer);
        footer.append(
            element("kbd", "", "↑"),
            element("kbd", "", "↓"),
            document.createTextNode(" to navigate  "),
            element("kbd", "", "↵"),
            document.createTextNode(" to open"),
        );
        const resizer = element("div", style.resizer);
        resizer.setAttribute("role", "separator");
        resizer.setAttribute("aria-label", "Resize Tabs sidebar");
        resizer.setAttribute("aria-orientation", "vertical");
        resizer.tabIndex = 0;
        resizer.onpointerdown = (event) => this.resize(event);
        resizer.onkeydown = (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            this.setWidth(this.width + (event.key === "ArrowRight" ? 20 : -20));
        };
        this.append(header, this.search, this.filters, this.list, this.preview, footer, resizer);
        this.addEventListener("keydown", (event) => this.keyDown(event));
        this.addEventListener("pointerdown", (event) => event.stopPropagation());
    }

    connectedCallback() {
        document.addEventListener("pointerdown", this.dismissSort, true);
    }
    disconnectedCallback() {
        document.removeEventListener("pointerdown", this.dismissSort, true);
        this.stopResize?.();
        this.closeSort();
        this.unwatch();
    }
    show() {
        this.hidden = false;
        this.setWidth(this.width);
        this.invalidateImages();
        this.render();
        this.search.hidden ? this.focusSelected() : this.search.focus();
    }
    hide() {
        this.hidden = true;
        this.imageRevision++;
        this.closeSort();
        this.stopResize?.();
        this.unwatch();
    }
    private unwatch() {
        for (const node of this.watched) node.removePropertyChanged(this.nodeChanged);
        this.watched.clear();
    }
    private readonly nodeChanged = (property: string) => {
        if (property !== "name") this.invalidateImages();
        this.render();
    };
    refreshPreview() {
        this.invalidateImages();
        this.render();
    }
    private invalidateImages() {
        this.images.clear();
        this.imageRevision++;
    }

    render() {
        if (this.hidden) return;
        const owner = this.workspace.document;
        if (owner !== this.owner) {
            this.unwatch();
            this.owner = owner;
            this.invalidateImages();
            this.search.value = "";
            this.kinds.clear();
            this.selected = undefined;
            this.lastActive = undefined;
        }
        if (!owner) {
            this.close();
            return;
        }
        const tabs = this.workspace.tabs();
        const nodes = new Set(tabs.flatMap((tab) => (tab.node ? [tab.node] : [])));
        for (const node of this.watched)
            if (!nodes.has(node)) {
                node.removePropertyChanged(this.nodeChanged);
                this.watched.delete(node);
            }
        for (const node of nodes)
            if (!this.watched.has(node)) {
                node.onPropertyChanged(this.nodeChanged);
                this.watched.add(node);
            }
        const ids = new Set(tabs.map((tab) => tab.id));
        for (const id of this.images.keys()) if (!ids.has(id)) this.images.delete(id);
        if (this.lastActive !== this.workspace.activeId) {
            this.lastActive = this.workspace.activeId;
            this.selected = this.lastActive;
        }
        this.renderFilters(tabs);
        const shown = this.visibleTabs(tabs);
        if (!shown.some((tab) => tab.id === this.selected)) this.selected = shown[0]?.id;
        const focused = this.list.contains(document.activeElement);
        this.list.replaceChildren(...shown.map((tab) => this.row(tab)));
        if (!shown.length) this.list.append(element("p", style.empty, "No matching tabs"));
        this.list.tabIndex = shown.length ? -1 : 0;
        this.renderPreview(shown.find((tab) => tab.id === this.selected));
        if (focused) this.focusSelected();
    }
    private visibleTabs(tabs = this.workspace.tabs()) {
        const query = this.search.value.trim().toLocaleLowerCase();
        const shown = tabs.filter(
            (tab) =>
                (!this.kinds.size || this.kinds.has(tab.kind)) &&
                `${tabName(tab)} ${kindName(tab)}`.toLocaleLowerCase().includes(query),
        );
        if (this.sort !== "order")
            shown.sort(
                (a, b) =>
                    (this.sort === "type" ? kindName(a).localeCompare(kindName(b)) : 0) ||
                    tabName(a).localeCompare(tabName(b), undefined, { numeric: true }),
            );
        return shown;
    }
    private renderFilters(tabs: ElementTab[]) {
        const kinds = [...new Set([...PRIMARY_KINDS, ...tabs.map((tab) => tab.kind)])];
        // Keep the focused filter button in place while changing the list below it.
        const key = JSON.stringify([kinds, [...this.kinds], !!this.search.value]);
        if (this.filters.dataset["state"] === key) return;
        this.filters.dataset["state"] = key;
        const focused = document.activeElement?.getAttribute("data-kind");
        this.filters.replaceChildren(
            ...kinds.map((kind) => {
                const definition = DocumentElements.kinds.find((item) => item.kind === kind);
                const title = KIND_NAMES[kind] ?? (definition ? I18n.translate(definition.display) : kind);
                const control = iconButton(title, kind, () => {
                    this.kinds.has(kind) ? this.kinds.delete(kind) : this.kinds.add(kind);
                    this.render();
                });
                control.dataset["kind"] = kind;
                control.setAttribute("aria-pressed", String(this.kinds.has(kind)));
                return control;
            }),
        );
        const clear = element("button", style.clear, "Clear");
        clear.type = "button";
        clear.disabled = !this.kinds.size && !this.search.value;
        clear.onclick = () => {
            this.kinds.clear();
            this.search.value = "";
            this.render();
            this.search.focus();
        };
        this.filters.append(clear);
        if (focused)
            [...this.filters.querySelectorAll<HTMLElement>("[data-kind]")]
                .find((item) => item.dataset["kind"] === focused)
                ?.focus();
    }
    private layout(compact: boolean) {
        this.compact = compact;
        this.dataset["compact"] = String(compact);
        this.compactButton.setAttribute("aria-pressed", String(compact));
        this.detailedButton.setAttribute("aria-pressed", String(!compact));
        this.render();
    }
    private row(tab: ElementTab) {
        const row = element("div", style.row);
        row.dataset["tabId"] = tab.id;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(tab.id === this.selected));
        row.setAttribute("aria-label", `${tabName(tab)}, ${kindName(tab)}`);
        row.tabIndex = tab.id === this.selected ? 0 : -1;
        if (tab.id === this.workspace.activeId) row.setAttribute("aria-current", "page");
        const content = element("div", style.rowText);
        const title = element("div", style.rowTitle);
        title.append(createCadIcon(tab.kind, tab.icon), element("span", style.name, tabName(tab)));
        if (tab.dirty) title.append(unsavedMark());
        content.append(title, element("span", style.kind, kindName(tab)));
        if (!this.compact) row.append(this.thumbnail(tab, style.thumbnail));
        row.append(content);
        row.title = tabName(tab);
        row.onclick = () => {
            this.selected = tab.id;
            this.workspace.activate(tab.id);
            this.focusSelected();
        };
        return row;
    }
    private thumbnail(tab: ElementTab, className: string) {
        const host = element("div", className);
        host.append(createCadIcon(tab.kind, tab.icon));
        let request = this.images.get(tab.id);
        if (!request) {
            const owner = this.workspace.document;
            request = Promise.resolve()
                .then(() => {
                    if (!owner) return undefined;
                    if (tab.node) return DocumentElements.kindOf(tab.node)?.thumbnail?.(tab.node, owner);
                    const view = this.workspace.app.views.find((view) => view.document === owner);
                    return view?.toThumbnail ? view.toThumbnail() : view?.toImage?.();
                })
                .catch(() => undefined);
            this.images.set(tab.id, request);
        }
        const revision = this.imageRevision;
        void request.then((source) => {
            if (!source || this.hidden || revision !== this.imageRevision) return;
            const image = element("img", "");
            image.alt = "";
            image.src = source;
            image.onerror = () => host.replaceChildren(createCadIcon(tab.kind, tab.icon));
            host.replaceChildren(image);
        });
        return host;
    }
    private renderPreview(tab?: ElementTab) {
        this.preview.replaceChildren();
        this.preview.hidden = !tab;
        if (!tab) return;
        const title = element("div", style.previewTitle);
        title.append(createCadIcon(tab.kind, tab.icon), element("strong", style.name, tabName(tab)));
        this.preview.setAttribute("aria-label", `Preview of ${tabName(tab)}`);
        this.preview.append(title, this.thumbnail(tab, style.previewImage));
    }
    private focusSelected() {
        this.list.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
    private keyDown(event: KeyboardEvent) {
        event.stopPropagation();
        if (event.key === "Escape") {
            event.preventDefault();
            if (this.sortMenu) {
                this.closeSort();
                this.sortButton.focus();
            } else this.close();
            return;
        }
        if (event.target !== this.search && !this.list.contains(event.target as Node)) return;
        const tabs = this.visibleTabs();
        if (event.key === "Enter") {
            event.preventDefault();
            if (this.selected) this.workspace.activate(this.selected);
            this.focusSelected();
            return;
        }
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !tabs.length) return;
        if (event.target === this.search && (event.key === "Home" || event.key === "End")) return;
        event.preventDefault();
        const current = tabs.findIndex((tab) => tab.id === this.selected);
        const index =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : Math.max(0, Math.min(tabs.length - 1, current + (event.key === "ArrowUp" ? -1 : 1)));
        this.selected = tabs[index].id;
        this.render();
        this.focusSelected();
    }
    private closeSort() {
        this.sortMenu?.remove();
        this.sortMenu = undefined;
        this.sortButton.setAttribute("aria-expanded", "false");
    }
    private readonly dismissSort = (event: PointerEvent) => {
        if (!this.sortMenu?.contains(event.target as Node) && !this.sortButton.contains(event.target as Node))
            this.closeSort();
    };
    private toggleSort() {
        if (this.sortMenu) {
            this.closeSort();
            return;
        }
        const menu = element("div", style.sortMenu);
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", "Sort tabs");
        for (const [key, name] of [
            ["order", "Tab order"],
            ["name", "Name"],
            ["type", "Type"],
        ] as const) {
            const item = element("button", style.sortItem, name);
            item.type = "button";
            item.setAttribute("role", "menuitemradio");
            item.setAttribute("aria-checked", String(this.sort === key));
            item.onclick = () => {
                this.sort = key;
                this.closeSort();
                this.render();
                this.sortButton.focus();
            };
            menu.append(item);
        }
        menu.onkeydown = (event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const items = [...menu.querySelectorAll("button")];
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            items[
                event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
            ]?.focus();
        };
        this.sortMenu = menu;
        this.append(menu);
        this.sortButton.setAttribute("aria-expanded", "true");
        menu.querySelector("button")?.focus();
    }
    private setWidth(width: number) {
        this.width = Math.max(250, Math.min(window.innerWidth * 0.6, width));
        this.style.width = `${this.width}px`;
    }
    private resize(event: PointerEvent) {
        if (event.button !== 0) return;
        event.preventDefault();
        this.stopResize?.();
        const x = event.clientX,
            width = this.width;
        const move = (event: PointerEvent) => this.setWidth(width + event.clientX - x);
        const end = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
            this.stopResize = undefined;
        };
        this.stopResize = end;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    }
}
customElements.define("chili-element-tabs-sidebar", ElementTabsSidebar);
