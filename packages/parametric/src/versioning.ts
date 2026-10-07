// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    formatNumber,
    I18n,
    type I18nKeys,
    isJsonObject,
    type JsonObject,
    type JsonValue,
    type Part,
    type RecPart,
    registerPropertySplitter,
    type SeqItem,
    type SeqPart,
    seqItems,
    summarizeValue,
    type UnitSpec,
    VersioningRoles,
} from "@chili3d/core";
import { ConstraintKind } from "../lib/garlic";
import { type FeatureData, featureHandler } from "./features";

/**
 * How the version history sees parametric nodes: a body's feature list is one object per
 * feature, a sketch one object per entity / constraint / external reference, a Feature Studio's
 * source a line-delta text. Editing one feature therefore stores one feature; two branches
 * editing different features (or entities, or source lines) merge without a conflict.
 */

// ------------------------------------------------------------------ Feature lists

registerPropertySplitter({
    className: "ParametricBodyNode",
    property: "featuresJson",
    split(value) {
        if (typeof value !== "string") return undefined;
        const features = JSON.parse(value) as unknown;
        if (!Array.isArray(features)) return undefined;
        return { kind: "seq", role: "feature", items: seqItems(features, (f) => (f as FeatureData)?.id) };
    },
    join(part) {
        return JSON.stringify(part.kind === "seq" ? part.items.map((x) => x.value) : []);
    },
});

function featureTypeLabel(feature: JsonValue): string {
    if (!isJsonObject(feature) || typeof feature["type"] !== "string") return "Feature";
    const handler = featureHandler(feature["type"]);
    const display = handler?.display;
    const key = typeof display === "function" ? display(feature as unknown as FeatureData) : display;
    return (key && I18n.translate(key as I18nKeys)) || feature["type"];
}

function featureParameter(feature: JsonValue, path: string) {
    if (!isJsonObject(feature) || typeof feature["type"] !== "string") return undefined;
    const handler = featureHandler(feature["type"]);
    if (handler === undefined) return undefined;
    const segments = path.split(".");
    try {
        const parameters = handler.parameters(feature as unknown as FeatureData);
        return (
            parameters.find((p) => p.key === segments[0]) ?? parameters.find((p) => p.key === segments.at(-1))
        );
    } catch {
        return undefined;
    }
}

const lowerFirst = (text: string) =>
    text.length === 0 ? text : text.charAt(0).toLocaleLowerCase() + text.slice(1);

