// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { InternalClassName } from "../serialize";
import { canonicalJson, isJsonObject, type JsonValue, jsonEquals } from "./hash";
import type { IObjectStore } from "./objectStore";
import type { NodeObj, ObjectHash, TreeObj } from "./objects";
import { joinProperty, loadPart, type Part, type SeqItem, VersioningRoles } from "./parts";
import { CONFIGURATION_ROLE, getNode, getTree, readMeta, treeNodes } from "./snapshot";
import { diffLines, lineStats } from "./textDiff";

/**
 * Semantic diff between two document snapshots: what changed in terms the user works in —
 * nodes added, removed, renamed and moved; features, sketch entities and variables added,
 * removed, reordered and edited (with old → new values); Feature Studio sources line by line.
 * Unchanged objects are skipped by hash, so diffing two adjacent microversions only reads what
 * the edit touched.
 */

/** One changed field: `label from → to`. */
export interface FieldChange {
    readonly path: string;
    readonly label: string;
    readonly from?: string;
    readonly to?: string;
}

/** A change inside a node (or a document-level collection). */
export type DetailChange =
    | { readonly kind: "field"; readonly field: FieldChange }
    | { readonly kind: "added"; readonly collection: string; readonly id: string; readonly label: string }
    | { readonly kind: "removed"; readonly collection: string; readonly id: string; readonly label: string }
    | {
          readonly kind: "changed";
          readonly collection: string;
          readonly id: string;
          readonly label: string;
          readonly fields: readonly FieldChange[];
      }
    | { readonly kind: "reordered"; readonly collection: string; readonly labels: readonly string[] }
    | {
          readonly kind: "text";
          readonly property: string;
          readonly added: number;
          readonly removed: number;
          readonly before: string;
          readonly after: string;
      };

export interface NodeDiff {
    readonly id: string;
    /** The node's name on the newer side (the older one for a removed node). */
    readonly name: string;
    readonly cls: string;
    readonly status: "added" | "removed" | "changed";
    readonly renamedFrom?: string;
    /** Set when the node changed parent (`to` is the new parent's name) or position among its siblings. */
    readonly moved?: { readonly from?: string; readonly to?: string; readonly reordered?: boolean };
    readonly changes: readonly DetailChange[];
}

export interface DocumentDiff {
    readonly nodes: readonly NodeDiff[];
    readonly variables: readonly DetailChange[];
    readonly materials: readonly DetailChange[];
    readonly components: readonly DetailChange[];
    readonly meta: readonly DetailChange[];
    /** Configuration inputs added, removed, reordered and edited. */
    readonly configuration: readonly DetailChange[];
}

export function isEmptyDiff(diff: DocumentDiff): boolean {
    return (
        diff.nodes.length === 0 &&
        diff.variables.length === 0 &&
        diff.materials.length === 0 &&
        diff.components.length === 0 &&
        diff.meta.length === 0 &&
        diff.configuration.length === 0
    );
}

interface TreeIndex {
    readonly tree: TreeObj;
    readonly hashes: Map<string, ObjectHash>;
    readonly nodes: Map<string, NodeObj>;
    readonly parents: Map<string, string>;
}

function indexTree(store: IObjectStore, treeHash: ObjectHash | undefined): TreeIndex | undefined {
    if (treeHash === undefined) return undefined;
    const tree = getTree(store, treeHash);
    const hashes = treeNodes(store, tree);
    const nodes = new Map<string, NodeObj>();
    const parents = new Map<string, string>();
    for (const [id, hash] of hashes) {
        const node = getNode(store, hash);
        nodes.set(id, node);
        for (const child of node.children ?? []) parents.set(child, id);
    }
    return { tree, hashes, nodes, parents };
}

const nameOf = (node: NodeObj | undefined, id: string) =>
    typeof node?.props["name"] === "string" ? (node.props["name"] as string) : id;

