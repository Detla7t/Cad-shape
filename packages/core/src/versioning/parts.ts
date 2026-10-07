// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { canonicalJson, type JsonValue } from "./hash";
import type { IObjectStore } from "./objectStore";
import type { ObjectHash, VcsObject } from "./objects";

/**
 * A property value broken into the units the version store tracks, diffs and merges.
 *
 * - `json` — an opaque value, merged field by field when it is a plain object;
 * - `text` — merged line by line (diff3), stored as line deltas;
 * - `seq` — an ordered collection of items with stable ids: merged by id (insertions anchored
 *   to their neighbours, concurrent reorders conflict), each item field by field;
 * - `rec` — a record of named parts.
 *
 * `role` names what a `json`/`seq`/`rec` part holds ("feature", "sketchEntity", "variable", …);
 * `VersioningRoles` hooks keyed by it supply labels for summaries and merge customizations.
 */
export type Part = JsonPart | TextPart | SeqPart | RecPart;

export interface JsonPart {
    readonly kind: "json";
    readonly role?: string;
    readonly value: JsonValue;
}
export interface TextPart {
    readonly kind: "text";
    readonly text: string;
}
export interface SeqItem {
    readonly id: string;
    readonly value: JsonValue;
}
export interface SeqPart {
    readonly kind: "seq";
    readonly role?: string;
    readonly items: readonly SeqItem[];
}
export interface RecPart {
    readonly kind: "rec";
    readonly role?: string;
    readonly fields: Readonly<Record<string, Part>>;
}

/**
 * Splits one serialized property of a node class into a `Part` and joins it back. Registered by
 * the module that owns the class (the parametric package registers the feature list, sketch and
 * studio splitters), so the version store stays independent of feature types.
 */
export interface PropertySplitter {
    /** The serialized class name (`__cla$$__`), or `"*"` for every class with this property. */
    readonly className: string;
    readonly property: string;
    /** The parts of `value`, or undefined to keep the value whole (e.g. it is not parseable). */
    split(value: unknown): Part | undefined;
    /** Inverse of `split`: `join(split(v))` must serialize equal to `v`. */
    join(part: Part): unknown;
}

const splitters = new Map<string, PropertySplitter>();

const splitterKey = (className: string, property: string) => `${className}\u0000${property}`;

export function registerPropertySplitter(splitter: PropertySplitter): void {
    splitters.set(splitterKey(splitter.className, splitter.property), splitter);
}

export function findPropertySplitter(className: string, property: string): PropertySplitter | undefined {
    return splitters.get(splitterKey(className, property)) ?? splitters.get(splitterKey("*", property));
}

/** Hooks for one part role: how its items read in summaries and how they merge. */
export interface RoleHooks {
    /** Label of a collection item, e.g. "Extrude 2". `items` is the collection it is in. */
    itemLabel?(value: JsonValue, items: readonly SeqItem[], index: number): string;
    /** Label of a field of an item (`path` is dot-separated below the item), e.g. "depth". */
    fieldLabel?(item: JsonValue, path: string): string;
    /** Display of a field value, e.g. "10 mm". */
    formatValue?(item: JsonValue, path: string, value: JsonValue | undefined): string;
    /** Fields left out of summaries (they still diff and merge). */
    hiddenField?(path: string): boolean;
    /**
     * Settles a field both sides changed differently, before it becomes a conflict — e.g. an id
     * counter takes the larger value. Undefined leaves it a conflict.
     */
    mergeField?(
        path: string,
        base: JsonValue | undefined,
        ours: JsonValue | undefined,
        theirs: JsonValue | undefined,
    ): { value: JsonValue | undefined } | undefined;
    /**
     * Rewrites the incoming side before a three-way merge of this part — e.g. renumbers sketch
     * entities both sides created with the same id, so both survive.
     */
    rebaseTheirs?(base: Part, ours: Part, theirs: Part): Part;
    /** Normalizes a merged part (e.g. bumps id counters past every merged id). */
    afterMerge?(merged: Part): Part;
}

const roles = new Map<string, RoleHooks>();

export const VersioningRoles = {
    register(role: string, hooks: RoleHooks): void {
        roles.set(role, hooks);
    },
    get(role: string | undefined): RoleHooks | undefined {
        return role === undefined ? undefined : roles.get(role);
    },
};

/**
 * Inline property values whose canonical JSON exceeds this are stored as their own object, so
 * a big imported mesh or B-rep string is not rewritten every time the node is renamed. Strings
 * become `text` (line deltas), everything else `json`.
 */
export const LARGE_VALUE_THRESHOLD = 2048;

/**
 * A property value as stored: the part, and whether it is a raw large value (`raw`) rather than
 * the output of the property's splitter — a splitter that refuses a value (say, unparseable
 * JSON) leaves it to the large-value fallback, and `join` must then not be asked to read it.
 */
export interface SplitProperty {
    readonly part: Part;
    readonly raw: boolean;
}

