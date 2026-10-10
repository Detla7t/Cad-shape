// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type EntityRef, entityAttr, type FsBody, FsContext } from "../context/fsContext";
import { resolveQuery } from "../context/queries";
import { FsEnumValue, FsMap, type FsValue, fail, freeze } from "../lang/values";
import type { StdBridge } from "./bridge";
import type { BuiltinRegistry } from "./registry";

/**
 * Part properties (`setProperty` / `getProperty`): name, appearance, material, part
 * number, description, custom properties... Like attributes they are keyed by the
 * entity's serial, which operations pass on along the kernel history, so a part keeps
 * its name and material through a fillet or a boolean. Only `APPEARANCE` and `NAME` may
 * be set on faces. Values are stored the way `getProperty` returns them: quantities
 * (a material's density, a mass override) as plain SI numbers.
 */

type PropertyStore = Map<number, Map<string, FsValue>>;

const stores = new WeakMap<FsContext, PropertyStore>();

function storeOf(context: FsContext): PropertyStore {
    let store = stores.get(context);
    if (store === undefined) {
        store = new Map();
        stores.set(context, store);
    }
    return store;
}

const FACE_PROPERTIES = new Set(["NAME", "APPEARANCE"]);

export function installPropertyBuiltins(define: BuiltinRegistry, bridge: StdBridge): void {
    const definitionOf = (args: FsValue[]): [FsContext, FsMap] => {
        if (!(args[1] instanceof FsMap)) fail("Expected a property definition map");
        return [FsContext.of(args[0]), args[1]];
    };

    define("setProperty", (args) => {
        const [context, definition] = definitionOf(args);
        const type = propertyName(definition.field("propertyType"));
        const key = propertyKey(type, definition);
        const value = storedValue(type, definition.field("value"));
        const store = storeOf(context);
        for (const ref of resolveQuery(context, bridge.toLocal(definition.field("entities")))) {
            if (ref.kind === "EDGE" || ref.kind === "VERTEX") continue;
            if (ref.kind === "FACE" && !FACE_PROPERTIES.has(type))
                fail(`setProperty: only APPEARANCE and NAME can be set on faces, not ${type}`);
            const serial = entityAttr(ref).serial;
            const properties = store.get(serial) ?? new Map<string, FsValue>();
            properties.set(key, value);
            store.set(serial, properties);
        }
        return undefined;
    });

    define("getProperty", (args) => {
        const [context, definition] = definitionOf(args);
        const type = propertyName(definition.field("propertyType"));
        const key = propertyKey(type, definition);
        const ref = resolveQuery(context, bridge.toLocal(definition.field("entity"))).find(
            (candidate) => candidate.kind === "BODY" || candidate.kind === "FACE",
        );
        if (ref === undefined) fail("getProperty: the entity query resolves to no body or face");
        const store = storeOf(context);
        const own = store.get(entityAttr(ref).serial)?.get(key);
        if (own !== undefined) return own;
        // A face without its own appearance shows its part's.
        if (ref.kind === "FACE" && type === "APPEARANCE")
            return store.get(ref.body.bodyAttr.serial)?.get(key);
        return defaultProperty(context, ref, type);
    });
}

function propertyName(value: FsValue): string {
    if (value instanceof FsEnumValue) return value.name;
    if (typeof value === "string") return value;
    fail("propertyType must be a PropertyType");
}

function propertyKey(type: string, definition: FsMap): string {
    if (type !== "CUSTOM") return type;
    const id = definition.field("customPropertyId");
    if (typeof id !== "string") fail("A CUSTOM property needs a customPropertyId");
    return `CUSTOM:${id}`;
}

/** A std `ValueWithUnits` map's magnitude (SI), anything else unchanged. */
function magnitudeOf(value: FsValue): FsValue {
    if (value instanceof FsMap && value.tag === "ValueWithUnits") return value.field("value");
    return value;
}

function storedValue(type: string, value: FsValue): FsValue {
    if (type === "MATERIAL") {
        if (!(value instanceof FsMap)) fail("A MATERIAL property needs a Material");
        const material = new FsMap(undefined, value.tag);
        for (const [key, field] of value.pairs()) material.set(key, magnitudeOf(field));
        return freeze(material);
    }
    if (type === "MASS_OVERRIDE") {
        const mass = magnitudeOf(value);
        if (typeof mass === "string" && mass.trim() !== "" && !Number.isNaN(Number(mass)))
            return Number(mass);
        return mass;
    }
    return freeze(value);
}

/** What an unset property reads as: Onshape's default part names, false for BOM exclusion. */
function defaultProperty(context: FsContext, ref: EntityRef, type: string): FsValue {
    if (type === "EXCLUDE_FROM_BOM") return false;
    if (type !== "NAME" || ref.kind !== "BODY") return undefined;
    return defaultName(context, ref.body);
}

/**
 * The name a body came with (a host part keeps its document node's name — custom tables
 * list them), else "Part 2": the body's kind and its place among the context's bodies
 * of that kind.
 */
function defaultName(context: FsContext, body: FsBody): string {
    if (body.name !== undefined) return body.name;
    if (body.flags.defaultGeometry) return body.bodyAttr.createdBy;
    const label = labelOf(body);
    const sameLabel = context.bodies.filter(
        (other) => !other.flags.defaultGeometry && labelOf(other) === label,
    );
    return `${label} ${sameLabel.indexOf(body) + 1}`;
}

function labelOf(body: FsBody): string {
    if (body.flags.sketch) return "Sketch";
    if (body.flags.construction) return "Plane";
    return { SOLID: "Part", SHEET: "Surface", WIRE: "Curve", POINT: "Point" }[body.kind];
}