/** Diff of two trees; `from` undefined diffs against an empty document. */
export function diffTrees(store: IObjectStore, from: ObjectHash | undefined, to: ObjectHash): DocumentDiff {
    const a = indexTree(store, from);
    const b = indexTree(store, to)!;
    if (a !== undefined && from === to)
        return { nodes: [], variables: [], materials: [], components: [], meta: [], configuration: [] };

    const nodes: NodeDiff[] = [];
    const reordered = reorderedChildren(a, b);
    // Tree order: the newer side's nodes as the model tree lists them, then the removed ones.
    const order = [...treeOrder(b), ...(a ? treeOrder(a).filter((id) => !b.hashes.has(id)) : [])];
    for (const id of order) {
        const before = a?.nodes.get(id);
        const after = b.nodes.get(id);
        if (after === undefined) {
            nodes.push({ id, name: nameOf(before, id), cls: before!.cls, status: "removed", changes: [] });
            continue;
        }
        // The root is the document itself — it is never "added".
        if (before === undefined && id === b.tree.root) continue;
        if (before === undefined) {
            nodes.push({ id, name: nameOf(after, id), cls: after.cls, status: "added", changes: [] });
            continue;
        }
        const parentFrom = a!.parents.get(id);
        const parentTo = b.parents.get(id);
        const moved =
            parentFrom !== parentTo
                ? { from: parentName(a!, parentFrom), to: parentName(b, parentTo) }
                : reordered.has(id)
                  ? { reordered: true }
                  : undefined;
        const sameHash = a!.hashes.get(id) === b.hashes.get(id);
        const changes = sameHash ? [] : diffNodeContent(store, before, after);
        const renamedFrom = nameOf(before, id) !== nameOf(after, id) ? nameOf(before, id) : undefined;
        if (changes.length === 0 && moved === undefined && renamedFrom === undefined) continue;
        nodes.push({
            id,
            name: nameOf(after, id),
            cls: after.cls,
            status: "changed",
            ...(renamedFrom === undefined ? {} : { renamedFrom }),
            ...(moved === undefined ? {} : { moved }),
            changes,
        });
    }

    return {
        nodes,
        variables: diffCollection(store, a?.tree.variables, b.tree.variables, "variables"),
        materials: diffCollection(store, a?.tree.materials, b.tree.materials, "materials"),
        components: diffCollection(store, a?.tree.components, b.tree.components, "components"),
        meta: diffMeta(store, a?.tree.meta, b.tree.meta),
        configuration: diffOptionalCollection(store, a?.tree.configuration, b.tree.configuration),
    };
}

/** The configuration inputs' changes — a side without a part has none (see `TreeObj.configuration`). */
function diffOptionalCollection(
    store: IObjectStore,
    before: ObjectHash | undefined,
    after: ObjectHash | undefined,
): DetailChange[] {
    if (before === after) return [];
    const items = (hash: ObjectHash | undefined): readonly SeqItem[] => {
        if (hash === undefined) return [];
        const part = loadPart(store, hash);
        return part.kind === "seq" ? part.items : [];
    };
    return diffSeq(items(before), items(after), CONFIGURATION_ROLE, "configuration");
}

/** Node ids depth-first from the root; nodes the walk does not reach follow in id order. */
function treeOrder(index: TreeIndex): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
        if (seen.has(id) || !index.nodes.has(id)) return;
        seen.add(id);
        order.push(id);
        for (const child of index.nodes.get(id)!.children ?? []) visit(child);
    };
    visit(index.tree.root);
    for (const id of [...index.nodes.keys()].sort()) if (!seen.has(id)) order.push(id);
    return order;
}

function parentName(index: TreeIndex, parent: string | undefined): string | undefined {
    if (parent === undefined) return undefined;
    return nameOf(index.nodes.get(parent), parent);
}

