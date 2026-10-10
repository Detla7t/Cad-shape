// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { BinaryOperator } from "./ast";
import {
    combineUnits,
    describeValue,
    FsArray,
    FsQuantity,
    type FsValue,
    fail,
    formatNumber,
    NO_UNITS,
    quantity,
    scaleUnits,
    toDisplayString,
    type Units,
    unitsEqual,
    unitsLabel,
    valuesEqual,
} from "./values";

/**
 * Built-in operator semantics: numbers, `ValueWithUnits` (dimension-checked), vectors
 * (element-wise, scaled by scalars), matrices, `Id + string`, and `~` string
 * concatenation. User `operator` overloads and std hooks (Transform composition) are
 * tried by the interpreter BEFORE this is reached.
 */
export function applyBinary(op: BinaryOperator, left: FsValue, right: FsValue): FsValue {
    switch (op) {
        case "==":
            return valuesEqual(left, right);
        case "!=":
            return !valuesEqual(left, right);
        case "~":
            return toDisplayString(left) + toDisplayString(right);
        case "<":
        case ">":
        case "<=":
        case ">=":
            return compare(op, left, right);
        case "+":
        case "-":
            return additive(op, left, right);
        case "*":
            return multiply(left, right);
        case "/":
            return divide(left, right);
        case "%":
            return modulo(left, right);
        case "^":
            return power(left, right);
    }
}

export function applyNegate(value: FsValue): FsValue {
    if (typeof value === "number") return -value;
    if (value instanceof FsQuantity) return new FsQuantity(-value.value, value.units);
    if (value instanceof FsArray) return new FsArray(value.items.map(applyNegate), value.tag);
    fail(`Cannot negate a ${describeValue(value)}`);
}

// ------------------------------------------------------------------ Scalars

interface Scalar {
    readonly value: number;
    readonly units: Units;
}

function asScalar(value: FsValue): Scalar | undefined {
    if (typeof value === "number") return { value, units: NO_UNITS };
    if (value instanceof FsQuantity) return { value: value.value, units: value.units };
    return undefined;
}

function isNumeric(value: FsValue): boolean {
    return typeof value === "number" || value instanceof FsQuantity;
}

