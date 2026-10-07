// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    expectArray,
    expectMap,
    expectNumber,
    expectString,
    FsArray,
    FsEnumValue,
    FsMap,
    type FsValue,
    fail,
    fsArray,
    fsMap,
    typeName,
    valuesEqual,
} from "../lang/values";
import type { BuiltinRegistry } from "./registry";

/**
 * The `@` built-ins with no modeling state: math, strings, containers, matrices, JSON.
 * Onshape's std wraps each in a typed function (`floor(value is number)` →
 * `@floor(value)`), so these trust their argument types the way the kernel does and fail
 * loudly when they do not hold.
 */
export function installPureBuiltins(define: BuiltinRegistry, version: number): void {
    installMath(define);
    installStrings(define);
    installContainers(define);
    installMatrices(define);
    define("getLanguageVersion", () => version);
    define("isAtVersionOrLater", (args) => {
        // Version enum members carry their number: `V740_PROPAGATE_PROPERTIES_IN_PATTERNS`.
        const introduced = versionNumber(args[1]);
        const current = args[2] === undefined ? version : versionNumber(args[2]);
        return current >= introduced;
    });
    define("report", () => undefined);
}

function versionNumber(value: FsValue): number {
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number.parseFloat(value);
    if (value instanceof FsEnumValue) {
        const match = /^V(\d+)/.exec(value.name);
        if (match !== null) return Number(match[1]);
    }
    fail(`Expected a FeatureScript version, got ${typeName(value)}`);
}

/** A number, or the magnitude of a `ValueWithUnits` map. */
export function magnitude(value: FsValue, what: string): number {
    if (typeof value === "number") return value;
    if (value instanceof FsMap) {
        const inner = value.field("value");
        if (typeof inner === "number") return inner;
    }
    fail(`${what} must be a number or ValueWithUnits, got ${typeName(value)}`);
}

// ------------------------------------------------------------------ Math

