// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    DocumentElements,
    FolderNode,
    I18n,
    type IDocument,
    type INode,
    type INodeLinkedList,
    isFeatureListNode,
    type ModelManager,
    type NodeRecord,
    NodeUtils,
    PartStudioTimeline,
    PubSub,
    ReferencePlaneNode,
    Transaction,
} from "@chili3d/core";
import { HistoryBar } from "../historyBar";
import { showNodeContextMenu } from "../nodeContextMenu";
import { canSelectNodes } from "../treeSelection";
import { computeOwnership, joinOwnerBars, ownerBars } from "./ownerColors";

/** The configuration, when one exists (UI tests may run the tree over a stand-in core). */
function config(): Config | undefined {
    return (Config as { instance?: Config } | undefined)?.instance;
}

/** The document's Part Studio timeline, when the core and document are real (see `config`). */
function partStudioTimeline(document: IDocument): PartStudioTimeline | undefined {
    if (typeof (PartStudioTimeline as Partial<typeof PartStudioTimeline> | undefined)?.of !== "function")
        return undefined;
    if (typeof document.modelManager?.addNodeObserver !== "function") return undefined;
    return PartStudioTimeline.of(document);
}

import style from "./tree.module.css";
import { TreeItem } from "./treeItem";
import { TreeGroup } from "./treeItemGroup";
import { TreeModel } from "./treeModel";

export class Tree extends HTMLElement {
    private readonly nodeMap = new Map<INode, TreeItem>();
    private readonly selectedNodes: Set<INode> = new Set();
    private dragging: INode[] | undefined;
    private highlightedGroup: TreeGroup | undefined;
    private lastClicked: INode | undefined;
    private lastSelected: INode[] | undefined;
    private filterText = "";
    private historyBar?: HistoryBar;
    private timeline?: PartStudioTimeline;
    /** The bar's position at rest (the last read), told apart from a drag preview. */
    private restingHistoryPosition = 0;
    private historyRows(): TreeItem[] {
        const root = this.nodeMap.get(this.document.modelManager.rootNode);
        const parent = root instanceof TreeGroup ? root.items : this;
        return [...parent.children].filter(
            (e): e is TreeItem =>
                e instanceof TreeItem && !e.hidden && !(e.node instanceof ReferencePlaneNode),
        );
    }
    /**
     * The document-level bar between top-level rows: a view of the Part Studio timeline. It
     * sits before the first row not fully applied; a body the marker splits shows the marker
     * in its own feature list (and is not dimmed here).
     */
    private historyPosition(timeline: PartStudioTimeline): number {
        const rows = this.historyRows();
        const index = rows.findIndex((row) => timeline.nodeState(row.node) !== "applied");
        return index < 0 ? rows.length : index;
    }
    private refreshHistory(): void {
        this.timeline ??= partStudioTimeline(this.document);
        const timeline = this.timeline;
        if (timeline === undefined) return;
        this.historyBar ??= new HistoryBar(
            () => this.historyRows(),
            () => {
                this.restingHistoryPosition = this.historyPosition(timeline);
                return this.restingHistoryPosition;
            },
            (position) => {
                const rows = this.historyRows();
                if (position >= rows.length) timeline.end();
                else timeline.rollBefore(rows.slice(position).map((row) => row.node));
            },
            (index, position) => {
                if (index < position) return false;
                // While dragging, everything past the preview; at rest, what the timeline says.
                if (position !== this.restingHistoryPosition) return true;
                const row = this.historyRows()[index];
                return row === undefined || timeline.nodeState(row.node) === "future";
            },
        );
        this.historyBar.refresh();
    }
    private readonly handleTimelineChanged = (property: string) => {
        if (property === "position" || property === "entries") this.historyBar?.refresh();
    };

    constructor(private document: IDocument) {
        super();
        this.className = style.panel;
        this.initializeTree(document);
    }

    private initializeTree(document: IDocument) {
        this.addAllNodes(document, this, document.modelManager.rootNode);
        this.addEvents(this);
        this.refreshHistory();
    }

