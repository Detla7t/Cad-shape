// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type INode, isFeatureListNode, NodeEvaluation, ShapeNode } from "@chili3d/core";
import { span } from "@chili3d/element";
import { mountEvaluationIndicator, type ReactIsland } from "@chili3d/react";
import { TreeItem } from "./treeItem";
import style from "./treeModel.module.css";

export class TreeModel extends TreeItem {
    /**
     * Holds the shared evaluation indicator of a shape node (a sketch that failed to rebuild);
     * other rows have none. Feature lists show theirs in their timeline instead.
     */
    private readonly evaluationHost: HTMLElement | undefined;
    private indicator: ReactIsland | undefined;

    constructor(document: IDocument, node: INode) {
        super(document, node);
        const typeIcon = this.createTypeIcon();
        if (typeIcon !== undefined) this.append(typeIcon);
        this.append(this.name, this.visibleIcon, this.warningBadge);
        if (node instanceof ShapeNode && !isFeatureListNode(node)) {
            this.evaluationHost = span({ className: style.evaluation });
            this.append(this.evaluationHost);
        }
        this.classList.add(style.panel);
    }

    mainElement(): HTMLElement {
        return this;
    }

    override connectedCallback(): void {
        super.connectedCallback();
        if (this.evaluationHost === undefined) return;
        this.node.onPropertyChanged(this.onEvaluationChanged);
        // Rows connect while a host (possibly a React effect) moves the UI; mount after it.
        queueMicrotask(() => {
            if (this.isConnected) this.syncIndicator();
        });
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        this.stopIndicator();
    }

    override dispose(): void {
        this.stopIndicator();
        super.dispose();
    }

    private stopIndicator(): void {
        if (this.evaluationHost === undefined) return;
        this.node?.removePropertyChanged(this.onEvaluationChanged);
        this.indicator?.dispose();
        this.indicator = undefined;
    }

    private readonly onEvaluationChanged = (property: string | number | symbol) => {
        if (property === "evaluationError") this.syncIndicator();
    };

    /**
     * Mounted on the first failure only (most rows never fail, so they hold no React root);
     * from then on the indicator follows the node by itself and hides while ready.
     */
    private syncIndicator(): void {
        const node = this.node;
        if (this.evaluationHost === undefined || this.indicator !== undefined) return;
        if (!(node instanceof ShapeNode) || node.evaluationError === undefined) return;
        this.indicator = mountEvaluationIndicator(this.evaluationHost, new NodeEvaluation(node).node, {
            hideReady: true,
        });
    }
}

customElements.define("tree-model", TreeModel);
