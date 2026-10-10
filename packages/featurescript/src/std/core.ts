// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE,
    describeValue,
    expectArray,
    expectMap,
    expectNumber,
    expectString,
    FsArray,
    FsMap,
    FsQuantity,
    type FsValue,
    fail,
    freeze,
    fsMap,
    isUnitless,
    keyOf,
    LENGTH,
    MASS,
    NO_UNITS,
    quantity,
    scaleUnits,
    TIME,
    toDisplayString,
    type Units,
    unitsEqual,
    unitsLabel,
    valuesEqual,
} from "../lang/values";
import { arg, expectArgCount, type StdBuilder } from "./registry";

/** Onshape's TOLERANCE.zeroLength / zeroAngle, in SI base units. */
export const ZERO_LENGTH = 1e-8;
export const ZERO_ANGLE = 1e-11;

interface Scalar {
    value: number;
    units: Units;
}

export function scalarOf(value: FsValue, what: string): Scalar {
    if (typeof value === "number") return { value, units: NO_UNITS };
    if (value instanceof FsQuantity) return { value: value.value, units: value.units };
    fail(`${what} must be a number or a value with units, got ${describeValue(value)}`);
}

/** An angle in radians: a radian quantity, or a bare number read as radians. */
export function angleOf(value: FsValue, what: string): number {
    const scalar = scalarOf(value, what);
    if (!isUnitless(scalar.units) && !unitsEqual(scalar.units, ANGLE)) {
        fail(`${what} must be an angle, got ${unitsLabel(scalar.units)}`);
    }
    return scalar.value;
}

function sameUnits(values: FsValue[], what: string): { values: number[]; units: Units } {
    let units: Units | undefined;
    const numbers = values.map((value) => {
        const scalar = scalarOf(value, what);
        if (units === undefined) units = scalar.units;
        else if (!unitsEqual(units, scalar.units)) {
            fail(`${what}: cannot mix ${unitsLabel(units)} with ${unitsLabel(scalar.units)}`);
        }
        return scalar.value;
    });
    return { values: numbers, units: units ?? NO_UNITS };
}

/** Elements of a variadic-or-array argument list (`min(a, b)` and `min([a, b])`). */
function spread(args: FsValue[]): FsValue[] {
    if (args.length === 1 && args[0] instanceof FsArray) return args[0].items;
    return args;
}

export function installCore(std: StdBuilder): void {
    installUnits(std);
    installMath(std);
    installArrays(std);
    installMaps(std);
    installStrings(std);
    installDebug(std);
}

// ------------------------------------------------------------------ Units

function installUnits(std: StdBuilder): void {
    const length = (factor: number) => new FsQuantity(factor, LENGTH);
    std.value("meter", length(1));
    std.value("centimeter", length(0.01));
    std.value("millimeter", length(0.001));
    std.value("micrometer", length(1e-6));
    std.value("inch", length(0.0254));
    std.value("foot", length(0.3048));
    std.value("yard", length(0.9144));
    // Short aliases, convenient in hand-written code; Onshape-ported code uses the long names.
    std.value("mm", length(0.001));
    std.value("cm", length(0.01));
    std.value("radian", new FsQuantity(1, ANGLE));
    std.value("degree", new FsQuantity(Math.PI / 180, ANGLE));
    std.value("kilogram", new FsQuantity(1, MASS));
    std.value("gram", new FsQuantity(0.001, MASS));
    std.value("pound", new FsQuantity(0.45359237, MASS));
    std.value("ounce", new FsQuantity(0.028349523125, MASS));
    std.value("second", new FsQuantity(1, TIME));
    std.value("minute", new FsQuantity(60, TIME));
    std.value("hour", new FsQuantity(3600, TIME));
    std.value("unitless", 1);
    std.value("PI", Math.PI);
    std.value("TOLERANCE", fsMap({ zeroLength: ZERO_LENGTH, zeroAngle: ZERO_ANGLE, booleanDefault: 1e-7 }));

    std.fn("isLength", (args) => {
        const value = arg(args, 0, "isLength");
        return value instanceof FsQuantity && unitsEqual(value.units, LENGTH) && withinBounds(value, args[1]);
    });
    std.fn("isAngle", (args) => {
        const value = arg(args, 0, "isAngle");
        return value instanceof FsQuantity && unitsEqual(value.units, ANGLE) && withinBounds(value, args[1]);
    });
    std.fn("isInteger", (args) => {
        const value = arg(args, 0, "isInteger");
        return typeof value === "number" && Number.isInteger(value) && withinBounds(value, args[1]);
    });
    std.fn("isReal", (args) => {
        const value = arg(args, 0, "isReal");
        return typeof value === "number" && Number.isFinite(value) && withinBounds(value, args[1]);
    });
    std.fn("isAnything", () => true);
    std.fn("isQuantity", (args) => arg(args, 0, "isQuantity") instanceof FsQuantity);
    std.fn("isUnitless", (args) => typeof arg(args, 0, "isUnitless") === "number");
    std.fn("tolerantEquals", (args) => {
        expectArgCount(args, 2, 3, "tolerantEquals");
        return tolerantEquals(args[0], args[1]);
    });
}

