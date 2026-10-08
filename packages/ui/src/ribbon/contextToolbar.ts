// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    CommandStore,
    Config,
    effectiveShortcuts,
    formatShortcutKey,
    I18n,
    type IApplication,
    ObservableCollection,
    type PushButton,
    type Ribbon,
    type RibbonCommand,
    type RibbonTab,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import style from "./contextToolbar.module.css";
import { type RibbonCustomization, tabLabel } from "./customization";
import { DropdownController, getItemData } from "./dropdownController";

type Tool = PushButton | CommandKeys;
const keyOf = (tool: Tool): CommandKeys => (typeof tool === "string" ? tool : tool.command);
const button = (name: string, run: () => void): HTMLButtonElement => {
    const result = document.createElement("button");
    result.type = "button";
    result.title = name;
    result.setAttribute("aria-label", name);
    result.onclick = run;
    return result;
};

/** One context-sensitive row. Families remember their last tool without losing custom commands. */
export class ContextToolbar extends HTMLElement {
    private readonly chosen = new Map<string, Tool>();
    private readonly subscriptions: Array<() => void> = [];
    private menu?: HTMLElement;
    private menuEvents?: AbortController;
    private menuAnchor?: HTMLElement;
    private construction = false;
    private reconnectQueued = false;
    private readonly included = new Set<CommandKeys>();

    constructor(
        private readonly app: IApplication,
        private readonly ribbon: Ribbon,
        private readonly customization: RibbonCustomization,
    ) {
        super();
        this.className = style.root;
        this.setAttribute("role", "toolbar");
        this.setAttribute("aria-label", "Modeling tools");
        this.render();
    }

    connectedCallback(): void {
        this.ribbon.onPropertyChanged(this.onRibbonChange);
        this.ribbon.tabs.onCollectionChanged(this.reconnect);
        this.ribbon.quickCommands.onCollectionChanged(this.render);
        this.app.onPropertyChanged?.(this.onAppChange);
        Config.instance.onPropertyChanged(this.onConfigChange);
        document.addEventListener("chili-sketch-style", this.onSketchStyle);
        this.reconnect();
    }

    disconnectedCallback(): void {
        this.closeMenu();
        document.removeEventListener("chili-sketch-style", this.onSketchStyle);
        this.clearSubscriptions();
        this.ribbon.removePropertyChanged(this.onRibbonChange);
        this.ribbon.tabs.removeCollectionChanged(this.reconnect);
        this.ribbon.quickCommands.removeCollectionChanged(this.render);
        this.app.removePropertyChanged?.(this.onAppChange);
        Config.instance.removePropertyChanged(this.onConfigChange);
    }

    private clearSubscriptions(): void {
        this.subscriptions.splice(0).forEach((dispose) => dispose());
    }

    private readonly scheduleReconnect = () => {
        if (this.reconnectQueued) return;
        this.reconnectQueued = true;
        queueMicrotask(() => {
            this.reconnectQueued = false;
            if (this.isConnected) this.reconnect();
        });
    };

    private readonly reconnect = () => {
        this.clearSubscriptions();
        const watch = <T>(collection: ObservableCollection<T>) => {
            collection.onCollectionChanged(this.scheduleReconnect);
            this.subscriptions.push(() => collection.removeCollectionChanged(this.scheduleReconnect));
        };
        for (const tab of this.ribbon.tabs) {
            tab.onPropertyChanged(this.render);
            this.subscriptions.push(() => tab.removePropertyChanged(this.render));
            watch(tab.groups);
            for (const group of tab.groups) {
                watch(group.items);
                watch(group.collapsedItems);
            }
        }
        this.render();
    };
    private readonly onRibbonChange = (property: keyof Ribbon) => {
        if (property === "activeTab") this.render();
    };
    private readonly onAppChange = (property: keyof IApplication) => {
        if (property === "executingCommand") this.refreshActiveTool();
    };
    private readonly onConfigChange = (property: keyof Config) => {
        if (property === "customShortcuts" || property === "navigation3D") this.render();
    };

    private readonly onSketchStyle = (event: Event) => {
        this.construction = (event as CustomEvent<{ construction: boolean }>).detail.construction;
        this.refreshActiveTool();
    };

    private shortcut(key: CommandKeys): string {
        const keys = effectiveShortcuts(Config.instance.navigation3D, Config.instance.customShortcuts)[key];
        return (
            (Array.isArray(keys) ? keys : keys ? [keys] : []).map(formatShortcutKey).join(" / ") ||
            (Config.instance.customShortcuts[key] === undefined
                ? key === "sketch.construction"
                    ? "Q"
                    : key === "sketch.normal"
                      ? "N"
                      : ""
                : "")
        );
    }

    private tool(tool: Tool, label = false): HTMLButtonElement {
        this.included.add(keyOf(tool));
        const data = getItemData(tool);
        const name = I18n.translate(data.display);
        const shortcut = this.shortcut(data.command);
        const item = button(name, () => {
            this.closeMenu();
            data.onClick();
        });
        item.title = shortcut ? `${name} (${shortcut})` : name;
        item.dataset["command"] = data.command;
        item.append(createCadIcon(data.command, data.icon));
        if (label) item.append(document.createTextNode(name));
        return item;
    }

