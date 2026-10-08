// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    FolderNode,
    type IDocument,
    type INode,
    type IShape,
    MultiShapeNode,
    NodeSelectionHandler,
    ShapeNode,
    ShapeSelectionHandler,
    ShapeTypes,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import style from "./modelSidebar.module.css";
import { showNodeContextMenu } from "./nodeContextMenu";
import { TreeModel } from "./tree/treeModel";

const solidResults = new WeakMap<IShape, boolean>();
function containsSolid(shape: IShape): boolean {
    if (shape.shapeType === ShapeTypes.solid || shape.shapeType === ShapeTypes.compoundSolid) return true;
    if (shape.shapeType !== ShapeTypes.compound) return false;
    const cached = solidResults.get(shape);
    if (cached !== undefined) return cached;
    const solids = shape.findSubShapes(ShapeTypes.solid);
    const result = solids.length > 0;
    for (const solid of solids) solid.dispose();
    solidResults.set(shape, result);
    return result;
}

/** Results are aliases of model nodes, never a second set of geometry or undo records. */
export function isPartNode(node: INode): boolean {
    // Boolean tools belong to their owning body, even if their own visibility flag is true.
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (!(parent instanceof FolderNode)) return false;
    }
    if (node instanceof ShapeNode) {
        if (node.display() === "body.sketch") return false;
        const shape = node.shape.unchecked();
        return shape !== undefined && containsSolid(shape);
    }
    return node instanceof MultiShapeNode && node.shapes.some(containsSolid);
}

export class PartsList extends HTMLElement {
    private readonly rows = new Map<INode, TreeModel>();
    private readonly watches = new Set<INode>();
    private pending = false;
    private anchor?: INode;
    private order: INode[] = [];
    private model?: IDocument;
    onCountChanged?: (count: number) => void;

    constructor() {
        super();
        this.className = style.parts;
        this.setAttribute("aria-label", "Parts");
    }

    setDocument(model: IDocument | undefined) {
        if (this.model === model) return;
        this.unsubscribe();
        this.clearRows();
        this.anchor = undefined;
        this.model = model;
        model?.modelManager.addNodeObserver(this.changed);
        model?.selection.onNodeChanged.sub(this.selectionChanged);
        this.refresh();
    }

    private unsubscribe() {
        this.model?.modelManager.removeNodeObserver(this.changed);
        this.model?.selection.onNodeChanged.remove(this.selectionChanged);
        for (const node of this.watches) node.removePropertyChanged(this.changed);
        this.watches.clear();
    }

    private clearRows() {
        for (const row of this.rows.values()) row.dispose();
        this.rows.clear();
        this.replaceChildren();
    }

    dispose() {
        this.setDocument(undefined);
    }

    private readonly changed = () => {
        if (this.pending) return;
        this.pending = true;
        queueMicrotask(() => {
            this.pending = false;
            this.refresh();
        });
    };

    private refresh() {
        for (const node of this.watches) node.removePropertyChanged(this.changed);
        this.watches.clear();
        const model = this.model;
        if (!model) {
            this.order = [];
            this.onCountChanged?.(0);
            return;
        }
        const nodes = model.modelManager.findNodes();
        const parts = nodes.filter((node) => {
            if (!(node instanceof ShapeNode || node instanceof MultiShapeNode)) return false;
            (node as INode).onPropertyChanged(this.changed);
            this.watches.add(node);
            return isPartNode(node);
        });
        for (const [node, row] of this.rows) {
            if (!parts.includes(node)) {
                row.dispose();
                this.rows.delete(node);
            }
        }
        this.order = parts;
        for (const [index, node] of parts.entries()) {
            let row = this.rows.get(node);
            if (!row) {
                row = new TreeModel(model, node);
                row.draggable = false;
                row.dataset["partId"] = node.id;
                row.tabIndex = 0;
                row.setAttribute("role", "button");
                const icon = createCadIcon("part");
                icon.classList.add(style.partIcon);
                row.replaceChildren(icon, row.name, row.visibleIcon, row.warningBadge);
                row.onclick = (event) => this.select(node, event);
                row.onkeydown = (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        this.select(node, event);
                    }
                };
                row.oncontextmenu = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    showNodeContextMenu(node, event.clientX, event.clientY);
                };
                this.rows.set(node, row);
            }
            row.setAttribute("aria-label", node.name);
            row.dataset["hidden"] = String(!node.visible || !node.parentVisible);
            row.refreshVisibleIcon();
            if (this.children[index] !== row) this.insertBefore(row, this.children[index] ?? null);
        }
        this.selectionChanged(this.model?.selection.getSelectedNodes() ?? []);
        this.onCountChanged?.(parts.length);
    }

    private select(node: INode, event: MouseEvent | KeyboardEvent) {
        const handler = this.model?.visual.eventHandler;
        if (
            !(handler instanceof NodeSelectionHandler) &&
            !(handler instanceof ShapeSelectionHandler && handler.shapeType === ShapeTypes.shape)
        )
            return;
        event.stopPropagation();
        let selected = [node];
        if (event.shiftKey && this.anchor && this.rows.has(this.anchor)) {
            const nodes = this.order;
            const from = nodes.indexOf(this.anchor),
                to = nodes.indexOf(node);
            selected = nodes.slice(Math.min(from, to), Math.max(from, to) + 1);
        }
        this.model?.selection.setSelectedNodes(selected, event.ctrlKey || event.metaKey);
        this.anchor = node;
    }

    private readonly selectionChanged = (nodes: INode[]) => {
        for (const [node, row] of this.rows) {
            row.classList.toggle(style.selected, nodes.includes(node));
            row.setAttribute("aria-pressed", String(nodes.includes(node)));
        }
    };
}

customElements.define("chili-parts-list", PartsList);
