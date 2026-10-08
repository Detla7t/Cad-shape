// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandKeys } from "../command/commandKeys";
import type { IDocument } from "../document";
import type { IDisposable } from "../foundation/disposable";
import { Logger } from "../foundation/logger";
import { PubSub } from "../foundation/pubsub";
import type { I18nKeys } from "../i18n";
import type { INode } from "../model/node";

/**
 * Document ELEMENTS — Onshape's tabs along the bottom of a document. One document is one
 * shared environment (one node tree, one variable scope, one undo history); its elements
 * are dedicated full-size views onto parts of it:
 *
 * - the Part Studio, the modeling view (viewport, model tree, properties) — one per
 *   document for now, and not backed by a node;
 * - one element per node of a registered kind — a Feature Studio, a Variable Studio, …
 *
 * This module is the registry those kinds plug into: a kind says which nodes are its
 * elements (`registerElementKind`), a view factory says how one is shown
 * (`registerElementView`, replaceable — a later registration for the same kind wins), and
 * the UI that hosts the tabs registers itself (`setHost`). Commands and the model tree
 * open an element through `openElement`, never through the UI directly — without a host
 * (a build without the tab strip) the view opens in a floating panel instead.
 */

/** The element kind of the Part Studio, the one element that is not a node. */
export const PART_STUDIO_KIND = "partStudio";

/** A mounted element view. */
export interface IElementView extends IDisposable {
    /**
     * Mounted full-size in the element area. Kept mounted while other tabs are active
     * (hidden, not detached), so drafts and scroll positions survive a tab switch.
     */
    readonly element: HTMLElement;
    /** Called each time its tab becomes the active one. */
    activated?(): void;
    /** Called when another tab takes over from it (the view stays mounted, hidden). */
    deactivated?(): void;
}

/** Builds the view of one element; called once per node, the first time its tab opens. */
export type ElementViewFactory = (node: INode, document: IDocument) => IElementView;

export interface ElementKind {
    /** The kind's key: `featureStudio`, `variableStudio`, … */
    readonly kind: string;
    /** Iconfont key shown on the tab. */
    readonly icon: string;
    /** The kind's name, for the "+" menu and tooltips. */
    readonly display: I18nKeys;
    /** Which document nodes are elements of this kind. */
    readonly isElement: (node: INode) => boolean;
    /** What the "+" menu runs to create one; the command opens the new element itself. */
    readonly newCommand?: CommandKeys;
    /** A detached copy for the tab's Duplicate; `node.clone()` when absent. */
    readonly duplicate?: (node: INode) => INode;
    /**
     * The view is a side panel beside the Part Studio's viewport rather than a full-size
     * page — for elements that work on the model in view (a CAM Studio previewing its
     * toolpaths, picking geometry). The Part Studio's own sidebar is hidden meanwhile.
     */
    readonly besideViewport?: boolean;
    /** Optional tab-browser thumbnail, generated without opening or changing the element's view. */
    readonly thumbnail?: (
        node: INode,
        document: IDocument,
    ) => string | undefined | Promise<string | undefined>;
}

/** One element of a document, as the tab strip lists it. */
export interface DocumentElement {
    readonly kind: ElementKind;
    readonly node: INode;
}

/** The UI that hosts element tabs. */
export interface IElementHost {
    /** Shows `node`'s element, switching tab (and document) as needed; false when it cannot. */
    openElement(document: IDocument, node: INode): boolean;
    /** Brings `document`'s Part Studio forward — after an edit whose result is in the viewport. */
    showPartStudio(document: IDocument): void;
}

function documentOf(node: INode): IDocument | undefined {
    return (node as { document?: IDocument }).document ?? undefined;
}

export class DocumentElementRegistry {
    private readonly _kinds: ElementKind[] = [];
    private readonly _views = new Map<string, ElementViewFactory>();
    private readonly _listeners = new Set<() => void>();
    /** Fallback panels open without a host, by node id — one per element. */
    private readonly _floating = new Set<string>();
    private _host: IElementHost | undefined;
    private _subscribed = false;

    /** The registered kinds, in registration order — the order of the "+" menu. */
    get kinds(): readonly ElementKind[] {
        return this._kinds;
    }

    get host(): IElementHost | undefined {
        return this._host;
    }

    /** Registers (or replaces, by `kind`) an element kind. */
    registerKind(kind: ElementKind): IDisposable {
        const index = this._kinds.findIndex((x) => x.kind === kind.kind);
        if (index >= 0) this._kinds[index] = kind;
        else this._kinds.push(kind);
        this.subscribeDoubleClick();
        this.changed();
        return {
            dispose: () => {
                const at = this._kinds.indexOf(kind);
                if (at < 0) return;
                this._kinds.splice(at, 1);
                this.changed();
            },
        };
    }