    connectedCallback() {
        this.document.modelManager.addNodeObserver(this.handleNodeChanged);
        this.document.modelManager.onPropertyChanged(this.handleCurrentNodeChanged);
        this.document.selection.onNodeChanged.sub(this.handleSelectionChanged);
        // Guarded: a test's document or configuration may be a partial stand-in.
        this.document.variables?.onPropertyChanged?.(this.handleScopeChanged);
        config()?.onPropertyChanged(this.handlePreferencesChanged);
        this.timeline?.onPropertyChanged(this.handleTimelineChanged);
        this.scheduleOwnerColors();
    }

    disconnectedCallback() {
        this.historyBar?.dispose();
        this.timeline?.removePropertyChanged(this.handleTimelineChanged);
        this.document.modelManager.removeNodeObserver(this.handleNodeChanged);
        this.document.modelManager.removePropertyChanged(this.handleCurrentNodeChanged);
        this.document.selection.onNodeChanged.remove(this.handleSelectionChanged);
        this.document.variables?.removePropertyChanged?.(this.handleScopeChanged);
        config()?.removePropertyChanged(this.handlePreferencesChanged);
    }

    private ownerColorsQueued = false;
    private readonly handleScopeChanged = (property: string) => {
        if (property === "scope") this.scheduleOwnerColors();
    };
    private readonly handlePreferencesChanged = (property: keyof Config) => {
        if (property === "preferences") this.scheduleOwnerColors();
    };

    /** Recolours the rows by owner once the burst of changes settles. */
    private scheduleOwnerColors(): void {
        if (this.ownerColorsQueued) return;
        this.ownerColorsQueued = true;
        queueMicrotask(() => {
            this.ownerColorsQueued = false;
            if (this.document === null || !this.isConnected) return;
            this.applyOwnerColors();
        });
    }

    private applyOwnerColors(): void {
        if (typeof this.document.modelManager?.findNodes !== "function") return;
        const mode = config()?.preferences.treeOwnerColors ?? "solid";
        const ownership = computeOwnership(this.document, mode);
        // The bars join across consecutive visible rows: a run of rows the same owner uses
        // reads as one continuous strip, broken only by a row it has no part in.
        const rows = this.visibleRowsInOrder().map((row) => ({
            row,
            bars: ownerBars(ownership, row.node),
            depth: nodeDepth(row.node),
        }));
        const joins = joinOwnerBars(rows);
        const seen = new Set<TreeItem>();
        rows.forEach(({ row, bars }, index) => {
            seen.add(row);
            row.setOwnerBars?.(bars, joins[index]);
        });
        for (const [node, row] of this.nodeMap)
            if (!seen.has(row)) row.setOwnerBars?.(ownerBars(ownership, node));
    }

    /** Every row shown now — not filtered out, not inside a collapsed group — in reading order. */
    private visibleRowsInOrder(): TreeItem[] {
        const rows = [...this.nodeMap.values()].filter((row) => {
            if (row.hidden) return false;
            for (
                let parent = row.parentElement;
                parent !== null && parent !== this;
                parent = parent.parentElement
            )
                if (parent instanceof TreeGroup && !parent.isExpanded) return false;
            return true;
        });
        return rows.sort((a, b) =>
            a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        );
    }

    private readonly handleCurrentNodeChanged = (
        prop: keyof ModelManager,
        source: ModelManager,
        oldValue: any,
    ) => {
        if (prop === "currentNode") {
            if (oldValue !== undefined) {
                this.nodeMap.get(oldValue)?.removeStyle(style.current);
            }
            if (source.currentNode) {
                this.nodeMap.get(source.currentNode)?.addStyle(style.current);
            }
        }
    };

