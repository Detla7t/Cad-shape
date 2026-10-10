// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Observable } from "../foundation/observer";

const propertiesMap = new Map<new (...args: any[]) => any, Array<PropertyInfo>>();
/** Every identifier a class is read by (its written id and its aliases) → the class. */
const reflectMap = new Map<string, RefelectData>();
/** Class → the identifier written for it in `__cla$$__`. */
const typeIds = new Map<new (...args: any[]) => any, string>();

export type PropertyInfo = {
    name: string;
    readonly?: boolean;
};

export const InternalClassName = "__cla$$__";

export type SerializedData = { [x: string]: any };

export type Serialized = { [InternalClassName]: string } & SerializedData;

export interface RefelectData {
    ctor: new (...args: any[]) => any;
    serialize?: (target: any) => SerializedData;
    deserialize?: (...args: any[]) => any;
}

/**
 * Registers a serializable class under `name` (by default its runtime class name), the
 * identifier written in `__cla$$__`, plus `aliases` it is also read by.
 */
export function registerReflect(
    data: RefelectData,
    name?: string,
    props?: {
        type: any;
        props: PropertyInfo[];
    },
    aliases: readonly string[] = [],
) {
    const actualName = name ?? data.ctor.name;
    if (reflectMap.has(actualName)) {
        console.warn(`Class ${actualName} already registered, skip.`);
        // The class still serializes under the name (a module evaluated twice, e.g. by hot reload).
        if (!typeIds.has(data.ctor)) typeIds.set(data.ctor, actualName);
        return;
    }
    reflectMap.set(actualName, data);
    typeIds.set(data.ctor, actualName);
    for (const alias of aliases) {
        if (alias === actualName) continue;
        if (reflectMap.has(alias)) {
            console.warn(`Serialized type alias ${alias} of ${actualName} is already registered, skip.`);
            continue;
        }
        reflectMap.set(alias, data);
    }
    if (props !== undefined) {
        const ps = propertiesMap.get(props.type);
        if (ps === undefined) {
            propertiesMap.set(props.type, props.props);
        } else {
            ps.push(...props.props);
        }
    }
}

export function registerTypeArray(
    typeArray: new (array: number[]) => Float16Array | Float32Array | Uint32Array,
) {
    const data = {
        ctor: typeArray,
        serialize: (target: Float16Array | Float32Array | Uint32Array) => {
            return {
                buffer: Array.from(target),
            };
        },
        deserialize: (data: any) => {
            return new typeArray(data.buffer);
        },
    };

    registerReflect(data, typeArray.name, {
        type: typeArray.prototype,
        props: [
            {
                name: "buffer",
                readonly: true,
            },
        ],
    });
}
// Float16Array is ES2024 and is absent in some runtimes (older Node, happy-dom).
// Guard it so importing this module never throws where the global is missing;
// half-float arrays are simply not registered there. Browsers register it as before.
if (typeof Float16Array !== "undefined") {
    registerTypeArray(Float16Array);
}
registerTypeArray(Float32Array);
registerTypeArray(Uint32Array);

export interface SerializableOptions<T> {
    /**
     * The stable identifier written in `__cla$$__` (default: the runtime class name). Declare it
     * as a string literal so saved documents do not depend on class names surviving minification
     * or a rename. An existing class keeps its current class name as its id: older versions of
     * Chili3D read documents by that name. Changing what an existing class writes is a document
     * schema change (see `documentSchema.ts`); keep the old identifier in `aliases`.
     */
    id?: string;
    /** Other identifiers this class is read by (former class names or ids). Never written. */
    aliases?: readonly string[];
    deserialize?: (...args: any[]) => T;
    serialize?: (target: T) => SerializedData;
}

export function serializable<T>(options?: SerializableOptions<T>) {
    return (target: new (options: any) => T) => {
        registerReflect(
            {
                ctor: target,
                ...(options?.serialize === undefined ? {} : { serialize: options.serialize }),
                ...(options?.deserialize === undefined ? {} : { deserialize: options.deserialize }),
            },
            options?.id,
            undefined,
            options?.aliases,
        );
    };
}

/**
 * The identifier an instance (or class) is written with in `__cla$$__`, or undefined when its
 * class is not serializable. Use it instead of `constructor.name` to key anything by the
 * serialized type: class names do not survive minification.
 */
export function serializedTypeId(target: object | (new (...args: any[]) => any)): string | undefined {
    const ctor = typeof target === "function" ? target : target.constructor;
    return typeIds.get(ctor as new (...args: any[]) => any);
}