    /** Registers the view of a kind; a later registration replaces an earlier one. */
    registerView(kind: string, factory: ElementViewFactory): IDisposable {
        this._views.set(kind, factory);
        this.changed();
        return {
            dispose: () => {
                if (this._views.get(kind) !== factory) return;
                this._views.delete(kind);
                this.changed();
            },
        };
    }

    viewFactory(kind: string): ElementViewFactory | undefined {
        return this._views.get(kind);
    }

    kindOf(node: INode): ElementKind | undefined {
        return this._kinds.find((kind) => kind.isElement(node));
    }

    /** The node-backed elements of `document`, in model-tree order — the tab order. */
    elementsOf(document: IDocument): DocumentElement[] {
        const elements: DocumentElement[] = [];
        for (const node of document.modelManager.findNodes()) {
            const kind = this.kindOf(node);
            if (kind !== undefined) elements.push({ kind, node });
        }
        return elements;
    }

    /** Builds `node`'s view through its kind's factory; undefined when it has none. */
    createView(node: INode, document: IDocument): IElementView | undefined {
        const kind = this.kindOf(node);
        const factory = kind === undefined ? undefined : this._views.get(kind.kind);
        return factory?.(node, document);
    }

    /** Called by the UI hosting the tabs; `undefined` when it goes away. */
    setHost(host: IElementHost | undefined): void {
        this._host = host;
    }

    /** Opens `node`'s element: its tab when a host is up, otherwise a floating panel. */
    open(document: IDocument, node: INode): void {
        if (this._host?.openElement(document, node)) return;
        this.openFloating(document, node);
    }

    /** Brings `document`'s Part Studio forward; without a host it is always in view. */
    showPartStudio(document: IDocument): void {
        this._host?.showPartStudio(document);
    }

    /** Re-renders whoever lists kinds (the tab strip) — a kind may register after the UI is up. */
    onChanged(listener: () => void): void {
        this._listeners.add(listener);
    }

    removeChanged(listener: () => void): void {
        this._listeners.delete(listener);
    }

    private changed(): void {
        for (const listener of [...this._listeners]) listener();
    }

    private openFloating(document: IDocument, node: INode): void {
        const kind = this.kindOf(node);
        if (kind === undefined || this._floating.has(node.id)) return;
        const view = this.createView(node, document);
        if (view === undefined) {
            Logger.warn(`document elements: no view is registered for "${kind.kind}"`);
            return;
        }
        this._floating.add(node.id);
        PubSub.default.pub("showFloatPanel", {
            title: kind.display,
            content: view.element,
            width: 760,
            height: 560,
            minWidth: 420,
            minHeight: 300,
            document,
            onClose: () => {
                this._floating.delete(node.id);
                view.dispose();
            },
        });
        view.activated?.();
    }

    /** Double-clicking an element node — in the model tree or the viewport — opens it. */
    private subscribeDoubleClick(): void {
        if (this._subscribed) return;
        this._subscribed = true;
        PubSub.default.sub("nodeDoubleClicked", (node) => {
            if (this.kindOf(node) === undefined) return;
            const document = documentOf(node);
            if (document !== undefined) this.open(document, node);
        });
    }
}

/** The application-wide element registry. */
export const DocumentElements = new DocumentElementRegistry();

/** Registers an element kind: which nodes get a tab, with which icon, and how to make one. */
export function registerElementKind(kind: ElementKind): IDisposable {
    return DocumentElements.registerKind(kind);
}

/**
 * Registers how an element of `kind` is shown: `(node, document) => { element, dispose }`.
 * Re-registering a kind replaces its view for elements opened from then on.
 */
export function registerElementView(kind: string, factory: ElementViewFactory): IDisposable {
    return DocumentElements.registerView(kind, factory);
}

/** Switches to `node`'s element tab (see `DocumentElementRegistry.open`). */
export function openElement(document: IDocument, node: INode): void {
    DocumentElements.open(document, node);
}

/** Switches `document` back to its Part Studio tab. */
export function showPartStudio(document: IDocument): void {
    DocumentElements.showPartStudio(document);
}

/**
 * A name no node of `document` uses yet: `<base> 1`, `<base> 2`, … — Onshape's "Part Studio 1".
 * Unique across the whole tree, not just the kind: a Feature Studio is imported by its name.
 */
export function nextElementName(document: IDocument, base: string): string {
    const taken = new Set(document.modelManager.findNodes().map((node) => node.name));
    for (let n = 1; ; n++) {
        const name = `${base} ${n}`;
        if (!taken.has(name)) return name;
    }
}
