// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DocumentPanelContent,
    type DocumentPanelId,
    DocumentPanels,
    I18n,
    type IApplication,
    type IDocument,
    type IDocumentPanelHost,
    type IView,
    PubSub,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import { ConfigurationTablePanel } from "./configurationTablePanel";
import { InspectionPanel } from "./inspectionPanel";
import style from "./studioSidebar.module.css";
import { VariableTablePanel } from "./variableTablePanel";

DocumentPanels.register({
    id: "configuration",
    title: "sidebar.configurations",
    icon: "configuration",
    create: (document) => new ConfigurationTablePanel(document),
});
DocumentPanels.register({
    id: "variables",
    title: "sidebar.variables",
    icon: "variable",
    create: (document, onApplied) => new VariableTablePanel(document, onApplied),
});

DocumentPanels.register({
    id: "inspection",
    title: "sidebar.inspection",
    icon: "inspection",
    create: (document) => new InspectionPanel(document),
});

const ORDER: DocumentPanelId[] = ["configuration", "tables", "inspection", "variables"];

/** The Part Studio's right-hand rail; one live document panel occupies the dock at a time. */
export class StudioSidebar extends HTMLElement implements IDocumentPanelHost {
    private readonly rail = document.createElement("div");
    private readonly panel = document.createElement("section");
    private readonly content = document.createElement("div");
    private readonly heading = document.createElement("strong");
    private readonly buttons = new Map<DocumentPanelId, HTMLButtonElement>();
    private mounted?: DocumentPanelContent;
    private currentDocument?: IDocument;
    private active?: DocumentPanelId;
    private width = 480;
    private stopResize?: () => void;

    constructor(private readonly app: IApplication) {
        super();
        this.className = style.root;
        this.rail.className = style.rail;
        this.rail.setAttribute("role", "toolbar");
        this.rail.setAttribute("aria-label", I18n.translate("sidebar.tools"));
        this.rail.setAttribute("aria-orientation", "vertical");
        for (const id of ORDER) {
            const definition = DocumentPanels.definitions.get(id);
            if (!definition) continue;
            const button = document.createElement("button");
            button.type = "button";
            button.title = I18n.translate(definition.title);
            button.setAttribute("aria-label", button.title);
            button.setAttribute("aria-expanded", "false");
            button.dataset["panel"] = id;
            button.append(createCadIcon(definition.icon));
            button.onclick = () => (this.active === id ? this.close() : this.show(id));
            this.buttons.set(id, button);
            this.rail.append(button);
        }
        this.rail.onkeydown = (event) => this.navigateRail(event);
        this.panel.className = style.panel;
        const header = document.createElement("header");
        header.className = style.header;
        const close = document.createElement("button");
        close.type = "button";
        close.title = I18n.translate("sidebar.close");
        close.setAttribute("aria-label", close.title);
        close.append(createCadIcon("close"));
        close.onclick = () => this.close(true);
        header.append(this.heading, close);
        const resizer = document.createElement("div");
        resizer.className = style.resizer;
        resizer.setAttribute("role", "separator");
        resizer.setAttribute("aria-label", I18n.translate("sidebar.resize"));
        resizer.setAttribute("aria-orientation", "vertical");
        resizer.tabIndex = 0;
        resizer.onpointerdown = (event) => this.resize(event);
        resizer.onkeydown = (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            this.setWidth(this.width + (event.key === "ArrowLeft" ? 30 : -30));
        };
        this.content.className = style.content;
        this.panel.append(resizer, header, this.content);
        this.panel.hidden = true;
        this.append(this.rail, this.panel);
        // Editing a table must not invoke modeling hotkeys or begin a viewport gesture.
        this.addEventListener("keydown", (event) => event.stopPropagation());
        this.addEventListener("pointerdown", (event) => event.stopPropagation());
    }

    connectedCallback() {
        DocumentPanels.host = this;
        PubSub.default.sub("activeViewChanged", this.viewChanged);
        PubSub.default.sub("documentClosed", this.documentClosed);
        this.setDocument(this.app.activeView?.document);
    }
    disconnectedCallback() {
        if (DocumentPanels.host === this) DocumentPanels.host = undefined;
        PubSub.default.remove("activeViewChanged", this.viewChanged);
        PubSub.default.remove("documentClosed", this.documentClosed);
        this.stopResize?.();
        this.unmount();
        this.currentDocument = undefined;
    }

    open(id: DocumentPanelId, document: IDocument, onApplied?: () => void): boolean {
        if (document !== this.currentDocument || !DocumentPanels.definitions.has(id)) return false;
        this.show(id, onApplied);
        return true;
    }

    setDocument(document: IDocument | undefined) {
        if (document === this.currentDocument) return;
        this.unmount();
        this.currentDocument = document;
        for (const button of this.buttons.values()) button.disabled = !document;
        if (document && this.active) this.show(this.active);
        else this.close();
    }

    private show(id: DocumentPanelId, onApplied?: () => void) {
        const definition = DocumentPanels.definitions.get(id);
        if (!definition || !this.currentDocument) return;
        if (this.active === id && this.mounted) return;
        this.unmount();
        this.active = id;
        this.heading.textContent = I18n.translate(definition.title);
        this.panel.setAttribute("aria-label", this.heading.textContent);
        this.mounted = definition.create(this.currentDocument, onApplied);
        this.content.append(this.mounted.element);
        this.panel.hidden = false;
        this.dataset["open"] = id;
        this.setWidth(this.width);
        for (const [key, button] of this.buttons) button.setAttribute("aria-expanded", String(key === id));
    }

    close(focusRail = false) {
        const active = this.active;
        this.unmount();
        this.active = undefined;
        delete this.dataset["open"];
        this.panel.hidden = true;
        this.style.width = "0px";
        for (const button of this.buttons.values()) button.setAttribute("aria-expanded", "false");
        if (focusRail && active) this.buttons.get(active)?.focus();
    }

    private unmount() {
        // Commit an in-progress cell before moving to another document/panel.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && this.content.contains(focused)) focused.blur();
        this.mounted?.dispose();
        this.mounted = undefined;
        this.content.replaceChildren();
    }

    private readonly viewChanged = (view: IView | undefined) => this.setDocument(view?.document);
    private readonly documentClosed = (document: IDocument) => {
        if (this.currentDocument === document) this.setDocument(undefined);
    };
    private setWidth(width: number) {
        this.width = Math.max(340, Math.min(window.innerWidth * 0.6, width));
        this.style.width = `${this.width}px`;
    }
    private resize(event: PointerEvent) {
        event.preventDefault();
        this.stopResize?.();
        const x = event.clientX,
            width = this.width;
        const move = (e: PointerEvent) => this.setWidth(width + x - e.clientX);
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
    private navigateRail(event: KeyboardEvent) {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...this.buttons.values()];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
    }
}
customElements.define("chili-studio-sidebar", StudioSidebar);
