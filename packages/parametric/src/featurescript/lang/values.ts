// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Block, Parameter, TypeReference } from "./ast";
import type { SourcePosition } from "./errors";
import { FsRuntimeError } from "./errors";

/**
 * FeatureScript values. Arrays and maps have VALUE semantics in the language — assigning
 * one and mutating the copy never shows through the original. That is implemented
 * copy-on-write: a container is mutable only while exactly one binding owns it, and the
 * interpreter `freeze`s it the moment a second reference can exist (it is read out of a
 * variable as a whole value). A write through a frozen container first clones it.
 * Boxes are the one reference type, exactly as in the language.
 */
export type FsValue =
    | undefined
    | boolean
    | number
    | string
    | FsArray
    | FsMap
    | FsBox
    | FsQuantity
    | FsEnumValue
    | FsEnumType
    | FsCallable
    | FsOpaque;

// ------------------------------------------------------------------ Containers

export class FsArray {
    frozen = false;

    constructor(
        readonly items: FsValue[],
        /** A custom type tag set by `as` (Vector, Id, Matrix, user types); undefined for a plain array. */
        public tag?: string,
    ) {}

    get size(): number {
        return this.items.length;
    }

    get(index: number): FsValue {
        return this.items[index];
    }
}

/**
 * A map. Iteration (`for`, `keys`, printing) walks entries in KEY order, as FeatureScript
 * maps are ordered: `keys({ "a" : 1, "c" : 2, "b" : 3 })` is `["a", "b", "c"]`.
 */
export class FsMap {
    frozen = false;
    /** Canonical key → [original key, value]; insertion ordered (see `pairs` for key order). */
    readonly entries = new Map<string, [FsValue, FsValue]>();
    /** `entries` sorted by key; dropped whenever the key set changes. */
    private sorted?: [FsValue, FsValue][];

    constructor(
        entries?: Iterable<[FsValue, FsValue]>,
        /** A custom type tag set by `as` (Query, Plane, Line, user types); undefined for a plain map. */
        public tag?: string,
    ) {
        if (entries !== undefined) {
            for (const [key, value] of entries) this.entries.set(keyOf(key), [key, value]);
        }
    }

    get size(): number {
        return this.entries.size;
    }

    get(key: FsValue): FsValue {
        return this.entries.get(keyOf(key))?.[1];
    }

    /** String-keyed read, the common case in std code. */
    field(name: string): FsValue {
        return this.entries.get(`s${name}`)?.[1];
    }

    has(key: FsValue): boolean {
        return this.entries.has(keyOf(key));
    }

    set(key: FsValue, value: FsValue): void {
        this.entries.set(keyOf(key), [key, value]);
        this.sorted = undefined;
    }

    delete(key: FsValue): void {
        if (this.entries.delete(keyOf(key))) this.sorted = undefined;
    }

    /** Entries in key order. */
    pairs(): readonly [FsValue, FsValue][] {
        if (this.sorted === undefined) {
            this.sorted = [...this.entries.values()];
            if (this.sorted.length > 1) this.sorted.sort((a, b) => compareKeys(a[0], b[0]));
        }
        return this.sorted;
    }
}

/** Builds a string-keyed map — the shape every std result and definition takes. */
export function fsMap(record: Record<string, FsValue>, tag?: string): FsMap {
    const map = new FsMap(undefined, tag);
    for (const [key, value] of Object.entries(record)) {
        if (value !== undefined) map.set(key, value);
    }
    return map;
}

export function fsArray(items: FsValue[], tag?: string): FsArray {
    return new FsArray(items, tag);
}

/** The single mutable reference type: `new box(v)`, read with `b[]`. */
export class FsBox {
    constructor(public value: FsValue) {}
}

// ------------------------------------------------------------------ Units

/** Exponents of the base units; every quantity is stored in SI base (meter, radian, kg, s). */
export interface Units {
    readonly meter: number;
    readonly radian: number;
    readonly kilogram: number;
    readonly second: number;
}

export const NO_UNITS: Units = { meter: 0, radian: 0, kilogram: 0, second: 0 };
export const LENGTH: Units = { meter: 1, radian: 0, kilogram: 0, second: 0 };
export const ANGLE: Units = { meter: 0, radian: 1, kilogram: 0, second: 0 };
export const AREA: Units = { meter: 2, radian: 0, kilogram: 0, second: 0 };
export const VOLUME: Units = { meter: 3, radian: 0, kilogram: 0, second: 0 };
export const MASS: Units = { meter: 0, radian: 0, kilogram: 1, second: 0 };
export const TIME: Units = { meter: 0, radian: 0, kilogram: 0, second: 1 };

const UNIT_KEYS = ["meter", "radian", "kilogram", "second"] as const;

export function unitsEqual(a: Units, b: Units): boolean {
    return UNIT_KEYS.every((key) => a[key] === b[key]);
}

