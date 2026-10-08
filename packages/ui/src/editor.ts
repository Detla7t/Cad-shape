// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ChatPanel, createChatPanel } from "@chili3d/ai";
import {
    DocumentVersionControl,
    type IApplication,
    type ICommand,
    type IDocument,
    type IFeatureListNode,
    type INode,
    type Material,
    OperationLog,
    PubSub,
    type Ribbon,
} from "@chili3d/core";
import { createCadIcon, div } from "@chili3d/element";
import style from "./editor.module.css";
import { ElementWorkspace } from "./elements";
import { FloatPanel } from "./floatPanel";
import { ModelSidebar } from "./project/modelSidebar";
import { showConfigurationPanel } from "./property/configuration";
import { showFeatureEditPanel } from "./property/featureEditPanel";
import { FeatureListProperty } from "./property/featureListProperty";
import { MaterialDataContent, MaterialEditor } from "./property/material";
import { showVariablesPanel } from "./property/variables";
import { UtilityDock } from "./review/utilityDock";
import { RibbonUI } from "./ribbon";
import { CommandContext } from "./ribbon/commandContext";
import { StudioSidebar } from "./sidebar/studioSidebar";
import { Statusbar } from "./statusbar";
import { VersionsDock } from "./versions";
import { promptFields } from "./versions/prompt";
import { LayoutViewport } from "./viewport";

/**
 * The document editor: ribbon on top, status bar at the bottom, and between them the
 * active document's ELEMENT — the Part Studio (model tree, properties, viewport) or a
 * dedicated full-size view of another element (a Feature Studio, a Variable Studio) — picked
 * with the element tabs just above the status bar (see `ElementWorkspace`).
 */
export class Editor extends HTMLElement {
    private readonly _viewportContainer: HTMLDivElement;
    private readonly _commandContextContainer = div({});
    private _contentEl: HTMLDivElement | null = null;
    private _workspace: ElementWorkspace | undefined;
    private commandContext?: CommandContext;
    private chatDock?: HTMLElement;
    private chatPanel?: ChatPanel;
    private floatingChat?: FloatPanel;
    private _sidebarWidth: number = 240;
    private _chatWidth: number = 320;
    private _isResizingSidebar: boolean = false;
    private _sidebarEl: HTMLDivElement | null = null;
    private readonly versionsDock: VersionsDock;
    private readonly utilityDock: UtilityDock;

    constructor(
        readonly app: IApplication,
        readonly ribbonContent: Ribbon,
    ) {
        super();
        this.versionsDock = new VersionsDock(app, () => this._contentEl);
        this.utilityDock = new UtilityDock(
            app,
            () => this._contentEl,
            () => {
                this.versionsDock.hide();
                this._workspace?.closeTabs();
            },
        );
        const viewport = new LayoutViewport(app);
        viewport.classList.add(style.viewport);
        this._viewportContainer = div({ className: style.viewportContainer }, viewport);
        this.render();
    }