/** True when `value` lies within a bound spec's [min, max] (no spec: always). */
export function withinBounds(value: FsValue, spec: FsValue): boolean {
    if (spec === undefined) return true;
    const range = boundRange(spec);
    if (range === undefined) return true;
    const scalar = scalarOf(value, "value");
    const tolerance = 1e-9 * Math.max(1, Math.abs(range.max), Math.abs(range.min));
    return scalar.value >= range.min - tolerance && scalar.value <= range.max + tolerance;
}

/**
 * The [min, max] (in SI base units) of a bound spec — a map from unit to
 * `[min, default, max]` or a default, as `LENGTH_BOUNDS` and friends are written; or a
 * bare `[min, default, max]` array for unitless specs.
 */
export function boundRange(spec: FsValue): { min: number; max: number } | undefined {
    if (spec instanceof FsArray) return arrayRange(spec, 1);
    if (!(spec instanceof FsMap)) return undefined;
    for (const [key, value] of spec.pairs()) {
        if (!(value instanceof FsArray)) continue;
        const factor = key instanceof FsQuantity ? key.value : typeof key === "number" ? key : 1;
        return arrayRange(value, factor);
    }
    return undefined;
}

function arrayRange(range: FsArray, factor: number): { min: number; max: number } | undefined {
    const min = range.items[0];
    const max = range.items[range.items.length - 1];
    if (typeof min !== "number" || typeof max !== "number") return undefined;
    return { min: min * factor, max: max * factor };
}

export function tolerantEquals(a: FsValue, b: FsValue): boolean {
    if (a instanceof FsArray && b instanceof FsArray) {
        return a.size === b.size && a.items.every((item, i) => tolerantEquals(item, b.items[i]));
    }
    const x = scalarOf(a, "tolerantEquals");
    const y = scalarOf(b, "tolerantEquals");
    if (!unitsEqual(x.units, y.units)) return false;
    const tolerance = unitsEqual(x.units, ANGLE) ? ZERO_ANGLE : ZERO_LENGTH;
    return Math.abs(x.value - y.value) <= tolerance;
}

// ------------------------------------------------------------------ Math

