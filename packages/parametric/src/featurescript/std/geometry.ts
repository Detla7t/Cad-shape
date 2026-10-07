// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Interpreter, NOT_HANDLED } from "../lang/interpreter";
import { makeMatrix, matrixRows } from "../lang/operators";
import {
    ANGLE,
    describeValue,
    expectArray,
    expectNumber,
    FsArray,
    FsMap,
    FsQuantity,
    type FsValue,
    fail,
    fsMap,
    isUnitless,
    LENGTH,
    NO_UNITS,
    quantity,
    type Units,
    unitsEqual,
    unitsLabel,
} from "../lang/values";
import { angleOf, scalarOf, ZERO_LENGTH } from "./core";
import { arg, expectArgCount, type StdBuilder } from "./registry";

export type Vec3 = [number, number, number];

// ------------------------------------------------------------------ Pure vector math (SI numbers)

export const vec = {
    add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a: Vec3, b: Vec3): Vec3 => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ],
    norm: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
    normalize: (a: Vec3): Vec3 => {
        const n = Math.hypot(a[0], a[1], a[2]);
        if (n < 1e-15) fail("Cannot normalize a zero-length vector");
        return [a[0] / n, a[1] / n, a[2] / n];
    },
    /**
     * A unit vector perpendicular to `a` (deterministic): world X projected off `a`, or
     * world Y when `a` is (nearly) along X — so the default planes get the x axes
     * Onshape gives them (Top and Front: +X, Right: +Y).
     */
    perpendicular: (a: Vec3): Vec3 => {
        const n = vec.normalize(a);
        const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        return vec.normalize(vec.sub(helper, vec.scale(n, vec.dot(helper, n))));
    },
};

// ------------------------------------------------------------------ FsValue <-> numbers

export interface VectorData {
    readonly values: number[];
    readonly units: Units;
}

/** Components of an array/Vector with one shared unit (bare numbers are unitless). */
export function readVector(value: FsValue, what: string): VectorData {
    if (!(value instanceof FsArray)) fail(`${what} must be a vector, got ${describeValue(value)}`);
    let units: Units | undefined;
    const values = value.items.map((item, i) => {
        const scalar = scalarOf(item, `${what}[${i}]`);
        if (units === undefined) units = scalar.units;
        else if (!unitsEqual(units, scalar.units))
            fail(`${what} mixes ${unitsLabel(units)} and ${unitsLabel(scalar.units)}`);
        return scalar.value;
    });
    return { values, units: units ?? NO_UNITS };
}

export function makeVector(values: readonly number[], units: Units = NO_UNITS): FsArray {
    return new FsArray(
        values.map((value) => quantity(value, units)),
        "Vector",
    );
}

/** A 3D point in meters (a 2D point gets z = 0). */
export function readPoint(value: FsValue, what: string): Vec3 {
    const vector = readVector(value, what);
    if (!unitsEqual(vector.units, LENGTH)) {
        fail(
            `${what} must be a length vector (e.g. vector(1, 2, 3) * inch), got ${unitsLabel(vector.units)}`,
        );
    }
    return to3(vector.values, what);
}

/** A 2D point in meters (sketch coordinates). */
export function readPoint2d(value: FsValue, what: string): [number, number] {
    const vector = readVector(value, what);
    if (!unitsEqual(vector.units, LENGTH)) {
        fail(`${what} must be a length vector (e.g. vector(1, 2) * inch), got ${unitsLabel(vector.units)}`);
    }
    if (vector.values.length !== 2) fail(`${what} must be a 2D vector`);
    return [vector.values[0], vector.values[1]];
}

/** A unit direction; any shared unit (or none) is accepted — only the direction matters. */
export function readDirection(value: FsValue, what: string): Vec3 {
    return vec.normalize(to3(readVector(value, what).values, what));
}

function to3(values: number[], what: string): Vec3 {
    if (values.length === 2) return [values[0], values[1], 0];
    if (values.length !== 3) fail(`${what} must have 2 or 3 components, got ${values.length}`);
    return [values[0], values[1], values[2]];
}

