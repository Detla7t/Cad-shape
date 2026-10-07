// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { InternalClassName } from "../serialize";
import { summarizeValue } from "./diff";
import { isJsonObject, type JsonObject, type JsonValue, jsonEquals, toJsonValue } from "./hash";
import type { IObjectStore } from "./objectStore";
import { type NodeObj, type ObjectHash, SHARD_COUNT, shardOf, type TreeObj } from "./objects";
import { joinProperty, loadPart, type Part, type SeqItem, storePart, VersioningRoles } from "./parts";
import { CONFIGURATION_ROLE, getNode, getTree, treeNodes } from "./snapshot";
import { type MergeChunk, mergeText, resolveMergeChunks, type TextChoice } from "./textDiff";

/**
 * Three-way merge of document snapshots.
 *
 * Every level short-circuits on hashes — a subtree only one side touched is taken whole — and
 * merges what both sides changed at the finest unit the snapshot has:
 *
 * - nodes by id: added on one side, deleted on one side, or merged field by field; a node
 *   deleted on one side and modified on the other is a conflict;
 * - ordered collections (features, sketch entities, variables, a folder's children) by item id:
 *   insertions are anchored to the item before them, deletions apply, a reorder on one side
 *   applies, different reorders on both sides conflict; items merge field by field;
 * - text (Feature Studio sources) by diff3, one conflict per overlapping hunk;
 * - anything else as a scalar: identical changes apply once, different ones conflict.
 *
 * Conflicts are reported with stable ids derived from their position in the snapshot. The
 * merged tree takes "ours" for every conflict unless `resolutions` says otherwise — so the
 * caller previews with no resolutions, lets the user choose, and merges again with them.
 */

export type ConflictKind = "value" | "delete-modify" | "order" | "class" | "text" | "move";

export interface MergeConflict {
    /** Stable within a merge of the same three snapshots — the key for its resolution. */
    readonly id: string;
    readonly kind: ConflictKind;
    /** Where it is, e.g. "Part 1 › Extrude 2". */
    readonly location: string;
    /** What it is, e.g. "depth". */
    readonly field?: string;
    readonly base?: string;
    readonly ours?: string;
    readonly theirs?: string;
    /** For text conflicts: the id under which a whole-text `{ text }` resolution is accepted. */
    readonly textId?: string;
}

/**
 * How a conflict is settled: one side, both (text hunks: ours then theirs), a value typed by the
 * user (value conflicts), or the whole merged text (keyed by a text conflict's `textId`).
 */
export type ConflictResolution =
    | "ours"
    | "theirs"
    | "both"
    | { readonly value: JsonValue | undefined }
    | { readonly text: string };

export interface TreeMergeResult {
    readonly tree: ObjectHash;
    readonly conflicts: readonly MergeConflict[];
}

const DELETED = "Deleted";

/** Merges `ours` and `theirs` against their common ancestor `base` (undefined: no common history). */
export function mergeTrees(
    store: IObjectStore,
    base: ObjectHash | undefined,
    ours: ObjectHash,
    theirs: ObjectHash,
    resolutions: ReadonlyMap<string, ConflictResolution> = new Map(),
): TreeMergeResult {
    if (ours === theirs || base === theirs) return { tree: ours, conflicts: [] };
    if (base === ours) return { tree: theirs, conflicts: [] };
    const merger = new TreeMerger(store, resolutions);
    const tree = merger.merge(base, ours, theirs);
    return { tree, conflicts: merger.conflicts };
}

type FieldEntry = { readonly inline: JsonValue } | { readonly part: ObjectHash; readonly raw: boolean };

interface Side {
    readonly hashes: Map<string, ObjectHash>;
    readonly parents: Map<string, string>;
    readonly nodes: Map<string, NodeObj>;
}

class TreeMerger {
    readonly conflicts: MergeConflict[] = [];

    constructor(
        private readonly store: IObjectStore,
        private readonly resolutions: ReadonlyMap<string, ConflictResolution>,
    ) {}