export function isUnitless(units: Units): boolean {
    return UNIT_KEYS.every((key) => units[key] === 0);
}

export function combineUnits(a: Units, b: Units, sign: 1 | -1): Units {
    return {
        meter: a.meter + sign * b.meter,
        radian: a.radian + sign * b.radian,
        kilogram: a.kilogram + sign * b.kilogram,
        second: a.second + sign * b.second,
    };
}

export function scaleUnits(units: Units, factor: number): Units {
    return {
        meter: units.meter * factor,
        radian: units.radian * factor,
        kilogram: units.kilogram * factor,
        second: units.second * factor,
    };
}

export function unitsLabel(units: Units): string {
    const parts: string[] = [];
    for (const key of UNIT_KEYS) {
        const exponent = units[key];
        if (exponent === 0) continue;
        parts.push(exponent === 1 ? key : `${key}^${exponent}`);
    }
    return parts.length === 0 ? "unitless" : parts.join(" ");
}

/** A `ValueWithUnits`: magnitude in SI base units plus the unit exponents. Immutable. */
export class FsQuantity {
    constructor(
        readonly value: number,
        readonly units: Units,
    ) {}
}

/** A quantity, collapsing to a plain number when every exponent cancels out. */
export function quantity(value: number, units: Units): FsQuantity | number {
    return isUnitless(units) ? value : new FsQuantity(value, units);
}

// ------------------------------------------------------------------ Enums

export class FsEnumType {
    readonly values = new Map<string, FsEnumValue>();

    constructor(
        /** Unique per declaring module, so two studios' `enum Mode` never compare equal. */
        readonly id: string,
        readonly name: string,
        members: readonly { name: string; display?: string }[],
    ) {
        for (const member of members) {
            this.values.set(
                member.name,
                new FsEnumValue(this, member.name, member.display, this.values.size),
            );
        }
    }

    member(name: string): FsEnumValue | undefined {
        return this.values.get(name);
    }
}

export class FsEnumValue {
    constructor(
        readonly type: FsEnumType,
        readonly name: string,
        /** The `annotation { "Name" : ... }` of the member, for parameter UIs. */
        readonly display?: string,
        /** Declaration order — enum map keys sort by it. */
        readonly ordinal = 0,
    ) {}
}

// ------------------------------------------------------------------ Functions and opaque objects

/** A native std function. `args` are already evaluated; `site` lets it call back into the language. */
export interface NativeFunction {
    readonly kind: "native";
    readonly name: string;
    readonly impl: (args: FsValue[], site: NativeCallContext) => FsValue;
    /** Set on the value `defineFeature` returns: what the feature UI and the body read. */
    readonly feature?: FeatureDefinition;
    /** Set on the value `defineTable` returns: the table function, `(context, definition)`. */
    readonly table?: FeatureDefinition;
}

/**
 * A custom feature (or table): the wrapped function plus the defaults `defineFeature` was
 * given — a table's wrapped function takes `(context, definition)` and has no defaults in std.
 */
export interface FeatureDefinition {
    readonly fn: UserFunction;
    readonly defaults?: FsMap;
}

/** What a native function can ask of the interpreter. */
export interface NativeCallContext {
    readonly pos?: SourcePosition;
    call(fn: FsValue, args: FsValue[]): FsValue;
    print(text: string): void;
    /** True when `value` satisfies the named type (built-in, std or user-declared). */
    isType(value: FsValue, type: string): boolean;
}

/** A closure over FeatureScript code. */
export interface UserFunction {
    readonly kind: "user";
    readonly name: string;
    readonly params: readonly Parameter[];
    readonly returns?: TypeReference;
    readonly precondition?: Block;
    readonly body: Block;
    readonly pos: SourcePosition;
    /** The environment the function closes over (opaque to this module). */
    readonly closure: unknown;
    /** Set for `predicate` declarations: every statement must hold, the call yields a boolean. */
    readonly predicate?: boolean;
}

/** Functions sharing a name, dispatched on the first whose parameter types match. */
export interface OverloadSet {
    readonly kind: "overloads";
    readonly name: string;
    readonly candidates: readonly UserFunction[];
    /** What the name meant before this module overloaded it (std or an import). */
    readonly fallback?: FsCallable;
}

export type FsCallable = NativeFunction | UserFunction | OverloadSet;

export function isCallable(value: FsValue): value is FsCallable {
    return (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        (value.kind === "native" || value.kind === "user" || value.kind === "overloads")
    );
}

export function native(name: string, impl: NativeFunction["impl"]): NativeFunction {
    return { kind: "native", name, impl };
}

/**
 * Host objects the language only passes around — the modeling `Context`, a `Sketch`.
 * `typeName` is what `is` checks and what errors print.
 */