function compare(op: "<" | ">" | "<=" | ">=", left: FsValue, right: FsValue): boolean {
    if (typeof left === "string" && typeof right === "string") {
        return compareResult(op, left < right ? -1 : left > right ? 1 : 0);
    }
    const a = asScalar(left);
    const b = asScalar(right);
    if (a === undefined || b === undefined) {
        fail(`Cannot compare ${describeValue(left)} with ${describeValue(right)}`);
    }
    if (!unitsEqual(a.units, b.units)) {
        // A bare zero compares against any dimension: `depth > 0` is idiomatic.
        if (!(a.value === 0 && typeof left === "number") && !(b.value === 0 && typeof right === "number")) {
            fail(`Cannot compare ${unitsLabel(a.units)} with ${unitsLabel(b.units)}`);
        }
    }
    return compareResult(op, a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
}

function compareResult(op: "<" | ">" | "<=" | ">=", order: number): boolean {
    switch (op) {
        case "<":
            return order < 0;
        case ">":
            return order > 0;
        case "<=":
            return order <= 0;
        case ">=":
            return order >= 0;
    }
}

function additive(op: "+" | "-", left: FsValue, right: FsValue): FsValue {
    if (left instanceof FsArray && left.tag === "Id" && op === "+") return appendId(left, right);
    if (left instanceof FsArray && right instanceof FsArray) {
        if (left.items.length !== right.items.length) {
            fail(`Cannot ${op === "+" ? "add" : "subtract"} vectors of size ${left.size} and ${right.size}`);
        }
        return new FsArray(
            left.items.map((item, i) => additive(op, item, right.items[i])),
            left.tag ?? right.tag,
        );
    }
    const a = asScalar(left);
    const b = asScalar(right);
    if (a === undefined || b === undefined) {
        if (typeof left === "string" || typeof right === "string") {
            fail(`Cannot ${op === "+" ? "add" : "subtract"} strings; use ~ to concatenate`);
        }
        fail(`Cannot ${op === "+" ? "add" : "subtract"} ${describeValue(left)} and ${describeValue(right)}`);
    }
    if (!unitsEqual(a.units, b.units)) {
        fail(`Cannot ${op === "+" ? "add" : "subtract"} ${unitsLabel(a.units)} and ${unitsLabel(b.units)}`);
    }
    return quantity(op === "+" ? a.value + b.value : a.value - b.value, a.units);
}

function appendId(id: FsArray, right: FsValue): FsArray {
    if (typeof right === "string") return new FsArray([...id.items, right], "Id");
    // `id + 2` appends "2" (a decimal point becomes "_", as Id components cannot hold one).
    if (typeof right === "number")
        return new FsArray([...id.items, formatNumber(right).replace(".", "_")], "Id");
    if (right instanceof FsArray) return new FsArray([...id.items, ...right.items], "Id");
    fail(`Cannot append a ${describeValue(right)} to an Id`);
}

function multiply(left: FsValue, right: FsValue): FsValue {
    if (left instanceof FsArray && left.tag === "Matrix") return matrixMultiply(left, right);
    if (left instanceof FsArray && isNumeric(right)) {
        return new FsArray(
            left.items.map((item) => multiply(item, right)),
            left.tag,
        );
    }
    if (right instanceof FsArray && isNumeric(left)) {
        return new FsArray(
            right.items.map((item) => multiply(left, item)),
            right.tag,
        );
    }
    const a = asScalar(left);
    const b = asScalar(right);
    if (a === undefined || b === undefined) {
        fail(`Cannot multiply ${describeValue(left)} by ${describeValue(right)}`);
    }
    return quantity(a.value * b.value, combineUnits(a.units, b.units, 1));
}

function divide(left: FsValue, right: FsValue): FsValue {
    if (left instanceof FsArray && isNumeric(right)) {
        return new FsArray(
            left.items.map((item) => divide(item, right)),
            left.tag,
        );
    }
    const a = asScalar(left);
    const b = asScalar(right);
    if (a === undefined || b === undefined) {
        fail(`Cannot divide ${describeValue(left)} by ${describeValue(right)}`);
    }
    if (b.value === 0) fail("Division by zero");
    return quantity(a.value / b.value, combineUnits(a.units, b.units, -1));
}

function modulo(left: FsValue, right: FsValue): FsValue {
    const a = asScalar(left);
    const b = asScalar(right);
    if (a === undefined || b === undefined)
        fail(`Cannot take ${describeValue(left)} modulo ${describeValue(right)}`);
    if (!unitsEqual(a.units, b.units))
        fail(`Cannot take ${unitsLabel(a.units)} modulo ${unitsLabel(b.units)}`);
    if (b.value === 0) fail("Modulo by zero");
    // Floored modulo, as the language defines it: the result takes the divisor's sign.
    const result = a.value - b.value * Math.floor(a.value / b.value);
    return quantity(result, a.units);
}

function power(left: FsValue, right: FsValue): FsValue {
    if (typeof right !== "number") fail(`The exponent must be a number, got ${describeValue(right)}`);
    if (typeof left === "number") return left ** right;
    if (left instanceof FsQuantity) return quantity(left.value ** right, scaleUnits(left.units, right));
    fail(`Cannot raise a ${describeValue(left)} to a power`);
}

// ------------------------------------------------------------------ Matrices

/** Rows of a `Matrix`-tagged array as plain numbers. */
export function matrixRows(matrix: FsArray): number[][] {
    return matrix.items.map((row) => {
        if (!(row instanceof FsArray)) fail("A matrix must be an array of rows");
        return row.items.map((cell) => {
            if (typeof cell !== "number") fail("Matrix entries must be numbers");
            return cell;
        });
    });
}

export function makeMatrix(rows: number[][]): FsArray {
    return new FsArray(
        rows.map((row) => new FsArray([...row])),
        "Matrix",
    );
}

function matrixMultiply(left: FsArray, right: FsValue): FsValue {
    const a = matrixRows(left);
    if (right instanceof FsArray && right.tag === "Matrix") {
        const b = matrixRows(right);
        if (a[0]?.length !== b.length) fail("Matrix dimensions do not agree");
        return makeMatrix(
            a.map((row) => b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0))),
        );
    }
    if (right instanceof FsArray) {
        if (a[0]?.length !== right.size) fail("Matrix and vector dimensions do not agree");
        // Each component keeps the vector's units (a rotation of a length vector stays a length).
        return new FsArray(
            a.map((row) =>
                row.reduce<FsValue>(
                    (sum, value, k) =>
                        sum === undefined
                            ? multiply(value, right.items[k])
                            : additive("+", sum, multiply(value, right.items[k])),
                    undefined,
                ),
            ),
            right.tag,
        );
    }
    if (typeof right === "number") return makeMatrix(a.map((row) => row.map((value) => value * right)));
    fail(`Cannot multiply a Matrix by ${describeValue(right)}`);
}
