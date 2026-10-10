// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ComponentContext,
    ComponentFolderNode,
    FolderNode,
    type IDocument,
    type INodeLinkedList,
    isFeatureListNode,
    PubSub,
} from "@chili3d/core";
import { button, div, setSVGIcon, svg } from "@chili3d/element";
import { FeatureListProperty } from "../../property/featureListProperty";
import { TreeItem } from "./treeItem";
import style from "./treeItemGroup.module.css";

export class TreeGroup extends TreeItem {
    private _isExpanded = true;
    readonly header: HTMLElement;
    readonly items: HTMLDivElement = div({ className: `${style.container} ${style.left16px}` });
    readonly expanderIcon: SVGSVGElement;
    /** Fusion's radio button that activates a component as the one being worked in (components only). */
    readonly activate: HTMLButtonElement | undefined;

    constructor(document: IDocument, node: INodeLinkedList) {
        super(document, node);
        this.expanderIcon = this.createExpanderIcon(node);
        const typeIcon = this.createTypeIcon();
        this.activate =
            node instanceof ComponentFolderNode ? this.createActivateButton(document, node) : undefined;
        this.header = div(
            { className: `${style.row} ${style.header}` },
            this.expanderIcon,
            ...(typeIcon === undefined ? [] : [typeIcon]),
            this.name,
            ...(this.activate === undefined ? [] : [this.activate]),
            this.visibleIcon,
            this.warningBadge,
        );
        super.append(this.createRootContainer());
        if (isFeatureListNode(node)) {
            this.items.append(new FeatureListProperty(document, node, undefined, true));
            this.header.hidden = true;
            this.header.style.display = "none";
            this.items.classList.remove(style.left16px);
        }
        this.refreshExpander();
    }

    /**
     * The activate button: a ring that fills for the active component. New nodes go into
     * the active component and the timeline shows only its steps; the root reactivates the
     * whole document. Plain folders have no ring: they group, they are not components.
     */
    private createActivateButton(document: IDocument, node: ComponentFolderNode): HTMLButtonElement {
        const control = button({
            className: style.activate,
            title: "Activate component",
            onclick: (event: MouseEvent) => {
                event.stopPropagation();
                ComponentContext.activate(
                    document,
                    ComponentContext.activeOf(document) === node ? undefined : node,
                );
            },
        });
        control.type = "button";
        control.setAttribute("aria-label", "Activate component");
        control.setAttribute("aria-pressed", String(ComponentContext.activeOf(document) === node));
        control.append(svg({ icon: "icon-circle", className: style.activateIcon }));
        return control;
    }

    private readonly handleActiveComponentChanged = (
        document: IDocument,
        component: INodeLinkedList | undefined,
    ) => {
        if (document !== this.document || this.activate === undefined) return;
        this.activate.setAttribute("aria-pressed", String(component === this.node));
    };

    override connectedCallback(): void {
        super.connectedCallback();
        PubSub.default.sub("activeComponentChanged", this.handleActiveComponentChanged);
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        PubSub.default.remove("activeComponentChanged", this.handleActiveComponentChanged);
    }

    private createExpanderIcon(node: INodeLinkedList): SVGSVGElement {
        // A parametric body is a linked list of consumed boolean tools, not a folder —
        // give its expander a distinct, muted look.
        const expanderClass =
            node instanceof FolderNode
                ? style.expanderIcon
                : `${style.expanderIcon} ${style.toolExpanderIcon}`;
        return svg({
            icon: this.getExpanderIcon(),
            className: expanderClass,
            onclick: this.handleExpanderClick,
        });
    }

    private createRootContainer(): HTMLDivElement {
        return div({ className: style.container }, this.header, this.items);
    }

    /** Folders always show the expander; a body shows it only with tools inside. */
    refreshExpander() {
        const hide =
            !(this.node instanceof FolderNode) &&
            !isFeatureListNode(this.node) &&
            (this.node as INodeLinkedList).firstChild === undefined;
        this.expanderIcon.classList.toggle(style.hide, hide);
    }

    get isExpanded(): boolean {
        return this._isExpanded;
    }

    set isExpanded(value: boolean) {
        this._isExpanded = value;
        setSVGIcon(this.expanderIcon, this.getExpanderIcon());
        this.items.classList.toggle(style.hide, !this._isExpanded);
    }

    mainElement(): HTMLElement {
        return this.header;
    }

    override dispose() {
        super.dispose();
        this.header.remove();
        this.expanderIcon.removeEventListener("click", this.handleExpanderClick);
    }

    private readonly handleExpanderClick = (e: MouseEvent) => {
        e.stopPropagation();
        this.isExpanded = !this._isExpanded;
    };

    private getExpanderIcon() {
        return this._isExpanded ? "icon-angle-down" : "icon-angle-right";
    }

    override appendChild<T extends Node>(node: T): T {
        this.items.appendChild(node);
        return node;
    }

    override append(...nodes: Node[]): void {
        this.items.append(...nodes);
    }

    override removeChild<T extends Node>(child: T): T {
        if (child.parentNode === this.items) this.items.removeChild(child);
        return child;
    }

    addItem(...items: Node[]) {
        this.items.append(...items);
        return this;
    }

    insertAfter(item: TreeItem, child: TreeItem | null): void {
        const referenceNode = child ? child.nextSibling : this.items.firstChild;
        this.items.insertBefore(item, referenceNode);
    }
}

customElements.define("tree-group", TreeGroup);
