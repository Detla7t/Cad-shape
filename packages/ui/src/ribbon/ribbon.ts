// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    applyRibbonPreferences,
    Binding,
    type CommandKeys,
    CommandStore,
    Config,
    I18n,
    type IApplication,
    type ICommand,
    type IConverter,
    type IDocument,
    type IView,
    Localize,
    Logger,
    PubSub,
    Result,
    type Ribbon,
    type RibbonGroup,
    type RibbonTab,
    type RibbonTabKeys,
} from "@chili3d/core";
import { button, collection, createCadIcon, createIcon, div, label, span, svg } from "@chili3d/element";
import { PreferencesDialog } from "../preferences/preferencesDialog";
import { ShortcutToolbar } from "../preferences/shortcutToolbar";
import { ContextToolbar } from "./contextToolbar";
import { RibbonCustomization, tabLabel } from "./customization";
import style from "./ribbon.module.css";
import type { RibbonPushButton } from "./ribbonButton";
import { RibbonGroupElement } from "./ribbonGroup";

export const QuickButton = (command: ICommand) => {
    const data = CommandStore.getComandData(command);
    if (!data) {
        Logger.warn("commandData is undefined");
        return span({ textContent: "null" });
    }

    const icon = createIcon(data.icon);
    icon.classList.add(style.icon);
    return span(
        {
            title: new Localize(`command.${data.key}`),
            dataset: { command: data.key },
            onclick: () => PubSub.default.pub("executeCommand", data.key),
        },
        icon,
    );
};

class ViewActiveConverter implements IConverter<IView> {
    constructor(
        readonly target: IView,
        readonly style: string,
        readonly activeStyle: string,
    ) {}

    convert(value: IView): Result<string> {
        return Result.ok(
            this.target.document === value?.document ? `${this.style} ${this.activeStyle}` : this.style,
        );
    }
}

class ActivedRibbonTabConverter implements IConverter<RibbonTab> {
    constructor(
        readonly tab: RibbonTab,
        readonly style: string,
        readonly activeStyle: string,
    ) {}

    convert(value: RibbonTab): Result<string> {
        return Result.ok(this.tab === value ? `${this.style} ${this.activeStyle}` : this.style);
    }
}

class DisplayConverter<T> implements IConverter<T> {
    constructor(readonly predicate: (value: T) => boolean) {}

    convert(value: T): Result<string> {
        return Result.ok(this.predicate(value) ? "" : "none");
    }
}

export class RibbonUI extends HTMLElement {
    private readonly customization: RibbonCustomization;
    private readonly shortcutToolbar: ShortcutToolbar;
    private preferences?: PreferencesDialog;
    private readonly resetToolbar: () => void;
    constructor(
        readonly app: IApplication,
        readonly dataContent: Ribbon,
    ) {
        super();
        const originalTabs = dataContent.tabs
            .items()
            .map((tab) => ({ tab, label: tab.label, visible: tab.visible, groups: tab.groups.items() }));
        const originalPins = dataContent.quickCommands.items();
        this.resetToolbar = () => {
            const active = dataContent.activeTab;
            for (const item of originalTabs) {
                item.tab.label = item.label;
                if (!item.tab.contextual) item.tab.visible = item.visible;
                item.tab.groups.clear();
                item.tab.groups.push(...item.groups);
            }
            dataContent.tabs.clear();
            dataContent.tabs.push(...originalTabs.map((item) => item.tab));
            dataContent.quickCommands.clear();
            dataContent.quickCommands.push(...originalPins);
            dataContent.activeTab = originalTabs.some((item) => item.tab === active)
                ? active
                : dataContent.tabs.find((tab) => tab.visible)!;
            Config.instance.ribbonPreferences = {};
            Config.instance.saveToStorage();
        };
        applyRibbonPreferences(dataContent, Config.instance.ribbonPreferences);
        this.customization = new RibbonCustomization(dataContent);
        this.shortcutToolbar = new ShortcutToolbar(dataContent);
        this.className = style.root;
        this.dataset["compact"] = String(Config.instance.ribbonPreferences.compact !== false);
        this.dataset["layout"] = Config.instance.ribbonPreferences.layout ?? "context";
        const parametric = dataContent.tabs.find(
            (tab) => tab.tabName === "ribbon.tab.parametric" && tab.visible,
        );
        if (this.dataset["layout"] === "context" && parametric && !dataContent.activeTab?.contextual)
            dataContent.activeTab = parametric;
        const home = button(
            { title: "Home", onclick: () => PubSub.default.pub("displayHome", true) },
            createCadIcon("box"),
            span({ textContent: "Chili3D" }),
        );
        const customize = button(
            { title: "Customize tools and tabs", onclick: () => this.customization.manageTabs() },
            createCadIcon("menu"),
        );
        const documentHeader = div(
            { className: style.documentHeader },
            home,
            this.centerPanel(),
            this.preferencesButton(),
            customize,
        );
        this.append(
            div({ className: style.legacy }, this.header(), this.ribbonTabs()),
            div(
                { className: style.context },
                documentHeader,
                new ContextToolbar(app, dataContent, this.customization),
            ),
        );
    }