    merge(base: ObjectHash | undefined, ours: ObjectHash, theirs: ObjectHash): ObjectHash {
        const o = getTree(this.store, ours);
        const t = getTree(this.store, theirs);
        const b = base === undefined ? undefined : getTree(this.store, base);
        const sides = {
            base: b === undefined ? emptySide() : this.side(treeNodes(this.store, b)),
            ours: this.side(treeNodes(this.store, o)),
            theirs: this.side(treeNodes(this.store, t)),
        };

        const meta = this.mergePart(b?.meta, o.meta, t.meta, "meta", "Document");
        const variables = this.mergePart(b?.variables, o.variables, t.variables, "variables", "Variables");
        const materials = this.mergePart(b?.materials, o.materials, t.materials, "materials", "Materials");
        const components = this.mergePart(
            b?.components,
            o.components,
            t.components,
            "components",
            "Components",
        );
        const configuration = this.mergeConfiguration(b, o, t);

        const merged = new Map<string, ObjectHash>();
        const ids = new Set([
            ...sides.base.hashes.keys(),
            ...sides.ours.hashes.keys(),
            ...sides.theirs.hashes.keys(),
        ]);
        for (const id of ids) {
            const hash = this.mergeNode(id, sides);
            if (hash !== undefined) merged.set(id, hash);
        }
        this.repairStructure(merged, o.root, sides);

        const buckets: Record<string, ObjectHash>[] = Array.from({ length: SHARD_COUNT }, () => ({}));
        for (const id of [...merged.keys()].sort()) buckets[shardOf(id)][id] = merged.get(id)!;
        return this.store.put({
            t: "tree",
            root: o.root,
            meta,
            shards: buckets.map((n) => this.store.put({ t: "shard", n })),
            variables,
            materials,
            components,
            ...(configuration === undefined ? {} : { configuration }),
        });
    }

    /**
     * The configuration inputs, merged like the variables. A side without the (optional) part
     * has no inputs — it merges as an empty collection, and an empty result drops the part.
     */
    private mergeConfiguration(b: TreeObj | undefined, o: TreeObj, t: TreeObj): ObjectHash | undefined {
        if (
            b?.configuration === undefined &&
            o.configuration === undefined &&
            t.configuration === undefined
        ) {
            return undefined;
        }
        const empty = storePart(this.store, { kind: "seq", role: CONFIGURATION_ROLE, items: [] });
        const merged = this.mergePart(
            b === undefined ? undefined : (b.configuration ?? empty),
            o.configuration ?? empty,
            t.configuration ?? empty,
            "configuration",
            "Configuration",
        );
        const part = loadPart(this.store, merged);
        return part.kind === "seq" && part.items.length === 0 ? undefined : merged;
    }

    private side(hashes: Map<string, ObjectHash>): Side {
        const nodes = new Map<string, NodeObj>();
        const parents = new Map<string, string>();
        for (const [id, hash] of hashes) {
            const node = getNode(this.store, hash);
            nodes.set(id, node);
            for (const child of node.children ?? []) parents.set(child, id);
        }
        return { hashes, parents, nodes };
    }

    // ------------------------------------------------------------------ Conflicts

    private choose<T>(
        conflict: MergeConflict,
        ours: T,
        theirs: T,
        manual?: (value: JsonValue | undefined) => T,
    ): T {
        this.conflicts.push(conflict);
        const resolution = this.resolutions.get(conflict.id);
        if (resolution === "theirs") return theirs;
        if (typeof resolution === "object" && "value" in resolution && manual !== undefined) {
            return manual(resolution.value);
        }
        return ours;
    }

    // ------------------------------------------------------------------ Nodes

    private mergeNode(id: string, sides: { base: Side; ours: Side; theirs: Side }): ObjectHash | undefined {
        const b = sides.base.hashes.get(id);
        const o = sides.ours.hashes.get(id);
        const t = sides.theirs.hashes.get(id);
        if (o === t) return o;
        if (b === o) return t;
        if (b === t) return o;
        const name = nodeName(
            sides.ours.nodes.get(id) ?? sides.theirs.nodes.get(id) ?? sides.base.nodes.get(id),
            id,
        );
        if (o === undefined || t === undefined) {
            // Deleted on one side, modified on the other: ours (or theirs) is the deletion itself.
            return this.choose(
                {
                    id: `node/${id}`,
                    kind: "delete-modify",
                    location: name,
                    ours: o === undefined ? DELETED : "Modified",
                    theirs: t === undefined ? DELETED : "Modified",
                },
                o,
                t,
            );
        }
        return this.mergeNodeObjects(
            id,
            name,
            b === undefined ? undefined : getNode(this.store, b),
            getNode(this.store, o),
            getNode(this.store, t),
            o,
            t,
        );
    }

