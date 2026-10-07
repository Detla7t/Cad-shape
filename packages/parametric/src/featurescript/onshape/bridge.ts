// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { query } from "../context/queries";
import type { Interpreter } from "../lang/interpreter";
import {
    FsArray,
    FsEnumType,
    FsEnumValue,
    FsMap,
    FsQuantity,
    type FsValue,
    fail,
    fsArray,
    fsMap,
    isUnitless,
    LENGTH,
    quantity,
    toDisplayString,
    type Units,
} from "../lang/values";

/**
 * Converts between the two value worlds. Onshape's std source represents everything in
 * FeatureScript itself — a length is `{ "value" : 0.0254, "unit" : { "meter" : 1 } } as
 * ValueWithUnits`, a query names its type with a `QueryType` enum value — while the
 * kernel layer (`context/`) reads native quantities and string-typed query maps.
 * `toLocal` translates std values on their way into a kernel operation; `toStd` builds
 * std values from what comes back, using std's own enums and tags.
 */
export class StdBridge {
    private readonly enums = new Map<string, FsEnumType>();

    constructor(private readonly interpreter: Interpreter) {}

    // ------------------------------------------------------------------ Std lookups

    stdEnum(name: string): FsEnumType {
        let type = this.enums.get(name);
        if (type === undefined) {
            const found = this.interpreter.findExport(name);
            if (!(found instanceof FsEnumType)) fail(`The std enum ${name} is not loaded`);
            type = found;
            this.enums.set(name, type);
        }
        return type;
    }

    enumValue(type: string, member: string): FsEnumValue {
        const value = this.stdEnum(type).member(member);
        if (value === undefined) fail(`${type} has no value ${member}`);
        return value;
    }

    // ------------------------------------------------------------------ Std → kernel layer

    toLocal(value: FsValue): FsValue {
        if (value instanceof FsArray)
            return new FsArray(
                value.items.map((item) => this.toLocal(item)),
                value.tag,
            );
        if (!(value instanceof FsMap)) return value;
        const units = unitsOfValueWithUnits(value);
        if (units !== undefined) return quantity(value.field("value") as number, units);
        if (isStdQuery(value)) return this.localQuery(value);
        const copy = new FsMap(undefined, value.tag);
        for (const [key, item] of value.pairs()) copy.set(key, this.toLocal(item));
        return copy;
    }

