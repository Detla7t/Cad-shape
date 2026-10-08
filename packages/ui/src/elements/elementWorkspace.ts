// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DocumentElements,
    type ElementKind,
    I18n,
    type IApplication,
    type IDocument,
    type IElementHost,
    type IElementView,
    type INode,
    type IView,
    Logger,
    PART_STUDIO_KIND,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { div } from "@chili3d/element";
import style from "./elements.module.css";
import { ElementTabStrip } from "./elementTabStrip";
import { ElementTabsSidebar } from "./elementTabsSidebar";
import { setShown } from "./visibility";

/** The Part Studio's tab id: one per document, and not a node. */
export const PART_STUDIO_ID = "partStudio";

/** One tab of the element strip. */
export interface ElementTab {
    /** `PART_STUDIO_ID`, or the element node's id. */
    readonly id: string;
    readonly kind: string;
    readonly icon: string;
    /** The node's name; empty for the Part Studio, whose label is localized. */
    readonly name: string;
    /** The element's node; undefined for the Part Studio. */
    readonly node?: INode;
}

interface MountedView {
    readonly node: INode;
    /** Undefined when no view is registered for the kind (a placeholder is shown). */
    readonly view: IElementView | undefined;
    /** Wraps the view's element, so hiding never touches the view's own classes. */
    readonly frame: HTMLElement;
}

interface DocumentState {
    activeId: string;
    /** Views built so far, by node id — built on first activation, kept until the node goes. */
    readonly views: Map<string, MountedView>;
}

/**
 * The element area of the editor: which element of the active document is shown, and the
 * mounted views of the others. It is the `IElementHost` the core registry opens elements
 * through, and the model behind the tab strip.
 *
 * The Part Studio is the editor's existing modeling view (`partStudio`: sidebar + viewport),
 * shown or hidden but never rebuilt. Every other element's view is built through the
 * registry the first time its tab opens, mounted in `viewArea`, and from then on hidden
 * rather than detached while another tab is active — so an unapplied draft, a scroll
 * position or a focused row survives a tab switch. A view is disposed when its node leaves
 * the document (deleted, or the creation undone) or the document closes.
 *
 * Each document remembers its own active element: switching documents with the tabs at
 * the top brings back whatever was open in that document.
 */
export class ElementWorkspace implements IElementHost {
    readonly strip: ElementTabStrip;
    readonly tabsSidebar: ElementTabsSidebar;
    /** The editor closes other left docks before showing the tab browser. */
    onTabsOpened?: () => void;
    private readonly states = new Map<IDocument, DocumentState>();
    /** Element nodes of the active document whose renames redraw their tab. */
    private readonly watched = new Set<INode>();
    private _document: IDocument | undefined;
    private connected = false;
    /** The view last brought forward, so `activated` runs on a switch, not on every re-layout. */
    private shownView: IElementView | undefined;

    constructor(
        readonly app: IApplication,
        readonly partStudio: HTMLElement,
        readonly viewArea: HTMLElement,
    ) {
        // The Part Studio until told otherwise.
        setShown(viewArea, false);
        this.tabsSidebar = new ElementTabsSidebar(this, () => this.closeTabs(true));
        this.strip = new ElementTabStrip(this);
    }

    /** Starts following the application; the editor calls this once it is on screen. */
    connect(): void {
        if (this.connected) return;
        this.connected = true;
        PubSub.default.sub("activeViewChanged", this.handleActiveViewChanged);
        PubSub.default.sub("documentClosed", this.handleDocumentClosed);
        PubSub.default.sub("documentSaved", this.handleDocumentSaved);
        DocumentElements.onChanged(this.handleRegistryChanged);
        DocumentElements.setHost(this);
        this.setDocument(this.app.activeView?.document);
    }

    disconnect(): void {
        if (!this.connected) return;
        this.connected = false;
        PubSub.default.remove("activeViewChanged", this.handleActiveViewChanged);
        PubSub.default.remove("documentClosed", this.handleDocumentClosed);
        PubSub.default.remove("documentSaved", this.handleDocumentSaved);
        this.closeTabs();
        DocumentElements.removeChanged(this.handleRegistryChanged);
        if (DocumentElements.host === this) DocumentElements.setHost(undefined);
        this.setDocument(undefined);
    }

    /** The document whose elements the strip lists — the active view's. */
    get document(): IDocument | undefined {
        return this._document;
    }

    /** The active tab of the current document. */
    get activeId(): string {
        return this._document === undefined ? PART_STUDIO_ID : this.stateOf(this._document).activeId;
    }

    toggleTabs(): void {
        if (!this.tabsSidebar.hidden) this.closeTabs();
        else if (this._document) {
            this.onTabsOpened?.();
            this.partStudio.setAttribute("data-tabs-open", "");
            this.tabsSidebar.show();
            this.strip.render();
        }
    }