/** Ids whose position among unchanged siblings changed (LCS-moved), per container present in both. */
function reorderedChildren(a: TreeIndex | undefined, b: TreeIndex): Set<string> {
    const moved = new Set<string>();
    if (a === undefined) return moved;
    for (const [id, after] of b.nodes) {
        const before = a.nodes.get(id);
        if (before?.children === undefined || after.children === undefined) continue;
        if (a.hashes.get(id) === b.hashes.get(id)) continue;
        for (const child of movedIds(before.children, after.children)) moved.add(child);
    }
    return moved;
}

/** Ids present in both lists that are not on their longest common subsequence — the ones that moved. */
export function movedIds(before: readonly string[], after: readonly string[]): string[] {
    const inAfter = new Set(after);
    const inBefore = new Set(before);
    const x = before.filter((id) => inAfter.has(id));
    const y = after.filter((id) => inBefore.has(id));
    const deleted = new Set<string>();
    const inserted = new Set<string>();
    for (const run of diffLines(x, y)) {
        if (run.op === "del") for (let i = 0; i < run.n; i++) deleted.add(x[run.a + i]);
        if (run.op === "ins") for (let i = 0; i < run.n; i++) inserted.add(y[run.b + i]);
    }
    return [...deleted].filter((id) => inserted.has(id));
}

/** Changes between two versions of one node's properties and parts (name and children excluded). */
function diffNodeContent(store: IObjectStore, before: NodeObj, after: NodeObj): DetailChange[] {
    const changes: DetailChange[] = [];
    const keys = new Set([
        ...Object.keys(before.props),
        ...Object.keys(before.parts),
        ...Object.keys(after.props),
        ...Object.keys(after.parts),
    ]);
    keys.delete("name");
    for (const key of [...keys].sort()) {
        const partBefore = before.parts[key];
        const partAfter = after.parts[key];
        if (partBefore !== undefined && partAfter !== undefined) {
            if (partBefore === partAfter) continue;
            const x = loadPart(store, partBefore);
            const y = loadPart(store, partAfter);
            if (x.kind === y.kind) {
                changes.push(...diffParts(x, y, key));
                continue;
            }
        }
        const x = fieldValue(store, before, key);
        const y = fieldValue(store, after, key);
        if (jsonEquals(x, y)) continue;
        changes.push(...diffValues(undefined, key, x, y).map((field) => ({ kind: "field" as const, field })));
    }
    return changes;
}

/** A node field as plain JSON, whether it is inline or a part. */
function fieldValue(store: IObjectStore, node: NodeObj, key: string): unknown {
    const part = node.parts[key];
    if (part === undefined) return node.props[key];
    return joinProperty(node.cls, key, loadPart(store, part), (node.raw ?? []).includes(key));
}

/** Changes between two parts of the same kind; `path` names the property (or rec field). */
export function diffParts(before: Part, after: Part, path: string): DetailChange[] {
    if (before.kind === "text" && after.kind === "text") {
        if (before.text === after.text) return [];
        const stats = lineStats(before.text, after.text);
        return [{ kind: "text", property: path, ...stats, before: before.text, after: after.text }];
    }
    if (before.kind === "seq" && after.kind === "seq")
        return diffSeq(before.items, after.items, after.role, path);
    if (before.kind === "rec" && after.kind === "rec") {
        const keys = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
        const changes: DetailChange[] = [];
        for (const key of [...keys].sort()) {
            const x = before.fields[key];
            const y = after.fields[key];
            if (x !== undefined && y !== undefined && x.kind === y.kind) {
                changes.push(...diffParts(x, y, key));
            } else if (!jsonEquals(x, y)) {
                changes.push({
                    kind: "field",
                    field: { path: key, label: key, from: summarizeValue(x), to: summarizeValue(y) },
                });
            }
        }
        return changes;
    }
    if (before.kind === "json" && after.kind === "json") {
        // Paths below a part start at its root (role hooks address their own fields); the
        // property name labels a change of the whole value.
        return diffValues(after.role, "", before.value, after.value, undefined, path).map((field) => ({
            kind: "field",
            field,
        }));
    }
    return [];
}