    /** A std query map as the kernel layer's query (see `context/queries.ts`). */
    localQuery(q: FsMap): FsMap {
        const type = queryTypeName(q.field("queryType"));
        const sub = (field: string) => this.queryOrArray(q.field(field));
        const kind = q.has("entityType") ? { entityType: q.field("entityType") } : {};
        const point = (field: string) => lengthVector(q.field(field));
        switch (type) {
            case "NOTHING":
            case "EVERYTHING":
                return query(type, kind);
            case "CREATED_BY":
                return query("CREATED_BY", { featureId: q.field("featureId"), ...kind });
            case "TRANSIENT":
                return query("TRANSIENT", { transientId: q.field("transientId") });
            case "UNION":
            case "INTERSECTION":
                return query(type, { subqueries: sub("subqueries") });
            case "SUBTRACTION":
                return query("SUBTRACTION", { query1: sub("query1"), query2: sub("query2") });
            case "NTH_ELEMENT":
                return query("NTH_ELEMENT", { query: sub("subquery"), n: q.field("n") });
            case "ENTITY_FILTER":
                return query("ENTITY_FILTER", { query: sub("subquery"), ...kind });
            case "OWNER_PART":
                return query("OWNER_BODY", { query: sub("query") });
            case "OWNED_BY_PART": {
                const owned = query("OWNED_BY_BODY", { body: sub("part"), ...kind });
                if (!q.has("subquery")) return owned;
                return query("INTERSECTION", { subqueries: fsArray([sub("subquery"), owned]) });
            }
            case "BODY_TYPE":
                return query("BODY_TYPE", { query: sub("subquery"), bodyType: q.field("bodyType") });
            case "GEOMETRY":
                return query("GEOMETRY", { query: sub("subquery"), geometryType: q.field("geometryType") });
            case "CONSTRUCTION_FILTER":
                return query("CONSTRUCTION_FILTER", {
                    query: sub("subquery"),
                    filter: q.field("constructionFilter"),
                });
            case "SKETCH_OBJECT_FILTER":
                return query("SKETCH_FILTER", {
                    query: sub("subquery"),
                    filter: q.field("sketchObjectFilter"),
                });
            case "SKETCH_REGION":
                return query("SKETCH_REGION", {
                    featureId: q.field("featureId"),
                    filterInnerLoops: q.field("filterInnerLoops") ?? false,
                });
            case "CAP_ENTITY":
                return query("CAP_ENTITY", {
                    featureId: q.field("featureId"),
                    capType: q.field("capType"),
                    ...kind,
                });
            case "EDGE_ADJACENT":
            case "VERTEX_ADJACENT":
                return query("ADJACENT", {
                    query: sub("query"),
                    adjacencyType: type === "EDGE_ADJACENT" ? "EDGE" : "VERTEX",
                    ...kind,
                });
            case "LOOP_EDGES":
                return query("ADJACENT", {
                    query: sub("subquery"),
                    adjacencyType: "EDGE",
                    entityType: "EDGE",
                });
            case "LARGEST":
            case "SMALLEST":
                return query(type, { query: sub("subquery") });
            case "CLOSEST_TO":
            case "CONTAINS_POINT":
                return query(type, { query: sub("subquery"), point: point("point") });
            case "FARTHEST_ALONG":
                return query("FARTHEST_ALONG", { query: sub("subquery"), direction: q.field("direction") });
            case "INTERSECTS_BALL":
                return query("WITHIN_RADIUS", {
                    query: sub("subquery"),
                    point: point("point"),
                    radius: quantity(q.field("radius") as number, LENGTH),
                });
            case "COINCIDES_WITH_PLANE":
                return query("COINCIDES_WITH_PLANE", {
                    query: sub("subquery"),
                    plane: strippedPlane(q.field("plane")),
                });
            case "PLANE_NORMAL":
                return query("PARALLEL_PLANES", {
                    query: sub("subquery"),
                    normal: q.field("normal"),
                    allowAntiparallel: q.field("allowAntiparallel") ?? true,
                });
            case "PARALLEL_EDGES":
                return query("PARALLEL_EDGES", {
                    query: sub("queryToFilter"),
                    direction: q.field("direction"),
                });
            case "MODIFIABLE_ENTITY_FILTER":
                return this.queryOrArray(q.field("subquery")) as FsMap;
            // No meshes, flattened or active sheet metal, forms or composite parts exist here:
            // asking for them finds nothing, excluding them keeps everything.
            case "MESH_GEOMETRY_FILTER":
            case "ACTIVE_SM_FILTER":
            case "SM_FLAT_FILTER":
            case "SM_FORM_FILTER": {
                const field = {
                    MESH_GEOMETRY_FILTER: "meshGeometryFilter",
                    ACTIVE_SM_FILTER: "activeSheetMetal",
                    SM_FLAT_FILTER: "flatFilter",
                    SM_FORM_FILTER: "formFilter",
                }[type];
                const wanted = q.field(field);
                const yes = wanted instanceof FsEnumValue ? wanted.name === "YES" : wanted === true;
                return yes ? query("NOTHING") : (this.queryOrArray(q.field("subquery")) as FsMap);
            }
            case "ATTRIBUTE_FILTER":
                // Resolved against the attribute store (see `attributeBuiltins.ts`).
                return query("ATTRIBUTE_FILTER", {
                    query: q.has("subquery") ? sub("subquery") : query("EVERYTHING"),
                    name: q.field("name"),
                    attributePattern: q.field("attributePattern"),
                    value: q.field("valueToMatchExactly"),
                    hasValue: q.has("valueToMatchExactly"),
                });
            case "COMPOSITE_PART_TYPE_FITLER":
            case "CONTAINED_IN_COMPOSITE":
            case "COMPOSITE_CONTAINING":
                return query("NOTHING");
            // Operation-history queries: `makeQuery(id, "IMPRINT", ...)` names the faces a sketch made.
            case "IMPRINT":
                return query("CREATED_BY", {
                    featureId: stripSuffix(q.field("operationId"), "imprint"),
                    ...kind,
                });
            case "SKETCH_ENTITY":
                return query("SKETCH_ENTITY", {
                    featureId: q.field("operationId"),
                    sketchEntityId: q.field("sketchEntityId"),
                    ...kind,
                });
            case "SWEPT_FACE":
            case "SWEPT_EDGE":
                return query("NON_CAP_ENTITY", { featureId: q.field("operationId"), ...kind });
            default:
                fail(`Query type ${type} is not supported`);
        }
    }

    private queryOrArray(value: FsValue): FsValue {
        if (value instanceof FsArray) return new FsArray(value.items.map((item) => this.queryOrArray(item)));
        if (value instanceof FsMap && isStdQuery(value)) return this.localQuery(value);
        fail(`Expected a Query, got ${value === undefined ? "undefined" : toDisplayString(value)}`);
    }

    // ------------------------------------------------------------------ Kernel layer → std

