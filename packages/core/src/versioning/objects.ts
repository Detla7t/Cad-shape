// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { JsonObject, JsonValue } from "./hash";

/**
 * The objects of the version store. Every object is plain JSON and is addressed by the hash of
 * its canonical JSON (`contentHash`), so an object that did not change between two commits is
 * the same object — stored once, shared by both.
 *
 * A document snapshot is a tree of these:
 *
 * ```
 * commit ─▶ tree ─┬─ meta (json: name, userData, acts)
 *                 ├─ shards[16] ─▶ shard {nodeId → node}
 *                 │                 node {cls, props, parts{prop → part}, children[]}
 *                 │                   part = json | text | seq{[id, item]} | rec{field → part}
 *                 ├─ variables (seq of variables by id)
 *                 ├─ materials (seq by material id)
 *                 ├─ components (seq by component id)
 *                 └─ configuration? (seq of configuration inputs by id)
 * ```
 *
 * Big composite properties are split into finer objects by `PropertySplitter`s (see
 * `parts.ts`): a body's feature list is a `seq` of one object per feature, so editing one
 * feature writes that feature, the list, the node, its shard and the tree — never the others.
 */

export type ObjectHash = string;

/** An arbitrary JSON value. */
export interface JsonObj {
    readonly t: "json";
    readonly role?: string;
    readonly v: JsonValue;
}

/** A text blob — stored as a line delta against its previous version when that is smaller. */
export interface TextObj {
    readonly t: "text";
    readonly s: string;
}

/** An ordered collection of items with stable ids (features, sketch entities, variables). */
export interface SeqObj {
    readonly t: "seq";
    readonly role?: string;
    /** `[item id, item object hash]` in collection order. */
    readonly items: readonly (readonly [string, ObjectHash])[];
}

/** A record of named parts (e.g. a sketch: entities, constraints, the rest). */
export interface RecObj {
    readonly t: "rec";
    readonly role?: string;
    readonly f: Readonly<Record<string, ObjectHash>>;
}

/** One document node: its serialized class, inline properties, split properties and child order. */
export interface NodeObj {
    readonly t: "node";
    readonly cls: string;
    readonly props: JsonObject;
    readonly parts: Readonly<Record<string, ObjectHash>>;
    /** Parts that hold a raw large value rather than their splitter's output (see `splitProperty`). */
    readonly raw?: readonly string[];
    /** Child ids in order — present on container nodes only. */
    readonly children?: readonly string[];
}

/** A slice of the node index: node id → node object. */
export interface ShardObj {
    readonly t: "shard";
    readonly n: Readonly<Record<string, ObjectHash>>;
}

/** A whole-document snapshot. */
export interface TreeObj {
    readonly t: "tree";
    readonly root: string;
    readonly meta: ObjectHash;
    readonly shards: readonly ObjectHash[];
    readonly variables: ObjectHash;
    readonly materials: ObjectHash;
    readonly components: ObjectHash;
    /**
     * The configuration inputs (seq by input id). Absent when the document has none, so a
     * document without configurations hashes exactly as it did before they existed. The
     * active configuration is not versioned: switching it is a view, not an edit.
     */
    readonly configuration?: ObjectHash;
}

/**
 * `micro`: captured automatically after an undoable change (Onshape's microversion).
 * `version`: a named, immutable snapshot the user created. `merge`: joins two lines of work.
 */
export type CommitKind = "micro" | "version" | "merge";

export interface CommitObj {
    readonly t: "commit";
    readonly tree: ObjectHash;
    readonly parents: readonly ObjectHash[];
    readonly time: number;
    readonly kind: CommitKind;
    readonly message: string;
    /** Human-readable semantic change list against the first parent. */
    readonly summary: readonly string[];
    /** The branch the commit was made on — the graph keeps it in that branch's lane. */
    readonly branch: string;
    readonly author?: string;
}

export type VcsObject = JsonObj | TextObj | SeqObj | RecObj | NodeObj | ShardObj | TreeObj | CommitObj;

/** Fixed fan-out of the node index: a one-node edit rewrites one shard of ~n/16 entries. */
export const SHARD_COUNT = 16;

/** The shard a node id lives in — FNV-1a of the id, so it never depends on insertion order. */
export function shardOf(id: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) % SHARD_COUNT;
}