    /** Keep ancestors of matches visible so filtered nodes retain their context. */
    filter(text: string): void {
        this.filterText = text;
        const query = text.trim().toLocaleLowerCase();
        const shown = new Set<INode>();
        for (const node of this.nodeMap.keys()) {
            if (
                !query ||
                node.name.toLocaleLowerCase().includes(query) ||
                (isFeatureListNode(node) &&
                    node
                        .featureItems()
                        .some((item) =>
                            (item.name ?? I18n.translate(item.display)).toLocaleLowerCase().includes(query),
                        ))
            ) {
                let ancestor: INode | undefined = node;
                while (ancestor) {
                    shown.add(ancestor);
                    ancestor = ancestor.parent;
                }
                if (query) this.expandParents(node);
            }
        }
        for (const [node, row] of this.nodeMap) row.style.display = shown.has(node) ? "" : "none";
    }

    treeItem(node: INode): TreeItem | undefined {
        return this.nodeMap.get(node);
    }

    dispose(): void {
        this.historyBar?.dispose();
        this.lastClicked = undefined;
        this.dragging = undefined;
        this.highlightedGroup = undefined;
        this.timeline?.removePropertyChanged(this.handleTimelineChanged);
        // The rollback belongs to the document's timeline, not to this view: it stays.
        this.nodeMap.forEach((x) => {
            x.dispose();
        });
        this.nodeMap.clear();
        this.selectedNodes.clear();
        this.removeEvents(this);
        this.document.modelManager.removeNodeObserver(this.handleNodeChanged);
        this.document.modelManager.removePropertyChanged(this.handleCurrentNodeChanged);
        this.document.selection.onNodeChanged.remove(this.handleSelectionChanged);
        this.document = null as any;
    }

    readonly handleNodeChanged = (records: NodeRecord[]) => {
        this.ensureHasHTML(records);
        records.forEach((record) => {
            const ele = this.nodeMap.get(record.node);
            ele?.remove();
            if (!ele || !record.newParent) {
                this.refreshGroupExpander(record.oldParent);
                return;
            }

            const parent = this.nodeMap.get(record.newParent) || this.createAndMapParent(record.newParent);
            if (parent instanceof TreeGroup) {
                const pre = record.newPrevious ? this.nodeMap.get(record.newPrevious) : null;
                parent.insertAfter(ele, pre ?? null);
                parent.refreshExpander();
            }
            ele.refreshVisibleIcon();
            this.refreshGroupExpander(record.oldParent);
        });
        this.filter(this.filterText);
        this.refreshHistory();
        this.scheduleOwnerColors();
    };

    private refreshGroupExpander(parent: INodeLinkedList | undefined) {
        const group = parent === undefined ? undefined : this.nodeMap.get(parent);
        if (group instanceof TreeGroup) group.refreshExpander();
    }

    private createAndMapParent(newParent: INode) {
        const parent = this.createHTMLElement(this.document, newParent);
        this.nodeMap.set(newParent, parent);
        return parent;
    }

    private readonly handleSelectionChanged = (selected: INode[]) => {
        this.lastSelected?.forEach((x) => {
            this.nodeMap.get(x)?.removeStyle(style.selected);
            this.selectedNodes.delete(x);
        });
        this.lastSelected = Array.from(selected);

        selected.forEach((model) => {
            this.selectedNodes.add(model);
            this.nodeMap.get(model)?.addStyle(style.selected);
        });
        this.scrollToNode(selected);
    };

    private ensureHasHTML(records: NodeRecord[]) {
        records.forEach((record) => {
            if (!this.nodeMap.has(record.node)) {
                this.nodeMap.set(record.node, this.createHTMLElement(this.document, record.node));
            }
        });
    }