    toStd(value: FsValue): FsValue {
        if (value instanceof FsQuantity) return this.quantity(value.value, value.units);
        // Only the native std's enums need translating; a studio's or std's own pass as they are.
        if (value instanceof FsEnumValue)
            return value.type.id.startsWith("std::") ? this.enumValue(value.type.name, value.name) : value;
        if (value instanceof FsArray)
            return new FsArray(
                value.items.map((item) => this.toStd(item)),
                value.tag,
            );
        if (!(value instanceof FsMap)) return value;
        if (value.tag === "Query" && typeof value.field("queryType") === "string")
            return this.stdQuery(value);
        const copy = new FsMap(undefined, value.tag);
        for (const [key, item] of value.pairs()) copy.set(key, this.toStd(item));
        return copy;
    }

    /** A `ValueWithUnits` the way std builds one (unitless collapses to a number). */
    quantity(value: number, units: Units): FsValue {
        if (isUnitless(units)) return value;
        const spec = new FsMap(undefined, "UnitSpec");
        for (const key of ["kilogram", "meter", "radian", "second"] as const) {
            if (units[key] !== 0) spec.set(key, units[key]);
        }
        return fsMap({ value, unit: spec }, "ValueWithUnits");
    }

    length(meters: number): FsValue {
        return this.quantity(meters, LENGTH);
    }

    lengthVector(meters: readonly number[]): FsArray {
        return new FsArray(
            meters.map((m) => this.length(m)),
            "Vector",
        );
    }

    /** A std `Transform`: row-major 3x3 linear part and a translation in meters. */
    transform(linear: readonly number[], translation: readonly number[]): FsMap {
        const rows = [0, 1, 2].map((r) => new FsArray(linear.slice(3 * r, 3 * r + 3)));
        return fsMap(
            { linear: new FsArray(rows, "Matrix"), translation: this.lengthVector(translation) },
            "Transform",
        );
    }

    /** The only kernel-layer query a native hands back is a transient one. */
    /** The kernel-layer queries the host and the natives build: entity picks and their unions. */
    private stdQuery(local: FsMap): FsMap {
        const type = local.field("queryType") as string;
        const queryType = this.enumValue("QueryType", type);
        switch (type) {
            case "TRANSIENT":
                return fsMap({ queryType, transientId: local.field("transientId") }, "Query");
            case "NOTHING":
                return fsMap({ queryType }, "Query");
            case "UNION": {
                const subqueries = local.field("subqueries");
                if (!(subqueries instanceof FsArray)) fail("A union query needs its subqueries");
                return fsMap({ queryType, subqueries: this.toStd(subqueries) }, "Query");
            }
            default:
                fail(`Cannot hand a ${type} query to std code`);
        }
    }
}

/** The units of a std `ValueWithUnits` map, or undefined for any other value. */
function unitsOfValueWithUnits(value: FsMap): Units | undefined {
    if (value.tag !== "ValueWithUnits") return undefined;
    const magnitude = value.field("value");
    const unit = value.field("unit");
    if (typeof magnitude !== "number" || !(unit instanceof FsMap)) return undefined;
    const exponent = (key: string) => {
        const e = unit.field(key);
        return typeof e === "number" ? e : 0;
    };
    return {
        meter: exponent("meter"),
        radian: exponent("radian"),
        kilogram: exponent("kilogram"),
        second: exponent("second"),
    };
}

function isStdQuery(value: FsMap): boolean {
    const type = value.field("queryType");
    return (
        (type instanceof FsEnumValue && type.type.name === "QueryType") ||
        (value.tag === "Query" && typeof type === "string")
    );
}

function queryTypeName(value: FsValue): string {
    if (value instanceof FsEnumValue) return value.name;
    if (typeof value === "string") return value;
    fail("A query has no queryType");
}

/** `stripUnits` leaves meters as plain numbers; the kernel layer reads length quantities. */
function lengthVector(value: FsValue): FsValue {
    if (!(value instanceof FsArray)) fail("Expected a point");
    return new FsArray(
        value.items.map((item) => (typeof item === "number" ? new FsQuantity(item, LENGTH) : item)),
        "Vector",
    );
}

function strippedPlane(value: FsValue): FsValue {
    if (!(value instanceof FsMap)) fail("Expected a plane");
    return fsMap(
        {
            origin: lengthVector(value.field("origin")),
            normal: value.field("normal"),
            x: value.field("x") ?? undefined,
        },
        "Plane",
    );
}

/** `sketchId + "imprint"` → `sketchId`. */
function stripSuffix(id: FsValue, last: string): FsValue {
    if (id instanceof FsArray && id.items[id.size - 1] === last)
        return new FsArray(id.items.slice(0, -1), id.tag);
    return id;
}