function installMath(std: StdBuilder): void {
    const unary = (name: string, fn: (x: number) => number) =>
        std.fn(name, (args) => {
            expectArgCount(args, 1, 1, name);
            return fn(expectNumber(args[0], `${name} argument`));
        });
    unary("exp", Math.exp);
    unary("log", Math.log);
    unary("log10", Math.log10);
    unary("log1p", Math.log1p);
    unary("sinh", Math.sinh);
    unary("cosh", Math.cosh);
    unary("tanh", Math.tanh);
    unary("asinh", Math.asinh);
    unary("acosh", Math.acosh);
    unary("atanh", Math.atanh);

    std.fn("abs", (args) => {
        const scalar = scalarOf(arg(args, 0, "abs"), "abs argument");
        return quantity(Math.abs(scalar.value), scalar.units);
    });
    std.fn("sqrt", (args) => {
        const scalar = scalarOf(arg(args, 0, "sqrt"), "sqrt argument");
        if (scalar.value < 0) fail("sqrt of a negative value");
        return quantity(Math.sqrt(scalar.value), scaleUnits(scalar.units, 0.5));
    });
    std.fn("sin", (args) => Math.sin(angleOf(arg(args, 0, "sin"), "sin argument")));
    std.fn("cos", (args) => Math.cos(angleOf(arg(args, 0, "cos"), "cos argument")));
    std.fn("tan", (args) => Math.tan(angleOf(arg(args, 0, "tan"), "tan argument")));
    const inverse = (name: string, fn: (x: number) => number) =>
        std.fn(
            name,
            (args) => new FsQuantity(fn(expectNumber(arg(args, 0, name), `${name} argument`)), ANGLE),
        );
    inverse("asin", (x) => Math.asin(Math.max(-1, Math.min(1, x))));
    inverse("acos", (x) => Math.acos(Math.max(-1, Math.min(1, x))));
    inverse("atan", Math.atan);
    std.fn("atan2", (args) => {
        expectArgCount(args, 2, 2, "atan2");
        const { values } = sameUnits(args, "atan2");
        return new FsQuantity(Math.atan2(values[0], values[1]), ANGLE);
    });
    const rounding = (name: string, fn: (x: number) => number) =>
        std.fn(name, (args) => {
            expectArgCount(args, 1, 2, name);
            const scalar = scalarOf(args[0], `${name} argument`);
            if (args.length === 1) return quantity(fn(scalar.value), scalar.units);
            // `round(value, multiple)` rounds to a multiple in the value's own units.
            const step = scalarOf(args[1], `${name} multiple`);
            if (!unitsEqual(step.units, scalar.units))
                fail(`${name}: the multiple must have the value's units`);
            if (step.value === 0) fail(`${name}: the multiple must be non-zero`);
            return quantity(fn(scalar.value / step.value) * step.value, scalar.units);
        });
    rounding("floor", Math.floor);
    rounding("ceil", Math.ceil);
    rounding("round", Math.round);
    std.fn("roundToPrecision", (args) => {
        const value = expectNumber(arg(args, 0, "roundToPrecision"), "value");
        const digits = expectNumber(arg(args, 1, "roundToPrecision"), "precision");
        const factor = 10 ** digits;
        return Math.round(value * factor) / factor;
    });
    std.fn("min", (args) => extreme(spread(args), "min", -1));
    std.fn("max", (args) => extreme(spread(args), "max", 1));
    std.fn("clamp", (args) => {
        expectArgCount(args, 3, 3, "clamp");
        const { values, units } = sameUnits(args, "clamp");
        return quantity(Math.min(Math.max(values[0], values[1]), values[2]), units);
    });
    std.fn("sum", (args) => {
        const items = spread(args);
        if (items.length === 0) return 0;
        const { values, units } = sameUnits(items, "sum");
        return quantity(
            values.reduce((a, b) => a + b, 0),
            units,
        );
    });
}

function extreme(items: FsValue[], name: string, sign: 1 | -1): FsValue {
    if (items.length === 0) fail(`${name} needs at least one value`);
    const { values } = sameUnits(items, name);
    let best = 0;
    values.forEach((value, i) => {
        if (sign * (value - values[best]) > 0) best = i;
    });
    return items[best];
}

// ------------------------------------------------------------------ Arrays