    private scrollToNode(selected: INode[]) {
        const node = selected.at(0);
        if (node) {
            this.expandParents(node);
            this.nodeMap.get(node)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    }

    private expandParents(node: INode) {
        let parent = node.parent;
        while (parent) {
            const group = this.nodeMap.get(parent) as TreeGroup;
            if (group && !group.isExpanded) {
                group.isExpanded = true;
            }
            parent = parent.parent;
        }
    }

    private addAllNodes(document: IDocument, parent: HTMLElement, node: INode) {
        const element = this.createHTMLElement(document, node);
        this.nodeMap.set(node, element);
        parent.appendChild(element);

        const firstChild = (node as INodeLinkedList).firstChild;
        if (firstChild) this.addAllNodes(document, element, firstChild);
        if (node.nextSibling) this.addAllNodes(document, parent, node.nextSibling);
    }

    private createHTMLElement(document: IDocument, node: INode): TreeItem {
        // Groups nest; every other node — visual or not (a Feature Studio holds code, not
        // geometry) — is a plain row. A file element (a drawing, an attached document) is a
        // tab of the document, not a feature: its row exists for the maps but stays hidden.
        const item = NodeUtils.isLinkedListNode(node)
            ? new TreeGroup(document, node)
            : new TreeModel(document, node);
        if (DocumentElements.hiddenInTree(node)) item.hidden = true;
        return item;
    }

    private addEvents(item: HTMLElement) {
        item.addEventListener("dragstart", this.onDragStart);
        item.addEventListener("dragover", this.onDragOver);
        item.addEventListener("dragleave", this.onDragLeave);
        item.addEventListener("dragend", this.onDragEnd);
        item.addEventListener("drop", this.onDrop);
        item.addEventListener("click", this.onClick);
        item.addEventListener("contextmenu", this.onContextMenu);
        item.addEventListener("dblclick", this.onDoubleClick);
    }

    private removeEvents(item: HTMLElement) {
        item.removeEventListener("dragstart", this.onDragStart);
        item.removeEventListener("dragover", this.onDragOver);
        item.removeEventListener("dragleave", this.onDragLeave);
        item.removeEventListener("dragend", this.onDragEnd);
        item.removeEventListener("drop", this.onDrop);
        item.removeEventListener("click", this.onClick);
        item.removeEventListener("contextmenu", this.onContextMenu);
        item.removeEventListener("dblclick", this.onDoubleClick);
    }

    private getTreeItem(item: HTMLElement | null): TreeItem | undefined {
        if (item === null) return undefined;
        if (item instanceof TreeItem) return item;
        return this.getTreeItem(item.parentElement);
    }

    private readonly onContextMenu = (event: MouseEvent) => {
        const node = this.getTreeItem(event.target as HTMLElement)?.node;
        if (!node) return;
        event.preventDefault();
        event.stopPropagation();
        showNodeContextMenu(node, event.clientX, event.clientY);
    };

    private readonly onClick = (event: MouseEvent) => {
        if (!this.canSelect()) return;

        const item = this.getTreeItem(event.target as HTMLElement)?.node;
        if (!item) return;
        event.stopPropagation();

        if (event.shiftKey) {
            this.handleShiftClick(item);
        } else {
            this.document.selection.setSelectedNodes(
                [item],
                event.ctrlKey || event.metaKey || this.document.selection.getSelectedNodes().includes(item),
            );
        }

        this.handleLastClickItem(item);
    };

    /** Lets feature packages react to a node double-click (e.g. sketch editing). */
    private readonly onDoubleClick = (event: MouseEvent) => {
        const node = this.getTreeItem(event.target as HTMLElement)?.node;
        if (node === undefined) return;
        event.stopPropagation();
        // The marker follows the step being opened (a sketch, a plain node): the model shows
        // the state with it just applied, before the editors react to the double-click.
        partStudioTimeline(this.document)?.rollAfter(node);
        PubSub.default.pub("nodeDoubleClicked", node);
    };

    private handleShiftClick(item: INode) {
        if (this.lastClicked) {
            const nodes = NodeUtils.getNodesBetween(this.lastClicked, item);
            this.document.selection.setSelectedNodes(nodes, false);
        }
    }

    private readonly onDragLeave = (event: DragEvent) => {
        if (event.target === this) {
            this.clearDropTargetHighlight();
        }
    };

    private readonly onDragOver = (event: DragEvent) => {
        if (!this.canDrop(event)) {
            this.clearDropTargetHighlight();
            return;
        }
        event.preventDefault();
        event.dataTransfer!.dropEffect = "move";

        const group = this.getDropTargetGroup(event.target as HTMLElement);
        if (group !== this.highlightedGroup) {
            this.clearDropTargetHighlight();
            if (group) {
                this.highlightedGroup = group;
                group.classList.add(style.dropTarget);
            }
        }
    };

    private canSelect() {
        return canSelectNodes(this.document);
    }

    /**
     * Remembers the clicked row for Shift ranges. Clicking never moves the model manager's
     * `currentNode`: where new parts go is the active component's business alone
     * (`ComponentContext`), so a click on a folder only selects it.
     */
    private handleLastClickItem(item: INode | undefined) {
        this.lastClicked = item;
    }

    private canDrop(event: DragEvent) {
        const node = this.getTreeItem(event.target as HTMLElement)?.node;
        return node !== undefined && this.canDropNode(node);
    }

    private canDropNode(node: INode) {
        if (this.dragging?.includes(node)) return false;
        // Rows under a parametric body (consumed tools) accept no drops.
        if (node.parent !== undefined && !(node.parent instanceof FolderNode)) return false;
        let parent: INodeLinkedList | undefined = node.parent;
        while (parent !== undefined) {
            if (this.dragging?.includes(parent)) return false;
            parent = parent.parent;
        }
        return true;
    }

    protected onDrop = (event: DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        this.clearDropTargetHighlight();

        const node = this.getTreeItem(event.target as HTMLElement)?.node;
        if (node === undefined || !this.canDropNode(node)) return;
        Transaction.execute(this.document, "move node", () => {
            // Drop INTO folders only — dropping onto a parametric body (also a linked
            // list, holding hidden consumed tools) inserts as its sibling instead.
            const isFolder = node instanceof FolderNode;
            const newParent = isFolder ? (node as INodeLinkedList) : node.parent;
            if (!(newParent instanceof FolderNode)) return; // never drop into a body
            const target = isFolder ? undefined : node;
            this.dragging?.forEach((x) => {
                x.parent?.move(x, newParent, target);
            });
            this.dragging = undefined;
        });
    };

    private readonly onDragStart = (event: DragEvent) => {
        event.stopPropagation();
        const item = this.getTreeItem(event.target as HTMLElement)?.node;
        // Consumed boolean tools (children of a parametric body) stay with the body.
        const draggable = (x: INode) => x.parent === undefined || x.parent instanceof FolderNode;
        this.dragging = NodeUtils.findTopLevelNodes(this.selectedNodes).filter(draggable);
        if (
            item &&
            draggable(item) &&
            !this.dragging.includes(item) &&
            !NodeUtils.containsDescendant(this.selectedNodes, item)
        ) {
            this.dragging.push(item);
        }
    };

    private readonly onDragEnd = () => {
        this.clearDropTargetHighlight();
        this.dragging = undefined;
    };

    private getDropTargetGroup(element: HTMLElement): TreeGroup | undefined {
        // Folders only — a parametric body's TreeGroup holds hidden consumed tools
        // and is not a drop target (the drop lands next to the body instead).
        let current: HTMLElement | null = this.getTreeItem(element) ?? null;
        while (current) {
            if (current instanceof TreeGroup && current.node instanceof FolderNode) return current;
            current = current.parentElement;
        }
        return undefined;
    }

    private clearDropTargetHighlight() {
        if (this.highlightedGroup) {
            this.highlightedGroup.classList.remove(style.dropTarget);
            this.highlightedGroup = undefined;
        }
    }
}

customElements.define("ui-tree", Tree);

/** How deep a node sits in the model tree (the root at 0). */
function nodeDepth(node: INode): number {
    let depth = 0;
    for (let parent = node.parent; parent !== undefined; parent = parent.parent) depth++;
    return depth;
}
