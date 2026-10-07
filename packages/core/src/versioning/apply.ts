// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Transaction } from "../foundation/transaction";
import { I18n } from "../i18n";
import type { Material } from "../material";
import type { Component } from "../model/component";
import { isFeatureListNode } from "../model/featureList";
import { type INode, type INodeLinkedList, NodeUtils } from "../model/node";
import type { VariableData } from "../parameters/variableData";
import { InternalClassName, type Serialized, Serializer } from "../serialize";
import { jsonEquals } from "./hash";
import { propertyEquals, type SeqItem } from "./parts";
import { type DocumentSnapshot, type NodeSnapshot, preorder, serializedNode } from "./snapshot";

/**
 * Brings a live document to a snapshot IN PLACE — the document object, its views and every node
 * that did not change stay as they are. Only what differs is touched:
 *
 * - a changed property is assigned through the node's own setter, so the node reacts exactly
 *   as to an edit (a body whose `featuresJson` changed rebuilds; an untouched body does not);
 * - a node whose class changed, or whose changed property has no setter, is replaced by a
 *   freshly deserialized one with the same id;
 * - nodes are created, moved and removed to match the snapshot's tree;
 * - variables, materials and components are patched the same way.
 *
 * `undoable: true` runs the patch as one transaction (restore, merge: one undo step);
 * `false` applies it with history off (switching branches is not an edit).
 */
export interface ApplyOptions {
    readonly undoable: boolean;
    /** The transaction name for an undoable apply. */
    readonly name?: string;
}

export interface ApplyReport {
    readonly added: number;
    readonly removed: number;
    readonly updated: number;
    readonly replaced: number;
}

const SKIP_KEYS = new Set(["id", "parentId", InternalClassName]);

export function applySnapshot(
    document: IDocument,
    target: DocumentSnapshot,
    options: ApplyOptions,
): ApplyReport {
    const patch = new SnapshotPatch(document, target);
    if (options.undoable) {
        Transaction.execute(document, options.name ?? "restore", () => patch.run());
        return patch.report();
    }
    const history = document.history;
    const disabled = history.disabled;
    history.disabled = true;
    try {
        patch.run();
    } finally {
        history.disabled = disabled;
    }
    // No history record owns what was removed — dispose it here.
    patch.disposeRemoved();
    return patch.report();
}

class SnapshotPatch {
    private added = 0;
    private updated = 0;
    private readonly removedNodes: INode[] = [];
    private readonly removedMaterials: Material[] = [];
    private replaced = 0;

    constructor(
        private readonly document: IDocument,
        private readonly target: DocumentSnapshot,
    ) {}

    report(): ApplyReport {
        return {
            added: this.added,
            removed: this.removedNodes.length,
            updated: this.updated,
            replaced: this.replaced,
        };
    }

    run(): void {
        // Variables first: a body resolves its parameters against them when it rebuilds.
        const variables = this.target.variables.map((x) => x.value) as unknown as VariableData[];
        if (!jsonEquals(this.document.variables.items, variables))
            this.document.variables.setItems(variables);
        const staleMaterials = this.patchMaterials();
        const staleComponents = this.patchComponents();
        this.patchNodes();
        // Removed last, once no node refers to them any more.
        if (staleMaterials.length > 0) {
            this.document.modelManager.materials.remove(...staleMaterials);
            this.removedMaterials.push(...staleMaterials);
        }
        if (staleComponents.length > 0) this.document.modelManager.components.remove(...staleComponents);
        this.patchMeta();
    }

    disposeRemoved(): void {
        for (const node of this.removedNodes) node.dispose();
        for (const material of this.removedMaterials) material.dispose();
    }

    // ------------------------------------------------------------------ Nodes

    private patchNodes(): void {
        const root = this.document.modelManager.rootNode;
        const live = new Map<string, INode>([[this.target.rootId, root]]);
        for (const node of NodeUtils.children(root)) live.set(node.id, node);

        // 1. Properties of nodes that stay; a node that cannot be patched is replaced.
        for (const [id, snapshot] of this.target.nodes) {
            const node = live.get(id);
            if (node === undefined) continue;
            const current = Serializer.serializeObject(node);
            const patched =
                current[InternalClassName] === snapshot.cls &&
                this.patchProperties(node, current, snapshot.props);
            if (!patched && node !== root) {
                live.delete(id);
                this.replaced++;
            }
        }

        // 2. Structure, top-down: each container's children in snapshot order, creating the
        // missing ones. A container is always placed before its own children are arranged.
        for (const id of preorder(this.target)) {
            const snapshot = this.target.nodes.get(id)!;
            if (snapshot.children === undefined) continue;
            const parent = live.get(id);
            if (parent === undefined || !NodeUtils.isLinkedListNode(parent)) continue;
            let previous: INode | undefined;
            for (const childId of snapshot.children) {
                const childSnapshot = this.target.nodes.get(childId);
                if (childSnapshot === undefined) continue;
                let child = live.get(childId);
                if (child === undefined) {
                    child = this.create(childId, childSnapshot);
                    live.set(childId, child);
                    parent.insertAfter(previous, child);
                    this.added++;
                } else if (child.parent !== parent) {
                    if (child.parent === undefined) parent.insertAfter(previous, child);
                    else child.parent.move(child, parent, previous);
                } else if (child.previousSibling !== previous) {
                    parent.move(child, parent, previous);
                }
                previous = child;
            }
        }

        // 3. Whatever the snapshot does not have (or replaced) leaves the tree.
        const leftovers: INode[] = [];
        const collect = (parent: INodeLinkedList) => {
            let child = parent.firstChild;
            while (child !== undefined) {
                if (!this.target.nodes.has(child.id) || live.get(child.id) !== child) leftovers.push(child);
                else if (NodeUtils.isLinkedListNode(child)) collect(child);
                child = child.nextSibling;
            }
        };
        collect(root);
        // Last first: undoing a removal re-appends the node to its parent, so undoing them in
        // reverse brings trailing nodes back in their original order.
        for (const node of leftovers.reverse()) {
            node.parent?.remove(node);
            this.removedNodes.push(node);
        }
    }