    private mergeNodeObjects(
        id: string,
        name: string,
        b: NodeObj | undefined,
        o: NodeObj,
        t: NodeObj,
        oHash: ObjectHash,
        tHash: ObjectHash,
    ): ObjectHash {
        if (o.cls !== t.cls) {
            if (b?.cls === o.cls) return tHash;
            if (b?.cls === t.cls) return oHash;
            return this.choose(
                {
                    id: `node/${id}/class`,
                    kind: "class",
                    location: name,
                    field: "type",
                    ours: o.cls,
                    theirs: t.cls,
                },
                oHash,
                tHash,
            );
        }
        const props: JsonObject = {};
        const parts: Record<string, ObjectHash> = {};
        const raw: string[] = [];
        const keys = new Set([
            ...Object.keys(o.props),
            ...Object.keys(o.parts),
            ...Object.keys(t.props),
            ...Object.keys(t.parts),
            ...(b ? [...Object.keys(b.props), ...Object.keys(b.parts)] : []),
        ]);
        for (const key of [...keys].sort()) {
            const entry = this.mergeField(
                `node/${id}/${key}`,
                name,
                key,
                o.cls,
                b && fieldEntry(b, key),
                fieldEntry(o, key),
                fieldEntry(t, key),
            );
            if (entry === undefined) continue;
            if ("inline" in entry) props[key] = entry.inline;
            else {
                parts[key] = entry.part;
                if (entry.raw) raw.push(key);
            }
        }
        let children: string[] | undefined;
        if (o.children !== undefined || t.children !== undefined) {
            children = this.mergeOrderedIds(
                b?.children ?? [],
                o.children ?? [],
                t.children ?? [],
                `node/${id}/children`,
                name,
            );
        }
        const node: NodeObj = {
            t: "node",
            cls: o.cls,
            props,
            parts,
            ...(raw.length > 0 ? { raw } : {}),
            ...(children === undefined ? {} : { children }),
        };
        return this.store.put(node);
    }

    /** Three-way merge of one node field, inline or split. */
    private mergeField(
        id: string,
        location: string,
        key: string,
        cls: string,
        b: FieldEntry | undefined,
        o: FieldEntry | undefined,
        t: FieldEntry | undefined,
    ): FieldEntry | undefined {
        if (sameEntry(o, t)) return o;
        if (sameEntry(b, o)) return t;
        if (sameEntry(b, t)) return o;
        if (
            o !== undefined &&
            t !== undefined &&
            "part" in o &&
            "part" in t &&
            (b === undefined || "part" in b)
        ) {
            const kinds = [o.part, t.part, ...(b && "part" in b ? [b.part] : [])].map(
                (h) => this.store.get(h)?.t,
            );
            if (kinds.every((k) => k === kinds[0])) {
                const part = this.mergePart(
                    b && "part" in b ? b.part : undefined,
                    o.part,
                    t.part,
                    id,
                    location,
                    key,
                );
                return { part, raw: o.raw };
            }
        }
        const value = (entry: FieldEntry | undefined) => {
            if (entry === undefined) return undefined;
            if ("inline" in entry) return entry.inline;
            return toJsonValue(joinProperty(cls, key, loadPart(this.store, entry.part), entry.raw));
        };
        const merged = this.mergeJson(id, location, "", undefined, value(b), value(o), value(t), null, key);
        return merged === undefined ? undefined : { inline: merged };
    }