function installArrays(std: StdBuilder): void {
    std.fn("size", (args) => {
        const value = arg(args, 0, "size");
        if (value instanceof FsArray || value instanceof FsMap) return value.size;
        if (typeof value === "string") return value.length;
        fail(`size needs an array or a map, got ${describeValue(value)}`);
    });
    std.fn("isArray", (args) => arg(args, 0, "isArray") instanceof FsArray);
    std.fn("append", (args) => {
        const array = expectArray(arg(args, 0, "append"), "append array");
        return new FsArray([...array.items, arg(args, 1, "append")], array.tag);
    });
    std.fn("concatenate", (args) => {
        const items = args.length === 1 ? expectArray(args[0], "concatenate arrays").items : args;
        const result: FsValue[] = [];
        for (const item of items) result.push(...expectArray(item, "concatenate argument").items);
        return new FsArray(result);
    });
    std.fn("makeArray", (args) => {
        const size = expectNumber(arg(args, 0, "makeArray"), "makeArray size");
        if (!Number.isInteger(size) || size < 0) fail("makeArray size must be a non-negative integer");
        const fill = freeze(args[1]);
        return new FsArray(Array.from({ length: size }, () => fill));
    });
    std.fn("range", (args) => {
        expectArgCount(args, 2, 3, "range");
        const from = scalarOf(args[0], "range start");
        const to = scalarOf(args[1], "range end");
        if (!unitsEqual(from.units, to.units)) fail("range: start and end must have the same units");
        if (args.length === 3) {
            const count = expectNumber(args[2], "range count");
            if (!Number.isInteger(count) || count < 1) fail("range count must be a positive integer");
            if (count === 1) return new FsArray([quantity(from.value, from.units)]);
            const step = (to.value - from.value) / (count - 1);
            return new FsArray(
                Array.from({ length: count }, (_, i) => quantity(from.value + step * i, from.units)),
            );
        }
        const items: FsValue[] = [];
        const direction = to.value >= from.value ? 1 : -1;
        if (Math.abs(to.value - from.value) > 1e7) fail("range is too large");
        for (let value = from.value; direction * (to.value - value) >= -1e-12; value += direction) {
            items.push(quantity(value, from.units));
        }
        return new FsArray(items);
    });
    std.fn("mapArray", (args, site) => {
        const array = expectArray(arg(args, 0, "mapArray"), "mapArray array");
        const fn = arg(args, 1, "mapArray");
        return new FsArray(array.items.map((item) => freeze(site.call(fn, [item]))));
    });
    std.fn("filter", (args, site) => {
        const array = expectArray(arg(args, 0, "filter"), "filter array");
        const fn = arg(args, 1, "filter");
        return new FsArray(
            array.items.filter((item) => {
                const keep = site.call(fn, [item]);
                if (typeof keep !== "boolean") fail("The filter function must return a boolean");
                return keep;
            }),
            array.tag,
        );
    });
    std.fn("foldArray", (args, site) => {
        const array = expectArray(arg(args, 0, "foldArray"), "foldArray array");
        let accumulator = arg(args, 1, "foldArray");
        const fn = arg(args, 2, "foldArray");
        for (const item of array.items) accumulator = freeze(site.call(fn, [accumulator, item]));
        return accumulator;
    });
    std.fn("reverse", (args) => {
        const array = expectArray(arg(args, 0, "reverse"), "reverse array");
        return new FsArray([...array.items].reverse(), array.tag);
    });
    std.fn("sort", (args, site) => {
        const array = expectArray(arg(args, 0, "sort"), "sort array");
        const compare = args[1];
        const items = [...array.items];
        if (compare === undefined) {
            items.sort((a, b) => defaultOrder(a, b));
        } else {
            items.sort((a, b) => {
                const result = site.call(compare, [a, b]);
                if (typeof result === "boolean") return result ? -1 : 1;
                const scalar = scalarOf(result, "sort comparison");
                return scalar.value;
            });
        }
        return new FsArray(items, array.tag);
    });
    std.fn("subArray", (args) => {
        const array = expectArray(arg(args, 0, "subArray"), "subArray array");
        const start = expectNumber(arg(args, 1, "subArray"), "subArray start");
        const end = args[2] === undefined ? array.size : expectNumber(args[2], "subArray end");
        if (start < 0 || end > array.size || start > end)
            fail(`subArray range [${start}, ${end}) is out of bounds`);
        return new FsArray(array.items.slice(start, end), array.tag);
    });
    std.fn("last", (args) => {
        const array = expectArray(arg(args, 0, "last"), "last array");
        if (array.size === 0) fail("last of an empty array");
        return array.items[array.size - 1];
    });
    std.fn("indexOf", (args) => {
        const array = expectArray(arg(args, 0, "indexOf"), "indexOf array");
        const value = arg(args, 1, "indexOf");
        return array.items.findIndex((item) => valuesEqual(item, value));
    });
    std.fn("isIn", (args) => {
        const value = arg(args, 0, "isIn");
        const container = arg(args, 1, "isIn");
        if (container instanceof FsArray) return container.items.some((item) => valuesEqual(item, value));
        if (container instanceof FsMap) return container.has(value);
        fail(`isIn needs an array or a map, got ${describeValue(container)}`);
    });
    std.fn("removeElementAt", (args) => {
        const array = expectArray(arg(args, 0, "removeElementAt"), "array");
        const index = expectNumber(arg(args, 1, "removeElementAt"), "index");
        if (index < 0 || index >= array.size) fail(`removeElementAt index ${index} is out of bounds`);
        return new FsArray(
            array.items.filter((_, i) => i !== index),
            array.tag,
        );
    });
    std.fn("insertElementAt", (args) => {
        const array = expectArray(arg(args, 0, "insertElementAt"), "array");
        const index = expectNumber(arg(args, 1, "insertElementAt"), "index");
        if (index < 0 || index > array.size) fail(`insertElementAt index ${index} is out of bounds`);
        const items = [...array.items];
        items.splice(index, 0, arg(args, 2, "insertElementAt"));
        return new FsArray(items, array.tag);
    });
    std.fn("resize", (args) => {
        const array = expectArray(arg(args, 0, "resize"), "array");
        const size = expectNumber(arg(args, 1, "resize"), "size");
        if (!Number.isInteger(size) || size < 0) fail("resize size must be a non-negative integer");
        const items = array.items.slice(0, size);
        while (items.length < size) items.push(freeze(args[2]));
        return new FsArray(items, array.tag);
    });
    std.fn("deduplicate", (args) => {
        const array = expectArray(arg(args, 0, "deduplicate"), "array");
        const seen = new Set<string>();
        return new FsArray(
            array.items.filter((item) => {
                const key = keyOf(item);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }),
            array.tag,
        );
    });
    std.fn("rotateArray", (args) => {
        const array = expectArray(arg(args, 0, "rotateArray"), "array");
        const steps = expectNumber(arg(args, 1, "rotateArray"), "steps");
        const n = array.size;
        if (n === 0) return array;
        const shift = ((steps % n) + n) % n;
        return new FsArray([...array.items.slice(shift), ...array.items.slice(0, shift)], array.tag);
    });
}