export const point = (v: Vec3): FsArray => makeVector(v, LENGTH);
export const direction = (v: Vec3): FsArray => makeVector(v, NO_UNITS);

export interface PlaneData {
    readonly origin: Vec3;
    readonly normal: Vec3;
    readonly x: Vec3;
}

export function makePlaneData(origin: Vec3, normal: Vec3, x?: Vec3): PlaneData {
    const n = vec.normalize(normal);
    let xDir = x === undefined ? vec.perpendicular(n) : x;
    // Re-orthogonalize: the x axis must lie in the plane.
    xDir = vec.sub(xDir, vec.scale(n, vec.dot(xDir, n)));
    if (vec.norm(xDir) < 1e-12) xDir = vec.perpendicular(n);
    return { origin, normal: n, x: vec.normalize(xDir) };
}

export function readPlane(value: FsValue, what: string): PlaneData {
    if (!(value instanceof FsMap)) fail(`${what} must be a Plane, got ${describeValue(value)}`);
    const x = value.field("x");
    return makePlaneData(
        readPoint(value.field("origin"), `${what}.origin`),
        readDirection(value.field("normal"), `${what}.normal`),
        x === undefined ? undefined : readDirection(x, `${what}.x`),
    );
}

export function makePlane(data: PlaneData): FsMap {
    return fsMap(
        { origin: point(data.origin), normal: direction(data.normal), x: direction(data.x) },
        "Plane",
    );
}

export const planeY = (plane: PlaneData): Vec3 => vec.cross(plane.normal, plane.x);

export function planeToWorld(plane: PlaneData, u: number, v: number): Vec3 {
    return vec.add(plane.origin, vec.add(vec.scale(plane.x, u), vec.scale(planeY(plane), v)));
}

export function worldToPlane(plane: PlaneData, p: Vec3): [number, number] {
    const d = vec.sub(p, plane.origin);
    return [vec.dot(d, plane.x), vec.dot(d, planeY(plane))];
}

export interface LineData {
    readonly origin: Vec3;
    readonly direction: Vec3;
}

export function readLine(value: FsValue, what: string): LineData {
    if (!(value instanceof FsMap)) fail(`${what} must be a Line, got ${describeValue(value)}`);
    return {
        origin: readPoint(value.field("origin"), `${what}.origin`),
        direction: readDirection(value.field("direction"), `${what}.direction`),
    };
}

export function makeLine(data: LineData): FsMap {
    return fsMap({ origin: point(data.origin), direction: direction(data.direction) }, "Line");
}

/** An affine map: row-major 3x3 linear part and a translation in meters. */
export interface AffineData {
    readonly m: readonly number[];
    readonly t: Vec3;
}

export const IDENTITY: AffineData = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export function readTransform(value: FsValue, what: string): AffineData {
    if (!(value instanceof FsMap)) fail(`${what} must be a Transform, got ${describeValue(value)}`);
    const linear = value.field("linear");
    if (!(linear instanceof FsArray)) fail(`${what}.linear must be a Matrix`);
    const rows = matrixRows(linear);
    if (rows.length !== 3 || rows.some((row) => row.length !== 3))
        fail(`${what}.linear must be a 3x3 matrix`);
    return { m: rows.flat(), t: readPoint(value.field("translation"), `${what}.translation`) };
}

export function makeTransform(data: AffineData): FsMap {
    const m = data.m;
    return fsMap(
        {
            linear: makeMatrix([
                [m[0], m[1], m[2]],
                [m[3], m[4], m[5]],
                [m[6], m[7], m[8]],
            ]),
            translation: point(data.t),
        },
        "Transform",
    );
}

export function applyLinear(m: readonly number[], v: Vec3): Vec3 {
    return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
}

export function applyAffine(a: AffineData, p: Vec3): Vec3 {
    return vec.add(applyLinear(a.m, p), a.t);
}