    /**
     * Every merged node must hang from exactly one parent: children lists merged independently
     * can claim a node twice (moved to different folders on each side) or not at all (its
     * parent was deleted, or it survived a delete-modify conflict). Double claims keep our
     * placement (a conflict); orphans go back under their nearest surviving ancestor.
     */
    private repairStructure(
        merged: Map<string, ObjectHash>,
        root: string,
        sides: { base: Side; ours: Side; theirs: Side },
    ) {
        const nodes = new Map<string, NodeObj>();
        for (const [id, hash] of merged) nodes.set(id, getNode(this.store, hash));
        const claims = new Map<string, string[]>();
        for (const [id, node] of nodes) {
            for (const child of node.children ?? []) {
                if (!merged.has(child) || child === root) continue;
                claims.set(child, [...(claims.get(child) ?? []), id]);
            }
        }
        const children = new Map<string, string[]>();
        const childrenOf = (id: string) => {
            let list = children.get(id);
            if (list === undefined) {
                list = (nodes.get(id)?.children ?? []).filter((c) => merged.has(c) && c !== root);
                children.set(id, list);
            }
            return list;
        };
        for (const [child, parents] of claims) {
            if (parents.length < 2) continue;
            const oursParent = sides.ours.parents.get(child);
            const theirsParent = sides.theirs.parents.get(child);
            const name = nodeName(nodes.get(child), child);
            const keep = this.choose(
                {
                    id: `move/${child}`,
                    kind: "move",
                    location: name,
                    field: "parent",
                    ours: nodeName(nodes.get(oursParent ?? ""), oursParent ?? ""),
                    theirs: nodeName(nodes.get(theirsParent ?? ""), theirsParent ?? ""),
                },
                parents.includes(oursParent ?? "") ? oursParent! : parents[0],
                parents.includes(theirsParent ?? "") ? theirsParent! : parents[0],
            );
            for (const parent of parents) {
                if (parent === keep) continue;
                children.set(
                    parent,
                    childrenOf(parent).filter((c) => c !== child),
                );
            }
        }
        for (const id of nodes.keys()) {
            if (id === root || claims.has(id)) continue;
            const { parent, after } = this.reattachPoint(id, merged, sides, root);
            const list = [...childrenOf(parent)];
            const index = after === undefined ? -1 : list.indexOf(after);
            list.splice(index + 1, 0, id);
            children.set(parent, list);
        }
        for (const [id, list] of children) {
            const node = nodes.get(id);
            if (node === undefined || node.children === undefined) continue;
            if (list.length === node.children.length && list.every((c, i) => c === node.children![i]))
                continue;
            merged.set(id, this.store.put({ ...node, children: list }));
        }
        // Drop dangling child ids of nodes the loop above did not rewrite.
        for (const [id, node] of nodes) {
            if (children.has(id) || node.children === undefined) continue;
            const list = node.children.filter((c) => merged.has(c) && c !== root);
            if (list.length !== node.children.length)
                merged.set(id, this.store.put({ ...node, children: list }));
        }
        this.attachUnreachable(merged, root);
    }