/** Ordering for `sort` without a comparator: numbers/quantities, then strings. */
function defaultOrder(a: FsValue, b: FsValue): number {
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
    return scalarOf(a, "sort element").value - scalarOf(b, "sort element").value;
}

// ------------------------------------------------------------------ Maps

function installMaps(std: StdBuilder): void {
    std.fn(
        "keys",
        (args) => new FsArray([...expectMap(arg(args, 0, "keys"), "keys map").pairs()].map(([key]) => key)),
    );
    std.fn(
        "values",
        (args) =>
            new FsArray(
                [...expectMap(arg(args, 0, "values"), "values map").pairs()].map(([, value]) => value),
            ),
    );
    std.fn("mergeMaps", (args) => {
        expectArgCount(args, 2, 2, "mergeMaps");
        return mergeMaps(expectMap(args[0], "mergeMaps defaults"), expectMap(args[1], "mergeMaps overrides"));
    });
    std.fn("isMap", (args) => arg(args, 0, "isMap") instanceof FsMap);
}

/** Recursive merge: nested maps merge, everything else in `overrides` wins. */
export function mergeMaps(defaults: FsMap, overrides: FsMap): FsMap {
    const result = new FsMap(defaults.pairs(), defaults.tag);
    for (const [key, value] of overrides.pairs()) {
        const base = result.get(key);
        result.set(key, base instanceof FsMap && value instanceof FsMap ? mergeMaps(base, value) : value);
    }
    if (overrides.tag !== undefined) result.tag = overrides.tag;
    return result;
}