    private family(tools: Tool[], name?: string, remember = true): HTMLElement {
        tools.forEach((tool) => this.included.add(keyOf(tool)));
        const family = document.createElement("div");
        family.className = style.family;
        const id = tools.map(keyOf).join("|");
        const selected = this.chosen.get(id) ?? tools[0];
        if (remember) family.append(this.tool(selected));
        const arrow = button(name ?? `${I18n.translate(getItemData(selected).display)} tools`, () => {
            this.openMenu(
                arrow,
                tools.map((tool) => {
                    const row = this.tool(tool, true);
                    row.setAttribute("role", "menuitem");
                    const shortcut = document.createElement("kbd");
                    shortcut.textContent = this.shortcut(keyOf(tool));
                    row.append(shortcut);
                    row.onclick = () => {
                        if (remember) this.chosen.set(id, tool);
                        this.closeMenu();
                        this.render();
                        getItemData(tool).onClick();
                    };
                    return row;
                }),
            );
        });
        arrow.className = remember ? style.arrow : style.groupMenu;
        arrow.setAttribute("aria-haspopup", "menu");
        arrow.setAttribute("aria-expanded", "false");
        arrow.textContent = remember ? "▾" : `${name} ▾`;
        family.append(arrow);
        return family;
    }

    private appendCommand(parent: HTMLElement, command: RibbonCommand): void {
        if (
            typeof command === "string" ||
            (!(command instanceof ObservableCollection) && command.type === "push")
        ) {
            parent.append(this.tool(command));
        } else if (command instanceof ObservableCollection) {
            const tools = command.items();
            if (tools.length > 1) parent.append(this.family(tools));
            else if (tools[0]) parent.append(this.tool(tools[0]));
        } else {
            parent.append(
                this.family(
                    command.items,
                    command.type === "pulldown" ? I18n.translate(command.display) : undefined,
                    command.type !== "pulldown",
                ),
            );
        }
    }

    private workspaceName(tab: RibbonTab): string {
        if (tab.label) return tab.label;
        if (tab.tabName === "ribbon.tab.parametric") return "Part Studio";
        if (tab.tabName === "ribbon.tab.model") return "Direct modeling";
        return tabLabel(tab);
    }