/** The identifier `name` (an id or an alias) is written as today, or undefined when unknown. */
export function canonicalSerializedTypeId(name: string): string | undefined {
    const data = reflectMap.get(name);
    return data === undefined ? undefined : typeIds.get(data.ctor);
}

export function serialize() {
    return (target: any, property: string) => {
        let props = propertiesMap.get(target);
        if (props === undefined) {
            props = [];
            propertiesMap.set(target, props);
        }
        props.push({
            name: property,
        });
    };
}

export class Serializer {
    public static deserializeObject(document: IDocument, data: Serialized) {
        const props: Record<string, any> = { document };
        for (const key of Object.keys(data)) {
            props[key] = Serializer.deserialValue(document, data[key]);
        }

        const instance = Serializer.deserializeInstance(props);
        Serializer.deserializeProperties(document, instance, props);
        return instance;
    }

    static deserializeInstance(data: Record<string, any>) {
        const className = data[InternalClassName];
        if (!className) {
            console.warn(`${data} cannot be deserialize.`);
            return data;
        }

        if (!reflectMap.has(data[InternalClassName])) {
            throw new Error(
                `${data[InternalClassName]} cannot be deserialize. Did you forget to add the decorator @Serializer.register?`,
            );
        }

        const { ctor, deserialize } = reflectMap.get(className)!;
        if (deserialize) {
            return deserialize(data);
        }
        return new ctor(data);
    }

    static deserialValue(document: IDocument, value: any) {
        if (value === null || value === undefined) {
            return undefined;
        }
        if (Array.isArray(value)) {
            return value.map((v) => {
                if (v === null || v === undefined) {
                    return undefined;
                }
                return typeof v === "object" ? Serializer.deserializeObject(document, v) : v;
            });
        }
        return (value as Serialized)[InternalClassName]
            ? Serializer.deserializeObject(document, value)
            : value;
    }

    static deserializeProperties(document: IDocument, instance: any, data: Record<string, any>) {
        const keys = Object.keys(data);
        for (const key of keys) {
            if (key !== InternalClassName && document !== data[key] && instance[key] !== data[key]) {
                if (instance instanceof Observable) {
                    instance.setPrivateValue(key as any, data[key]);
                } else if (Serializer.isWritable(instance, key)) {
                    instance[key] = Serializer.deserialValue(document, data[key]);
                }
            }
        }
    }

    static isWritable(obj: any, prop: string) {
        while (obj !== null) {
            const desc = Object.getOwnPropertyDescriptor(obj, prop);
            if (desc) {
                if (desc.set) return true;
                return desc.writable === true;
            }
            obj = Object.getPrototypeOf(obj);
        }
        return false;
    }

    static serializeObject(target: object): Serialized {
        const className = typeIds.get(target.constructor as new (...args: any[]) => any);
        if (className === undefined) {
            throw new Error(
                `Type ${target.constructor.name} is not registered, please add the @serializable() decorator.`,
            );
        }
        const data = reflectMap.get(className)!;
        const properties = data.serialize?.(target) ?? Serializer.serializeProperties(target);
        return {
            ...properties,
            [InternalClassName]: className,
        };
    }

    static serializeProperties(target: object) {
        const data: Record<string, any> = {};

        const props = Serializer.getAllKeysOfPrototypeChain(target, propertiesMap);
        for (const prop of props) {
            const value = (target as any)[prop.name];
            if (Array.isArray(value)) {
                data[prop.name] = value.map((v) => Serializer.serializePropertyValue(v));
            } else {
                data[prop.name] = Serializer.serializePropertyValue(value);
            }
        }
        return data;
    }

    private static serializePropertyValue(value: any) {
        const type = typeof value;
        if (type === "object") {
            return Serializer.serializeObject(value);
        }
        if (type !== "function" && type !== "symbol") {
            return value;
        }
        throw new Error(`Unsupported serialized object: ${value}`);
    }

    private static getAllKeysOfPrototypeChain(
        target: object,
        map: Map<new (...args: any[]) => any, Array<PropertyInfo>>,
    ) {
        const keys: PropertyInfo[] = [];
        let prototype = Object.getPrototypeOf(target);
        while (prototype !== null) {
            const k = map.get(prototype);
            if (k) keys.push(...k.values());
            prototype = Object.getPrototypeOf(prototype); // prototype chain
        }
        return new Set(keys);
    }
}