export function composeAffine(a: AffineData, b: AffineData): AffineData {
    // (a ∘ b)(p) = a.m (b.m p + b.t) + a.t
    const m: number[] = [];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            m.push(a.m[i * 3] * b.m[j] + a.m[i * 3 + 1] * b.m[3 + j] + a.m[i * 3 + 2] * b.m[6 + j]);
        }
    }
    return { m, t: applyAffine(a, b.t) };
}

export function invertAffine(a: AffineData): AffineData {
    const m = a.m;
    const det =
        m[0] * (m[4] * m[8] - m[5] * m[7]) -
        m[1] * (m[3] * m[8] - m[5] * m[6]) +
        m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(det) < 1e-15) fail("The transform is not invertible");
    const inv = [
        (m[4] * m[8] - m[5] * m[7]) / det,
        (m[2] * m[7] - m[1] * m[8]) / det,
        (m[1] * m[5] - m[2] * m[4]) / det,
        (m[5] * m[6] - m[3] * m[8]) / det,
        (m[0] * m[8] - m[2] * m[6]) / det,
        (m[2] * m[3] - m[0] * m[5]) / det,
        (m[3] * m[7] - m[4] * m[6]) / det,
        (m[1] * m[6] - m[0] * m[7]) / det,
        (m[0] * m[4] - m[1] * m[3]) / det,
    ];
    return { m: inv, t: vec.scale(applyLinear(inv, a.t), -1) };
}

/** Rodrigues rotation about `axis` (unit) through `origin` by `angle` radians. */
export function rotationAffine(origin: Vec3, axis: Vec3, angle: number): AffineData {
    const [x, y, z] = vec.normalize(axis);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    const m = [
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
    // Fix `origin`: p' = R (p - o) + o.
    return { m, t: vec.sub(origin, applyLinear(m, origin)) };
}

export function mirrorAffine(plane: PlaneData): AffineData {
    const [a, b, c] = plane.normal;
    const m = [
        1 - 2 * a * a,
        -2 * a * b,
        -2 * a * c,
        -2 * a * b,
        1 - 2 * b * b,
        -2 * b * c,
        -2 * a * c,
        -2 * b * c,
        1 - 2 * c * c,
    ];
    return { m, t: vec.sub(plane.origin, applyLinear(m, plane.origin)) };
}

export interface CoordSystemData {
    readonly origin: Vec3;
    readonly xAxis: Vec3;
    readonly zAxis: Vec3;
}

export function readCoordSystem(value: FsValue, what: string): CoordSystemData {
    if (!(value instanceof FsMap)) fail(`${what} must be a CoordSystem, got ${describeValue(value)}`);
    const zAxis = readDirection(value.field("zAxis"), `${what}.zAxis`);
    const plane = makePlaneData(
        readPoint(value.field("origin"), `${what}.origin`),
        zAxis,
        readDirection(value.field("xAxis"), `${what}.xAxis`),
    );
    return { origin: plane.origin, xAxis: plane.x, zAxis: plane.normal };
}

export function makeCoordSystem(data: CoordSystemData): FsMap {
    return fsMap(
        { origin: point(data.origin), xAxis: direction(data.xAxis), zAxis: direction(data.zAxis) },
        "CoordSystem",
    );
}

/** Local → world for a coordinate system. */
export function coordSystemAffine(cs: CoordSystemData): AffineData {
    const y = vec.cross(cs.zAxis, cs.xAxis);
    return {
        m: [cs.xAxis[0], y[0], cs.zAxis[0], cs.xAxis[1], y[1], cs.zAxis[1], cs.xAxis[2], y[2], cs.zAxis[2]],
        t: cs.origin,
    };
}

// ------------------------------------------------------------------ Std registration

export function installGeometry(std: StdBuilder): void {
    for (const type of ["Vector", "Matrix", "Plane", "Line", "CoordSystem", "Transform", "Box3d"])
        std.tagType(type);

    std.value("X_DIRECTION", direction([1, 0, 0]));
    std.value("Y_DIRECTION", direction([0, 1, 0]));
    std.value("Z_DIRECTION", direction([0, 0, 1]));
    std.value("WORLD_ORIGIN", point([0, 0, 0]));
    std.value("XY_PLANE", makePlane(makePlaneData([0, 0, 0], [0, 0, 1], [1, 0, 0])));
    std.value("YZ_PLANE", makePlane(makePlaneData([0, 0, 0], [1, 0, 0], [0, 1, 0])));
    std.value("XZ_PLANE", makePlane(makePlaneData([0, 0, 0], [0, -1, 0], [1, 0, 0])));
    std.value(
        "WORLD_COORD_SYSTEM",
        makeCoordSystem({ origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] }),
    );

    installVectors(std);
    installPlanesAndLines(std);
    installTransforms(std);
    installOperators(std.interpreter);
}