function installMath(define: BuiltinRegistry): void {
    // Out-of-domain input (`sqrt(-4)`, `asin(1.5)`, `log(-1)`) is an error, not NaN.
    const unary = (name: string, fn: (x: number) => number) =>
        define(name, (args) => {
            const x = expectNumber(args[0], `@${name}`);
            const result = fn(x);
            if (Number.isNaN(result) && !Number.isNaN(x)) fail(`@${name}(${x}) is undefined`);
            return result;
        });
    unary("floor", Math.floor);
    unary("ceil", Math.ceil);
    unary("sqrt", Math.sqrt);
    unary("sin", Math.sin);
    unary("cos", Math.cos);
    unary("tan", Math.tan);
    unary("asin", Math.asin);
    unary("acos", Math.acos);
    unary("atan", Math.atan);
    unary("sinh", Math.sinh);
    unary("cosh", Math.cosh);
    unary("tanh", Math.tanh);
    unary("asinh", Math.asinh);
    unary("acosh", Math.acosh);
    unary("atanh", Math.atanh);
    unary("exp", Math.exp);
    unary("exp2", (x) => 2 ** x);
    unary("log", Math.log);
    unary("log10", Math.log10);
    define("atan2", (args) => Math.atan2(expectNumber(args[0], "@atan2"), expectNumber(args[1], "@atan2")));
    define("hypot", (args) => Math.hypot(expectNumber(args[0], "@hypot"), expectNumber(args[1], "@hypot")));
    define("normalize", (args) => {
        const vector = expectArray(args[0], "@normalize");
        const components = vector.items.map((item) => magnitude(item, "A vector component"));
        const length = Math.hypot(...components);
        if (length === 0) fail("Cannot normalize a zero-length vector");
        return fsArray(components.map((component) => component / length));
    });
    define("range", (args) => {
        const count = expectNumber(args[2], "@range count");
        if (!Number.isInteger(count) || count < 0) fail("@range count must be a non-negative integer");
        const from = magnitude(args[0], "@range from");
        const to = magnitude(args[1], "@range to");
        const template = args[0] instanceof FsMap ? args[0] : undefined;
        const items: FsValue[] = [];
        for (let i = 0; i < count; i++) {
            const value = count === 1 ? from : from + ((to - from) * i) / (count - 1);
            items.push(template === undefined ? value : withMagnitude(template, value));
        }
        return fsArray(items);
    });
    define("tolerantSort", (args) => {
        // Values chained within `tolerance` of a neighbour form one cluster, which keeps its
        // original order: [1, 1.00009, 0.99991] at 0.0001 stays as it is.
        const values = expectArray(args[0], "@tolerantSort").items.map((item) =>
            magnitude(item, "A sorted value"),
        );
        const tolerance = magnitude(args[1], "@tolerantSort tolerance");
        const byValue = values.map((_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
        const result: number[] = [];
        let cluster: number[] = [];
        byValue.forEach((index, k) => {
            if (k > 0 && values[index] - values[byValue[k - 1]] >= tolerance) {
                result.push(...cluster.sort((a, b) => a - b));
                cluster = [];
            }
            cluster.push(index);
        });
        result.push(...cluster.sort((a, b) => a - b));
        return fsArray(result);
    });
}

/** A copy of a `ValueWithUnits` map with a new magnitude (unit and tag kept). */
function withMagnitude(template: FsMap, value: number): FsMap {
    const copy = new FsMap(template.pairs(), template.tag);
    copy.set("value", value);
    return copy;
}

// ------------------------------------------------------------------ Strings

function installStrings(define: BuiltinRegistry): void {
    const str = (value: FsValue, what: string) => expectString(value, what);
    define("length", (args) => str(args[0], "@length").length);
    define("substring", (args) => {
        const s = str(args[0], "@substring");
        const start = expectNumber(args[1], "@substring start");
        const end = args[2] === undefined ? s.length : expectNumber(args[2], "@substring end");
        if (start < 0 || end > s.length || start > end)
            fail(`@substring range ${start}..${end} is out of bounds`);
        return s.substring(start, end);
    });
    define("indexOfString", (args) =>
        str(args[0], "@indexOfString").indexOf(str(args[1], "@indexOfString"), (args[2] as number) ?? 0),
    );
    define("indexOfRegexp", (args) => {
        const s = str(args[0], "@indexOfRegexp");
        const start = (args[2] as number | undefined) ?? 0;
        const index = s.slice(start).search(new RegExp(str(args[1], "@indexOfRegexp")));
        return index < 0 ? -1 : index + start;
    });
    define("startsWith", (args) => str(args[0], "@startsWith").startsWith(str(args[1], "@startsWith")));
    define("endsWith", (args) => str(args[0], "@endsWith").endsWith(str(args[1], "@endsWith")));
    define("splitIntoCharacters", (args) => fsArray([...str(args[0], "@splitIntoCharacters")]));
    define("splitByRegexp", (args) => {
        const s = str(args[0], "@splitByRegexp");
        const separator = str(args[1], "@splitByRegexp");
        // Documented: an empty separator matches around every character, leaving only
        // empty parts (`"foo"` → four of them).
        if (separator === "") return fsArray(new Array<FsValue>(s.length + 1).fill(""));
        const parts = s.split(new RegExp(separator));
        // Trailing empty parts are dropped, as a Java-style split does.
        while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
        return fsArray(parts);
    });
    define("replace", (args) =>
        str(args[0], "@replace").replace(new RegExp(str(args[1], "@replace"), "g"), str(args[2], "@replace")),
    );
    define("repeatString", (args) =>
        str(args[0], "@repeatString").repeat(expectNumber(args[1], "@repeatString")),
    );
    define("match", (args) => {
        const s = str(args[0], "@match");
        const result = new RegExp(`^(?:${str(args[1], "@match")})$`).exec(s);
        if (result === null) return fsMap({ hasMatch: false, captures: fsArray([]) });
        return fsMap({ hasMatch: true, captures: fsArray(result.map((group) => group ?? "")) });
    });
    define("stringToNumber", (args) => {
        const s = str(args[0], "@stringToNumber").trim();
        const value = Number(s);
        if (s === "" || Number.isNaN(value)) fail(`"${s}" is not a number`);
        return value;
    });
    define("parseJson", (args) => {
        const options = args[1] instanceof FsMap ? args[1] : undefined;
        const units = options?.field("stringToUnitMap");
        let parsed: unknown;
        try {
            parsed = JSON.parse(str(args[0], "@parseJson"));
        } catch (error) {
            fail(`Invalid JSON: ${(error as Error).message}`);
        }
        return fromJson(parsed, units instanceof FsMap ? units : undefined);
    });
}

function fromJson(value: unknown, units: FsMap | undefined): FsValue {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return units === undefined ? value : (withUnits(value, units) ?? value);
    if (Array.isArray(value)) return fsArray(value.map((item) => fromJson(item, units)));
    const map = new FsMap();
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
        map.set(key, fromJson(item, units));
    return map;
}

/** `"3 inch"` → 3 inches, when `inch` is in the unit map. */
function withUnits(text: string, units: FsMap): FsValue | undefined {
    const match = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([A-Za-z_][A-Za-z0-9_^]*)\s*$/.exec(
        text,
    );
    if (match === null) return undefined;
    const unit = units.get(match[2]);
    if (!(unit instanceof FsMap)) return undefined;
    return withMagnitude(unit, Number(match[1]) * magnitude(unit, "A unit"));
}

// ------------------------------------------------------------------ Containers

function installContainers(define: BuiltinRegistry): void {
    define("size", (args) => {
        const value = args[0];
        if (value instanceof FsArray) return value.size;
        if (value instanceof FsMap) return value.size;
        if (typeof value === "string") return value.length;
        fail(`@size needs an array or map, got ${typeName(value)}`);
    });
    define("resize", (args) => {
        const array = expectArray(args[0], "@resize");
        const size = expectNumber(args[1], "@resize size");
        if (!Number.isInteger(size) || size < 0) fail("@resize size must be a non-negative integer");
        const items = array.items.slice(0, size);
        while (items.length < size) items.push(args[2]);
        return new FsArray(items, array.tag);
    });
    define("subArray", (args) => {
        const array = expectArray(args[0], "@subArray");
        const start = expectNumber(args[1], "@subArray start");
        const end = args[2] === undefined ? array.size : expectNumber(args[2], "@subArray end");
        if (start < 0 || end > array.size || start > end)
            fail(`@subArray range ${start}..${end} is out of bounds`);
        return new FsArray(array.items.slice(start, end), array.tag);
    });
    define("indexOf", (args) => {
        const array = expectArray(args[0], "@indexOf");
        const start = (args[2] as number | undefined) ?? 0;
        for (let i = start; i < array.size; i++) if (valuesEqual(array.items[i], args[1])) return i;
        return -1;
    });
    define("concatenateArrays", (args) =>
        fsArray(
            expectArray(args[0], "@concatenateArrays").items.flatMap(
                (item) => expectArray(item, "An element").items,
            ),
        ),
    );
    define("reverse", (args) => {
        const array = expectArray(args[0], "@reverse");
        return new FsArray([...array.items].reverse(), array.tag);
    });
    define("keys", (args) => fsArray([...expectMap(args[0], "@keys").pairs()].map(([key]) => key)));
    define("values", (args) => fsArray([...expectMap(args[0], "@values").pairs()].map(([, value]) => value)));
    define("mergeMaps", (args) => {
        const defaults = expectMap(args[0], "@mergeMaps");
        const merged = new FsMap(defaults.pairs(), defaults.tag);
        for (const [key, value] of expectMap(args[1], "@mergeMaps").pairs()) merged.set(key, value);
        return merged;
    });
    define("intersectMaps", (args) => {
        const maps = expectArray(args[0], "@intersectMaps").items.map((item) =>
            expectMap(item, "An element"),
        );
        if (maps.length === 0) return new FsMap();
        const last = maps[maps.length - 1];
        const result = new FsMap();
        for (const [key, value] of last.pairs())
            if (maps.every((map) => map.has(key))) result.set(key, value);
        return result;
    });
}

// ------------------------------------------------------------------ Matrices

type Matrix = number[][];

function readMatrix(value: FsValue, what: string): Matrix {
    const rows = expectArray(value, what).items.map((row) =>
        expectArray(row, `${what} row`).items.map((cell) => expectNumber(cell, `${what} entry`)),
    );
    if (rows.length === 0 || rows.some((row) => row.length !== rows[0].length))
        fail(`${what} must be rectangular`);
    return rows;
}

function toMatrix(m: Matrix): FsArray {
    return fsArray(m.map((row) => fsArray(row)));
}

function isMatrixValue(value: FsValue): boolean {
    if (!(value instanceof FsArray) || value.size === 0) return false;
    const width = value.items[0] instanceof FsArray ? value.items[0].size : -1;
    return (
        width > 0 &&
        value.items.every(
            (row) =>
                row instanceof FsArray &&
                row.size === width &&
                row.items.every((cell) => typeof cell === "number"),
        )
    );
}

function multiply(a: Matrix, b: Matrix): Matrix {
    if (a[0].length !== b.length) fail("Matrix dimensions do not agree");
    return a.map((row) => b[0].map((_, j) => row.reduce((sum, cell, k) => sum + cell * b[k][j], 0)));
}

function transpose(m: Matrix): Matrix {
    return m[0].map((_, j) => m.map((row) => row[j]));
}

function identity(n: number): Matrix {
    return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

function elementwise(a: Matrix, b: Matrix, fn: (x: number, y: number) => number): Matrix {
    if (a.length !== b.length || a[0].length !== b[0].length) fail("Matrix dimensions do not agree");
    return a.map((row, i) => row.map((cell, j) => fn(cell, b[i][j])));
}

function inverse(m: Matrix): Matrix {
    const n = m.length;
    if (m[0].length !== n) fail("Only square matrices have inverses");
    const a = m.map((row, i) => [...row, ...identity(n)[i]]);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
        if (Math.abs(a[pivot][col]) < 1e-300) fail("The matrix is singular");
        [a[col], a[pivot]] = [a[pivot], a[col]];
        const p = a[col][col];
        for (let j = 0; j < 2 * n; j++) a[col][j] /= p;
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = a[r][col];
            if (f !== 0) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
        }
    }
    return a.map((row) => row.slice(n));
}

function determinant(m: Matrix): number {
    const n = m.length;
    if (m[0].length !== n) fail("Only square matrices have determinants");
    const a = m.map((row) => [...row]);
    let det = 1;
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
        if (a[pivot][col] === 0) return 0;
        if (pivot !== col) {
            [a[col], a[pivot]] = [a[pivot], a[col]];
            det = -det;
        }
        det *= a[col][col];
        for (let r = col + 1; r < n; r++) {
            const f = a[r][col] / a[col][col];
            for (let j = col; j < n; j++) a[r][j] -= f * a[col][j];
        }
    }
    return det;
}