    private readonly render = () => {
        this.closeMenu();
        this.replaceChildren();
        this.included.clear();
        const tab = this.ribbon.activeTab;
        if (!tab) return;
        this.dataset["tab"] = tab.tabName;
        const workspace = button("Choose toolset", () => {
            this.openMenu(
                workspace,
                this.ribbon.tabs
                    .filter((item) => item.visible)
                    .map((item) => {
                        const row = button(this.workspaceName(item), () => {
                            this.closeMenu();
                            this.ribbon.activeTab = item;
                        });
                        row.textContent = this.workspaceName(item);
                        row.dataset["ribbonTab"] = item.tabName;
                        row.setAttribute("role", "menuitemradio");
                        row.setAttribute("aria-checked", String(item === tab));
                        return row;
                    }),
            );
        });
        workspace.className = style.workspace;
        workspace.dataset["ribbonTab"] = tab.tabName;
        workspace.setAttribute("aria-haspopup", "menu");
        workspace.setAttribute("aria-expanded", "false");
        workspace.textContent = `${this.workspaceName(tab)} ▾`;
        this.append(workspace);
        const row = document.createElement("div");
        row.className = style.tools;
        this.append(row);
        const pinned = this.ribbon.quickCommands.items();
        const quick: CommandKeys[] = ["edit.undo", "edit.redo"];
        for (const key of quick) row.append(this.tool(key));
        this.separator(row);
        if (tab.tabName === "ribbon.tab.sketch") {
            row.append(
                this.tool("sketch.line"),
                this.tool("sketch.rectangle"),
                this.family(["sketch.circle", "sketch.circle3Point"], "Circle tools"),
                this.tool("sketch.arc"),
            );
            this.separator(row);
            row.append(this.tool("sketch.construction"), this.tool("sketch.projectEdges"));
            this.separator(row);
            row.append(
                this.family(
                    [
                        "dimension.distance",
                        "dimension.radius",
                        "dimension.angle",
                        "dimension.horizontalDistance",
                        "dimension.verticalDistance",
                        "dimension.pointLineDistance",
                    ],
                    "Dimensions",
                ),
            );
            this.separator(row);
            for (const key of [
                "coincident",
                "horizontal",
                "vertical",
                "perpendicular",
                "parallel",
                "tangent",
                "equal",
                "fix",
            ] as const)
                row.append(this.tool(`constraint.${key}`));
            row.append(
                this.family(
                    [
                        "constraint.midpoint",
                        "constraint.symmetric",
                        "constraint.pointOn",
                        "constraint.horizontalAlign",
                        "constraint.verticalAlign",
                    ],
                    "More constraints",
                    false,
                ),
            );
            this.separator(row);
            row.append(
                this.tool("sketch.normal"),
                this.family(
                    ["sketch.projectEdges", "sketch.toggleExternal", "sketch.export"],
                    "Sketch utilities",
                    false,
                ),
            );
            // Preserve commands contributed by plugins and user tabs beyond this core arrangement.
            this.included.add("sketch.exit");
            this.included.add("sketch.cancel");
            for (const group of tab.groups) {
                for (const tool of group.items) {
                    if (typeof tool === "string") {
                        if (!this.included.has(tool)) this.appendCommand(row, tool);
                    } else if (tool instanceof ObservableCollection) {
                        for (const key of tool) if (!this.included.has(key)) this.appendCommand(row, key);
                    } else if (tool.type === "push") {
                        if (!this.included.has(tool.command)) this.appendCommand(row, tool);
                    } else {
                        const remaining = tool.items.filter((item) => !this.included.has(keyOf(item)));
                        if (remaining.length) this.appendCommand(row, { ...tool, items: remaining });
                    }
                }
                const extra = group.collapsedItems.filter((key) => !this.included.has(key));
                if (extra.length) row.append(this.family(extra, I18n.translate(group.groupName), false));
            }
        } else {
            if (tab.tabName === "ribbon.tab.parametric") {
                row.append(this.family(["sketch.create", "sketch.enter"], "Sketch tools"));
                const available = new Set<CommandKeys>();
                for (const group of tab.groups)
                    for (const item of group.items) {
                        if (typeof item === "string") available.add(item);
                    }
                for (const [name, tools] of [
                    ["Solid features", ["feature.extrude", "feature.revolve"]],
                    ["Edge treatments", ["feature.fillet", "feature.chamfer"]],
                    ["Boolean operations", ["feature.fuse", "feature.cut", "feature.common"]],
                    [
                        "FeatureScript",
                        ["featurescript.insert", "featurescript.newStudio", "featurescript.editStudio"],
                    ],
                ] as const) {
                    const supported = tools.filter((key) => available.has(key));
                    if (supported.length) row.append(this.family(supported, name));
                }
            }
            for (const group of tab.groups) {
                const items = group.items
                    .items()
                    .filter((item) => typeof item !== "string" || !this.included.has(item));
                if (!items.length && !group.collapsedItems.length) continue;
                for (const item of items) this.appendCommand(row, item);
                if (group.collapsedItems.length)
                    row.append(
                        this.family(group.collapsedItems.items(), I18n.translate(group.groupName), false),
                    );
                this.separator(row);
            }
        }
        const extras = pinned.filter((key) => !quick.includes(key));
        if (extras.length) {
            this.separator(row);
            for (const key of extras) row.append(this.tool(key));
        }
        const search = button("Search tools", () => this.customization.searchTools());
        search.className = style.search;
        search.append(createCadIcon("search"), document.createTextNode("Search tools…"));
        this.append(search);
        this.refreshActiveTool();
    };

    private separator(parent: HTMLElement): void {
        const separator = document.createElement("span");
        separator.className = style.separator;
        separator.setAttribute("role", "separator");
        parent.append(separator);
    }

    private refreshActiveTool(): void {
        const executing = this.app.executingCommand;
        const command = executing && CommandStore.getComandData(executing)?.key;
        this.querySelectorAll<HTMLButtonElement>("[data-command]").forEach((item) => {
            item.setAttribute(
                "aria-pressed",
                String(
                    item.dataset["command"] === "sketch.construction"
                        ? this.construction
                        : item.dataset["command"] === command,
                ),
            );
        });
    }

    private closeMenu(): void {
        this.menuEvents?.abort();
        this.menu?.remove();
        this.menuAnchor?.setAttribute("aria-expanded", "false");
        this.menu = undefined;
        this.menuEvents = undefined;
        this.menuAnchor = undefined;
    }

    private openMenu(anchor: HTMLElement, rows: HTMLElement[]): void {
        const alreadyOpen = anchor === this.menuAnchor;
        this.closeMenu();
        DropdownController.closeAll();
        if (alreadyOpen) return;
        const menu = document.createElement("div");
        menu.className = style.menu;
        menu.setAttribute("role", "menu");
        menu.append(...rows);
        document.body.append(menu);
        const rect = anchor.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 2}px`;
        menu.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 4))}px`;
        this.menu = menu;
        this.menuAnchor = anchor;
        anchor.setAttribute("aria-expanded", "true");
        const controller = new AbortController();
        this.menuEvents = controller;
        document.addEventListener(
            "pointerdown",
            (event) => {
                if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node))
                    this.closeMenu();
            },
            { signal: controller.signal },
        );
        menu.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
                this.closeMenu();
                anchor.focus();
            }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const current = rows.indexOf(document.activeElement as HTMLElement);
                const next =
                    event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? rows.length - 1
                          : (current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
                rows[next]?.focus();
            }
        });
        rows[0]?.focus();
    }
}

customElements.define("chili-context-toolbar", ContextToolbar);