function installVectors(std: StdBuilder): void {
    std.fn("vector", (args) => {
        const items = args.length === 1 ? expectArray(args[0], "vector components").items : args;
        if (items.length < 2) fail("vector needs at least 2 components");
        items.forEach((item, i) => {
            scalarOf(item, `vector component ${i}`);
        });
        return new FsArray([...items], "Vector");
    });
    std.fn("zeroVector", (args) => {
        const size = expectNumber(arg(args, 0, "zeroVector"), "zeroVector size");
        return makeVector(Array.from({ length: size }, () => 0));
    });
    std.fn("isVector", (args) => {
        const value = args[0];
        return (
            value instanceof FsArray &&
            value.items.every((item) => typeof item === "number" || item instanceof FsQuantity)
        );
    });
    std.fn("isLengthVector", (args) => {
        const value = args[0];
        if (!(value instanceof FsArray) || value.size === 0) return false;
        return value.items.every((item) => item instanceof FsQuantity && unitsEqual(item.units, LENGTH));
    });
    std.fn("isUnitlessVector", (args) => {
        const value = args[0];
        return (
            value instanceof FsArray &&
            value.size > 0 &&
            value.items.every((item) => typeof item === "number")
        );
    });
    std.fn("is3dLengthVector", (args) => {
        const value = args[0];
        return (
            value instanceof FsArray &&
            value.size === 3 &&
            value.items.every((item) => item instanceof FsQuantity && unitsEqual(item.units, LENGTH))
        );
    });
    std.fn("is2dPoint", (args) => {
        const value = args[0];
        return (
            value instanceof FsArray &&
            value.size === 2 &&
            value.items.every((item) => item instanceof FsQuantity && unitsEqual(item.units, LENGTH))
        );
    });
    std.fn("squaredNorm", (args) => {
        const v = readVector(arg(args, 0, "squaredNorm"), "squaredNorm argument");
        return quantity(
            v.values.reduce((sum, x) => sum + x * x, 0),
            scaleUnits2(v.units),
        );
    });
    std.fn("norm", (args) => {
        const v = readVector(arg(args, 0, "norm"), "norm argument");
        return quantity(Math.hypot(...v.values), v.units);
    });
    std.fn("normalize", (args) => {
        const v = readVector(arg(args, 0, "normalize"), "normalize argument");
        const n = Math.hypot(...v.values);
        if (n < 1e-15) fail("Cannot normalize a zero-length vector");
        return makeVector(v.values.map((x) => x / n));
    });
    std.fn("dot", (args) => {
        expectArgCount(args, 2, 2, "dot");
        const a = readVector(args[0], "dot first argument");
        const b = readVector(args[1], "dot second argument");
        if (a.values.length !== b.values.length) fail("dot needs vectors of the same size");
        return quantity(
            a.values.reduce((sum, x, i) => sum + x * b.values[i], 0),
            addUnits(a.units, b.units),
        );
    });
    std.fn("cross", (args) => {
        expectArgCount(args, 2, 2, "cross");
        const a = readVector(args[0], "cross first argument");
        const b = readVector(args[1], "cross second argument");
        if (a.values.length !== 3 || b.values.length !== 3) fail("cross needs 3D vectors");
        return makeVector(vec.cross(a.values as Vec3, b.values as Vec3), addUnits(a.units, b.units));
    });
    std.fn("angleBetween", (args) => {
        expectArgCount(args, 2, 3, "angleBetween");
        const a = readDirection(args[0], "angleBetween first argument");
        const b = readDirection(args[1], "angleBetween second argument");
        const unsigned = Math.atan2(vec.norm(vec.cross(a, b)), vec.dot(a, b));
        if (args.length === 2) return new FsQuantity(unsigned, ANGLE);
        // With a reference normal the angle is signed, measured counter-clockwise about it.
        const ref = readDirection(args[2], "angleBetween reference");
        const sign = vec.dot(vec.cross(a, b), ref) < 0 ? -1 : 1;
        let angle = sign * unsigned;
        if (angle < 0) angle += 2 * Math.PI;
        return new FsQuantity(angle, ANGLE);
    });
    std.fn("perpendicularVector", (args) =>
        direction(vec.perpendicular(readDirection(arg(args, 0, "perpendicularVector"), "vector"))),
    );
    std.fn("parallelVectors", (args) => {
        const a = readDirection(arg(args, 0, "parallelVectors"), "first vector");
        const b = readDirection(arg(args, 1, "parallelVectors"), "second vector");
        return vec.norm(vec.cross(a, b)) < 1e-9;
    });
    std.fn("perpendicularVectors", (args) => {
        const a = readDirection(arg(args, 0, "perpendicularVectors"), "first vector");
        const b = readDirection(arg(args, 1, "perpendicularVectors"), "second vector");
        return Math.abs(vec.dot(a, b)) < 1e-9;
    });
    std.fn("matrix", (args) => {
        const rows = expectArray(arg(args, 0, "matrix"), "matrix rows").items.map((row) =>
            expectArray(row, "matrix row").items.map((cell) => expectNumber(cell, "matrix entry")),
        );
        return makeMatrix(rows);
    });
    std.fn("identityMatrix", (args) => {
        const n = expectNumber(arg(args, 0, "identityMatrix"), "size");
        return makeMatrix(
            Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 1 : 0))),
        );
    });
    std.fn("transpose", (args) => {
        const m = arg(args, 0, "transpose");
        if (!(m instanceof FsArray)) fail("transpose needs a Matrix");
        const rows = matrixRows(m);
        return makeMatrix((rows[0] ?? []).map((_, j) => rows.map((row) => row[j])));
    });
    std.fn("rotationMatrix3d", (args) => {
        expectArgCount(args, 2, 2, "rotationMatrix3d");
        if (args[1] instanceof FsArray) {
            // From one direction to another.
            const from = readDirection(args[0], "from");
            const to = readDirection(args[1], "to");
            const axis = vec.cross(from, to);
            const angle = Math.atan2(vec.norm(axis), vec.dot(from, to));
            const m =
                vec.norm(axis) < 1e-12
                    ? angle < 1
                        ? IDENTITY.m
                        : rotationAffine([0, 0, 0], vec.perpendicular(from), Math.PI).m
                    : rotationAffine([0, 0, 0], axis, angle).m;
            return matrixOf(m);
        }
        const axis = readDirection(args[0], "axis");
        return matrixOf(rotationAffine([0, 0, 0], axis, angleOf(args[1], "angle")).m);
    });
}

