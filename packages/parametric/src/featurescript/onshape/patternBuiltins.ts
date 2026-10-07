// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsArray, FsMap, type FsValue, fail, fsArray, fsMap } from "../lang/values";
import type { StdBridge } from "./bridge";
import { magnitude } from "./pureBuiltins";
import type { BuiltinRegistry } from "./registry";

/**
 * The pattern transform built-ins: the instance transforms a linear or circular pattern
 * places copies with, as std's pre-builtin code computed them (that code still ships in
 * `linearPattern.fs` / `circularPattern.fs` for held-back features). Instance skipping is
 * not modelled.
 */
export function installPatternBuiltins(define: BuiltinRegistry, bridge: StdBridge): void {
    const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const result = (transforms: FsValue[], names: string[]) =>
        fsMap({
            transforms: fsArray(transforms),
            instanceNames: fsArray(names),
            manipulatorPoints: fsArray([]),
        });

    define("computeLinearPatternTransforms", (args) => {
        const definition = mapArg(args[1]);
        const offset1 = meters(definition.field("offset1"));
        const offset2 = meters(definition.field("offset2"));
        const count1 = countOf(definition.field("instanceCount"));
        const count2 = countOf(definition.field("instanceCountTwo") ?? 1);
        const start1 = definition.field("isCentered") === true ? 1 - count1 : 0;
        const start2 = definition.field("isCenteredTwo") === true ? 1 - count2 : 0;
        const transforms: FsValue[] = [];
        const names: string[] = [];
        for (let j = start2; j < count2; j++) {
            for (let i = start1; i < count1; i++) {
                if (i === 0 && j === 0) continue;
                const t = [0, 1, 2].map((k) => offset1[k] * i + offset2[k] * j);
                transforms.push(bridge.transform(IDENTITY, t));
                names.push(j === 0 ? `${i}` : `${i}_${j}`);
            }
        }
        return result(transforms, names);
    });

    define("computeCircularPatternTransforms", (args) => {
        const definition = mapArg(args[1]);
        const axis = definition.field("axis");
        if (!(axis instanceof FsMap)) fail("A circular pattern needs an axis");
        const origin = meters(axis.field("origin"));
        const direction = unit(meters(axis.field("direction")));
        const angle = magnitude(definition.field("angle"), "The pattern angle");
        const count = countOf(definition.field("instanceCount"));
        const start = definition.field("isCentered") === true ? 1 - count : 0;
        const transforms: FsValue[] = [];
        const names: string[] = [];
        for (let i = start; i < count; i++) {
            if (i === 0) continue;
            const m = rotation(direction, i * angle);
            // Rotate about the axis line: x' = R (x - o) + o.
            const t = [0, 1, 2].map(
                (r) =>
                    origin[r] - (m[3 * r] * origin[0] + m[3 * r + 1] * origin[1] + m[3 * r + 2] * origin[2]),
            );
            transforms.push(bridge.transform(m, t));
            names.push(`${i}`);
        }
        return result(transforms, names);
    });
}

function mapArg(value: FsValue): FsMap {
    if (!(value instanceof FsMap)) fail("Expected the pattern definition map");
    return value;
}

function countOf(value: FsValue): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
        fail("An instance count must be a positive integer");
    return value;
}

/** A vector of lengths (or plain numbers) as meters. */
function meters(value: FsValue): number[] {
    if (value === undefined) return [0, 0, 0];
    if (!(value instanceof FsArray)) fail("Expected a vector");
    return value.items.map((item) => magnitude(item, "A vector component"));
}

function unit(v: number[]): number[] {
    const length = Math.hypot(...v);
    if (length === 0) fail("The axis direction is zero");
    return v.map((c) => c / length);
}

/** Row-major rotation about unit axis `a` by `angle` radians. */
function rotation(a: number[], angle: number): number[] {
    const [x, y, z] = a;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    return [
        t * x * x + c,
        t * x * y - s * z,
        t * x * z + s * y,
        t * x * y + s * z,
        t * y * y + c,
        t * y * z - s * x,
        t * x * z - s * y,
        t * y * z + s * x,
        t * z * z + c,
    ];
}