export class FsOpaque {
    constructor(
        readonly typeName: string,
        readonly payload: unknown,
    ) {}
}

// ------------------------------------------------------------------ Copy-on-write helpers

export function isContainer(value: FsValue): value is FsArray | FsMap {
    return value instanceof FsArray || value instanceof FsMap;
}

/** Marks a container shared: the next write through any owner clones it first. */
export function freeze<T extends FsValue>(value: T): T {
    if (value instanceof FsArray || value instanceof FsMap) value.frozen = true;
    return value;
}

/**
 * An unfrozen shallow copy. Its children become reachable from two parents, so they
 * are frozen — a nested write then clones down the path it touches, and only that path.
 */
export function cloneContainer<T extends FsArray | FsMap>(value: T): T {
    if (value instanceof FsArray) {
        value.items.forEach(freeze);
        return new FsArray([...value.items], value.tag) as T;
    }
    const copy = new FsMap(undefined, value.tag);
    for (const [canonical, entry] of value.entries) {
        freeze(entry[1]);
        copy.entries.set(canonical, [entry[0], entry[1]]);
    }
    return copy as T;
}

// ------------------------------------------------------------------ Identity, keys and equality

const identities = new WeakMap<object, number>();
let nextIdentity = 1;

function identityOf(value: object): number {
    let id = identities.get(value);
    if (id === undefined) {
        id = nextIdentity++;
        identities.set(value, id);
    }
    return id;
}

/**
 * Canonical map key. Value types (numbers, strings, quantities, containers) key by
 * content; reference types (boxes, functions, host objects) by identity.
 */
export function keyOf(value: FsValue): string {
    if (value === undefined) return "u";
    if (typeof value === "string") return `s${value}`;
    if (typeof value === "number") return `n${Object.is(value, -0) ? 0 : value}`;
    if (typeof value === "boolean") return value ? "b1" : "b0";
    if (value instanceof FsQuantity) {
        return `q${value.value}|${value.units.meter},${value.units.radian},${value.units.kilogram},${value.units.second}`;
    }
    if (value instanceof FsEnumValue) return `e${value.type.id}.${value.name}`;
    if (value instanceof FsArray) return `a[${value.items.map(keyOf).join(",")}]`;
    if (value instanceof FsMap) {
        return `m{${value
            .pairs()
            .map(([k, v]) => `${keyOf(k)}:${keyOf(v)}`)
            .join(",")}}`;
    }
    return `r${identityOf(value as object)}`;
}

/** Map key order: by kind (undefined, boolean, number, string, array, map, enum, other), then value. */
export function compareKeys(a: FsValue, b: FsValue): number {
    const rankA = keyRank(a);
    const rankB = keyRank(b);
    if (rankA !== rankB) return rankA - rankB;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
    if (a instanceof FsQuantity && b instanceof FsQuantity) return a.value - b.value;
    if (a instanceof FsArray && b instanceof FsArray) {
        for (let i = 0; i < Math.min(a.size, b.size); i++) {
            const order = compareKeys(a.items[i], b.items[i]);
            if (order !== 0) return order;
        }
        return a.size - b.size;
    }
    if (a instanceof FsMap && b instanceof FsMap) {
        const pa = a.pairs();
        const pb = b.pairs();
        for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
            const order = compareKeys(pa[i][0], pb[i][0]) || compareKeys(pa[i][1], pb[i][1]);
            if (order !== 0) return order;
        }
        return pa.length - pb.length;
    }
    if (a instanceof FsEnumValue && b instanceof FsEnumValue) {
        if (a.type !== b.type) return a.type.id < b.type.id ? -1 : 1;
        return a.ordinal - b.ordinal;
    }
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function keyRank(value: FsValue): number {
    if (value === undefined) return 0;
    if (typeof value === "boolean") return 1;
    if (typeof value === "number") return 2;
    if (value instanceof FsQuantity) return 3;
    if (typeof value === "string") return 4;
    if (value instanceof FsArray) return 5;
    if (value instanceof FsMap) return 6;
    if (value instanceof FsEnumValue) return 7;
    return 8;
}

/** `==`: structural for value types (tags ignored, as the language does), identity otherwise. */
export function valuesEqual(a: FsValue, b: FsValue): boolean {
    if (a === b) return true;
    if (typeof a === "number" && typeof b === "number") return a === b;
    if (a instanceof FsQuantity && b instanceof FsQuantity) {
        return a.value === b.value && unitsEqual(a.units, b.units);
    }
    if (a instanceof FsEnumValue && b instanceof FsEnumValue) return a.type === b.type && a.name === b.name;
    // An enum value is its name with a type tag, and `==` ignores tags.
    if (a instanceof FsEnumValue && typeof b === "string") return a.name === b;
    if (b instanceof FsEnumValue && typeof a === "string") return b.name === a;
    if (a instanceof FsArray && b instanceof FsArray) {
        return a.items.length === b.items.length && a.items.every((item, i) => valuesEqual(item, b.items[i]));
    }
    if (a instanceof FsMap && b instanceof FsMap) {
        if (a.entries.size !== b.entries.size) return false;
        for (const [canonical, [, value]] of a.entries) {
            const other = b.entries.get(canonical);
            if (other === undefined || !valuesEqual(value, other[1])) return false;
        }
        return true;
    }
    return false;
}