    private render() {
        this._sidebarEl = div(
            {
                className: style.sidebar,
                style: `width: ${this._sidebarWidth}px;`,
            },
            new ModelSidebar(this.app),
            div({
                className: style.sidebarResizer,
                onpointerdown: (e: PointerEvent) => this._startSidebarResize(e),
            }),
        );
        // The Part Studio's view is the modeling layout as it always was; other elements'
        // views mount beside it in `elementViews`, and the workspace shows one of the two.
        const partStudio = div(
            { className: style.partStudio },
            this._sidebarEl,
            this._viewportContainer,
            new StudioSidebar(this.app),
        );
        const elementViews = div({ className: style.elementViews });
        this._workspace = new ElementWorkspace(this.app, partStudio, elementViews);
        this._workspace.onTabsOpened = () => {
            this.versionsDock.hide();
            this.utilityDock.hide();
        };
        const rail = div({ className: style.utilityRail });
        const history = document.createElement("button");
        history.title = "Versions and history";
        history.setAttribute("aria-label", history.title);
        history.append(createCadIcon("history"));
        history.onclick = this.toggleVersions;
        const utilityButton = (title: string, icon: string, run: () => void) => {
            const button = document.createElement("button");
            button.title = title;
            button.setAttribute("aria-label", title);
            button.append(createCadIcon(icon));
            button.onclick = () => run();
            return button;
        };
        const version = utilityButton("Create version…", "create-version", () => {
            const doc = this.app.activeView?.document,
                control = doc && DocumentVersionControl.of(doc);
            if (!control) {
                PubSub.default.pub("displayError", "Open a document with version history first.");
                return;
            }
            promptFields(
                "versions.createVersion",
                [
                    { label: "versions.versionName", value: `V${control.versions().length + 1}` },
                    { label: "versions.description", multiline: true },
                ],
                ([name, description]) => {
                    const result = control.createVersion(name, description);
                    if (result.isOk)
                        PubSub.default.pub("showToast", "versions.versionCreated{0}", result.value.name);
                    else PubSub.default.pub("displayError", result.error);
                },
            );
        });
        const logs = document.createElement("button");
        logs.title = "Download diagnostic logs";
        logs.setAttribute("aria-label", logs.title);
        logs.append(createCadIcon("inspection"));
        logs.onclick = () => {
            const url = URL.createObjectURL(
                new Blob([OperationLog.export()], { type: "application/x-ndjson" }),
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = "chili3d-diagnostics.ndjson";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        rail.append(
            history,
            version,
            utilityButton("Comments", "comments", this.utilityDock.comments),
            utilityButton("Performance", "performance", this.utilityDock.performance),
            utilityButton("Where used", "where-used", this.utilityDock.whereUsed),
            logs,
        );
        this._contentEl = div(
            { className: style.content },
            rail,
            this._workspace.tabsSidebar,
            partStudio,
            elementViews,
        );
        this.append(
            div(
                { className: style.root },
                new RibbonUI(this.app, this.ribbonContent),
                this._contentEl,
                this._workspace.strip,
                new Statusbar(style.statusbar),
            ),
        );
        this.app.mainWindow?.appendChild(this);
    }

    private ensureChatPanel(): ChatPanel {
        if (this.chatPanel) return this.chatPanel;
        const chat = createChatPanel();
        chat.onClose = () => this.hideChat();
        chat.onDock = () => this.dockChat();
        this.attachDragToDetach(chat.header);
        this.chatPanel = chat;
        return chat;
    }

    private showChat() {
        if (this.chatDock || this.floatingChat) return;
        const chat = this.ensureChatPanel();
        chat.setFloating(false);

        const resizer = div({
            className: style.chatResizer,
            onpointerdown: (e: PointerEvent) => this._startChatResize(e),
        });
        this.chatDock = div({ className: style.rightPanel }, resizer, chat);
        this.chatDock.style.width = `${this._chatWidth}px`;
        this._contentEl?.append(this.chatDock);
    }

    private hideChat() {
        this.chatDock?.remove();
        this.chatDock = undefined;
        this.closeFloatingChat();
    }

    private closeFloatingChat() {
        if (this.floatingChat) {
            this.floatingChat.remove();
            this.floatingChat.dispose();
            this.floatingChat = undefined;
        }
    }

    private readonly toggleChat = () => {
        if (this.chatDock || this.floatingChat) {
            this.hideChat();
        } else {
            this.showChat();
        }
    };

    private attachDragToDetach(header: HTMLElement) {
        header.addEventListener("pointerdown", (e: PointerEvent) => {
            if ((e.target as HTMLElement).closest("button")) return;
            const startX = e.clientX;
            const startY = e.clientY;
            this.trackPointerDrag((ev, stop) => {
                if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 6) {
                    this.detachChat(ev.clientX, ev.clientY);
                    stop();
                }
            });
        });
    }

    private trackPointerDrag(onMove: (ev: PointerEvent, stop: () => void) => void, onEnd?: () => void) {
        const onUp = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
            onEnd?.();
        };
        const move = (ev: PointerEvent) => onMove(ev, onUp);
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
    }

    private detachChat(mouseX: number, mouseY: number) {
        const chat = this.chatPanel;
        if (!chat || !this.chatDock) return;
        this.chatDock?.remove();
        this.chatDock = undefined;
        chat.setFloating(true);

        this.floatingChat = new FloatPanel({
            title: "ai.title",
            content: chat,
            actions: chat.floatingActions(),
            width: 380,
            height: 520,
            x: Math.max(0, mouseX - 190),
            y: Math.max(0, mouseY - 16),
            onClose: () => {
                this.floatingChat = undefined;
            },
        });
        this.app.mainWindow?.appendChild(this.floatingChat);
    }

    private dockChat() {
        this.closeFloatingChat();
        this.showChat();
    }

    private _startChatResize(e: PointerEvent) {
        e.preventDefault();
        const dock = this.chatDock;
        if (!dock) return;
        const rect = dock.getBoundingClientRect();
        if (this.app.mainWindow) this.app.mainWindow.style.cursor = "ew-resize";
        this.trackPointerDrag(
            (ev) => {
                const minWidth = 220;
                const maxWidth = Math.floor(window.innerWidth * 0.6);
                this._chatWidth = Math.max(minWidth, Math.min(maxWidth, rect.right - ev.clientX));
                dock.style.width = `${this._chatWidth}px`;
            },
            () => {
                if (this.app.mainWindow) this.app.mainWindow.style.cursor = "";
            },
        );
    }