function diffCollection(
    store: IObjectStore,
    before: ObjectHash | undefined,
    after: ObjectHash,
    collection: string,
): DetailChange[] {
    if (before === after) return [];
    const x = before === undefined ? { kind: "seq" as const, items: [] } : loadPart(store, before);
    const y = loadPart(store, after);
    if (x.kind !== "seq" || y.kind !== "seq") return [];
    return diffSeq(x.items, y.items, y.role, collection);
}

function diffMeta(store: IObjectStore, before: ObjectHash | undefined, after: ObjectHash): DetailChange[] {
    if (before === undefined || before === after) return [];
    const x = readMeta(store, before);
    const y = readMeta(store, after);
    // The name is not listed: it mirrors the root node's name, whose rename is reported already.
    const changes: DetailChange[] = [];
    if (!jsonEquals(x.userData, y.userData)) {
        changes.push({ kind: "field", field: { path: "userData", label: "userData" } });
    }
    if (!jsonEquals(x.acts, y.acts)) changes.push({ kind: "field", field: { path: "acts", label: "acts" } });
    return changes;
}

/** Item-level changes of an ordered collection. */
export function diffSeq(
    before: readonly SeqItem[],
    after: readonly SeqItem[],
    role: string | undefined,
    collection: string,
): DetailChange[] {
    const hooks = VersioningRoles.get(role);
    const label = (items: readonly SeqItem[], index: number) =>
        hooks?.itemLabel?.(items[index].value, items, index) ?? defaultItemLabel(items[index]);
    const beforeIndex = new Map(before.map((item, index) => [item.id, index]));
    const afterIndex = new Map(after.map((item, index) => [item.id, index]));
    const changes: DetailChange[] = [];
    before.forEach((item, index) => {
        if (!afterIndex.has(item.id))
            changes.push({ kind: "removed", collection, id: item.id, label: label(before, index) });
    });
    after.forEach((item, index) => {
        const old = beforeIndex.get(item.id);
        if (old === undefined) {
            changes.push({ kind: "added", collection, id: item.id, label: label(after, index) });
            return;
        }
        if (jsonEquals(before[old].value, item.value)) return;
        const fields = diffValues(role, "", before[old].value, item.value, item.value);
        // Only hidden (derived) fields changed — e.g. a reference's cached geometry.
        if (fields.length === 0) return;
        changes.push({ kind: "changed", collection, id: item.id, label: label(after, index), fields });
    });
    const moved = movedIds(
        before.map((x) => x.id),
        after.map((x) => x.id),
    );
    if (moved.length > 0) {
        const labels = moved.map((id) => label(after, afterIndex.get(id)!));
        changes.push({ kind: "reordered", collection, labels });
    }
    return changes;
}

function defaultItemLabel(item: SeqItem): string {
    const value = item.value;
    if (isJsonObject(value)) {
        for (const key of ["name", "label", "title"]) {
            if (typeof value[key] === "string" && value[key] !== "") return value[key] as string;
        }
    }
    return item.id;
}

/**
 * Leaf-level differences between two JSON values. Plain objects are walked key by key; arrays
 * and class-tagged objects (`Plane`, `Matrix4`, …) count as one value.
 */
export function diffValues(
    role: string | undefined,
    path: string,
    before: unknown,
    after: unknown,
    item: JsonValue = (after ?? before ?? null) as JsonValue,
    rootLabel = "value",
): FieldChange[] {
    if (jsonEquals(before, after)) return [];
    const hooks = VersioningRoles.get(role);
    const walkable = (v: unknown) => isJsonObject(v) && !(InternalClassName in v);
    if (walkable(before) && walkable(after)) {
        const x = before as Record<string, unknown>;
        const y = after as Record<string, unknown>;
        const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
        const out: FieldChange[] = [];
        for (const key of [...keys].sort()) {
            out.push(
                ...diffValues(role, path === "" ? key : `${path}.${key}`, x[key], y[key], item, rootLabel),
            );
        }
        return out;
    }
    if (hooks?.hiddenField?.(path)) return [];
    const format = (value: unknown) =>
        hooks?.formatValue?.(item, path, value as JsonValue | undefined) ?? summarizeValue(value);
    const from = before === undefined ? undefined : format(before);
    const to = after === undefined ? undefined : format(after);
    const label = path === "" ? rootLabel : (hooks?.fieldLabel?.(item, path) ?? path);
    // Values that read the same ("1 edge" → "1 edge") are reported as a bare change.
    if (from !== undefined && from === to) return [{ path, label }];
    return [{ path, label, from, to }];
}