/** One-sided Jacobi SVD: `m = u * s * transpose(v)`. */
function svd(m: Matrix): { u: Matrix; s: Matrix; v: Matrix } {
    const rows = m.length;
    const cols = m[0].length;
    const a = m.map((row) => [...row]);
    const v = identity(cols);
    for (let sweep = 0; sweep < 60; sweep++) {
        let off = 0;
        for (let p = 0; p < cols - 1; p++) {
            for (let q = p + 1; q < cols; q++) {
                let alpha = 0;
                let beta = 0;
                let gamma = 0;
                for (let i = 0; i < rows; i++) {
                    alpha += a[i][p] * a[i][p];
                    beta += a[i][q] * a[i][q];
                    gamma += a[i][p] * a[i][q];
                }
                if (Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta)) continue;
                off = Math.max(off, Math.abs(gamma));
                const zeta = (beta - alpha) / (2 * gamma);
                const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
                const c = 1 / Math.sqrt(1 + t * t);
                const s = c * t;
                for (let i = 0; i < rows; i++) {
                    const x = a[i][p];
                    a[i][p] = c * x - s * a[i][q];
                    a[i][q] = s * x + c * a[i][q];
                }
                for (let i = 0; i < cols; i++) {
                    const x = v[i][p];
                    v[i][p] = c * x - s * v[i][q];
                    v[i][q] = s * x + c * v[i][q];
                }
            }
        }
        if (off === 0) break;
    }
    const sigma = Array.from({ length: cols }, (_, j) => Math.hypot(...a.map((row) => row[j])));
    const order = sigma.map((_, j) => j).sort((x, y) => sigma[y] - sigma[x]);
    const u = identity(rows);
    const s = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
    const vSorted = v.map((row) => order.map((j) => row[j]));
    order.forEach((j, k) => {
        if (k < rows) s[k][k] = sigma[j];
        if (k < rows && sigma[j] > 1e-300) for (let i = 0; i < rows; i++) u[i][k] = a[i][j] / sigma[j];
    });
    return { u, s, v: vSorted };
}