    closeTabs(focusButton = false): void {
        this.tabsSidebar.hide();
        this.partStudio.removeAttribute("data-tabs-open");
        this.strip.render();
        if (focusButton) this.strip.focusTabsButton();
    }

    /** The current document's tabs: the Part Studio, then its element nodes in model-tree order. */
    tabs(): ElementTab[] {
        const document = this._document;
        if (document === undefined) return [];
        const partStudio: ElementTab = {
            id: PART_STUDIO_ID,
            kind: PART_STUDIO_KIND,
            icon: "icon-box",
            name: "",
        };
        return [
            partStudio,
            ...DocumentElements.elementsOf(document).map(({ kind, node }) => ({
                id: node.id,
                kind: kind.kind,
                icon: kind.icon,
                name: node.name,
                node,
            })),
        ];
    }

    /** The kinds the "+" menu can create. */
    creatableKinds(): ElementKind[] {
        return DocumentElements.kinds.filter((kind) => kind.newCommand !== undefined);
    }

    /** Shows the tab `id` of the current document; false when there is no such tab. */
    activate(id: string): boolean {
        const document = this._document;
        if (document === undefined) return false;
        const state = this.stateOf(document);
        if (id !== PART_STUDIO_ID) {
            const element = DocumentElements.elementsOf(document).find(({ node }) => node.id === id);
            if (element === undefined) return false;
            this.ensureMounted(document, state, element.node);
        }
        state.activeId = id;
        this.apply();
        return true;
    }

    /**
     * `IElementHost`: brings the Part Studio forward — of `document` when given (it remembers
     * the choice even while another document is shown), else of the current one.
     */
    showPartStudio(document: IDocument | undefined = this._document): void {
        if (document === undefined) return;
        if (document !== this._document) {
            this.stateOf(document).activeId = PART_STUDIO_ID;
            return;
        }
        this.activate(PART_STUDIO_ID);
    }

    /** `IElementHost`: switches to `document` (when it has a view) and to `node`'s tab. */
    openElement(document: IDocument, node: INode): boolean {
        if (!this.connected || DocumentElements.kindOf(node) === undefined) return false;
        if (document !== this._document) {
            const view = this.app.views.find((candidate: IView) => candidate.document === document);
            if (view === undefined) return false;
            this.app.activeView = view;
            // The view change normally arrives through `activeViewChanged`; follow it here too
            // so the switch does not depend on who else is listening.
            this.setDocument(document);
        }
        return this.activate(node.id);
    }

    /** Renames an element node — one undo step. Blank or unchanged names are ignored. */
    rename(node: INode, name: string): void {
        const document = this._document;
        const trimmed = name.trim();
        if (document === undefined || trimmed === "" || trimmed === node.name) return;
        Transaction.execute(document, "rename element", () => {
            node.name = trimmed;
        });
    }

    /** Copies an element node next to the original and opens the copy — one undo step. */
    duplicate(node: INode): INode | undefined {
        const document = this._document;
        const kind = DocumentElements.kindOf(node);
        if (document === undefined || kind === undefined) return undefined;
        const copy = kind.duplicate?.(node) ?? node.clone();
        const name = copyName(document, node.name);
        Transaction.execute(document, "duplicate element", () => {
            copy.name = name;
            if (node.parent !== undefined) node.parent.insertAfter(node, copy);
            else document.modelManager.addNode(copy);
        });
        this.activate(copy.id);
        return copy;
    }

    /** Asks before deleting an element node; the Part Studio has no node and cannot go. */
    confirmDelete(node: INode): void {
        const message = div({
            className: style.confirm,
            textContent: I18n.translate("elements.delete.confirm{0}", node.name),
        });
        PubSub.default.pub("showDialog", "elements.delete.title", message, [
            { content: "common.confirm", onclick: () => this.delete(node) },
            { content: "common.cancel" },
        ]);
    }

    /** Removes an element node from the document — one undo step, which brings it back. */
    delete(node: INode): void {
        const document = this._document;
        if (document === undefined || DocumentElements.kindOf(node) === undefined) return;
        document.selection.clearSelection();
        Transaction.execute(document, "delete element", () => {
            node.parent?.remove(node);
        });
    }

    private stateOf(document: IDocument): DocumentState {
        let state = this.states.get(document);
        if (state === undefined) {
            state = { activeId: PART_STUDIO_ID, views: new Map() };
            this.states.set(document, state);
        }
        return state;
    }

