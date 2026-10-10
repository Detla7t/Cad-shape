// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { PubSub } from "../foundation/pubsub";
import { isComponentFolder } from "./componentFolderNode";
import type { INodeLinkedList } from "./node";

/**
 * The component being worked in (Fusion's activated component): a `ComponentFolderNode` of the
 * document, or none for the whole document. Activating one makes it the model manager's
 * `currentNode`, so new nodes go into it, and the timeline shows only its steps; the tree's
 * own `currentNode` bookkeeping (the folder of the clicked row) never activates anything.
 * A plain folder is not a component: asking to activate one does nothing.
 */
export class ComponentContext {
    private static readonly active = new WeakMap<IDocument, INodeLinkedList>();

    /** The active folder, or undefined for the whole document. */
    static activeOf(document: IDocument): INodeLinkedList | undefined {
        return ComponentContext.active.get(document);
    }

    /** Whether `node` can be the active component: a component node of this document. */
    static canActivate(node: INodeLinkedList | undefined): boolean {
        return isComponentFolder(node);
    }

    /**
     * Activates `component` (the root or undefined deactivates); publishes
     * `activeComponentChanged`. A node that is not a component is ignored.
     */
    static activate(document: IDocument, component: INodeLinkedList | undefined): void {
        const target = component === document.modelManager.rootNode ? undefined : component;
        if (target !== undefined && !ComponentContext.canActivate(target)) return;
        if (ComponentContext.active.get(document) === target) return;
        if (target === undefined) ComponentContext.active.delete(document);
        else ComponentContext.active.set(document, target);
        document.modelManager.currentNode = target;
        PubSub.default.pub("activeComponentChanged", document, target);
    }

    /** Back to the nearest component above the active one (the whole document past the top). */
    static activateParent(document: IDocument): void {
        let parent = ComponentContext.activeOf(document)?.parent;
        while (parent !== undefined && !ComponentContext.canActivate(parent)) parent = parent.parent;
        ComponentContext.activate(document, parent);
    }
}
