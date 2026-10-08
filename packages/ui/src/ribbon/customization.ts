// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    CommandStore,
    Config,
    effectiveShortcuts,
    formatShortcutKey,
    I18n,
    normalizeShortcut,
    PubSub,
    type Ribbon,
    RibbonGroup,
    RibbonTab,
    type RibbonTabKeys,
    type RibbonTabPreference,
} from "@chili3d/core";
import { button, div, input, label, option, select } from "@chili3d/element";
import style from "./customization.module.css";
import { DropdownController } from "./dropdownController";

export function tabLabel(tab: RibbonTab): string {
    return tab.label || I18n.translate(tab.tabName);
}

/** Owns the menus/dialogs and persists only user overrides, preserving module contributions. */
export class RibbonCustomization {
    private menu?: HTMLElement;
    private menuEvents?: AbortController;
    private dialog?: HTMLDialogElement;

    constructor(private readonly ribbon: Ribbon) {}

    private save(): void {
        Config.instance.saveToStorage();
    }

    private updateTab(tab: RibbonTab, change: RibbonTabPreference): void {
        const config = Config.instance;
        const prefs = config.ribbonPreferences;
        config.ribbonPreferences = {
            ...prefs,
            tabs: { ...prefs.tabs, [tab.tabName]: { ...prefs.tabs?.[tab.tabName], ...change } },
        };
        this.save();
    }

    start(): void {
        document.addEventListener("contextmenu", this.onContextMenu, true);
    }

    dispose(): void {
        document.removeEventListener("contextmenu", this.onContextMenu, true);
        this.closeMenu();
        this.dialog?.close();
        this.dialog?.remove();
    }

    private readonly onContextMenu = (event: MouseEvent) => {
        const target = event.target instanceof Element ? event.target : undefined;
        const tool = target?.closest<HTMLElement>("[data-command]");
        const tab = target?.closest<HTMLElement>("[data-ribbon-tab]");
        if (tool) {
            const command = tool.dataset["command"] as CommandKeys;
            if (!CommandStore.getComandData(command)) return;
            event.preventDefault();
            event.stopPropagation();
            this.openToolMenu(
                command,
                event.clientX,
                event.clientY,
                tool.closest<HTMLElement>("[data-tab]")?.dataset["tab"],
            );
        } else if (tab) {
            event.preventDefault();
            event.stopPropagation();
            this.manageTabs();
        }
    };

    private closeMenu(): void {
        this.menuEvents?.abort();
        this.menu?.remove();
        this.menu = undefined;
    }

