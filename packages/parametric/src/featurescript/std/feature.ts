// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsContext } from "../context/fsContext";
import {
    ANGLE,
    expectArray,
    expectMap,
    expectString,
    FsArray,
    FsMap,
    FsQuantity,
    type FsValue,
    fail,
    isCallable,
    LENGTH,
    toDisplayString,
    type UserFunction,
} from "../lang/values";
import { mergeMaps } from "./core";
import { arg, type StdBuilder } from "./registry";

/** Joins an Id's components; `qCreatedBy` matches this string or any `/`-extension of it. */
export function idString(value: FsValue): string {
    const id = expectArray(value, "Id");
    return id.items.map((part) => expectString(part, "Id component")).join("/");
}

export function makeId(parts: readonly string[]): FsArray {
    return new FsArray([...parts], "Id");
}

/** True when an entity created by `createdBy` belongs to the operation `id` (or one nested in it). */
export function createdByMatches(createdBy: string, id: string): boolean {
    return id === "" || createdBy === id || createdBy.startsWith(`${id}/`);
}

export function installFeatureSupport(std: StdBuilder): void {
    std.tagType("Id");
    std.tagType("Context");
    std.tagType("Sketch");
    std.tagType("LengthBoundSpec");
    std.tagType("AngleBoundSpec");
    std.tagType("IntegerBoundSpec");
    std.tagType("RealBoundSpec");

    std.fn("newId", () => makeId([]));
    std.fn("makeId", (args) => makeId([expectString(arg(args, 0, "makeId"), "makeId argument")]));
    std.fn("isTopLevelId", (args) => expectArray(arg(args, 0, "isTopLevelId"), "Id").size === 1);
    std.fn("isIdForSketch", () => false);

    std.fn("defineFeature", (args) => {
        const fn = arg(args, 0, "defineFeature");
        if (!isCallable(fn) || fn.kind !== "user")
            fail("defineFeature needs a function(context, id, definition)");
        if (fn.params.length !== 3) fail("A feature function takes exactly (context, id, definition)");
        const defaults = args[1] === undefined ? undefined : expectMap(args[1], "defineFeature defaults");
        return {
            kind: "native",
            name: fn.name,
            feature: { fn: fn as UserFunction, defaults },
            impl: (callArgs, site) => {
                if (callArgs.length !== 3) fail("A feature is called as feature(context, id, definition)");
                const definition = expectMap(callArgs[2], "feature definition");
                const merged = defaults === undefined ? definition : mergeMaps(defaults, definition);
                return site.call(fn, [callArgs[0], callArgs[1], merged]);
            },
        };
    });

    // Feature bracketing exists in Onshape for undo-on-failure; the body rebuild already
    // discards a failed run wholesale, so these are no-ops kept for ported code.
    std.fn("startFeature", () => undefined);
    std.fn("endFeature", () => undefined);
    std.fn("abortFeature", () => undefined);
    std.fn("setFeatureComputedParameter", () => undefined);

    std.fn("reportFeatureWarning", (args) => {
        FsContext.of(arg(args, 0, "reportFeatureWarning")).notes.warnings.push(toDisplayString(args[2]));
        return true;
    });
    std.fn("reportFeatureInfo", (args) => {
        FsContext.of(arg(args, 0, "reportFeatureInfo")).notes.infos.push(toDisplayString(args[2]));
        return true;
    });
    std.fn("getVariable", (args) => {
        const context = FsContext.of(arg(args, 0, "getVariable"));
        const name = expectString(arg(args, 1, "getVariable"), "variable name");
        if (!context.variables.has(name)) {
            if (args.length >= 3) return args[2];
            fail(`Variable "${name}" is not defined`);
        }
        return context.variables.get(name);
    });
    std.fn("setVariable", (args) => {
        const context = FsContext.of(arg(args, 0, "setVariable"));
        context.variables.set(
            expectString(arg(args, 1, "setVariable"), "variable name"),
            arg(args, 2, "setVariable"),
        );
        return undefined;
    });

    installBounds(std);
}

// ------------------------------------------------------------------ Bound specs

