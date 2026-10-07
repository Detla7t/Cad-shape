// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type EntityRef, entityAttr, FsContext } from "../context/fsContext";
import { registerQueryType, resolveQuery } from "../context/queries";
import { FsMap, type FsValue, fail, fsArray, valuesEqual } from "../lang/values";
import type { StdBridge } from "./bridge";
import type { BuiltinRegistry } from "./registry";

/**
 * Attributes: named values attached to entities. They are keyed by the entity's serial,
 * which operations pass on along the kernel history — so an attribute follows its face
 * through a fillet, as Onshape's do. A legacy unnamed attribute is stored under "".
 */

type AttributeStore = Map<number, Map<string, FsValue>>;

const stores = new WeakMap<FsContext, AttributeStore>();

function storeOf(context: FsContext): AttributeStore {
    let store = stores.get(context);
    if (store === undefined) {
        store = new Map();
        stores.set(context, store);
    }
    return store;
}

/** Does `value` match an attribute pattern: same type tag, and equal on every field the pattern sets? */
function matchesPattern(value: FsValue, pattern: FsValue): boolean {
    if (pattern === undefined) return true;
    if (!(pattern instanceof FsMap)) return valuesEqual(value, pattern);
    if (!(value instanceof FsMap) || value.tag !== pattern.tag) return false;
    for (const [key, field] of pattern.pairs()) if (!valuesEqual(value.get(key), field)) return false;
    return true;
}

/** The attributes on `ref` that `name` / `pattern` select, as [name, value] pairs. */
function selected(
    store: AttributeStore,
    ref: EntityRef,
    name: FsValue,
    pattern: FsValue,
): [string, FsValue][] {
    const attributes = store.get(entityAttr(ref).serial);
    if (attributes === undefined) return [];
    const result: [string, FsValue][] = [];
    for (const [key, value] of attributes) {
        if (typeof name === "string" && key !== name) continue;
        if (!matchesPattern(value, pattern)) continue;
        result.push([key, value]);
    }
    return result;
}

export function installAttributeBuiltins(define: BuiltinRegistry, bridge: StdBridge): void {
    const resolve = (context: FsContext, value: FsValue) =>
        value === undefined ? [] : resolveQuery(context, bridge.toLocal(value));
    const definitionOf = (args: FsValue[]): [FsContext, FsMap] => {
        if (!(args[1] instanceof FsMap)) fail("Expected an attribute definition map");
        return [FsContext.of(args[0]), args[1]];
    };

    define("setAttribute", (args) => {
        const [context, definition] = definitionOf(args);
        const refs = resolve(context, definition.field("entities"));
        if (refs.length === 0) fail("setAttribute: the entities query resolves to nothing");
        const name = definition.field("name");
        const key = typeof name === "string" ? name : "";
        const value = definition.field("attribute");
        const store = storeOf(context);
        for (const ref of refs) {
            const serial = entityAttr(ref).serial;
            const attributes = store.get(serial) ?? new Map<string, FsValue>();
            if (value === undefined) attributes.delete(key);
            else attributes.set(key, value);
            store.set(serial, attributes);
        }
        return undefined;
    });
    define("getAttributes", (args) => {
        const [context, definition] = definitionOf(args);
        const store = storeOf(context);
        const values: FsValue[] = [];
        for (const ref of resolve(context, definition.field("entities"))) {
            for (const [, value] of selected(
                store,
                ref,
                definition.field("name"),
                definition.field("attributePattern"),
            )) {
                if (!values.some((existing) => valuesEqual(existing, value))) values.push(value);
            }
        }
        return fsArray(values);
    });
    define("getAttribute", (args) => {
        const [context, definition] = definitionOf(args);
        const refs = resolve(context, definition.field("entity"));
        if (refs.length === 0) return undefined;
        return selected(storeOf(context), refs[0], definition.field("name"), undefined)[0]?.[1];
    });
    define("getAllAttributes", (args) => {
        const [context, definition] = definitionOf(args);
        const refs = resolve(context, definition.field("entity"));
        const result = new FsMap();
        if (refs.length > 0)
            for (const [key, value] of selected(storeOf(context), refs[0], undefined, undefined))
                result.set(key, value);
        return result;
    });
    define("removeAttributes", (args) => {
        const [context, definition] = definitionOf(args);
        const store = storeOf(context);
        const entities = definition.field("entities");
        const refs = entities === undefined ? [...allTagged(context, store)] : resolve(context, entities);
        for (const ref of refs) {
            const attributes = store.get(entityAttr(ref).serial);
            if (attributes === undefined) continue;
            for (const [key] of selected(
                store,
                ref,
                definition.field("name"),
                definition.field("attributePattern"),
            )) {
                attributes.delete(key);
            }
        }
        return undefined;
    });

    registerQueryType("ATTRIBUTE_FILTER", (context, value) => {
        const store = storeOf(context);
        const name = value.field("name");
        const pattern = value.field("attributePattern");
        const exact = value.field("hasValue") === true;
        return resolveQuery(context, value.field("query")).filter((ref) => {
            const found = selected(store, ref, name, pattern);
            return exact ? found.some(([, v]) => valuesEqual(v, value.field("value"))) : found.length > 0;
        });
    });
}

/** Every entity of the context that carries an attribute. */
function* allTagged(context: FsContext, store: AttributeStore): Iterable<EntityRef> {
    for (const body of context.bodies) {
        if (store.has(body.bodyAttr.serial)) yield { body, kind: "BODY", index: -1 };
        for (const kind of ["FACE", "EDGE", "VERTEX"] as const) {
            for (let index = 0; index < body.attrs(kind).length; index++) {
                if (store.has(body.attrs(kind)[index].serial)) yield { body, kind, index };
            }
        }
    }
}