    private header() {
        return div(
            { className: style.titleBar },
            this.leftPanel(),
            this.centerPanel(),
            this.preferencesButton(),
            this.rightPanel(),
        );
    }

    private preferencesButton() {
        return button(
            { title: "Preferences", ariaLabel: "Preferences", onclick: () => this.openPreferences() },
            createCadIcon("settings"),
        );
    }

    private readonly openPreferences = (model?: IDocument, section?: string) => {
        this.preferences?.dispose();
        this.preferences = new PreferencesDialog(
            this.dataContent,
            this.resetToolbar,
            model ?? this.app.activeView?.document,
        ).show(section ?? "language");
    };

    private leftPanel() {
        return div(
            { className: style.left },
            div(
                { className: style.appIcon, onclick: () => PubSub.default.pub("displayHome", true) },
                svg({ className: style.icon, icon: "icon-chili" }),
                span({ id: "appName", textContent: `Chili3D - v${__APP_VERSION__}` }),
            ),
            div(
                { className: style.ribbonTitlePanel },
                svg({
                    className: style.home,
                    icon: "icon-home",
                    onclick: () => PubSub.default.pub("displayHome", true),
                }),
                collection({
                    className: style.quickCommands,
                    sources: this.dataContent.quickCommands,
                    template: (command: CommandKeys) => QuickButton(command as any),
                }),
                span({ className: style.split }),
                this.createRibbonHeader(),
            ),
        );
    }

    private createRibbonHeader() {
        return collection({
            sources: this.dataContent.tabs,
            template: (tab: RibbonTab) => {
                const converter = new ActivedRibbonTabConverter(tab, style.tabHeader, style.activedTab);
                return label({
                    className: new Binding(this.dataContent, "activeTab", converter),
                    textContent: new Binding(tab, "label", { convert: () => Result.ok(tabLabel(tab)) }),
                    dataset: { ribbonTab: tab.tabName },
                    title: "Right-click to customize tabs",
                    style: {
                        display: new Binding(
                            tab,
                            "visible",
                            new DisplayConverter((visible: boolean) => visible),
                        ),
                    },
                    onclick: () => {
                        this.dataContent.activeTab = tab;
                    },
                });
            },
        });
    }

    private centerPanel() {
        return div(
            { className: style.center },
            collection({
                className: style.views,
                sources: this.app.views,
                template: (view) => this.createViewItem(view),
            }),
            svg({
                className: style.new,
                icon: "icon-plus",
                title: I18n.translate("command.doc.new"),
                onclick: () => PubSub.default.pub("executeCommand", "doc.new"),
            }),
        );
    }