function matrixOf(m: readonly number[]): FsArray {
    return makeMatrix([
        [m[0], m[1], m[2]],
        [m[3], m[4], m[5]],
        [m[6], m[7], m[8]],
    ]);
}

function addUnits(a: Units, b: Units): Units {
    return {
        meter: a.meter + b.meter,
        radian: a.radian + b.radian,
        kilogram: a.kilogram + b.kilogram,
        second: a.second + b.second,
    };
}

function scaleUnits2(units: Units): Units {
    return addUnits(units, units);
}

function installPlanesAndLines(std: StdBuilder): void {
    std.fn("plane", (args) => {
        expectArgCount(args, 2, 3, "plane");
        return makePlane(
            makePlaneData(
                readPoint(args[0], "plane origin"),
                readDirection(args[1], "plane normal"),
                args[2] === undefined ? undefined : readDirection(args[2], "plane x direction"),
            ),
        );
    });
    std.fn("yAxis", (args) => direction(planeY(readPlane(arg(args, 0, "yAxis"), "plane"))));
    std.fn("planeToWorld", (args) => {
        const plane = readPlane(arg(args, 0, "planeToWorld"), "plane");
        const local = readVector(arg(args, 1, "planeToWorld"), "plane point");
        if (!unitsEqual(local.units, LENGTH)) fail("planeToWorld needs a length vector");
        return point(planeToWorld(plane, local.values[0] ?? 0, local.values[1] ?? 0));
    });
    std.fn("worldToPlane", (args) => {
        const plane = readPlane(arg(args, 0, "worldToPlane"), "plane");
        return makeVector(worldToPlane(plane, readPoint(arg(args, 1, "worldToPlane"), "point")), LENGTH);
    });
    std.fn("planeToCSys", (args) => {
        const plane = readPlane(arg(args, 0, "planeToCSys"), "plane");
        return makeCoordSystem({ origin: plane.origin, xAxis: plane.x, zAxis: plane.normal });
    });
    std.fn("line", (args) => {
        expectArgCount(args, 2, 2, "line");
        return makeLine({
            origin: readPoint(args[0], "line origin"),
            direction: readDirection(args[1], "line direction"),
        });
    });
    std.fn("project", (args) => {
        expectArgCount(args, 2, 2, "project");
        const target = args[0];
        const p = readPoint(args[1], "point");
        if (target instanceof FsMap && target.tag === "Line") {
            const line = readLine(target, "line");
            return point(
                vec.add(
                    line.origin,
                    vec.scale(line.direction, vec.dot(vec.sub(p, line.origin), line.direction)),
                ),
            );
        }
        const plane = readPlane(target, "plane");
        return point(vec.sub(p, vec.scale(plane.normal, vec.dot(vec.sub(p, plane.origin), plane.normal))));
    });
    std.fn("isPointOnPlane", (args) => {
        const plane = readPlane(arg(args, 0, "isPointOnPlane"), "plane");
        const p = readPoint(arg(args, 1, "isPointOnPlane"), "point");
        return Math.abs(vec.dot(vec.sub(p, plane.origin), plane.normal)) < ZERO_LENGTH;
    });
    std.fn("coordSystem", (args) => {
        if (args.length === 1) {
            const plane = readPlane(args[0], "plane");
            return makeCoordSystem({ origin: plane.origin, xAxis: plane.x, zAxis: plane.normal });
        }
        expectArgCount(args, 3, 3, "coordSystem");
        const plane = makePlaneData(
            readPoint(args[0], "origin"),
            readDirection(args[2], "zAxis"),
            readDirection(args[1], "xAxis"),
        );
        return makeCoordSystem({ origin: plane.origin, xAxis: plane.x, zAxis: plane.normal });
    });
    std.fn("box3d", (args) => {
        expectArgCount(args, 2, 2, "box3d");
        return fsMap(
            {
                minCorner: point(readPoint(args[0], "minCorner")),
                maxCorner: point(readPoint(args[1], "maxCorner")),
            },
            "Box3d",
        );
    });
    std.fn("box3dCenter", (args) => {
        const box = arg(args, 0, "box3dCenter");
        if (!(box instanceof FsMap)) fail("box3dCenter needs a Box3d");
        const min = readPoint(box.field("minCorner"), "minCorner");
        const max = readPoint(box.field("maxCorner"), "maxCorner");
        return point(vec.scale(vec.add(min, max), 0.5));
    });
}