function unitSuffix(unit: UnitSpec | undefined): string {
    if (unit === undefined) return "";
    if (unit.length === 1 && unit.angle === 0) return " mm";
    if (unit.length === 0 && unit.angle === 1) return "°";
    return "";
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

VersioningRoles.register("feature", {
    itemLabel(value, items, index) {
        if (isJsonObject(value) && typeof value["name"] === "string" && value["name"] !== "")
            return value["name"];
        const type = featureTypeLabel(value);
        const ordinal = items
            .slice(0, index + 1)
            .filter((item) => featureTypeLabel(item.value) === type).length;
        return `${type} ${ordinal}`;
    },
    fieldLabel(item, path) {
        if (path === "suppressed") return "suppressed";
        if (path === "name") return "name";
        const parameter = featureParameter(item, path);
        if (parameter === undefined) return path;
        return lowerFirst(parameter.label ?? I18n.translate(parameter.display) ?? path);
    },
    formatValue(item, path, value) {
        if (typeof value === "number")
            return `${formatNumber(value)}${unitSuffix(featureParameter(item, path)?.unit)}`;
        if (Array.isArray(value)) {
            const leaf = path.split(".").at(-1);
            if (leaf === "edges") return plural(value.length, "edge");
            if (leaf === "profiles") return plural(value.length, "profile");
            if (leaf === "toolIds") return plural(value.length, "tool");
            if (leaf === "lines") return plural(value.length, "line");
        }
        return summarizeValue(value);
    },
});

// ------------------------------------------------------------------ Feature Studios

registerPropertySplitter({
    className: "FeatureStudioNode",
    property: "source",
    split: (value) => (typeof value === "string" ? { kind: "text", text: value } : undefined),
    join: (part) => (part.kind === "text" ? part.text : ""),
});

// ------------------------------------------------------------------ Variable studios and tables

/** Any node class that keeps a variable table as `variablesJson` (e.g. a Variable Studio). */
registerPropertySplitter({
    className: "*",
    property: "variablesJson",
    split(value) {
        if (typeof value !== "string") return undefined;
        const variables = JSON.parse(value) as unknown;
        if (!Array.isArray(variables)) return undefined;
        return {
            kind: "seq",
            role: "variable",
            items: seqItems(variables, (v) => (v as { id?: string })?.id),
        };
    },
    join: (part) => JSON.stringify(part.kind === "seq" ? part.items.map((x) => x.value) : []),
});

// ------------------------------------------------------------------ Sketches

const SKETCH_COLLECTIONS = {
    entities: { role: "sketchEntity", key: "id" },
    constraints: { role: "sketchConstraint", key: "id" },
    externalRefs: { role: "sketchExternal", key: "entityId" },
    anchors: { role: "sketchAnchor", key: "id" },
} as const;
type SketchCollection = keyof typeof SKETCH_COLLECTIONS;
const COLLECTION_NAMES = Object.keys(SKETCH_COLLECTIONS) as SketchCollection[];

registerPropertySplitter({
    className: "SketchNode",
    property: "dataJson",
    split(value) {
        if (typeof value !== "string") return undefined;
        const data = JSON.parse(value) as unknown;
        if (!isJsonObject(data) || !Array.isArray(data["entities"]) || !Array.isArray(data["constraints"])) {
            return undefined;
        }
        const fields: Record<string, Part> = {};
        const rest: JsonObject = {};
        for (const [key, item] of Object.entries(data)) {
            const collection = SKETCH_COLLECTIONS[key as SketchCollection];
            if (collection !== undefined && Array.isArray(item)) {
                fields[key] = {
                    kind: "seq",
                    role: collection.role,
                    items: seqItems(item, (x) => (isJsonObject(x) ? x[collection.key] : undefined)),
                };
            } else {
                rest[key] = item;
            }
        }
        fields["rest"] = { kind: "json", role: "sketchMeta", value: rest };
        return { kind: "rec", role: "sketch", fields };
    },
    join(part) {
        if (part.kind !== "rec") return JSON.stringify({ entities: [], constraints: [] });
        const rest = part.fields["rest"];
        const data: Record<string, unknown> =
            rest?.kind === "json" && isJsonObject(rest.value) ? { ...rest.value } : {};
        for (const name of COLLECTION_NAMES) {
            const field = part.fields[name];
            if (field?.kind === "seq") data[name] = field.items.map((x) => x.value);
        }
        return JSON.stringify(data);
    },
});

const ENTITY_NAMES: Record<string, string> = { line: "Line", circle: "Circle", arc: "Arc" };

function constraintName(kind: unknown): string {
    const name =
        typeof kind === "number" ? (ConstraintKind as unknown as Record<number, string>)[kind] : undefined;
    if (name === undefined) return "Constraint";
    return name.replace(/^P2[PL]/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

VersioningRoles.register("sketchEntity", {
    itemLabel: (value) =>
        isJsonObject(value)
            ? `${ENTITY_NAMES[String(value["type"])] ?? "Entity"} ${String(value["id"])}`
            : "Entity",
    fieldLabel: (_item, path) => (path === "params" ? "geometry" : path),
    formatValue: (_item, _path, value) =>
        Array.isArray(value)
            ? `(${value.map((x) => (typeof x === "number" ? formatNumber(Number(x.toFixed(4))) : String(x))).join(", ")})`
            : summarizeValue(value),
});

VersioningRoles.register("sketchConstraint", {
    itemLabel: (value) =>
        isJsonObject(value)
            ? `${constraintName(value["kind"])} constraint ${String(value["id"])}`
            : "Constraint",
    fieldLabel: (_item, path) => (path === "datum" || path === "datums" ? "dimension" : path),
});

VersioningRoles.register("sketchExternal", {
    itemLabel: (value) =>
        isJsonObject(value)
            ? `Reference edge ${String(-100 - Number(value["entityId"]) + 1)}`
            : "Reference edge",
    hiddenField: (path) => path === "snapshot" || path === "dangling",
});

VersioningRoles.register("sketchAnchor", {
    itemLabel: (value) =>
        isJsonObject(value) ? `Dimension label ${String(value["id"])}` : "Dimension label",
});

VersioningRoles.register("sketchMeta", {
    // Id counters only ever move one way; two branches that each allocated ids keep the furthest.
    mergeField(path, _base, ours, theirs) {
        if (typeof ours !== "number" || typeof theirs !== "number") return undefined;
        if (path === "entityIdSeq") return { value: Math.max(ours, theirs) };
        if (path === "externalIdSeq") return { value: Math.min(ours, theirs) };
        return undefined;
    },
    hiddenField: (path) =>
        path === "entityIdSeq" || path === "externalIdSeq" || path.startsWith("refPositions"),
});

VersioningRoles.register("sketch", {
    rebaseTheirs: (base, ours, theirs) => renumberIncomingSketchIds(base, ours, theirs),
    afterMerge: (merged) => bumpSketchCounters(merged),
});

function seqOf(part: Part, name: string): readonly SeqItem[] {
    if (part.kind !== "rec") return [];
    const field = part.fields[name];
    return field?.kind === "seq" ? field.items : [];
}

function restOf(part: Part): JsonObject {
    if (part.kind !== "rec") return {};
    const rest = part.fields["rest"];
    return rest?.kind === "json" && isJsonObject(rest.value) ? rest.value : {};
}

function numericIds(items: readonly SeqItem[], key: string): number[] {
    return items.flatMap((item) =>
        isJsonObject(item.value) && typeof item.value[key] === "number" ? [item.value[key]] : [],
    );
}

/**
 * Entity, constraint and external ids are per-sketch counters, so two branches that each drew
 * in the same sketch allocate the same ids for different geometry. Before merging, the incoming
 * side's new ids that collide with ours' new ids are renumbered past both sides' counters (and
 * every reference to them rewritten), so both drawings survive the merge.
 */
export function renumberIncomingSketchIds(base: Part, ours: Part, theirs: Part): Part {
    if (theirs.kind !== "rec") return theirs;
    const collisions = (name: SketchCollection) => {
        const key = SKETCH_COLLECTIONS[name].key;
        const inBase = new Set(seqOf(base, name).map((x) => x.id));
        const oursAdded = new Map(
            seqOf(ours, name)
                .filter((x) => !inBase.has(x.id))
                .map((x) => [x.id, x.value]),
        );
        const colliding = seqOf(theirs, name).filter(
            (x) =>
                !inBase.has(x.id) &&
                oursAdded.has(x.id) &&
                JSON.stringify(oursAdded.get(x.id)) !== JSON.stringify(x.value),
        );
        const all = [base, ours, theirs].flatMap((p) => numericIds(seqOf(p, name), key));
        return { colliding, all };
    };

    const entityMap = new Map<number, number>();
    const entities = collisions("entities");
    const counters = [restOf(ours)["entityIdSeq"], restOf(theirs)["entityIdSeq"]].filter(
        (x): x is number => typeof x === "number",
    );
    let nextEntity = Math.max(0, ...entities.all, ...counters.map((x) => x - 1)) + 1;
    for (const item of entities.colliding) entityMap.set(Number(item.id), nextEntity++);

    const externals = collisions("externalRefs");
    const externalCounters = [restOf(ours)["externalIdSeq"], restOf(theirs)["externalIdSeq"]].filter(
        (x): x is number => typeof x === "number",
    );
    let nextExternal = Math.min(-100, ...externals.all, ...externalCounters.map((x) => x + 1)) - 1;
    for (const item of externals.colliding) entityMap.set(Number(item.id), nextExternal--);

    const constraintMap = new Map<number, number>();
    const constraints = collisions("constraints");
    let nextConstraint = Math.max(0, ...constraints.all) + 1;
    for (const item of constraints.colliding) constraintMap.set(Number(item.id), nextConstraint++);

    if (entityMap.size === 0 && constraintMap.size === 0) return theirs;
    const mapEntity = (id: unknown) => (typeof id === "number" ? (entityMap.get(id) ?? id) : id);
    const rewrite = (
        name: SketchCollection,
        transform: (value: JsonObject) => JsonObject,
    ): SeqPart | undefined => {
        const field = theirs.fields[name];
        if (field?.kind !== "seq") return undefined;
        const key = SKETCH_COLLECTIONS[name].key;
        return {
            ...field,
            items: field.items.map((item) => {
                if (!isJsonObject(item.value)) return item;
                const value = transform(item.value);
                return { id: String(value[key]), value };
            }),
        };
    };
    const fields: Record<string, Part> = { ...theirs.fields };
    const set = (name: SketchCollection, part: SeqPart | undefined) => {
        if (part !== undefined) fields[name] = part;
    };
    set(
        "entities",
        rewrite("entities", (v) => ({ ...v, id: mapEntity(v["id"]) as JsonValue })),
    );
    set(
        "externalRefs",
        rewrite("externalRefs", (v) => ({ ...v, entityId: mapEntity(v["entityId"]) as JsonValue })),
    );
    set(
        "constraints",
        rewrite("constraints", (v) => ({
            ...v,
            id: typeof v["id"] === "number" ? (constraintMap.get(v["id"]) ?? v["id"]) : v["id"],
            refs: Array.isArray(v["refs"])
                ? v["refs"].map((ref) =>
                      isJsonObject(ref) ? { ...ref, entityId: mapEntity(ref["entityId"]) as JsonValue } : ref,
                  )
                : v["refs"],
        })),
    );
    set(
        "anchors",
        rewrite("anchors", (v) => ({
            ...v,
            id: typeof v["id"] === "number" ? (constraintMap.get(v["id"]) ?? v["id"]) : v["id"],
        })),
    );
    const rest = restOf(theirs);
    fields["rest"] = {
        kind: "json",
        role: "sketchMeta",
        value: {
            ...rest,
            ...(typeof rest["entityIdSeq"] === "number" || entityMap.size > 0
                ? { entityIdSeq: nextEntity }
                : {}),
            ...(typeof rest["externalIdSeq"] === "number" ? { externalIdSeq: nextExternal } : {}),
        },
    };
    return { ...theirs, fields } satisfies RecPart;
}

/** Keeps the merged sketch's counters past every merged id, so the next allocation is fresh. */
function bumpSketchCounters(merged: Part): Part {
    if (merged.kind !== "rec") return merged;
    const rest = restOf(merged);
    const entityIds = numericIds(seqOf(merged, "entities"), "id");
    const externalIds = numericIds(seqOf(merged, "externalRefs"), "entityId");
    let changed = false;
    const next: JsonObject = { ...rest };
    if (typeof rest["entityIdSeq"] === "number" && entityIds.length > 0) {
        const minimum = Math.max(...entityIds) + 1;
        if (rest["entityIdSeq"] < minimum) {
            next["entityIdSeq"] = minimum;
            changed = true;
        }
    }
    if (typeof rest["externalIdSeq"] === "number" && externalIds.length > 0) {
        const maximum = Math.min(...externalIds) - 1;
        if (rest["externalIdSeq"] > maximum) {
            next["externalIdSeq"] = maximum;
            changed = true;
        }
    }
    if (!changed) return merged;
    return {
        ...merged,
        fields: { ...merged.fields, rest: { kind: "json", role: "sketchMeta", value: next } },
    };
}