function installMatrices(define: BuiltinRegistry): void {
    define("isMatrix", (args) => isMatrixValue(args[0]));
    define("matrixIdentity", (args) => toMatrix(identity(expectNumber(args[0], "@matrixIdentity"))));
    define("matrixTranspose", (args) => toMatrix(transpose(readMatrix(args[0], "@matrixTranspose"))));
    define("matrixInverse", (args) => toMatrix(inverse(readMatrix(args[0], "@matrixInverse"))));
    define("matrixDeterminant", (args) => determinant(readMatrix(args[0], "@matrixDeterminant")));
    define("matrixNegate", (args) =>
        toMatrix(readMatrix(args[0], "@matrixNegate").map((row) => row.map((x) => -x))),
    );
    define("matrixSum", (args) =>
        toMatrix(
            elementwise(
                readMatrix(args[0], "@matrixSum"),
                readMatrix(args[1], "@matrixSum"),
                (x, y) => x + y,
            ),
        ),
    );
    define("matrixDifference", (args) =>
        toMatrix(
            elementwise(
                readMatrix(args[0], "@matrixDifference"),
                readMatrix(args[1], "@matrixDifference"),
                (x, y) => x - y,
            ),
        ),
    );
    define("matrixCwiseProduct", (args) =>
        toMatrix(
            elementwise(
                readMatrix(args[0], "@matrixCwiseProduct"),
                readMatrix(args[1], "@matrixCwiseProduct"),
                (x, y) => x * y,
            ),
        ),
    );
    define("matrixSquaredNorm", (args) =>
        readMatrix(args[0], "@matrixSquaredNorm").reduce(
            (sum, row) => sum + row.reduce((s, x) => s + x * x, 0),
            0,
        ),
    );
    define("matrixMultiply", (args) => {
        // `number * Matrix` passes the scalar first.
        if (typeof args[0] === "number") {
            const k = args[0];
            return toMatrix(readMatrix(args[1], "@matrixMultiply").map((row) => row.map((x) => x * k)));
        }
        const a = readMatrix(args[0], "@matrixMultiply");
        const b = args[1];
        if (typeof b === "number") return toMatrix(a.map((row) => row.map((x) => x * b)));
        if (isMatrixValue(b)) return toMatrix(multiply(a, readMatrix(b, "@matrixMultiply")));
        // A vector: a column.
        const vector = expectArray(b, "@matrixMultiply").items.map((x) =>
            expectNumber(x, "A vector component"),
        );
        if (vector.length !== a[0].length) fail("Matrix and vector dimensions do not agree");
        return fsArray(a.map((row) => row.reduce((sum, cell, k) => sum + cell * vector[k], 0)));
    });
    define("matrixRotation3d", (args) => {
        const axis = expectArray(args[0], "@matrixRotation3d axis").items.map((x) =>
            magnitude(x, "An axis component"),
        );
        const angle = expectNumber(args[1], "@matrixRotation3d angle");
        const length = Math.hypot(...axis);
        if (length === 0) fail("The rotation axis is zero");
        const [x, y, z] = axis.map((c) => c / length);
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const t = 1 - c;
        return toMatrix([
            [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
            [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
            [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
        ]);
    });
    define("matrixSvd", (args) => {
        const result = svd(readMatrix(args[0], "@matrixSvd"));
        return fsMap({ u: toMatrix(result.u), s: toMatrix(result.s), v: toMatrix(result.v) });
    });
}
