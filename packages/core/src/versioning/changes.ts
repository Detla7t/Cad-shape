// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation/result";
import { summarizeValue } from "./diff";
import { isJsonObject, type JsonValue, jsonEquals } from "./hash";
import type { IObjectStore } from "./objectStore";
import type { ObjectHash } from "./objects";
import { joinProperty, type Part, type SeqItem, splitProperty, VersioningRoles } from "./parts";
import { type DocumentSnapshot, type NodeSnapshot, preorder, readTree, writeSnapshot } from "./snapshot";

export interface CommitChange {
    /** Stable address within this commit, independent of labels and row order. */
    readonly id: string;
    readonly label: string;
    readonly before: string;
    readonly after: string;
}

interface Slot<T> {
    get(): T | undefined;
    set(value: T | undefined): void;
}

interface FieldContext {
    role: string | undefined;
    item: JsonValue;
    label: string;
    path: string;
}

/** Enumerates and selects the same semantic units used by merge: fields, entities, constraints and text. */
export function treeChanges(store: IObjectStore, from: ObjectHash, to: ObjectHash) {
    const before = readTree(store, from),
        after = readTree(store, to);
    let next = { ...before, nodes: new Map(before.nodes) };
    const changes: CommitChange[] = [];
    const actions = new Map<string, () => void>();
    const emit = (path: string[], label: string, a: unknown, b: unknown, apply: () => void) => {
        const id = JSON.stringify(path);
        changes.push({ id, label, before: summarizeValue(a), after: summarizeValue(b) });
        actions.set(id, apply);
    };
    const json = (
        a: JsonValue | undefined,
        b: JsonValue | undefined,
        slot: Slot<JsonValue>,
        path: string[],
        label: string,
        field?: FieldContext,
    ) => {
        if (jsonEquals(a, b)) return;
        if (isJsonObject(a) && isJsonObject(b)) {
            for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
                json(
                    a[key],
                    b[key],
                    {
                        get: () => (slot.get() as Record<string, JsonValue> | undefined)?.[key],
                        set: (value) => {
                            const object = { ...(slot.get() as Record<string, JsonValue>) };
                            if (value === undefined) delete object[key];
                            else object[key] = value;
                            slot.set(object);
                        },
                    },
                    [...path, key],
                    `${label} › ${key}`,
                    field ? { ...field, path: field.path ? `${field.path}.${key}` : key } : undefined,
                );
            }
        } else {
            const hooks = VersioningRoles.get(field?.role);
            const title = field?.path
                ? `${field.label} › ${hooks?.fieldLabel?.(field.item, field.path) ?? field.path}`
                : label;
            emit(path, title, a, b, () => slot.set(b));
            if (hooks?.formatValue && field) {
                changes[changes.length - 1] = {
                    ...changes[changes.length - 1],
                    before: hooks.formatValue(field.item, field.path, a),
                    after: hooks.formatValue(field.item, field.path, b),
                };
            }
        }
    };
    const seq = (
        a: readonly SeqItem[],
        b: readonly SeqItem[],
        slot: Slot<readonly SeqItem[]>,
        path: string[],
        label: string,
        role?: string,
    ) => {
        const old = new Map(a.map((x) => [x.id, x]));
        const fresh = new Map(b.map((x) => [x.id, x]));
        for (const id of new Set([...old.keys(), ...fresh.keys()])) {
            const av = old.get(id)?.value,
                bv = fresh.get(id)?.value;
            const list = fresh.has(id) ? b : a;
            const value = bv ?? av!;
            const name =
                VersioningRoles.get(role)?.itemLabel?.(
                    value,
                    list,
                    list.findIndex((x) => x.id === id),
                ) ?? id;
            json(
                av,
                bv,
                {
                    get: () => slot.get()?.find((x) => x.id === id)?.value,
                    set: (v) => {
                        const items = [...(slot.get() ?? [])];
                        const index = items.findIndex((x) => x.id === id);
                        if (v === undefined) {
                            if (index >= 0) items.splice(index, 1);
                        } else if (index >= 0) items[index] = { id, value: v };
                        else {
                            const afterId = b
                                .slice(
                                    0,
                                    b.findIndex((x) => x.id === id),
                                )
                                .map((x) => x.id)
                                .reverse()
                                .find((key) => items.some((x) => x.id === key));
                            items.splice(
                                afterId === undefined ? 0 : items.findIndex((x) => x.id === afterId) + 1,
                                0,
                                { id, value: v },
                            );
                        }
                        slot.set(items);
                    },
                },
                [...path, id],
                `${label} › ${name}`,
                { role, item: value, label: `${label} › ${name}`, path: "" },
            );
        }
        const common = (items: readonly SeqItem[]) =>
            items.filter((x) => old.has(x.id) && fresh.has(x.id)).map((x) => x.id);
        if (!jsonEquals(common(a), common(b)))
            emit([...path, "$order"], `${label} › Order`, common(a), common(b), () => {
                const items = slot.get() ?? [];
                const ordered = b.flatMap((x) => items.filter((v) => v.id === x.id));
                slot.set([...ordered, ...items.filter((x) => !fresh.has(x.id))]);
            });
    };
    const part = (a: Part, b: Part, slot: Slot<Part>, path: string[], label: string): void => {
        if (jsonEquals(a, b)) return;
        if (a.kind === "json" && b.kind === "json") {
            json(
                a.value,
                b.value,
                {
                    get: () => (slot.get() as typeof a).value,
                    set: (value) => slot.set({ ...b, value: value ?? null }),
                },
                path,
                label,
            );
        } else if (a.kind === "seq" && b.kind === "seq") {
            seq(
                a.items,
                b.items,
                {
                    get: () => (slot.get() as typeof a).items,
                    set: (items) => slot.set({ ...b, items: items ?? [] }),
                },
                path,
                label,
                b.role,
            );
        } else if (a.kind === "rec" && b.kind === "rec") {
            for (const key of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])) {
                const field: Slot<Part> = {
                    get: () => (slot.get() as typeof a).fields[key],
                    set: (value) => {
                        const fields = { ...(slot.get() as typeof a).fields };
                        if (value === undefined) delete fields[key];
                        else fields[key] = value;
                        slot.set({ ...b, fields });
                    },
                };
                if (a.fields[key] && b.fields[key])
                    part(a.fields[key], b.fields[key], field, [...path, key], `${label} › ${key}`);
                else
                    emit([...path, key], `${label} › ${key}`, a.fields[key], b.fields[key], () =>
                        field.set(b.fields[key]),
                    );
            }
        } else
            emit(path, label, a.kind === "text" ? a.text : a, b.kind === "text" ? b.text : b, () =>
                slot.set(b),
            );
    };
    const updateNode = (id: string, update: (node: NodeSnapshot) => NodeSnapshot) => {
        const node = next.nodes.get(id);
        if (!node) throw new Error(`Select the addition of node ${id} before its changes`);
        next.nodes.set(id, update(node));
    };
    const parentOf = (snapshot: DocumentSnapshot, id: string) =>
        [...snapshot.nodes].find(([, n]) => n.children?.includes(id))?.[0];
    const place = (id: string) => {
        for (const [key, node] of next.nodes)
            if (node.children?.includes(id))
                next.nodes.set(key, { ...node, children: node.children.filter((x) => x !== id) });
        const parent = parentOf(after, id);
        if (!parent) return;
        updateNode(parent, (node) => {
            const children = [...(node.children ?? [])];
            const order = after.nodes.get(parent)?.children ?? [];
            const previous = order
                .slice(0, order.indexOf(id))
                .reverse()
                .find((x) => children.includes(x));
            children.splice(previous === undefined ? 0 : children.indexOf(previous) + 1, 0, id);
            return { ...node, children };
        });
    };
    for (const id of new Set([...preorder(after), ...preorder(before)])) {
        const a = before.nodes.get(id),
            b = after.nodes.get(id);
        const label = String(b?.props["name"] ?? a?.props["name"] ?? id);
        if (!a || !b || a.cls !== b.cls) {
            emit(["nodes", id], label, a ? a.cls : undefined, b ? b.cls : undefined, () => {
                if (b) next.nodes.set(id, { ...b, children: b.children?.filter((x) => next.nodes.has(x)) });
                else next.nodes.delete(id);
                place(id);
            });
            continue;
        }
        for (const key of new Set([...Object.keys(a.props), ...Object.keys(b.props)])) {
            const av = a.props[key],
                bv = b.props[key];
            const property: Slot<unknown> = {
                get: () => next.nodes.get(id)?.props[key],
                set: (value) =>
                    updateNode(id, (node) => {
                        const props = { ...node.props };
                        if (value === undefined) delete props[key];
                        else props[key] = value;
                        return { ...node, props };
                    }),
            };
            const ap = splitProperty(a.cls, key, av),
                bp = splitProperty(b.cls, key, bv);
            if (ap && bp && ap.raw === bp.raw) {
                part(
                    ap.part,
                    bp.part,
                    {
                        get: () => splitProperty(b.cls, key, property.get())?.part,
                        set: (value) => {
                            const normalized =
                                value && "role" in value
                                    ? (VersioningRoles.get(value.role)?.afterMerge?.(value) ?? value)
                                    : value;
                            property.set(
                                normalized ? joinProperty(b.cls, key, normalized, bp.raw) : undefined,
                            );
                        },
                    },
                    ["nodes", id, key],
                    ["dataJson", "featuresJson"].includes(key) ? label : `${label} › ${key}`,
                );
            } else
                json(
                    av as JsonValue,
                    bv as JsonValue,
                    property as Slot<JsonValue>,
                    ["nodes", id, key],
                    `${label} › ${key}`,
                );
        }
        const ap = parentOf(before, id),
            bp = parentOf(after, id);
        if (ap !== bp) emit(["nodes", id, "$parent"], `${label} › Parent`, ap, bp, () => place(id));
        const old = a.children?.filter((x) => b.children?.includes(x)) ?? [];
        const fresh = b.children?.filter((x) => a.children?.includes(x)) ?? [];
        if (!jsonEquals(old, fresh))
            emit(["nodes", id, "$order"], `${label} › Order`, old, fresh, () =>
                updateNode(id, (node) => ({
                    ...node,
                    children: [
                        ...(b.children ?? []).filter((x) => node.children?.includes(x)),
                        ...(node.children ?? []).filter((x) => !b.children?.includes(x)),
                    ],
                })),
            );
    }
    for (const key of ["variables", "materials", "components", "configuration"] as const)
        seq(
            before[key] ?? [],
            after[key] ?? [],
            {
                get: () => next[key],
                set: (items) => {
                    next[key] = items ?? [];
                },
            },
            [key],
            key,
            key === "configuration" ? "configurationInput" : key.slice(0, -1),
        );
    json(
        before.meta as unknown as JsonValue,
        after.meta as unknown as JsonValue,
        {
            get: () => next.meta as unknown as JsonValue,
            set: (meta) => {
                next.meta = meta as unknown as DocumentSnapshot["meta"];
            },
        },
        ["meta"],
        "Document",
    );
    return {
        changes,
        select(ids: readonly string[]): Result<ObjectHash> {
            try {
                next = { ...before, nodes: new Map(before.nodes) };
                for (const id of ids) {
                    if (!actions.has(id)) return Result.err("A selected change is not in this commit");
                }
                // Document order ensures a selected new parent exists before its children.
                for (const [id, apply] of actions) if (ids.includes(id)) apply();
                const seen = new Set<string>();
                const visit = (id: string) => {
                    if (seen.has(id))
                        throw new Error("The selected changes create a cycle or duplicate parent");
                    const node = next.nodes.get(id);
                    if (!node)
                        throw new Error(
                            "The selected changes leave a missing child; include its structural changes",
                        );
                    seen.add(id);
                    node.children?.forEach(visit);
                };
                visit(next.rootId);
                if (seen.size !== next.nodes.size)
                    return Result.err(
                        "The selected changes leave an orphan node; include its parent changes",
                    );
                return Result.ok(writeSnapshot(store, next));
            } catch (error) {
                return Result.err(error instanceof Error ? error.message : String(error));
            }
        },
    };
}
