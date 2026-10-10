// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsArray, FsMap, type FsValue, fail, fsArray, fsMap } from "../lang/values";
import type { StdBridge } from "./bridge";
import { magnitude } from "./pureBuiltins";
import type { BuiltinRegistry } from "./registry";

/**
 * The pattern transform built-ins: the instance transforms a linear, circular or curve
 * pattern places copies with, as std's pre-builtin code computed them (that code still
 * ships in `linearPattern.fs` / `circularPattern.fs` / `curvePattern.fs` for held-back
 * features). Instance skipping is modelled for the curve pattern only.
 */
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function installPatternBuiltins(define: BuiltinRegistry, bridge: StdBridge): void {
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

    // Each instance moves the seed from the first tangent (a Line or a Plane along the
    // path) to its own, chained instance by instance the way std's fallback composes
    // `transform(tangents[i - 1], tangents[i]) * transforms[i - 2]`.
    define("computeCurvePatternTransforms", (args) => {
        const definition = mapArg(args[1]);
        const tangentsValue = definition.field("tangents");
        if (!(tangentsValue instanceof FsArray)) fail("A curve pattern needs its path tangents");
        const frames = tangentsValue.items.map(frameOf);
        const count = countOf(definition.field("instanceCount"));
        if (frames.length < count) fail("A curve pattern needs one tangent per instance");
        const skipped = new Set<number>();
        const skipList = definition.field("skippedInstances");
        if (definition.field("skipInstances") === true && skipList instanceof FsArray) {
            for (const entry of skipList.items) {
                if (entry instanceof FsMap) skipped.add(magnitude(entry.field("index"), "A skipped index"));
            }
        }
        const transforms: FsValue[] = [];
        const names: string[] = [];
        const placements: Affine[] = [];
        let chained: Affine = { linear: IDENTITY, translation: [0, 0, 0] };
        for (let i = 1; i < count; i++) {
            chained = compose(frameTransform(frames[i - 1], frames[i]), chained);
            placements.push(chained);
            if (skipped.has(i)) continue;
            transforms.push(bridge.transform(chained.linear, chained.translation));
            names.push(`${i}`);
        }
        const start = definition.field("startPoint");
        const manipulatorPoints =
            start instanceof FsArray
                ? [meters(start), ...placements.map((t) => apply(t, meters(start)))].map((p) =>
                      bridge.lengthVector(p),
                  )
                : [];
        return fsMap({
            transforms: fsArray(transforms),
            instanceNames: fsArray(names),
            manipulatorPoints: fsArray(manipulatorPoints),
        });
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

// ------------------------------------------------------------------ Curve pattern frames

interface Affine {
    /** Row-major 3x3. */
    readonly linear: readonly number[];
    /** Meters. */
    readonly translation: readonly number[];
}

/** A path tangent: a std Line (origin, direction) or Plane (origin, normal, x), in meters. */
interface Frame {
    readonly origin: number[];
    readonly direction?: number[];
    readonly axes?: { x: number[]; y: number[]; z: number[] };
}

function frameOf(value: FsValue): Frame {
    if (!(value instanceof FsMap)) fail("A curve pattern tangent must be a Line or a Plane");
    const origin = meters(value.field("origin"));
    if (value.has("normal")) {
        const z = unit(meters(value.field("normal")));
        const x = unit(meters(value.field("x")));
        return { origin, axes: { x, y: cross(z, x), z } };
    }
    return { origin, direction: unit(meters(value.field("direction"))) };
}

/** std's `transform(from, to)`: minimal rotation between lines, or the plane-to-plane map. */
function frameTransform(from: Frame, to: Frame): Affine {
    let linear: number[];
    if (from.axes !== undefined && to.axes !== undefined) {
        // planeToWorld3D(to) * worldToPlane3D(from): columns of `to`, rows of `from`.
        const a = from.axes;
        const b = to.axes;
        linear = [0, 1, 2].flatMap((r) =>
            [0, 1, 2].map((c) => b.x[r] * a.x[c] + b.y[r] * a.y[c] + b.z[r] * a.z[c]),
        );
    } else if (from.direction !== undefined && to.direction !== undefined) {
        linear = minimalRotation(from.direction, to.direction);
    } else fail("Curve pattern tangents must all be Lines or all be Planes");
    const moved = multiply(linear, from.origin);
    return { linear, translation: [0, 1, 2].map((k) => to.origin[k] - moved[k]) };
}

/** std's `rotationMatrix3d(from, to)`. */
function minimalRotation(from: number[], to: number[]): number[] {
    const axis = cross(from, to);
    const sine = Math.hypot(...axis);
    const cosine = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
    if (sine < 1e-8) {
        if (cosine > 0) return [...[1, 0, 0], ...[0, 1, 0], ...[0, 0, 1]];
        return rotation(perpendicular(from), Math.PI);
    }
    return rotation(unit(axis), Math.atan2(sine, cosine));
}

/** std's `perpendicularVector`, with its tie-breaking constants. */
function perpendicular(v: number[]): number[] {
    const [x, y, z] = v.map(Math.abs);
    const other = [0, 0, 0];
    if (x > 1.0366636528619326 * y) other[x > 0.9517029893922335 * z ? 2 : 1] = 1;
    else other[y > 0.9204199474553859 * z ? 0 : 1] = 1;
    return unit(cross(other, v));
}

function compose(outer: Affine, inner: Affine): Affine {
    const linear = [0, 1, 2].flatMap((r) =>
        [0, 1, 2].map((c) =>
            [0, 1, 2].reduce((sum, k) => sum + outer.linear[3 * r + k] * inner.linear[3 * k + c], 0),
        ),
    );
    const moved = multiply(outer.linear, inner.translation);
    return { linear, translation: [0, 1, 2].map((k) => moved[k] + outer.translation[k]) };
}

function apply(t: Affine, p: readonly number[]): number[] {
    const moved = multiply(t.linear, p);
    return [0, 1, 2].map((k) => moved[k] + t.translation[k]);
}

function multiply(m: readonly number[], v: readonly number[]): number[] {
    return [0, 1, 2].map((r) => m[3 * r] * v[0] + m[3 * r + 1] * v[1] + m[3 * r + 2] * v[2]);
}

function cross(a: readonly number[], b: readonly number[]): number[] {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