function installTransforms(std: StdBuilder): void {
    std.fn("identityTransform", () => makeTransform(IDENTITY));
    std.fn("transform", (args) => {
        expectArgCount(args, 1, 2, "transform");
        if (args.length === 1) return makeTransform({ m: IDENTITY.m, t: readPoint(args[0], "translation") });
        const linear = args[0];
        if (!(linear instanceof FsArray)) fail("transform(linear, translation) needs a Matrix");
        return makeTransform({ m: matrixRows(linear).flat(), t: readPoint(args[1], "translation") });
    });
    std.fn("rotationAround", (args) => {
        expectArgCount(args, 2, 2, "rotationAround");
        const line = readLine(args[0], "axis");
        return makeTransform(rotationAffine(line.origin, line.direction, angleOf(args[1], "angle")));
    });
    std.fn("scaleUniformly", (args) => {
        expectArgCount(args, 1, 2, "scaleUniformly");
        const s = expectNumber(args[0], "scale");
        const center: Vec3 = args[1] === undefined ? [0, 0, 0] : readPoint(args[1], "center");
        const m = [s, 0, 0, 0, s, 0, 0, 0, s];
        return makeTransform({ m, t: vec.sub(center, vec.scale(center, s)) });
    });
    std.fn("mirrorAcross", (args) =>
        makeTransform(mirrorAffine(readPlane(arg(args, 0, "mirrorAcross"), "plane"))),
    );
    std.fn("inverse", (args) => {
        const value = arg(args, 0, "inverse");
        if (value instanceof FsMap && value.tag === "Transform")
            return makeTransform(invertAffine(readTransform(value, "transform")));
        if (value instanceof FsArray) {
            const rows = matrixRows(value);
            if (rows.length !== 3) fail("inverse supports 3x3 matrices");
            return matrixOf(invertAffine({ m: rows.flat(), t: [0, 0, 0] }).m);
        }
        fail(`inverse needs a Transform or a Matrix, got ${describeValue(value)}`);
    });
    std.fn("toWorld", (args) => {
        expectArgCount(args, 1, 2, "toWorld");
        const affine = coordSystemAffine(readCoordSystem(args[0], "coordinate system"));
        if (args.length === 1) return makeTransform(affine);
        return point(applyAffine(affine, readPoint(args[1], "point")));
    });
    std.fn("fromWorld", (args) => {
        expectArgCount(args, 1, 2, "fromWorld");
        const affine = invertAffine(coordSystemAffine(readCoordSystem(args[0], "coordinate system")));
        if (args.length === 1) return makeTransform(affine);
        return point(applyAffine(affine, readPoint(args[1], "point")));
    });
}