/** A short display of any JSON value. */
export function summarizeValue(value: unknown): string {
    if (value === undefined || value === null) return "—";
    if (typeof value === "number") return formatNumber(value);
    if (typeof value === "string") return truncate(value, 48);
    if (typeof value === "boolean") return value ? "on" : "off";
    if (Array.isArray(value)) {
        const json = canonicalJson(value);
        return json.length <= 48 ? json : `[${value.length} items]`;
    }
    if (isJsonObject(value) && typeof value[InternalClassName] === "string")
        return `(${value[InternalClassName]})`;
    return truncate(canonicalJson(value), 48);
}

export function formatNumber(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    return String(Number.parseFloat(value.toPrecision(6)));
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ------------------------------------------------------------------ Summaries

const ARROW = " → ";

function fieldText(field: FieldChange): string {
    if (field.from === undefined && field.to === undefined) return `${field.label} changed`;
    if (field.from === undefined) return `${field.label} set to ${field.to}`;
    if (field.to === undefined) return `${field.label} cleared (was ${field.from})`;
    return `${field.label} ${field.from}${ARROW}${field.to}`;
}

/** Human-readable lines for one change inside a node or collection. */
export function describeDetail(detail: DetailChange): string {
    switch (detail.kind) {
        case "field":
            return fieldText(detail.field);
        case "added":
            return `Added ${detail.label}`;
        case "removed":
            return `Removed ${detail.label}`;
        case "changed":
            return detail.fields.length === 0
                ? `${detail.label} changed`
                : `${detail.label}: ${detail.fields.map(fieldText).join(", ")}`;
        case "reordered":
            return `Reordered ${detail.labels.join(", ")}`;
        case "text":
            return `+${detail.added} −${detail.removed} lines`;
    }
}

/** One line per change, e.g. `Part 1 › Extrude 2: depth 10 mm → 20 mm`, `Added Fillet 1`. */
export function summarizeDiff(diff: DocumentDiff, limit = 40): string[] {
    const lines: string[] = [];
    for (const node of diff.nodes) {
        if (node.status === "added") {
            lines.push(`Added ${node.name}`);
            continue;
        }
        if (node.status === "removed") {
            lines.push(`Removed ${node.name}`);
            continue;
        }
        if (node.renamedFrom !== undefined) lines.push(`Renamed ${node.renamedFrom}${ARROW}${node.name}`);
        if (node.moved?.reordered) lines.push(`Reordered ${node.name}`);
        else if (node.moved !== undefined)
            lines.push(`Moved ${node.name} to ${node.moved.to ?? "top level"}`);
        for (const detail of node.changes) {
            lines.push(
                detail.kind === "text"
                    ? `${node.name}: ${describeDetail(detail)}`
                    : `${node.name} › ${describeDetail(detail)}`,
            );
        }
    }
    for (const detail of diff.variables) lines.push(`Variables › ${describeDetail(detail)}`);
    for (const detail of diff.materials) lines.push(`Materials › ${describeDetail(detail)}`);
    for (const detail of diff.components) lines.push(`Components › ${describeDetail(detail)}`);
    for (const detail of diff.configuration) lines.push(`Configuration › ${describeDetail(detail)}`);
    for (const detail of diff.meta) lines.push(`Document › ${describeDetail(detail)}`);
    if (lines.length > limit) {
        const rest = lines.length - limit;
        return [...lines.slice(0, limit), `… and ${rest} more`];
    }
    return lines;
}