    private createViewItem(view: IView) {
        return div(
            {
                className: new Binding(
                    this.app,
                    "activeView",
                    new ViewActiveConverter(view, style.tab, style.active),
                ),
                dataset: { viewDocument: view.document.id },
                onclick: () => {
                    this.app.activeView = view;
                },
            },
            div({ className: style.name }, span({ textContent: new Binding(view.document, "name") })),
            svg({
                className: style.close,
                icon: "icon-times",
                onclick: (e) => {
                    e.stopPropagation();
                    void view.document.close();
                },
            }),
        );
    }

    private rightPanel() {
        return div(
            { className: style.right },
            button({
                className: style.searchTools,
                textContent: "Search tools…",
                onclick: () => this.customization.searchTools(),
            }),
            button({
                className: style.customize,
                title: "Customize tabs",
                textContent: "⚙",
                onclick: () => this.customization.manageTabs(),
            }),
        );
    }

    private ribbonTabs() {
        return collection({
            className: style.tabContentPanel,
            sources: this.dataContent.tabs,
            template: (tab: RibbonTab) => this.ribbonTab(tab),
        });
    }

    private ribbonTab(tab: RibbonTab) {
        return collection({
            className: style.groupPanel,
            dataset: { tab: tab.tabName },
            sources: tab.groups,
            style: {
                display: new Binding(
                    this.dataContent,
                    "activeTab",
                    new DisplayConverter((tb: RibbonTab) => tab === tb),
                ),
            },
            template: (group: RibbonGroup) => new RibbonGroupElement(group),
        });
    }

    connectedCallback(): void {
        PubSub.default.sub("openPreferences", this.openPreferences);
        this.shortcutToolbar.start();
        this.app.views.onCollectionChanged?.(this.syncDocumentTabs);
        this.syncDocumentTabs();
        this.customization.start();
        Config.instance.onPropertyChanged(this.handleConfigChanged);
        this.dataContent.onPropertyChanged(this.syncContext);
        this.dataContent.quickCommands.onCollectionChanged(this.syncContext);
        this.syncContext();
    }

    disconnectedCallback(): void {
        PubSub.default.remove("openPreferences", this.openPreferences);
        this.shortcutToolbar.dispose();
        this.preferences?.dispose();
        this.app.views.removeCollectionChanged?.(this.syncDocumentTabs);
        this.customization.dispose();
        Config.instance.removePropertyChanged(this.handleConfigChanged);
        this.dataContent.removePropertyChanged(this.syncContext);
        this.dataContent.quickCommands.removeCollectionChanged(this.syncContext);
    }

    private readonly syncContext = () => {
        const legacy = this.querySelector(`.${style.legacy}`);
        legacy?.querySelectorAll<HTMLElement>("[data-command]").forEach((element) => {
            element.hidden = !this.dataContent.isCommandAvailable(element.dataset["command"] as CommandKeys);
        });
        legacy?.querySelectorAll<HTMLElement>("[data-ribbon-tab]").forEach((element) => {
            const tab = this.dataContent.tabs.find((tab) => tab.tabName === element.dataset["ribbonTab"]);
            element.hidden = !!tab && !this.dataContent.isTabAvailable(tab);
        });
    };

    private readonly syncDocumentTabs = () => {
        queueMicrotask(() => {
            for (const group of this.querySelectorAll(`.${style.views}`)) {
                const seen = new Set<string>();
                for (const tab of group.querySelectorAll<HTMLElement>("[data-view-document]")) {
                    const id = tab.dataset["viewDocument"]!;
                    tab.style.display = seen.has(id) ? "none" : "";
                    seen.add(id);
                }
            }
        });
    };

    private readonly handleConfigChanged = (prop: keyof Config) => {
        if (prop === "ribbonPreferences") {
            this.dataset["compact"] = String(Config.instance.ribbonPreferences.compact !== false);
            this.dataset["layout"] = Config.instance.ribbonPreferences.layout ?? "context";
        }
        if (prop === "navigation3D" || prop === "customShortcuts") {
            this.querySelectorAll("ribbon-button, ribbon-toggle-button").forEach((x) => {
                (x as RibbonPushButton).updateShortcut();
            });
        }
    };
}

customElements.define("chili-ribbon", RibbonUI);