/** `Transform * x` for points, directions, lines, planes, coordinate systems and transforms. */
function installOperators(interpreter: Interpreter): void {
    interpreter.defineOperator("*", (left, right) => {
        if (!(left instanceof FsMap) || left.tag !== "Transform") return NOT_HANDLED;
        const affine = readTransform(left, "transform");
        if (right instanceof FsMap) {
            switch (right.tag) {
                case "Transform":
                    return makeTransform(composeAffine(affine, readTransform(right, "transform")));
                case "Line": {
                    const line = readLine(right, "line");
                    return makeLine({
                        origin: applyAffine(affine, line.origin),
                        direction: vec.normalize(applyLinear(affine.m, line.direction)),
                    });
                }
                case "Plane": {
                    const plane = readPlane(right, "plane");
                    return makePlane(
                        makePlaneData(
                            applyAffine(affine, plane.origin),
                            applyLinear(affine.m, plane.normal),
                            applyLinear(affine.m, plane.x),
                        ),
                    );
                }
                case "CoordSystem": {
                    const cs = readCoordSystem(right, "coordinate system");
                    return makeCoordSystem({
                        origin: applyAffine(affine, cs.origin),
                        xAxis: vec.normalize(applyLinear(affine.m, cs.xAxis)),
                        zAxis: vec.normalize(applyLinear(affine.m, cs.zAxis)),
                    });
                }
                default:
                    return NOT_HANDLED;
            }
        }
        if (right instanceof FsArray) {
            const v = readVector(right, "vector");
            if (unitsEqual(v.units, LENGTH)) return point(applyAffine(affine, to3(v.values, "point")));
            if (isUnitless(v.units)) return direction(applyLinear(affine.m, to3(v.values, "direction")));
        }
        return NOT_HANDLED;
    });
}