    private create(id: string, snapshot: NodeSnapshot): INode {
        return Serializer.deserializeObject(this.document, serializedNode(id, snapshot)) as INode;
    }

    /**
     * Assigns the properties that differ through the node's setters. False when one of them
     * cannot be assigned (no setter) — the caller replaces the node instead.
     */
    private patchProperties(
        target: object,
        current: Serialized,
        props: Readonly<Record<string, unknown>>,
    ): boolean {
        const cls = current[InternalClassName];
        const keys = new Set([...Object.keys(current), ...Object.keys(props)]);
        const changed = [...keys].filter(
            (key) => !SKIP_KEYS.has(key) && !propertyEquals(cls, key, current[key], props[key]),
        );
        if (changed.length === 0) return true;
        if (!changed.every((key) => Serializer.isWritable(target, key))) return false;
        for (const key of changed) {
            (target as Record<string, unknown>)[key] = Serializer.deserialValue(this.document, props[key]);
        }
        this.updated++;
        return true;
    }

    // ------------------------------------------------------------------ Materials, components, meta

    /** Adds and patches materials; returns the ones the snapshot no longer has. */
    private patchMaterials(): Material[] {
        const collection = this.document.modelManager.materials;
        const wanted = new Set(this.target.materials.map((x) => x.id));
        const byId = new Map<string, Material>(collection.map((x) => [x.id, x] as const));
        const stale = collection.filter((x) => !wanted.has(x.id));
        for (const item of this.target.materials) {
            const existing = byId.get(item.id);
            if (existing !== undefined) {
                const current = Serializer.serializeObject(existing);
                const value = item.value as Serialized;
                if (
                    current[InternalClassName] === value[InternalClassName] &&
                    this.patchProperties(existing, current, value)
                ) {
                    continue;
                }
                stale.push(existing);
            }
            collection.push(this.deserialize<Material>(item));
        }
        return stale;
    }

    private patchComponents(): Component[] {
        const collection = this.document.modelManager.components;
        const wanted = new Map(this.target.components.map((x) => [x.id, x]));
        const stale: Component[] = [];
        const have = new Set<string>();
        for (const component of collection) {
            const item = wanted.get(component.id);
            if (item !== undefined && jsonEquals(Serializer.serializeObject(component), item.value)) {
                have.add(component.id);
            } else {
                stale.push(component);
            }
        }
        for (const item of this.target.components) {
            if (!have.has(item.id)) collection.push(this.deserialize<Component>(item));
        }
        return stale;
    }

    private deserialize<T>(item: SeqItem): T {
        return Serializer.deserializeObject(this.document, item.value as Serialized) as T;
    }

    private patchMeta(): void {
        const { meta } = this.target;
        if (meta.name !== "" && this.document.name !== meta.name) this.document.name = meta.name;
        if (!jsonEquals(this.document.userData ?? {}, meta.userData)) {
            this.document.userData = structuredClone(meta.userData) as Record<string, unknown>;
        }
        const acts = this.document.acts.map((x) => Serializer.serializeObject(x));
        if (!jsonEquals(acts, meta.acts)) {
            const old = [...this.document.acts];
            this.document.acts.clear();
            for (const act of old) act.dispose();
            this.document.acts.push(
                ...meta.acts.map((x) => Serializer.deserializeObject(this.document, x as Serialized)),
            );
        }
    }
}

/** A feature that failed to rebuild, as surfaced after a restore or merge. */
export interface FeatureErrorReport {
    readonly nodeId: string;
    readonly nodeName: string;
    readonly feature: string;
    readonly message: string;
}

/** Every failing feature of every feature-list node in the document. */
export function collectFeatureErrors(document: IDocument): FeatureErrorReport[] {
    const errors: FeatureErrorReport[] = [];
    for (const node of document.modelManager.findNodes()) {
        if (!isFeatureListNode(node)) continue;
        for (const item of node.featureItems()) {
            if (item.error === undefined) continue;
            errors.push({
                nodeId: node.id,
                nodeName: node.name,
                feature: item.name ?? I18n.translate(item.display) ?? item.id,
                message: item.error,
            });
        }
    }
    return errors;
}