    private openToolMenu(command: CommandKeys, x: number, y: number, sourceTab?: string): void {
        this.closeMenu();
        DropdownController.closeAll();
        const menu = div({ className: style.menu, role: "menu" });
        this.menu = menu;
        menu.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") this.closeMenu();
        });
        const action = (text: string, run: () => void) =>
            button({
                textContent: text,
                role: "menuitem",
                onclick: () => {
                    this.closeMenu();
                    run();
                },
            });
        const pinned = this.ribbon.quickCommands.contains(command);
        menu.append(
            div({ className: style.heading, textContent: I18n.translate(`command.${command}`) }),
            action("Assign keyboard shortcut…", () => this.assignShortcut(command)),
            action(pinned ? "Unpin tool" : "Pin tool", () => {
                if (pinned) this.ribbon.quickCommands.remove(command);
                else this.ribbon.quickCommands.push(command);
                Config.instance.ribbonPreferences = {
                    ...Config.instance.ribbonPreferences,
                    pins: this.ribbon.quickCommands.items(),
                };
                this.save();
            }),
            action("Add to tab…", () => this.addToTab(command)),
        );
        const source = this.ribbon.tabs.find((tab) => tab.tabName === sourceTab);
        if (source && Config.instance.ribbonPreferences.tabs?.[source.tabName]?.commands?.includes(command)) {
            menu.append(
                action("Remove from this tab", () => {
                    source.groups
                        .find((group) => group.groupName === "ribbon.group.custom")
                        ?.items.remove(command);
                    this.updateTab(source, {
                        commands: Config.instance.ribbonPreferences.tabs?.[source.tabName]?.commands?.filter(
                            (key) => key !== command,
                        ),
                    });
                }),
            );
        }
        menu.append(action("Customize tabs…", () => this.manageTabs()));
        document.body.append(menu);
        menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
        this.menuEvents = new AbortController();
        document.addEventListener(
            "pointerdown",
            (event) => {
                if (!menu.contains(event.target as Node)) this.closeMenu();
            },
            { signal: this.menuEvents.signal },
        );
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key === "Escape") this.closeMenu();
            },
            { signal: this.menuEvents.signal },
        );
        menu.querySelector<HTMLButtonElement>("button")?.focus();
    }

    private openDialog(title: string): { content: HTMLElement; close: () => void } {
        this.dialog?.close();
        this.dialog?.remove();
        const dialog = document.createElement("dialog");
        dialog.className = style.dialog;
        dialog.setAttribute("aria-label", title);
        const close = () => {
            dialog.close();
            dialog.remove();
        };
        const content = div({ className: style.dialogContent });
        dialog.append(
            div(
                { className: style.dialogHeader },
                div({ textContent: title }),
                button({ textContent: "×", title: "Close", onclick: close }),
            ),
            content,
        );
        dialog.addEventListener("keydown", (event) => event.stopPropagation());
        dialog.addEventListener("close", () => dialog.remove());
        document.body.append(dialog);
        this.dialog = dialog;
        dialog.showModal();
        return { content, close };
    }

    assignShortcut(command: CommandKeys): void {
        const { content, close } = this.openDialog(`Shortcut · ${I18n.translate(`command.${command}`)}`);
        const shortcuts = effectiveShortcuts(Config.instance.navigation3D, Config.instance.customShortcuts);
        const existing = shortcuts[command];
        let recorded = typeof existing === "string" ? existing : (existing?.[0] ?? "");
        const field = input({
            placeholder: "Press a key combination",
            readOnly: true,
            value: recorded ? formatShortcutKey(recorded) : "",
        });
        field.setAttribute("aria-label", "Keyboard shortcut");
        const message = div({
            className: style.hint,
            textContent: "Click the field and press a key combination.",
        });
        const save = button({
            textContent: "Save shortcut",
            onclick: () => {
                Config.instance.customShortcuts = { ...Config.instance.customShortcuts, [command]: recorded };
                this.save();
                close();
            },
        });
        field.addEventListener("keydown", (event) => {
            if (event.key === "Tab" || event.key === "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
            recorded = normalizeShortcut(
                [
                    event.ctrlKey || event.metaKey ? "ctrl" : "",
                    event.shiftKey ? "shift" : "",
                    event.altKey ? "alt" : "",
                    event.key.toLowerCase(),
                ]
                    .filter(Boolean)
                    .join("+"),
            );
            field.value = formatShortcutKey(recorded);
            const conflict = Object.entries(shortcuts).find(
                ([key, value]) =>
                    key !== command &&
                    (Array.isArray(value) ? value : [value]).some(
                        (key) => key && normalizeShortcut(key) === recorded,
                    ),
            );
            message.textContent = conflict
                ? `Already assigned to ${I18n.translate(`command.${conflict[0]}` as `command.${CommandKeys}`)}. Choose another shortcut.`
                : "Ready to save.";
            save.disabled = !!conflict;
        });
        content.append(
            field,
            message,
            div(
                { className: style.actions },
                button({
                    textContent: "Remove shortcut",
                    onclick: () => {
                        Config.instance.customShortcuts = {
                            ...Config.instance.customShortcuts,
                            [command]: "",
                        };
                        this.save();
                        close();
                    },
                }),
                button({
                    textContent: "Use default",
                    onclick: () => {
                        const overrides = { ...Config.instance.customShortcuts };
                        delete overrides[command];
                        Config.instance.customShortcuts = overrides;
                        this.save();
                        close();
                    },
                }),
                save,
            ),
        );
        field.focus();
    }

    addToTab(command: CommandKeys): void {
        const { content, close } = this.openDialog("Add tool to tab");
        const tabs = select(
            {},
            ...this.ribbon.tabs
                .items()
                .map((tab) => option({ value: tab.tabName, textContent: tabLabel(tab) })),
        );
        tabs.setAttribute("aria-label", "Destination tab");
        content.append(
            div({ textContent: I18n.translate(`command.${command}`) }),
            tabs,
            button({
                textContent: "Add tool",
                onclick: () => {
                    const tab = this.ribbon.tabs.find((item) => item.tabName === tabs.value);
                    if (!tab) return;
                    const commands = [
                        ...new Set([
                            ...(Config.instance.ribbonPreferences.tabs?.[tab.tabName]?.commands ?? []),
                            command,
                        ]),
                    ];
                    let group = tab.groups.find((item) => item.groupName === "ribbon.group.custom");
                    if (!group) {
                        group = new RibbonGroup("ribbon.group.custom", []);
                        tab.groups.push(group);
                    }
                    if (!group.items.contains(command)) group.items.push(command);
                    this.updateTab(tab, { commands });
                    close();
                },
            }),
        );
    }

    manageTabs(): void {
        const { content } = this.openDialog("Customize tabs");
        const layout = select(
            {
                onchange: () => {
                    Config.instance.ribbonPreferences = {
                        ...Config.instance.ribbonPreferences,
                        layout: layout.value as "context" | "ribbon",
                    };
                    this.save();
                },
            },
            option({ value: "context", textContent: "Context toolbar" }),
            option({ value: "ribbon", textContent: "Ribbon tabs" }),
        );
        layout.value = Config.instance.ribbonPreferences.layout ?? "context";
        layout.setAttribute("aria-label", "Toolbar layout");
        content.append(label({}, document.createTextNode("Toolbar layout "), layout));
        const compact = input({
            type: "checkbox",
            checked: Config.instance.ribbonPreferences.compact !== false,
            onchange: () => {
                Config.instance.ribbonPreferences = {
                    ...Config.instance.ribbonPreferences,
                    compact: compact.checked,
                };
                this.save();
            },
        });
        content.append(label({}, compact, document.createTextNode(" Compact ribbon (ribbon layout)")));
        const list = div({ className: style.tabList });
        const render = () => {
            list.replaceChildren();
            const tabs = this.ribbon.tabs.items();
            tabs.forEach((tab, index) => {
                const name = input({
                    value: tabLabel(tab),
                    onchange: () => {
                        if (!name.value.trim()) {
                            name.value = tabLabel(tab);
                            return;
                        }
                        tab.label = name.value.trim();
                        this.updateTab(tab, { label: tab.label });
                    },
                });
                name.setAttribute("aria-label", `Tab name: ${tabLabel(tab)}`);
                const visible = input({
                    type: "checkbox",
                    checked: tab.contextual || tab.visible,
                    disabled: tab.contextual,
                    onchange: () => {
                        if (
                            !visible.checked &&
                            tabs.filter((item) => item.visible && !item.contextual).length <= 1
                        ) {
                            visible.checked = true;
                            return;
                        }
                        tab.visible = visible.checked;
                        this.updateTab(tab, { hidden: !tab.visible });
                        if (!tab.visible && this.ribbon.activeTab === tab)
                            this.ribbon.activeTab = tabs.find((item) => item.visible)!;
                    },
                });
                visible.setAttribute("aria-label", `Show ${tabLabel(tab)}`);
                const move = (offset: number) => {
                    const reordered = [...tabs];
                    reordered.splice(index, 1);
                    reordered.splice(index + offset, 0, tab);
                    this.ribbon.tabs.clear();
                    this.ribbon.tabs.push(...reordered);
                    Config.instance.ribbonPreferences = {
                        ...Config.instance.ribbonPreferences,
                        tabOrder: reordered.map((item) => item.tabName),
                    };
                    this.save();
                    render();
                };
                const row = div(
                    { className: style.tabRow },
                    visible,
                    name,
                    button({
                        textContent: "↑",
                        title: `Move ${tabLabel(tab)} left`,
                        disabled: index === 0,
                        onclick: () => move(-1),
                    }),
                    button({
                        textContent: "↓",
                        title: `Move ${tabLabel(tab)} right`,
                        disabled: index === tabs.length - 1,
                        onclick: () => move(1),
                    }),
                );
                if (Config.instance.ribbonPreferences.tabs?.[tab.tabName]?.custom)
                    row.append(
                        button({
                            textContent: "×",
                            title: `Delete ${tabLabel(tab)}`,
                            onclick: () => {
                                this.ribbon.tabs.remove(tab);
                                if (this.ribbon.activeTab === tab)
                                    this.ribbon.activeTab = this.ribbon.tabs.find((item) => item.visible)!;
                                const preferences = { ...Config.instance.ribbonPreferences.tabs };
                                delete preferences[tab.tabName];
                                Config.instance.ribbonPreferences = {
                                    ...Config.instance.ribbonPreferences,
                                    tabs: preferences,
                                };
                                this.save();
                                render();
                            },
                        }),
                    );
                list.append(row);
            });
        };
        render();
        const name = input({ placeholder: "New tab name" });
        name.setAttribute("aria-label", "New tab name");
        content.append(
            list,
            div(
                { className: style.actions },
                name,
                button({
                    textContent: "Create tab",
                    onclick: () => {
                        if (!name.value.trim()) return;
                        const tab = new RibbonTab(`custom.${crypto.randomUUID()}` as RibbonTabKeys);
                        tab.label = name.value.trim();
                        this.ribbon.tabs.push(tab);
                        this.updateTab(tab, { custom: true, label: tab.label });
                        this.ribbon.activeTab = tab;
                        name.value = "";
                        render();
                    },
                }),
            ),
            div({
                className: style.hint,
                textContent:
                    "Right-click any tool to pin it, set a shortcut, or add it to a tab. Sketch tabs appear while editing a sketch.",
            }),
        );
    }

    searchTools(): void {
        const { content, close } = this.openDialog("Search tools");
        const query = input({ placeholder: "Search tools…", type: "search" });
        query.setAttribute("aria-label", "Search tools");
        const results = div({ className: style.searchResults });
        const render = () => {
            results.replaceChildren();
            for (const command of CommandStore.getAllCommands()
                .filter((item) =>
                    I18n.translate(`command.${item.key}`).toLowerCase().includes(query.value.toLowerCase()),
                )
                .slice(0, 80)) {
                results.append(
                    button({
                        textContent: I18n.translate(`command.${command.key}`),
                        dataset: { command: command.key },
                        onclick: () => {
                            close();
                            PubSub.default.pub("executeCommand", command.key);
                        },
                    }),
                );
            }
        };
        query.addEventListener("input", render);
        content.append(query, results);
        render();
        query.focus();
    }
}
