// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { InternalClassName, type Serialized } from "../serialize";
import { isJsonObject, type JsonObject, type JsonValue, toJsonValue } from "./hash";
import type { IObjectStore } from "./objectStore";
import { type NodeObj, type ObjectHash, SHARD_COUNT, type ShardObj, shardOf, type TreeObj } from "./objects";
import { joinProperty, loadPart, type SeqItem, splitProperty, storePart } from "./parts";

/**
 * Normalization: a document's serialized form ⇄ the store's object tree.
 *
 * A node object keeps the node's serialized properties minus `id` (its key) and `parentId`
 * (structure lives in the parent's `children`), with every property a `PropertySplitter` (or
 * the large-value rule) claims moved into `parts`.
 */

/** Everything a node object holds except its child order — cached per node by the capture. */
export interface NodeContent {
    readonly cls: string;
    readonly props: JsonObject;
    readonly parts: Readonly<Record<string, ObjectHash>>;
    readonly raw?: readonly string[];
}

/** A node read back from a tree, with its split properties joined again. */
export interface NodeSnapshot {
    readonly cls: string;
    /** Serialized properties, without `id`, `parentId` and the class tag. */
    readonly props: Readonly<Record<string, unknown>>;
    readonly children?: readonly string[];
}

/** A whole document read back from a tree. */
export interface DocumentSnapshot {
    readonly meta: DocumentMeta;
    readonly rootId: string;
    readonly nodes: ReadonlyMap<string, NodeSnapshot>;
    readonly variables: readonly SeqItem[];
    readonly materials: readonly SeqItem[];
    readonly components: readonly SeqItem[];
}

export interface DocumentMeta {
    readonly name: string;
    readonly userData: JsonObject;
    readonly acts: readonly JsonValue[];
}

const STRUCTURAL_KEYS = new Set(["id", "parentId", InternalClassName]);

/**
 * Splits a node's serialized form into its content. `previous` (the node's content in the last
 * snapshot) lets text parts be stored as deltas against their previous version.
 */
export function nodeContent(
    store: IObjectStore,
    serialized: Serialized,
    previous?: NodeContent,
): NodeContent {
    const cls = serialized[InternalClassName];
    const props: JsonObject = {};
    const parts: Record<string, ObjectHash> = {};
    const raw: string[] = [];
    for (const key of Object.keys(serialized).sort()) {
        if (STRUCTURAL_KEYS.has(key)) continue;
        const value = serialized[key];
        if (value === undefined || typeof value === "function") continue;
        const split = splitProperty(cls, key, value);
        if (split === undefined) {
            props[key] = toJsonValue(value);
            continue;
        }
        parts[key] = storePart(store, split.part, previous?.parts[key]);
        if (split.raw) raw.push(key);
    }
    return raw.length > 0 ? { cls, props, parts, raw } : { cls, props, parts };
}

export function nodeObject(content: NodeContent, children: readonly string[] | undefined): NodeObj {
    return {
        t: "node",
        cls: content.cls,
        props: content.props,
        parts: content.parts,
        ...(content.raw === undefined ? {} : { raw: content.raw }),
        ...(children === undefined ? {} : { children }),
    };
}

/** Items of an ordered collection, keyed by `idOf`; a missing or repeated id is made unique. */
export function seqItems<T>(values: readonly T[], idOf: (value: T) => unknown): SeqItem[] {
    const seen = new Set<string>();
    return values.map((value, index) => {
        const raw = idOf(value);
        let id = typeof raw === "string" || typeof raw === "number" ? String(raw) : `#${index}`;
        while (seen.has(id)) id = `${id}~`;
        seen.add(id);
        return { id, value: toJsonValue(value) };
    });
}

/** Writes the node index shards for `nodes` (id → node object hash). */
export function storeShards(store: IObjectStore, nodes: ReadonlyMap<string, ObjectHash>): ObjectHash[] {
    const buckets: Record<string, ObjectHash>[] = Array.from({ length: SHARD_COUNT }, () => ({}));
    for (const id of [...nodes.keys()].sort()) buckets[shardOf(id)][id] = nodes.get(id)!;
    return buckets.map((n) => store.put({ t: "shard", n } satisfies ShardObj));
}

export function getTree(store: IObjectStore, hash: ObjectHash): TreeObj {
    const tree = store.get(hash);
    if (tree?.t !== "tree") throw new Error(`version store: ${hash} is not a tree`);
    return tree;
}

/** id → node object hash of every node in a tree. */
export function treeNodes(store: IObjectStore, tree: TreeObj): Map<string, ObjectHash> {
    const nodes = new Map<string, ObjectHash>();
    for (const shardHash of tree.shards) {
        const shard = store.get(shardHash);
        if (shard?.t !== "shard") throw new Error(`version store: ${shardHash} is not a shard`);
        for (const [id, hash] of Object.entries(shard.n)) nodes.set(id, hash);
    }
    return nodes;
}

