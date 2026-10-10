// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    FolderNode,
    GroupNode,
    type IDocument,
    type IFeatureListNode,
    type INode,
    type IView,
    isFeatureListNode,
    Localize,
    Node,
    PropertyUtils,
    PubSub,
    VisualNode,
} from "@chili3d/core";
import { div, Expander, label } from "@chili3d/element";
import { propertyControl } from "./complexPropertyUtils";
import { FeatureListProperty } from "./featureListProperty";
import { MatrixProperty } from "./matrixProperty";
import style from "./propertyView.module.css";

export class PropertyView extends HTMLElement {
    private readonly panel = div({ className: style.panel });

    constructor(props: { className: string; showHeader?: boolean }) {
        super();
        this.classList.add(style.root);
        if (props.className) this.classList.add(props.className);
        this.dataset["empty"] = "true";
        this.append(
            label({
                className: style.header,
                textContent: new Localize("properties.header"),
            }),
            this.panel,
        );
        if (props.showHeader === false) this.querySelector(`.${style.header}`)?.remove();
        PubSub.default.sub("showProperties", this.handleShowProperties);
        PubSub.default.sub("activeViewChanged", this.handleActiveViewChanged);
    }

    private readonly handleActiveViewChanged = (view: IView | undefined) => {
        if (view) {
            const nodes = view.document.selection.getSelectedNodes();
            this.handleShowProperties(view.document, nodes);
        }
    };

    private readonly handleShowProperties = (document: IDocument, nodes: INode[]) => {
        this.removeProperties();
        this.dataset["empty"] = String(nodes.length === 0);
        if (nodes.length === 0) return;
        this.addModel(document, nodes);
        this.addGeometry(nodes, document);
        this.addFeatureList(document, nodes);
    };

    private removeProperties() {
        while (this.panel.lastElementChild) {
            this.panel.removeChild(this.panel.lastElementChild);
        }
    }

    private addModel(document: IDocument, nodes: INode[]) {
        if (nodes.length === 0) return;

        let controls: (HTMLElement | string)[] = [];
        if (nodes[0] instanceof FolderNode) {
            controls = PropertyUtils.getProperties(Object.getPrototypeOf(nodes[0])).map((x) =>
                propertyControl(document, nodes, x),
            );
        } else if (nodes[0] instanceof Node) {
            controls = PropertyUtils.getOwnProperties(Node.prototype).map((x) =>
                propertyControl(document, nodes, x),
            );
        }

        this.panel.append(div({ className: style.properties }, ...controls));
    }

    private addGeometry(nodes: INode[], document: IDocument) {
        const geometries = nodes.filter((x) => x instanceof VisualNode || x instanceof GroupNode);
        if (geometries.length === 0) return;
        if (this.isAllElementsOfTypeFirstElement(geometries)) this.addTransform(document, geometries);
        this.addParameters(geometries, document);
    }

    private addTransform(document: IDocument, geometries: (VisualNode | GroupNode)[]) {
        const matrix = new Expander("common.matrix");
        this.panel.append(matrix);

        matrix.contenxtPanel.append(new MatrixProperty(document, geometries, style.properties));
    }

    /**
     * The parameters every selected entity has: those of their nearest common class, so a
     * mixed selection (a note, a datum and a feature control frame) still edits the properties
     * their base class declares together.
     */
    private addParameters(geometries: (VisualNode | GroupNode)[], document: IDocument) {
        if (geometries.length !== geometries.filter((x) => x instanceof VisualNode).length) return;
        const entities = geometries as VisualNode[];
        const common = this.nearestCommonPrototype(entities);
        if (!common) return;
        const properties = PropertyUtils.getProperties(common, Node.prototype);
        if (properties.length === 0) return;
        // a mixed selection is titled by the common class when it names itself (abstract ones may not)
        const commonDisplay = (common as Partial<VisualNode>).display;
        const title =
            this.isAllElementsOfTypeFirstElement(entities) || typeof commonDisplay !== "function"
                ? entities[0].display()
                : commonDisplay.call(entities[0]);
        const parameters = new Expander(title);
        parameters.contenxtPanel.append(...properties.map((x) => propertyControl(document, entities, x)));
        this.panel.append(parameters);
    }

    /** The closest prototype on every item's chain, or undefined when they share none. */
    private nearestCommonPrototype(items: readonly object[]): object | undefined {
        const chains = items.slice(1).map((item) => {
            const chain = new Set<object>();
            for (let proto = Object.getPrototypeOf(item); proto; proto = Object.getPrototypeOf(proto)) {
                chain.add(proto);
            }
            return chain;
        });
        for (let proto = Object.getPrototypeOf(items[0]); proto; proto = Object.getPrototypeOf(proto)) {
            if (chains.every((chain) => chain.has(proto))) return proto;
        }
        return undefined;
    }

    private addFeatureList(document: IDocument, nodes: INode[]) {
        if (nodes.length !== 1 || !isFeatureListNode(nodes[0])) return;

        const features = new Expander("features.header");
        features.contenxtPanel.append(
            new FeatureListProperty(document, nodes[0] as INode & IFeatureListNode),
        );
        this.panel.append(features);
    }

    private isAllElementsOfTypeFirstElement(arr: readonly object[]): boolean {
        if (arr.length <= 1) {
            return true;
        }
        const firstElementType = Object.getPrototypeOf(arr[0]).constructor;
        for (let i = 1; i < arr.length; i++) {
            if (Object.getPrototypeOf(arr[i]).constructor !== firstElementType) {
                return false;
            }
        }
        return true;
    }
}

customElements.define("chili-property-view", PropertyView);