// ------------------------------------------------------------------ Strings

function installStrings(std: StdBuilder): void {
    std.fn("toString", (args) => toDisplayString(arg(args, 0, "toString")));
    std.fn("length", (args) => expectString(arg(args, 0, "length"), "length argument").length);
    std.fn(
        "splitIntoCharacters",
        (args) => new FsArray([...expectString(arg(args, 0, "splitIntoCharacters"), "string")]),
    );
    std.fn("stringToNumber", (args) => {
        const text = expectString(arg(args, 0, "stringToNumber"), "string");
        const value = Number(text.trim());
        if (text.trim() === "" || !Number.isFinite(value)) fail(`"${text}" is not a number`);
        return value;
    });
    std.fn("toUpperCase", (args) => expectString(arg(args, 0, "toUpperCase"), "string").toUpperCase());
    std.fn("toLowerCase", (args) => expectString(arg(args, 0, "toLowerCase"), "string").toLowerCase());
    std.fn("startsWith", (args) =>
        expectString(arg(args, 0, "startsWith"), "string").startsWith(
            expectString(arg(args, 1, "startsWith"), "prefix"),
        ),
    );
    std.fn("endsWith", (args) =>
        expectString(arg(args, 0, "endsWith"), "string").endsWith(
            expectString(arg(args, 1, "endsWith"), "suffix"),
        ),
    );
    std.fn(
        "split",
        (args) =>
            new FsArray(
                expectString(arg(args, 0, "split"), "string").split(
                    expectString(arg(args, 1, "split"), "separator"),
                ),
            ),
    );
    std.fn("join", (args) => {
        const items = expectArray(arg(args, 0, "join"), "join array").items.map((item) =>
            toDisplayString(item),
        );
        return items.join(args[1] === undefined ? "" : expectString(args[1], "separator"));
    });
    std.fn("match", (args) => {
        const text = expectString(arg(args, 0, "match"), "string");
        const pattern = compileRegex(expectString(arg(args, 1, "match"), "regex"));
        const found = new RegExp(`^(?:${pattern.source})$`).exec(text);
        return fsMap({
            hasMatch: found !== null,
            captures: new FsArray(found === null ? [] : [...found].map((capture) => capture ?? "")),
        });
    });
    std.fn("replace", (args) => {
        const text = expectString(arg(args, 0, "replace"), "string");
        const pattern = compileRegex(expectString(arg(args, 1, "replace"), "regex"));
        const replacement = expectString(arg(args, 2, "replace"), "replacement");
        return text.replace(new RegExp(pattern.source, "g"), replacement);
    });
}

function compileRegex(pattern: string): RegExp {
    try {
        return new RegExp(pattern);
    } catch (error) {
        fail(`Invalid regular expression: ${(error as Error).message}`);
    }
}

// ------------------------------------------------------------------ Debugging and errors

function installDebug(std: StdBuilder): void {
    std.fn("print", (args, site) => {
        site.print(args.map((value) => toDisplayString(value)).join(""));
        return undefined;
    });
    std.fn("println", (args, site) => {
        site.print(args.map((value) => toDisplayString(value)).join(""));
        return undefined;
    });
    std.fn("debug", (args, site) => {
        // `debug(context, value)` highlights entities in Onshape; here it prints.
        const value = args.length >= 2 ? args[1] : args[0];
        site.print(`debug: ${toDisplayString(value)}`);
        return undefined;
    });
    std.fn("regenError", (args) => {
        const message = arg(args, 0, "regenError");
        return fsMap(
            {
                message: typeof message === "string" ? message : toDisplayString(message),
                faultyParameters: args[1] instanceof FsArray ? args[1] : undefined,
            },
            "RegenError",
        );
    });
    std.tagType("RegenError");
    std.fn("isUndefinedOrEmptyString", (args) => {
        const value = args[0];
        return value === undefined || value === "";
    });
}