    private _startSidebarResize(e: PointerEvent) {
        e.preventDefault();
        this._isResizingSidebar = true;
        if (this.app.mainWindow) this.app.mainWindow.style.cursor = "ew-resize";
        this.trackPointerDrag(
            (ev) => {
                if (!this._isResizingSidebar) return;
                if (!this._sidebarEl) return;
                const sidebarRect = this._sidebarEl.getBoundingClientRect();
                let newWidth = ev.clientX - sidebarRect.left;
                const minWidth = 75;
                const maxWidth = Math.floor(window.innerWidth * 0.85);
                newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
                this._sidebarWidth = newWidth;
                this._sidebarEl.style.width = `${newWidth}px`;
            },
            () => {
                this._isResizingSidebar = false;
                if (this.app.mainWindow) this.app.mainWindow.style.cursor = "";
            },
        );
    }

    connectedCallback(): void {
        PubSub.default.sub("editFeature", this.editFeature);
        PubSub.default.sub("editMaterial", this._handleMaterialEdit);
        PubSub.default.sub("editVariables", this._handleVariablesEdit);
        PubSub.default.sub("editConfiguration", this._handleConfigurationEdit);
        PubSub.default.sub("openCommandContext", this.openContext);
        PubSub.default.sub("closeCommandContext", this.closeContext);
        PubSub.default.sub("toggleChatPanel", this.toggleChat);
        this._workspace?.connect();
        this.utilityDock.connect();
        PubSub.default.sub("toggleVersionsPanel", this.toggleVersions);
    }

    private readonly toggleVersions = () => {
        this.utilityDock.hide();
        this._workspace?.closeTabs();
        this.versionsDock.toggle();
    };

    disconnectedCallback(): void {
        PubSub.default.remove("editFeature", this.editFeature);
        PubSub.default.remove("editMaterial", this._handleMaterialEdit);
        PubSub.default.remove("editVariables", this._handleVariablesEdit);
        PubSub.default.remove("editConfiguration", this._handleConfigurationEdit);
        PubSub.default.remove("openCommandContext", this.openContext);
        PubSub.default.remove("closeCommandContext", this.closeContext);
        PubSub.default.remove("toggleChatPanel", this.toggleChat);
        this._workspace?.disconnect();
        this.utilityDock.disconnect();
        PubSub.default.remove("toggleVersionsPanel", this.toggleVersions);
        this.versionsDock.hide();
        this.chatDock?.remove();
        this.chatDock = undefined;
        this.closeFloatingChat();
    }

    private readonly editFeature = async (node: INode & IFeatureListNode, featureId: string) => {
        const model = this.app.activeView?.document;
        if (!model) return;
        if (node.beginFeatureEdit) {
            const session = await node.beginFeatureEdit(featureId);
            if (!session.isOk) {
                PubSub.default.pub("displayError", session.error);
                return;
            }
            this._workspace?.showPartStudio();
            showFeatureEditPanel(model, node, session.value);
            return;
        }
        const content = new FeatureListProperty(model, node, featureId);
        content.setAttribute("aria-label", "Edit feature");
        PubSub.default.pub("showFloatPanel", {
            title: "properties.header",
            content,
            document: model,
            x: 282,
            y: 76,
            width: 280,
            height: 400,
        });
    };

    private readonly openContext = (command: ICommand) => {
        if (this.commandContext) {
            this.closeContext();
        }
        // A command works in the viewport: bring the Part Studio forward if another element is open.
        this._workspace?.showPartStudio();
        this.commandContext = new CommandContext(command);
        this._commandContextContainer.append(this.commandContext);
        this._viewportContainer.append(this._commandContextContainer);
    };

    private readonly closeContext = () => {
        this.commandContext?.remove();
        this.commandContext?.dispose();
        this.commandContext = undefined;
        this._commandContextContainer.innerHTML = "";
    };

    private readonly _handleMaterialEdit = (
        document: IDocument,
        editingMaterial: Material,
        callback: (material: Material) => void,
    ) => {
        const context = new MaterialDataContent(document, callback, editingMaterial);
        this._workspace?.showPartStudio();
        this._viewportContainer.append(new MaterialEditor(context));
    };

    private readonly _handleVariablesEdit = (document: IDocument, onApplied: () => void) => {
        showVariablesPanel(document, onApplied);
    };

    private readonly _handleConfigurationEdit = (document: IDocument) => {
        showConfigurationPanel(document);
    };
}

customElements.define("chili-editor", Editor);