export function getNode(store: IObjectStore, hash: ObjectHash): NodeObj {
    const node = store.get(hash);
    if (node?.t !== "node") throw new Error(`version store: ${hash} is not a node`);
    return node;
}

/** A node object with its parts joined back into serialized property values. */
export function readNode(store: IObjectStore, hash: ObjectHash): NodeSnapshot {
    const node = getNode(store, hash);
    const props: Record<string, unknown> = { ...node.props };
    const raw = new Set(node.raw ?? []);
    for (const [key, partHash] of Object.entries(node.parts)) {
        props[key] = joinProperty(node.cls, key, loadPart(store, partHash), raw.has(key));
    }
    return node.children === undefined
        ? { cls: node.cls, props }
        : { cls: node.cls, props, children: node.children };
}

export function readSeq(store: IObjectStore, hash: ObjectHash): SeqItem[] {
    const part = loadPart(store, hash);
    if (part.kind !== "seq") throw new Error(`version store: ${hash} is not a collection`);
    return [...part.items];
}

export function readMeta(store: IObjectStore, hash: ObjectHash): DocumentMeta {
    const part = loadPart(store, hash);
    const value = part.kind === "json" && isJsonObject(part.value) ? part.value : {};
    return {
        name: typeof value["name"] === "string" ? value["name"] : "",
        userData: isJsonObject(value["userData"]) ? value["userData"] : {},
        acts: Array.isArray(value["acts"]) ? value["acts"] : [],
    };
}

/** Reads a whole document snapshot back from a tree. */
export function readTree(store: IObjectStore, treeHash: ObjectHash): DocumentSnapshot {
    const tree = getTree(store, treeHash);
    const nodes = new Map<string, NodeSnapshot>();
    for (const [id, hash] of treeNodes(store, tree)) nodes.set(id, readNode(store, hash));
    return {
        meta: readMeta(store, tree.meta),
        rootId: tree.root,
        nodes,
        variables: readSeq(store, tree.variables),
        materials: readSeq(store, tree.materials),
        components: readSeq(store, tree.components),
    };
}

/**
 * Writes a snapshot into the store and returns its tree hash — the inverse of `readTree`. The
 * live capture builds the same objects incrementally; this writes a snapshot given as data (a
 * serialized document, a test fixture).
 */
export function writeSnapshot(store: IObjectStore, snapshot: DocumentSnapshot): ObjectHash {
    const nodes = new Map<string, ObjectHash>();
    for (const [id, node] of snapshot.nodes) {
        const content = nodeContent(store, serializedNode(id, node));
        nodes.set(id, store.put(nodeObject(content, node.children)));
    }
    const tree: TreeObj = {
        t: "tree",
        root: snapshot.rootId,
        meta: storePart(store, { kind: "json", value: toJsonValue(snapshot.meta) }),
        shards: storeShards(store, nodes),
        variables: storePart(store, { kind: "seq", role: "variable", items: [...snapshot.variables] }),
        materials: storePart(store, { kind: "seq", role: "material", items: [...snapshot.materials] }),
        components: storePart(store, { kind: "seq", role: "component", items: [...snapshot.components] }),
    };
    return store.put(tree);
}

/** Node ids in tree order (pre-order from the root, children in order); unreachable ids are left out. */
export function preorder(snapshot: Pick<DocumentSnapshot, "rootId" | "nodes">): string[] {
    const order: string[] = [];
    const visit = (id: string, seen: Set<string>) => {
        if (seen.has(id) || !snapshot.nodes.has(id)) return;
        seen.add(id);
        order.push(id);
        for (const child of snapshot.nodes.get(id)!.children ?? []) visit(child, seen);
    };
    visit(snapshot.rootId, new Set());
    return order;
}

/** The serialized node of a snapshot node — the form `Serializer.deserializeObject` reads. */
export function serializedNode(id: string, node: NodeSnapshot, parentId?: string): Serialized {
    return {
        ...(node.props as Record<string, unknown>),
        id,
        ...(parentId === undefined ? {} : { parentId }),
        [InternalClassName]: node.cls,
    } as Serialized;
}

/**
 * The document's serialized form (what `Document.serialize` writes) for a snapshot — loadable
 * with `Document.load`.
 */
export function snapshotToSerialized(
    snapshot: DocumentSnapshot,
    documentId: string,
    version: string,
): Serialized {
    const nodes: Serialized[] = [];
    const parents = new Map<string, string>();
    for (const [id, node] of snapshot.nodes) for (const child of node.children ?? []) parents.set(child, id);
    for (const id of preorder(snapshot))
        nodes.push(serializedNode(id, snapshot.nodes.get(id)!, parents.get(id)));
    return {
        [InternalClassName]: "Document",
        version,
        id: documentId,
        name: snapshot.meta.name,
        models: {
            components: snapshot.components.map((x) => x.value),
            nodes,
            materials: snapshot.materials.map((x) => x.value),
        },
        variables: snapshot.variables.map((x) => x.value),
        acts: [...snapshot.meta.acts],
        userData: snapshot.meta.userData,
    };
}