/** The part a property value is stored as, or undefined to keep it inline in the node object. */
export function splitProperty(
    className: string,
    property: string,
    value: unknown,
): SplitProperty | undefined {
    const splitter = findPropertySplitter(className, property);
    if (splitter !== undefined) {
        try {
            const part = splitter.split(value);
            if (part !== undefined) return { part, raw: false };
        } catch {
            // An unparseable value is kept whole — never lose data to a splitter.
        }
    }
    if (typeof value === "string") {
        return value.length > LARGE_VALUE_THRESHOLD
            ? { part: { kind: "text", text: value }, raw: true }
            : undefined;
    }
    if (value !== null && typeof value === "object") {
        const json = canonicalJson(value);
        if (json.length > LARGE_VALUE_THRESHOLD) {
            return { part: { kind: "json", value: JSON.parse(json) as JsonValue }, raw: true };
        }
    }
    return undefined;
}

/**
 * Whether two serialized values of a property are the same — compared through the property's
 * splitter when it has one, so a feature list re-serialized with its keys in another order (the
 * version store keeps canonical JSON) is not mistaken for an edit.
 */
export function propertyEquals(className: string, property: string, a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (canonicalJson(a) === canonicalJson(b)) return true;
    const splitter = findPropertySplitter(className, property);
    if (splitter === undefined) return false;
    try {
        const x = splitter.split(a);
        const y = splitter.split(b);
        return x !== undefined && y !== undefined && canonicalJson(x) === canonicalJson(y);
    } catch {
        return false;
    }
}

/** Inverse of `splitProperty`. */
export function joinProperty(className: string, property: string, part: Part, raw: boolean): unknown {
    const splitter = raw ? undefined : findPropertySplitter(className, property);
    return splitter === undefined ? rawValue(part) : splitter.join(part);
}

function rawValue(part: Part): unknown {
    switch (part.kind) {
        case "text":
            return part.text;
        case "json":
            return part.value;
        case "seq":
            return part.items.map((item) => item.value);
        case "rec":
            return Object.fromEntries(Object.entries(part.fields).map(([key, p]) => [key, rawValue(p)]));
    }
}

/**
 * Writes a part's objects and returns the root hash. `previous` is the hash this part had in
 * the previous snapshot: text objects are stored as a delta against the matching previous text.
 */
export function storePart(store: IObjectStore, part: Part, previous?: ObjectHash): ObjectHash {
    switch (part.kind) {
        case "json":
            return store.put(part.role === undefined ? { t: "json", v: part.value } : jsonObject(part));
        case "text":
            return store.put({ t: "text", s: part.text }, previousOfKind(store, previous, "text"));
        case "seq":
            return store.put({
                t: "seq",
                ...(part.role === undefined ? {} : { role: part.role }),
                items: part.items.map((item) => [item.id, store.put({ t: "json", v: item.value })] as const),
            });
        case "rec": {
            const prev = previousOfKind(store, previous, "rec");
            const prevFields =
                prev === undefined ? undefined : (store.get(prev) as { f: Record<string, string> }).f;
            const fields: Record<string, ObjectHash> = {};
            for (const [key, child] of Object.entries(part.fields)) {
                fields[key] = storePart(store, child, prevFields?.[key]);
            }
            return store.put({
                t: "rec",
                ...(part.role === undefined ? {} : { role: part.role }),
                f: fields,
            });
        }
    }
}

function jsonObject(part: JsonPart): VcsObject {
    return { t: "json", role: part.role, v: part.value };
}

function previousOfKind(store: IObjectStore, hash: ObjectHash | undefined, kind: "text" | "rec") {
    if (hash === undefined) return undefined;
    return store.get(hash)?.t === kind ? hash : undefined;
}

/** Reads a part back from its root hash. */
export function loadPart(store: IObjectStore, hash: ObjectHash): Part {
    const object = store.get(hash);
    if (object === undefined) throw new Error(`version store: object ${hash} is missing`);
    switch (object.t) {
        case "json":
            return {
                kind: "json",
                ...(object.role === undefined ? {} : { role: object.role }),
                value: object.v,
            };
        case "text":
            return { kind: "text", text: object.s };
        case "seq":
            return {
                kind: "seq",
                ...(object.role === undefined ? {} : { role: object.role }),
                items: object.items.map(([id, itemHash]) => ({ id, value: loadJson(store, itemHash) })),
            };
        case "rec":
            return {
                kind: "rec",
                ...(object.role === undefined ? {} : { role: object.role }),
                fields: Object.fromEntries(
                    Object.entries(object.f).map(([key, h]) => [key, loadPart(store, h)]),
                ),
            };
        default:
            throw new Error(`version store: ${hash} is a ${object.t}, not a part`);
    }
}

export function loadJson(store: IObjectStore, hash: ObjectHash): JsonValue {
    const object = store.get(hash);
    if (object?.t !== "json") throw new Error(`version store: ${hash} is not a json object`);
    return object.v;
}

/** The role a stored part object declares. */
export function roleOf(object: VcsObject | undefined): string | undefined {
    return object !== undefined && "role" in object ? object.role : undefined;
}