// ------------------------------------------------------------------ Type names and printing

/** The built-in type a value belongs to, as `is` and error messages name it. */
export function typeName(value: FsValue): string {
    if (value === undefined) return "undefined";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    if (typeof value === "string") return "string";
    if (value instanceof FsArray) return value.tag ?? "array";
    if (value instanceof FsMap) return value.tag ?? "map";
    if (value instanceof FsBox) return "box";
    if (value instanceof FsQuantity) return "ValueWithUnits";
    if (value instanceof FsEnumValue) return value.type.name;
    if (value instanceof FsEnumType) return "enum";
    if (value instanceof FsOpaque) return value.typeName;
    return "function";
}

const UNIT_SYMBOLS: Record<string, string> = {
    meter: "meter",
    radian: "radian",
    kilogram: "kilogram",
    second: "second",
};

export function formatNumber(value: number): string {
    if (Number.isInteger(value)) return String(value);
    if (Math.abs(value) >= 1e-4 && Math.abs(value) < 1e15) {
        return String(Number.parseFloat(value.toPrecision(15)));
    }
    return String(value);
}

/** `toString` / `println` rendering. */
export function toDisplayString(value: FsValue, depth = 0): string {
    if (depth > 20) return "...";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return depth === 0 ? value : JSON.stringify(value);
    if (typeof value === "number") return formatNumber(value);
    if (typeof value === "boolean") return String(value);
    if (value instanceof FsQuantity) {
        const units = UNIT_KEYS_ORDERED.filter((key) => value.units[key] !== 0)
            .map((key) =>
                value.units[key] === 1 ? UNIT_SYMBOLS[key] : `${UNIT_SYMBOLS[key]}^${value.units[key]}`,
            )
            .join(" ");
        return `${formatNumber(value.value)} ${units}`;
    }
    if (value instanceof FsEnumValue) return value.name;
    if (value instanceof FsArray) {
        return `[ ${value.items.map((item) => toDisplayString(item, depth + 1)).join(", ")} ]`;
    }
    if (value instanceof FsMap) {
        const entries = [...value.pairs()].map(
            ([key, item]) =>
                `${typeof key === "string" ? key : toDisplayString(key, depth + 1)} : ${toDisplayString(item, depth + 1)}`,
        );
        return `{ ${entries.join(", ")} }`;
    }
    if (value instanceof FsBox) return `box(${toDisplayString(value.value, depth + 1)})`;
    if (value instanceof FsEnumType) return `enum ${value.name}`;
    if (value instanceof FsOpaque) return `<${value.typeName}>`;
    return `function ${(value as FsCallable).name}`;
}

const UNIT_KEYS_ORDERED = UNIT_KEYS;

// ------------------------------------------------------------------ Coercion helpers for native code

export function fail(message: string, pos?: SourcePosition): never {
    throw new FsRuntimeError(message, pos);
}

export function expectNumber(value: FsValue, what: string): number {
    if (typeof value !== "number") fail(`${what} must be a number, got ${typeName(value)}`);
    return value;
}

export function expectString(value: FsValue, what: string): string {
    if (typeof value !== "string") fail(`${what} must be a string, got ${typeName(value)}`);
    return value;
}

export function expectBoolean(value: FsValue, what: string): boolean {
    if (typeof value !== "boolean") fail(`${what} must be a boolean, got ${typeName(value)}`);
    return value;
}

export function expectArray(value: FsValue, what: string): FsArray {
    if (!(value instanceof FsArray)) fail(`${what} must be an array, got ${typeName(value)}`);
    return value;
}

export function expectMap(value: FsValue, what: string): FsMap {
    if (!(value instanceof FsMap)) fail(`${what} must be a map, got ${typeName(value)}`);
    return value;
}

/** A quantity of the given units (a unitless one accepts a plain number; zero is zero in any unit). */
export function expectQuantity(value: FsValue, units: Units, what: string): number {
    if (typeof value === "number" && (value === 0 || isUnitless(units))) return value;
    if (value instanceof FsQuantity && unitsEqual(value.units, units)) return value.value;
    fail(`${what} must be a ${unitsLabel(units)} value, got ${describeValue(value)}`);
}

export function describeValue(value: FsValue): string {
    if (value instanceof FsQuantity) return unitsLabel(value.units);
    return typeName(value);
}
