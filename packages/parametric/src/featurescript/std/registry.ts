// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Interpreter, type TypeDefinition, typeValue } from "../lang/interpreter";
import {
    FsArray,
    FsEnumType,
    FsEnumValue,
    FsMap,
    FsOpaque,
    type FsValue,
    fail,
    type NativeCallContext,
    native,
    typeName,
} from "../lang/values";

export type NativeImpl = (args: FsValue[], site: NativeCallContext) => FsValue;

/** Registration surface the std modules write into. */
export class StdBuilder {
    constructor(readonly interpreter: Interpreter) {}

    fn(name: string, impl: NativeImpl): void {
        this.interpreter.std.define(name, native(name, impl));
    }

    value(name: string, value: FsValue): void {
        this.interpreter.std.define(name, value);
    }

    /** A std type checked by container tag (or host-object type name). */
    tagType(name: string, extra?: (value: FsValue) => boolean): void {
        const definition: TypeDefinition = {
            name,
            tag: name,
            check: (value) =>
                ((value instanceof FsArray || value instanceof FsMap) && value.tag === name) ||
                (value instanceof FsOpaque && value.typeName === name) ||
                (extra?.(value) ?? false),
        };
        this.interpreter.std.define(name, typeValue(definition));
    }

    enumType(name: string, members: readonly string[]): FsEnumType {
        const type = new FsEnumType(
            `std::${name}`,
            name,
            members.map((member) => ({ name: member })),
        );
        this.interpreter.std.define(name, type);
        return type;
    }
}

/** Reads argument `index`, failing with the function's name when it is missing. */
export function arg(args: FsValue[], index: number, fn: string): FsValue {
    if (index >= args.length) fail(`${fn} expects at least ${index + 1} argument${index === 0 ? "" : "s"}`);
    return args[index];
}

export function expectArgCount(args: FsValue[], min: number, max: number, fn: string): void {
    if (args.length < min || args.length > max) {
        const expected = min === max ? `${min}` : `${min} to ${max}`;
        fail(`${fn} expects ${expected} argument${max === 1 ? "" : "s"}, got ${args.length}`);
    }
}

/** An enum value's name when it belongs to `type`, else a descriptive failure. */
export function enumName(value: FsValue, type: string, what: string): string {
    if (value instanceof FsEnumValue && value.type.name === type) return value.name;
    if (typeof value === "string") return value;
    fail(`${what} must be a ${type}, got ${typeName(value)}`);
}

/** Like `enumName`, but undefined passes through as `fallback`. */
export function optionalEnum(value: FsValue, type: string, what: string, fallback: string): string {
    return value === undefined ? fallback : enumName(value, type, what);
}