    private ensureMounted(document: IDocument, state: DocumentState, node: INode): MountedView {
        const existing = state.views.get(node.id);
        if (existing !== undefined && existing.node === node) return existing;
        if (existing !== undefined) this.unmount(state, node.id);
        let view: IElementView | undefined;
        try {
            view = DocumentElements.createView(node, document);
        } catch (error) {
            Logger.error(`document elements: the view of "${node.name}" failed to build`, error);
        }
        const content =
            view?.element ??
            div({
                className: style.placeholder,
                textContent: I18n.translate("error.default:{0}", `no view for "${node.name}"`),
            });
        const frame = div({ className: style.frame }, content);
        setShown(frame, false);
        frame.dataset["elementId"] = node.id;
        this.viewArea.append(frame);
        const mounted = { node, view, frame };
        state.views.set(node.id, mounted);
        return mounted;
    }

    private unmount(state: DocumentState, id: string): void {
        const mounted = state.views.get(id);
        if (mounted === undefined) return;
        state.views.delete(id);
        mounted.frame.remove();
        try {
            mounted.view?.dispose();
        } catch (error) {
            Logger.error("document elements: a view failed to dispose", error);
        }
    }

    /**
     * Shows the active element of the current document and hides everything else. An
     * element whose kind is `besideViewport` is shown as a side panel next to the Part
     * Studio's viewport (whose own sidebar steps aside meanwhile).
     */
    private apply(): void {
        const document = this._document;
        const activeId = this.activeId;
        const showPartStudio = activeId === PART_STUDIO_ID;
        let active: MountedView | undefined;
        for (const [owner, state] of this.states) {
            for (const [id, mounted] of state.views) {
                const visible = owner === document && id === activeId;
                setShown(mounted.frame, visible);
                if (visible) active = mounted;
            }
        }
        const beside =
            !showPartStudio &&
            active !== undefined &&
            DocumentElements.kindOf(active.node)?.besideViewport === true;
        setShown(this.partStudio, showPartStudio || beside);
        setShown(this.viewArea, !showPartStudio);
        this.partStudio.toggleAttribute("data-viewport-only", beside);
        this.viewArea.toggleAttribute("data-beside-viewport", beside);
        this.strip.render();
        this.tabsSidebar.render();
        if (active?.view !== this.shownView) {
            this.shownView?.deactivated?.();
            this.shownView = active?.view;
            this.shownView?.activated?.();
        }
    }

    /**
     * Brings the current document's state in line with its tree: views of nodes that are no
     * longer elements go, an active tab whose node went falls back to the Part Studio, and
     * the rename watches follow the element set.
     */
    private reconcile(): void {
        const document = this._document;
        if (document === undefined) return;
        const state = this.stateOf(document);
        const elements = DocumentElements.elementsOf(document);
        const nodes = new Map(elements.map(({ node }) => [node.id, node]));
        for (const [id, mounted] of [...state.views]) {
            if (nodes.get(id) !== mounted.node) this.unmount(state, id);
        }
        if (state.activeId !== PART_STUDIO_ID && !nodes.has(state.activeId)) state.activeId = PART_STUDIO_ID;
        this.watchNames(elements.map(({ node }) => node));
        this.apply();
    }

    private watchNames(nodes: readonly INode[]): void {
        const next = new Set(nodes);
        for (const node of this.watched) {
            if (!next.has(node)) node.removePropertyChanged(this.handleNodeChanged);
        }
        for (const node of next) {
            if (!this.watched.has(node)) node.onPropertyChanged(this.handleNodeChanged);
        }
        this.watched.clear();
        for (const node of next) this.watched.add(node);
    }

    private setDocument(document: IDocument | undefined): void {
        if (document === this._document) return;
        this._document?.modelManager.removeNodeObserver(this.handleNodesChanged);
        this.watchNames([]);
        this._document = document;
        document?.modelManager.addNodeObserver(this.handleNodesChanged);
        // Also lays out the strip and the views for the new document (or none: the home screen).
        this.reconcile();
        if (document === undefined) this.apply();
    }

    private readonly handleActiveViewChanged = (view: IView | undefined) => {
        this.setDocument(view?.document);
    };

    private readonly handleDocumentClosed = (document: IDocument) => {
        const state = this.states.get(document);
        if (state !== undefined) {
            for (const id of [...state.views.keys()]) this.unmount(state, id);
            this.states.delete(document);
        }
        if (document === this._document) this.setDocument(undefined);
    };

    private readonly handleNodesChanged = () => {
        this.reconcile();
    };

    private readonly handleRegistryChanged = () => {
        this.reconcile();
    };

    private readonly handleNodeChanged = (property: string) => {
        if (property === "name") {
            this.strip.render();
            this.tabsSidebar.render();
        }
    };

    private readonly handleDocumentSaved = (document: IDocument) => {
        if (document === this._document) this.tabsSidebar.refreshPreview();
    };
}

/** `<name> copy`, `<name> copy 2`, … — the first name no node of the document has. */
function copyName(document: IDocument, name: string): string {
    const taken = new Set(document.modelManager.findNodes().map((node) => node.name));
    const base = `${name} copy`;
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        const candidate = `${base} ${n}`;
        if (!taken.has(candidate)) return candidate;
    }
}