const LENGTH_UNITS_M = {
    meter: 1,
    centimeter: 0.01,
    millimeter: 0.001,
    inch: 0.0254,
    foot: 0.3048,
    yard: 0.9144,
} as const;

/** A LengthBoundSpec: `[min, default, max]` in meters plus per-unit defaults. */
function lengthBounds(min: number, defaultMm: number, max: number): FsMap {
    const map = new FsMap(undefined, "LengthBoundSpec");
    map.set(new FsQuantity(LENGTH_UNITS_M.meter, LENGTH), new FsArray([min, defaultMm / 1000, max]));
    map.set(new FsQuantity(LENGTH_UNITS_M.millimeter, LENGTH), defaultMm);
    map.set(new FsQuantity(LENGTH_UNITS_M.centimeter, LENGTH), defaultMm / 10);
    map.set(new FsQuantity(LENGTH_UNITS_M.inch, LENGTH), roundTo(defaultMm / 25.4, 3));
    map.set(new FsQuantity(LENGTH_UNITS_M.foot, LENGTH), roundTo(defaultMm / 304.8, 4));
    map.set(new FsQuantity(LENGTH_UNITS_M.yard, LENGTH), roundTo(defaultMm / 914.4, 4));
    return map;
}

function angleBounds(minDeg: number, defaultDeg: number, maxDeg: number): FsMap {
    const map = new FsMap(undefined, "AngleBoundSpec");
    map.set(new FsQuantity(Math.PI / 180, ANGLE), new FsArray([minDeg, defaultDeg, maxDeg]));
    map.set(new FsQuantity(1, ANGLE), roundTo((defaultDeg * Math.PI) / 180, 6));
    return map;
}

function roundTo(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function installBounds(std: StdBuilder): void {
    std.value("LENGTH_BOUNDS", lengthBounds(-500, 25, 500));
    std.value("NONNEGATIVE_LENGTH_BOUNDS", lengthBounds(0, 25, 500));
    std.value("NONNEGATIVE_ZERO_DEFAULT_LENGTH_BOUNDS", lengthBounds(0, 0, 500));
    std.value("ZERO_DEFAULT_LENGTH_BOUNDS", lengthBounds(-500, 0, 500));
    std.value("NONNEGATIVE_ZERO_INCLUSIVE_LENGTH_BOUNDS", lengthBounds(0, 0, 500));
    std.value("BLEND_BOUNDS", lengthBounds(0, 5, 500));
    std.value("SHELL_OFFSET_BOUNDS", lengthBounds(0, 2, 500));
    std.value("SM_THICKNESS_BOUNDS", lengthBounds(0, 1, 50));
    std.value("SM_BEND_RADIUS_BOUNDS", lengthBounds(0, 1, 500));
    std.value("ANGLE_360_BOUNDS", angleBounds(0, 30, 360));
    std.value("ANGLE_360_ZERO_DEFAULT_BOUNDS", angleBounds(0, 0, 360));
    std.value("ANGLE_360_FULL_DEFAULT_BOUNDS", angleBounds(0, 360, 360));
    std.value("ANGLE_360_90_DEFAULT_BOUNDS", angleBounds(0, 90, 360));
    std.value("ANGLE_180_MINUS_180_BOUNDS", angleBounds(-180, 0, 180));
    std.value("ANGLE_STRICT_90_BOUNDS", angleBounds(0, 45, 90));
    std.value("POSITIVE_COUNT_BOUNDS", new FsArray([1, 2, 1e5], "IntegerBoundSpec"));
    std.value("PRIMITIVE_COUNT_BOUNDS", new FsArray([1, 4, 1e5], "IntegerBoundSpec"));
    std.value("POSITIVE_REAL_BOUNDS", new FsArray([0, 1, 1e9], "RealBoundSpec"));
    std.value("SCALE_BOUNDS", new FsArray([0, 1, 1e5], "RealBoundSpec"));
    std.value("CLAMP_MAGIC_NUMBER_BOUNDS", new FsArray([0, 0.5, 1], "RealBoundSpec"));
}