    /**
     * Crossed moves (A into B on one side, B into A on the other) can leave a claimed cycle no
     * path from the root reaches; such nodes are cut loose and appended to the root.
     */
    private attachUnreachable(merged: Map<string, ObjectHash>, root: string) {
        const reached = new Set<string>();
        const stack = [root];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (reached.has(id) || !merged.has(id)) continue;
            reached.add(id);
            stack.push(...(getNode(this.store, merged.get(id)!).children ?? []));
        }
        const lost = [...merged.keys()].filter((id) => !reached.has(id));
        if (lost.length === 0) return;
        const lostSet = new Set(lost);
        for (const id of lost) {
            const node = getNode(this.store, merged.get(id)!);
            if (node.children?.some((c) => lostSet.has(c))) {
                merged.set(
                    id,
                    this.store.put({ ...node, children: node.children.filter((c) => !lostSet.has(c)) }),
                );
            }
        }
        const rootNode = getNode(this.store, merged.get(root)!);
        merged.set(root, this.store.put({ ...rootNode, children: [...(rootNode.children ?? []), ...lost] }));
    }

    /** Where an orphaned node goes: under its nearest surviving ancestor (ours, theirs, then base). */
    private reattachPoint(
        id: string,
        merged: Map<string, ObjectHash>,
        sides: { base: Side; ours: Side; theirs: Side },
        root: string,
    ): { parent: string; after?: string } {
        for (const side of [sides.ours, sides.theirs, sides.base]) {
            let parent = side.parents.get(id);
            let child = id;
            while (parent !== undefined) {
                if (merged.has(parent)) {
                    const siblings = side.nodes.get(parent)?.children ?? [];
                    const index = siblings.indexOf(child);
                    const after = siblings
                        .slice(0, Math.max(0, index))
                        .reverse()
                        .find((s) => merged.has(s));
                    return { parent, after };
                }
                child = parent;
                parent = side.parents.get(parent);
            }
        }
        return { parent: root };
    }

    // ------------------------------------------------------------------ Parts

    private mergePart(
        b: ObjectHash | undefined,
        o: ObjectHash,
        t: ObjectHash,
        id: string,
        location: string,
        field?: string,
    ): ObjectHash {
        if (o === t || b === t) return o;
        if (b === o) return t;
        const oPart = loadPart(this.store, o);
        let tPart = loadPart(this.store, t);
        const bPart = b === undefined ? undefined : loadPart(this.store, b);
        if (oPart.kind !== tPart.kind || (bPart !== undefined && bPart.kind !== oPart.kind)) {
            return this.choose(
                {
                    id,
                    kind: "value",
                    location,
                    field,
                    ours: summarizeValue(partValue(oPart)),
                    theirs: summarizeValue(partValue(tPart)),
                },
                o,
                t,
            );
        }
        const role = "role" in oPart ? oPart.role : undefined;
        const hooks = VersioningRoles.get(role);
        if (hooks?.rebaseTheirs !== undefined && bPart !== undefined) {
            tPart = hooks.rebaseTheirs(bPart, oPart, tPart);
        }
        let merged = this.mergeLoadedParts(bPart, oPart, tPart, id, location, field, o);
        if (hooks?.afterMerge !== undefined) merged = hooks.afterMerge(merged);
        return storePart(this.store, merged, o);
    }

    private mergeLoadedParts(
        b: Part | undefined,
        o: Part,
        t: Part,
        id: string,
        location: string,
        field: string | undefined,
        oursHash: ObjectHash,
    ): Part {
        switch (o.kind) {
            case "json": {
                // Paths below a part start at its root: role hooks address their own fields.
                const value = this.mergeJson(
                    id,
                    location,
                    "",
                    o.role,
                    b?.kind === "json" ? b.value : undefined,
                    o.value,
                    (t as typeof o).value,
                    null,
                    field,
                );
                return {
                    kind: "json",
                    ...(o.role === undefined ? {} : { role: o.role }),
                    value: value ?? null,
                };
            }
            case "text":
                return { kind: "text", text: this.mergeTextPart(id, location, field, b, o, t as typeof o) };
            case "seq":
                return this.mergeSeq(id, location, b?.kind === "seq" ? b : undefined, o, t as typeof o);
            case "rec": {
                const tr = t as typeof o;
                const br = b?.kind === "rec" ? b : undefined;
                const keys = new Set([
                    ...Object.keys(o.fields),
                    ...Object.keys(tr.fields),
                    ...Object.keys(br?.fields ?? {}),
                ]);
                const fields: Record<string, Part> = {};
                for (const key of [...keys].sort()) {
                    const of = o.fields[key];
                    const tf = tr.fields[key];
                    const bf = br?.fields[key];
                    if (of === undefined && tf === undefined) continue;
                    if (of === undefined || tf === undefined) {
                        // A field present on one side only: take it unless the other side removed it.
                        const present = (of ?? tf)!;
                        if (bf !== undefined && jsonEquals(partValue(bf), partValue(present))) continue;
                        fields[key] = present;
                        continue;
                    }
                    const sub = this.mergeLoadedParts(bf, of, tf, `${id}/${key}`, location, key, oursHash);
                    fields[key] = sub;
                }
                return { kind: "rec", ...(o.role === undefined ? {} : { role: o.role }), fields };
            }
        }
    }

    private mergeTextPart(
        id: string,
        location: string,
        field: string | undefined,
        b: Part | undefined,
        o: Extract<Part, { kind: "text" }>,
        t: Extract<Part, { kind: "text" }>,
    ): string {
        const base = b?.kind === "text" ? b.text : "";
        const chunks: readonly MergeChunk[] = mergeText(base, o.text, t.text);
        const choices: TextChoice[] = [];
        let index = 0;
        for (const chunk of chunks) {
            if (chunk.kind !== "conflict") continue;
            const conflict: MergeConflict = {
                id: `${id}#${index}`,
                kind: "text",
                location,
                field,
                base: chunk.base.join(""),
                ours: chunk.ours.join(""),
                theirs: chunk.theirs.join(""),
                textId: id,
            };
            this.conflicts.push(conflict);
            const resolution = this.resolutions.get(conflict.id);
            choices.push(resolution === "theirs" || resolution === "both" ? resolution : "ours");
            index++;
        }
        const manual = this.resolutions.get(id);
        if (typeof manual === "object" && "text" in manual) return manual.text;
        return resolveMergeChunks(chunks, choices);
    }

    private mergeSeq(
        id: string,
        location: string,
        b: Extract<Part, { kind: "seq" }> | undefined,
        o: Extract<Part, { kind: "seq" }>,
        t: Extract<Part, { kind: "seq" }>,
    ): Part {
        const role = o.role;
        const hooks = VersioningRoles.get(role);
        const baseItems = new Map((b?.items ?? []).map((item) => [item.id, item.value]));
        const oursItems = new Map(o.items.map((item) => [item.id, item.value]));
        const theirsItems = new Map(t.items.map((item) => [item.id, item.value]));
        const labelOf = (itemId: string) => {
            for (const items of [o.items, t.items, b?.items ?? []]) {
                const index = items.findIndex((x) => x.id === itemId);
                if (index >= 0) return hooks?.itemLabel?.(items[index].value, items, index) ?? itemId;
            }
            return itemId;
        };

        const values = new Map<string, JsonValue>();
        const ids = new Set([...baseItems.keys(), ...oursItems.keys(), ...theirsItems.keys()]);
        for (const itemId of ids) {
            const bv = baseItems.get(itemId);
            const ov = oursItems.get(itemId);
            const tv = theirsItems.get(itemId);
            const itemLocation = `${location} › ${labelOf(itemId)}`;
            if (ov === undefined && tv === undefined) continue;
            if (ov === undefined || tv === undefined) {
                const present = (ov ?? tv)!;
                if (bv === undefined) {
                    values.set(itemId, present);
                    continue;
                }
                // Removed on one side: clean when the other side left it as it was.
                if (jsonEquals(bv, present)) continue;
                const kept = this.choose(
                    {
                        id: `${id}/${itemId}`,
                        kind: "delete-modify",
                        location: itemLocation,
                        ours: ov === undefined ? DELETED : "Modified",
                        theirs: tv === undefined ? DELETED : "Modified",
                    },
                    ov,
                    tv,
                );
                if (kept !== undefined) values.set(itemId, kept);
                continue;
            }
            const merged = this.mergeJson(`${id}/${itemId}`, itemLocation, "", role, bv, ov, tv, ov);
            if (merged !== undefined) values.set(itemId, merged);
        }
        const order = this.mergeOrderedIds(
            (b?.items ?? []).map((x) => x.id),
            o.items.map((x) => x.id),
            t.items.map((x) => x.id),
            `${id}/order`,
            location,
            new Set(values.keys()),
        );
        const items: SeqItem[] = order.map((itemId) => ({ id: itemId, value: values.get(itemId)! }));
        return { kind: "seq", ...(role === undefined ? {} : { role }), items };
    }

    // ------------------------------------------------------------------ JSON

    /**
     * Three-way merge of a JSON value at `path` (dot-separated below the merged unit). Plain
     * objects merge key by key; anything else is a scalar.
     */
    private mergeJson(
        id: string,
        location: string,
        path: string,
        role: string | undefined,
        b: JsonValue | undefined,
        o: JsonValue | undefined,
        t: JsonValue | undefined,
        item: JsonValue | undefined,
        rootField?: string,
    ): JsonValue | undefined {
        if (jsonEquals(o, t)) return o;
        if (jsonEquals(b, o)) return t;
        if (jsonEquals(b, t)) return o;
        const hooks = VersioningRoles.get(role);
        const custom = hooks?.mergeField?.(path, b, o, t);
        if (custom !== undefined) return custom.value;
        const walkable = (v: JsonValue | undefined) => isJsonObject(v) && !(InternalClassName in v);
        if (walkable(o) && walkable(t) && (b === undefined || walkable(b))) {
            const x = o as JsonObject;
            const y = t as JsonObject;
            const z = (b ?? {}) as JsonObject;
            const out: JsonObject = {};
            const keys = new Set([...Object.keys(x), ...Object.keys(y), ...Object.keys(z)]);
            for (const key of [...keys].sort()) {
                const sub = path === "" ? key : `${path}.${key}`;
                const value = this.mergeJson(
                    `${id}.${key}`,
                    location,
                    sub,
                    role,
                    z[key],
                    x[key],
                    y[key],
                    item ?? o,
                );
                if (value !== undefined) out[key] = value;
            }
            return out;
        }
        const itemValue = item ?? o ?? t ?? null;
        const format = (v: JsonValue | undefined) =>
            v === undefined ? DELETED : (hooks?.formatValue?.(itemValue, path, v) ?? summarizeValue(v));
        return this.choose(
            {
                id,
                kind: "value",
                location,
                field: path === "" ? rootField : (hooks?.fieldLabel?.(itemValue, path) ?? path),
                base: b === undefined ? undefined : format(b),
                ours: format(o),
                theirs: format(t),
            },
            o,
            t,
            (value) => value,
        );
    }

    // ------------------------------------------------------------------ Order

    /**
     * Three-way merge of an ordered id list. Items present in all three keep the order of the
     * side that reordered them (different reorders on both sides: a conflict); items present
     * on one side only are inserted after the nearest preceding item that is already placed,
     * ours before theirs at a shared spot. `keep` filters the result (items a merge deleted).
     */
    private mergeOrderedIds(
        base: readonly string[],
        ours: readonly string[],
        theirs: readonly string[],
        id: string,
        location: string,
        keep?: ReadonlySet<string>,
    ): string[] {
        const inBase = new Set(base);
        const inOurs = new Set(ours);
        const inTheirs = new Set(theirs);
        const common = (list: readonly string[]) =>
            list.filter((x) => inBase.has(x) && inOurs.has(x) && inTheirs.has(x));
        const b = common(base);
        const o = common(ours);
        const t = common(theirs);
        const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
        let result: string[];
        if (same(o, b)) result = t;
        else if (same(t, b) || same(o, t)) result = o;
        else result = this.choose({ id, kind: "order", location, field: "order" }, o, t);
        result = [...result];

        const placed = new Set(result);
        const insertFrom = (list: readonly string[], fromOtherSide: ReadonlySet<string>) => {
            let anchor: string | undefined;
            for (const item of list) {
                if (placed.has(item)) {
                    anchor = item;
                    continue;
                }
                let index = anchor === undefined ? 0 : result.indexOf(anchor) + 1;
                // Step over the other side's insertions at the same spot: ours come first.
                while (index < result.length && fromOtherSide.has(result[index])) index++;
                result.splice(index, 0, item);
                placed.add(item);
                anchor = item;
            }
        };
        const oursInserted = new Set(ours.filter((x) => !placed.has(x)));
        insertFrom(ours, new Set());
        insertFrom(theirs, oursInserted);

        // Items removed by one side and untouched by the other leave the list.
        const removed = (x: string) => inBase.has(x) && (!inOurs.has(x) || !inTheirs.has(x));
        return result.filter((x) => (keep === undefined ? !removed(x) : keep.has(x)));
    }
}

function emptySide(): Side {
    return { hashes: new Map(), parents: new Map(), nodes: new Map() };
}

function nodeName(node: NodeObj | undefined, fallback: string): string {
    return typeof node?.props["name"] === "string" ? (node.props["name"] as string) : fallback;
}

function fieldEntry(node: NodeObj, key: string): FieldEntry | undefined {
    const part = node.parts[key];
    if (part !== undefined) return { part, raw: (node.raw ?? []).includes(key) };
    return key in node.props ? { inline: node.props[key] } : undefined;
}

function sameEntry(x: FieldEntry | undefined, y: FieldEntry | undefined): boolean {
    if (x === undefined || y === undefined) return x === y;
    if ("part" in x && "part" in y) return x.part === y.part && x.raw === y.raw;
    if ("inline" in x && "inline" in y) return jsonEquals(x.inline, y.inline);
    return false;
}

function partValue(part: Part): unknown {
    switch (part.kind) {
        case "json":
            return part.value;
        case "text":
            return part.text;
        case "seq":
            return part.items.map((x) => x.value);
        case "rec":
            return Object.fromEntries(Object.entries(part.fields).map(([k, p]) => [k, partValue(p)]));
    }
}
