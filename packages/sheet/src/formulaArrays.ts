// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Ast,
    compare,
    ERR,
    type EvalContext,
    type Fn,
    flatten,
    isError,
    LambdaValue,
    matrix,
    type Scalar,
    scalar,
    toBoolean,
    toNumber,
    toText,
    type Value,
    wildcard,
} from "./formulaValues";

/**
 * Logic, lookup, reference and dynamic-array functions of the formula engine: the array
 * shapers (FILTER, SORT, UNIQUE, SEQUENCE, TAKE, …), LET/LAMBDA and its helpers (MAP,
 * BYROW, REDUCE, …), and array-aware versions of IF, IFERROR, INDEX and XLOOKUP.
 */

/** The number of argument `i` (`fallback` when omitted or empty). */
export function numberArg(args: Value[], i: number, fallback: number): number | ReturnType<typeof ERR> {
    if (i >= args.length) return fallback;
    const value = scalar(args[i]);
    if (value === null) return fallback;
    return toNumber(value);
}

const isOmitted = (raw: Ast | undefined) => raw === undefined || (raw.type === "name" && raw.name === "");

const transpose = (a: Scalar[][]): Scalar[][] => (a[0] ?? []).map((_, c) => a.map((row) => row[c] ?? null));

const truthy = (value: Scalar): boolean | ReturnType<typeof ERR> => {
    if (typeof value === "string") return value !== "" ? ERR("#VALUE!") : false;
    return toBoolean(value);
};

/** Rows of `a` as an array result (a single cell collapses to a scalar). */
function result(a: Scalar[][]): Value {
    if (a.length === 0 || (a[0]?.length ?? 0) === 0) return ERR("#CALC!");
    return a.length === 1 && a[0].length === 1 ? a[0][0] : a;
}

function sortKeyCompare(a: Scalar, b: Scalar): number {
    // Errors and blanks sort last, as in Excel.
    const rank = (v: Scalar) => (isError(v) ? 2 : v === null ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return compare(a, b);
}

/** XLOOKUP's search: the index of the match in `lookup`, or -1. */
function xmatchIndex(
    key: Scalar,
    lookup: Scalar[],
    mode: number,
    order: number,
): number | ReturnType<typeof ERR> {
    if (![0, -1, 1, 2].includes(mode) || ![1, -1, 2, -2].includes(order)) return ERR("#VALUE!");
    if (Math.abs(order) === 2) {
        // Binary search over sorted data (ascending 2, descending -2).
        let lo = 0;
        let hi = lookup.length - 1;
        let best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const c = compare(lookup[mid], key) * (order > 0 ? 1 : -1);
            if (c === 0) return mid;
            if (c < 0) {
                if (mode === -1) best = mid;
                lo = mid + 1;
            } else {
                if (mode === 1) best = mid;
                hi = mid - 1;
            }
        }
        return best;
    }
    const indices = lookup.map((_, i) => i);
    if (order < 0) indices.reverse();
    const pattern = mode === 2 && typeof key === "string" ? wildcard(key) : undefined;
    let best = -1;
    for (const i of indices) {
        const item = lookup[i];
        if (isError(item)) continue;
        if (pattern ? typeof item === "string" && pattern.test(item) : compare(item, key) === 0) return i;
        const c = compare(item, key);
        if ((mode === -1 && c < 0) || (mode === 1 && c > 0)) {
            if (best < 0 || (mode === -1 ? compare(item, lookup[best]) > 0 : compare(item, lookup[best]) < 0))
                best = i;
        }
    }
    return best;
}

function lambdaArg(context: EvalContext, raw: Ast | undefined): LambdaValue | undefined {
    if (raw === undefined) return undefined;
    const value = context.bind(raw);
    return value instanceof LambdaValue ? value : undefined;
}

export const ARRAY_FUNCTIONS: Record<string, Fn> = {
    IF: (_args, raw, context) => {
        if (raw.length < 2 || raw.length > 3) return ERR("#VALUE!");
        const condition = context.evaluate(raw[0]);
        if (!Array.isArray(condition)) {
            const test = toBoolean(condition);
            if (isError(test)) return test;
            if (test) return context.evaluate(raw[1]);
            return raw.length === 3 ? (isOmitted(raw[2]) ? 0 : context.evaluate(raw[2])) : false;
        }
        // An array condition picks per element: IF(A2:A9>0, "in", "out").
        const yes = matrix(context.evaluate(raw[1]));
        const no = matrix(raw.length === 3 ? context.evaluate(raw[2]) : false);
        const pick = (a: Scalar[][], r: number, c: number) =>
            a[a.length === 1 ? 0 : r]?.[(a[0]?.length ?? 0) === 1 ? 0 : c] ?? ERR("#N/A");
        return condition.map((row, r) =>
            row.map((cell, c) => {
                const test = toBoolean(cell);
                return isError(test) ? test : test ? pick(yes, r, c) : pick(no, r, c);
            }),
        );
    },
    IFERROR: (_args, raw, context) => {
        if (raw.length !== 2) return ERR("#VALUE!");
        const value = context.evaluate(raw[0]);
        if (!Array.isArray(value)) return isError(value) ? context.evaluate(raw[1]) : value;
        if (!value.some((row) => row.some(isError))) return value;
        const fallback = scalar(context.evaluate(raw[1]));
        return value.map((row) => row.map((cell) => (isError(cell) ? fallback : cell)));
    },
    IFNA: (_args, raw, context) => {
        if (raw.length !== 2) return ERR("#VALUE!");
        const value = context.evaluate(raw[0]);
        const isNa = (v: Scalar) => isError(v) && v.code === "#N/A";
        if (!Array.isArray(value)) return isNa(value) ? context.evaluate(raw[1]) : value;
        if (!value.some((row) => row.some(isNa))) return value;
        const fallback = scalar(context.evaluate(raw[1]));
        return value.map((row) => row.map((cell) => (isNa(cell) ? fallback : cell)));
    },
    CHOOSE: (_args, raw, context) => {
        const index = toNumber(scalar(context.evaluate(raw[0])));
        if (isError(index)) return index;
        const i = Math.trunc(index);
        if (i < 1 || i >= raw.length) return ERR("#VALUE!");
        return context.evaluate(raw[i]);
    },
    SWITCH: (_args, raw, context) => {
        if (raw.length < 3) return ERR("#VALUE!");
        const value = scalar(context.evaluate(raw[0]));
        if (isError(value)) return value;
        let i = 1;
        for (; i + 1 < raw.length; i += 2) {
            const candidate = scalar(context.evaluate(raw[i]));
            if (compare(candidate, value) === 0 && typeof candidate === typeof value)
                return context.evaluate(raw[i + 1]);
        }
        return i < raw.length ? context.evaluate(raw[i]) : ERR("#N/A");
    },
    LET: (_args, raw, context) => {
        if (raw.length < 3 || raw.length % 2 === 0) return ERR("#VALUE!");
        const names = new Map<string, Value | LambdaValue>();
        for (let i = 0; i + 1 < raw.length; i += 2) {
            const name = raw[i];
            if (name.type !== "name" || name.name === "") return ERR("#VALUE!");
            // Each value sees the names bound before it; a LAMBDA stays callable.
            names.set(name.name, bindWith(context, raw[i + 1], names));
        }
        return context.evaluateWith(raw[raw.length - 1], names);
    },
    // Evaluated by the engine itself (it closes over the call's names); listed for the editor.
    LAMBDA: () => ERR("#CALC!"),
    XOR: (args) => {
        let count = 0;
        for (const value of flatten(args)) {
            if (value === null || typeof value === "string") continue;
            const b = toBoolean(value);
            if (isError(b)) return b;
            if (b) count++;
        }
        return count % 2 === 1;
    },
    INDEX: (args) => {
        const table = matrix(args[0] ?? null);
        const height = table.length;
        const width = table[0]?.length ?? 0;
        let row = numberArg(args, 1, 0);
        let col = numberArg(args, 2, args.length > 2 ? 0 : 1);
        if (isError(row)) return row;
        if (isError(col)) return col;
        // A one-row array indexed by a single number counts along the row.
        if (height === 1 && args.length === 2) {
            col = row;
            row = 1;
        }
        row = Math.trunc(row);
        col = Math.trunc(col);
        if (row < 0 || col < 0 || row > height || col > width) return ERR("#REF!");
        if (row === 0 && col === 0) return result(table);
        if (row === 0) return result(table.map((r) => [r[col - 1] ?? null]));
        if (col === 0) return result([table[row - 1]]);
        return table[row - 1]?.[col - 1] ?? null;
    },
    XLOOKUP: (args) => {
        const lookupArray = matrix(args[1] ?? null);
        const returnArray = matrix(args[2] ?? null);
        const vertical = lookupArray.length > 1 || (lookupArray[0]?.length ?? 0) === 1;
        if (lookupArray.length > 1 && (lookupArray[0]?.length ?? 0) > 1) return ERR("#VALUE!");
        // The return array runs alongside the lookup array.
        if (
            vertical
                ? returnArray.length !== lookupArray.length
                : (returnArray[0]?.length ?? 0) !== (lookupArray[0]?.length ?? 0)
        )
            return ERR("#VALUE!");
        const lookup = flatten([lookupArray]);
        const mode = numberArg(args, 4, 0);
        const order = numberArg(args, 5, 1);
        if (isError(mode)) return mode;
        if (isError(order)) return order;
        const keys = matrix(args[0] ?? null);
        const one = (key: Scalar): Value => {
            if (isError(key)) return key;
            const index = xmatchIndex(key, lookup, mode, order);
            if (isError(index)) return index;
            if (index < 0) return args.length > 3 && args[3] !== null ? args[3] : ERR("#N/A");
            // The matching row (vertical lookup) or column of the return array.
            if (vertical) {
                if (index >= returnArray.length) return ERR("#VALUE!");
                return result([returnArray[index]]);
            }
            if (index >= (returnArray[0]?.length ?? 0)) return ERR("#VALUE!");
            return result(returnArray.map((row) => [row[index] ?? null]));
        };
        if (keys.length === 1 && keys[0].length === 1) return one(keys[0][0]);
        return keys.map((row) => row.map((key) => scalar(one(key))));
    },
    XMATCH: (args) => {
        const lookup = flatten([args[1] ?? null]);
        const mode = numberArg(args, 2, 0);
        const order = numberArg(args, 3, 1);
        if (isError(mode)) return mode;
        if (isError(order)) return order;
        const keys = matrix(args[0] ?? null);
        const one = (key: Scalar): Scalar => {
            if (isError(key)) return key;
            const index = xmatchIndex(key, lookup, mode, order);
            return isError(index) ? index : index < 0 ? ERR("#N/A") : index + 1;
        };
        if (keys.length === 1 && keys[0].length === 1) return one(keys[0][0]);
        return keys.map((row) => row.map(one));
    },
    LOOKUP: (args) => {
        const key = scalar(args[0] ?? null);
        if (isError(key)) return key;
        const vector = matrix(args[1] ?? null);
        const tall = vector.length >= (vector[0]?.length ?? 0);
        const lookup = args.length > 2 ? flatten([args[1]]) : tall ? vector.map((r) => r[0]) : vector[0];
        const values =
            args.length > 2
                ? flatten([args[2]])
                : tall
                  ? vector.map((r) => r[r.length - 1])
                  : vector[vector.length - 1];
        let found = -1;
        for (let i = 0; i < lookup.length; i++) {
            const c = compare(lookup[i], key);
            if (c <= 0 && !isError(lookup[i])) found = i;
            if (c > 0) break;
        }
        return found < 0 ? ERR("#N/A") : (values[found] ?? ERR("#N/A"));
    },
    ROW: (_args, raw, context) => {
        if (isOmitted(raw[0])) return context.cell ? context.cell.row + 1 : ERR("#VALUE!");
        const ref = context.referenceOf(raw[0]);
        if (ref === undefined) return ERR("#VALUE!");
        if (ref.start.row === ref.end.row) return ref.start.row + 1;
        return Array.from({ length: ref.end.row - ref.start.row + 1 }, (_, i) => [ref.start.row + i + 1]);
    },
    COLUMN: (_args, raw, context) => {
        if (isOmitted(raw[0])) return context.cell ? context.cell.col + 1 : ERR("#VALUE!");
        const ref = context.referenceOf(raw[0]);
        if (ref === undefined) return ERR("#VALUE!");
        if (ref.start.col === ref.end.col) return ref.start.col + 1;
        return [Array.from({ length: ref.end.col - ref.start.col + 1 }, (_, i) => ref.start.col + i + 1)];
    },
    ROWS: (args) => matrix(args[0] ?? null).length,
    COLUMNS: (args) => matrix(args[0] ?? null)[0]?.length ?? 0,
    OFFSET: (_args, raw, context) => {
        const ref = offsetRef(raw, context);
        if (ref === undefined) return ERR("#REF!");
        const values = context.values(ref);
        return result(values);
    },
    INDIRECT: (args, _raw, context) => {
        const text = toText(scalar(args[0] ?? null));
        if (isError(text)) return text;
        const ref = context.parseReference(text);
        return ref === undefined ? ERR("#REF!") : result(context.values(ref));
    },
    ADDRESS: (args) => {
        const row = numberArg(args, 0, 0);
        const col = numberArg(args, 1, 0);
        const kind = numberArg(args, 2, 1);
        if (isError(row)) return row;
        if (isError(col)) return col;
        if (isError(kind)) return kind;
        if (row < 1 || col < 1) return ERR("#VALUE!");
        let name = "";
        for (let n = Math.trunc(col); n > 0; n = Math.floor((n - 1) / 26)) {
            name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
        }
        const absRow = kind === 1 || kind === 2;
        const absCol = kind === 1 || kind === 3;
        const address = `${absCol ? "$" : ""}${name}${absRow ? "$" : ""}${Math.trunc(row)}`;
        const sheet = args.length > 4 ? toText(scalar(args[4])) : "";
        if (isError(sheet)) return sheet;
        return sheet
            ? `${/^[A-Za-z_]\w*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`}!${address}`
            : address;
    },
    ISREF: (_args, raw, context) => context.referenceOf(raw[0]) !== undefined,
    ISFORMULA: (_args, raw, context) => {
        const ref = context.referenceOf(raw[0]);
        return ref !== undefined && context.formulaAt(ref.sheet, ref.start.row, ref.start.col) !== undefined;
    },
    FORMULATEXT: (_args, raw, context) => {
        const ref = context.referenceOf(raw[0]);
        if (ref === undefined) return ERR("#N/A");
        const formula = context.formulaAt(ref.sheet, ref.start.row, ref.start.col);
        return formula === undefined ? ERR("#N/A") : `=${formula}`;
    },
    TRANSPOSE: (args) => result(transpose(matrix(args[0] ?? null))),
    FILTER: (args) => {
        const array = matrix(args[0] ?? null);
        const include = matrix(args[1] ?? null);
        const empty = () => (args.length > 2 ? (args[2] ?? null) : ERR("#CALC!"));
        // Rows chosen by a column of tests, or columns by a row of tests.
        if (include.length === array.length && (include[0]?.length ?? 0) === 1) {
            const rows: Scalar[][] = [];
            for (let r = 0; r < array.length; r++) {
                const keep = truthy(include[r][0]);
                if (isError(keep)) return keep;
                if (keep) rows.push(array[r]);
            }
            return rows.length ? result(rows) : empty();
        }
        if (include.length === 1 && include[0].length === (array[0]?.length ?? 0)) {
            const keep: number[] = [];
            for (let c = 0; c < include[0].length; c++) {
                const test = truthy(include[0][c]);
                if (isError(test)) return test;
                if (test) keep.push(c);
            }
            return keep.length ? result(array.map((row) => keep.map((c) => row[c]))) : empty();
        }
        return ERR("#VALUE!");
    },
    SORT: (args) => {
        const array = matrix(args[0] ?? null);
        const index = numberArg(args, 1, 1);
        const order = numberArg(args, 2, 1);
        const byCol = args.length > 3 ? toBoolean(scalar(args[3])) : false;
        if (isError(index)) return index;
        if (isError(order)) return order;
        if (isError(byCol)) return byCol;
        const rows = byCol ? transpose(array) : array;
        const key = Math.trunc(index) - 1;
        if (key < 0 || key >= (rows[0]?.length ?? 0) || (order !== 1 && order !== -1)) return ERR("#VALUE!");
        const sorted = rows
            .map((row, i) => ({ row, i }))
            .sort((a, b) => sortKeyCompare(a.row[key], b.row[key]) * order || a.i - b.i)
            .map((entry) => entry.row);
        return result(byCol ? transpose(sorted) : sorted);
    },
    SORTBY: (args) => {
        const array = matrix(args[0] ?? null);
        const keys: { values: Scalar[]; order: number }[] = [];
        for (let i = 1; i < args.length; i += 2) {
            const by = matrix(args[i]);
            const order = numberArg(args, i + 1, 1);
            if (isError(order)) return order;
            const values = by.length === array.length ? by.map((r) => r[0]) : by[0];
            if (values.length !== array.length) return ERR("#VALUE!");
            keys.push({ values, order });
        }
        const sorted = array
            .map((row, i) => ({ row, i }))
            .sort((a, b) => {
                for (const key of keys) {
                    const c = sortKeyCompare(key.values[a.i], key.values[b.i]) * key.order;
                    if (c !== 0) return c;
                }
                return a.i - b.i;
            })
            .map((entry) => entry.row);
        return result(sorted);
    },
    UNIQUE: (args) => {
        const array = matrix(args[0] ?? null);
        const byCol = args.length > 1 ? toBoolean(scalar(args[1])) : false;
        const once = args.length > 2 ? toBoolean(scalar(args[2])) : false;
        if (isError(byCol)) return byCol;
        if (isError(once)) return once;
        const rows = byCol ? transpose(array) : array;
        const keyOf = (row: Scalar[]) =>
            JSON.stringify(row.map((v) => (typeof v === "string" ? v.toLowerCase() : String(v))));
        const counts = new Map<string, number>();
        for (const row of rows) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
        const seen = new Set<string>();
        const out: Scalar[][] = [];
        for (const row of rows) {
            const key = keyOf(row);
            if (seen.has(key) || (once && counts.get(key) !== 1)) continue;
            seen.add(key);
            out.push(row);
        }
        return out.length ? result(byCol ? transpose(out) : out) : ERR("#CALC!");
    },
    SEQUENCE: (args) => {
        const rows = numberArg(args, 0, 1);
        const cols = numberArg(args, 1, 1);
        const start = numberArg(args, 2, 1);
        const step = numberArg(args, 3, 1);
        for (const v of [rows, cols, start, step]) if (isError(v)) return v;
        const r = Math.trunc(rows as number);
        const c = Math.trunc(cols as number);
        if (r < 1 || c < 1) return ERR("#CALC!");
        if (r * c > 1_048_576) return ERR("#NUM!");
        return result(
            Array.from({ length: r }, (_, i) =>
                Array.from({ length: c }, (_, j) => (start as number) + (i * c + j) * (step as number)),
            ),
        );
    },
    RANDARRAY: (args) => {
        const rows = numberArg(args, 0, 1);
        const cols = numberArg(args, 1, 1);
        const min = numberArg(args, 2, 0);
        const max = numberArg(args, 3, 1);
        const whole = args.length > 4 ? toBoolean(scalar(args[4])) : false;
        for (const v of [rows, cols, min, max, whole]) if (isError(v)) return v;
        const lo = min as number;
        const hi = max as number;
        if (hi < lo) return ERR("#VALUE!");
        const draw = () =>
            whole ? Math.floor(lo + Math.random() * (hi - lo + 1)) : lo + Math.random() * (hi - lo);
        return result(
            Array.from({ length: Math.trunc(rows as number) }, () =>
                Array.from({ length: Math.trunc(cols as number) }, draw),
            ),
        );
    },
    TAKE: (args) => takeDrop(args, true),
    DROP: (args) => takeDrop(args, false),
    CHOOSEROWS: (args) => {
        const array = matrix(args[0] ?? null);
        const picks = flatten(args.slice(1)).map(toNumber);
        const out: Scalar[][] = [];
        for (const pick of picks) {
            if (isError(pick)) return pick;
            const i = pick < 0 ? array.length + pick : pick - 1;
            if (!array[i]) return ERR("#VALUE!");
            out.push(array[i]);
        }
        return result(out);
    },
    CHOOSECOLS: (args) => {
        const array = matrix(args[0] ?? null);
        const width = array[0]?.length ?? 0;
        const picks = flatten(args.slice(1)).map(toNumber);
        const cols: number[] = [];
        for (const pick of picks) {
            if (isError(pick)) return pick;
            const i = pick < 0 ? width + pick : pick - 1;
            if (i < 0 || i >= width) return ERR("#VALUE!");
            cols.push(i);
        }
        return result(array.map((row) => cols.map((c) => row[c])));
    },
    VSTACK: (args) => {
        const arrays = args.map(matrix);
        const width = Math.max(...arrays.map((a) => a[0]?.length ?? 0));
        return result(arrays.flatMap((a) => a.map((row) => pad(row, width))));
    },
    HSTACK: (args) => {
        const arrays = args.map(matrix);
        const height = Math.max(...arrays.map((a) => a.length));
        return result(
            Array.from({ length: height }, (_, r) =>
                arrays.flatMap((a) => (a[r] ? a[r] : pad([], a[0]?.length ?? 0))),
            ),
        );
    },
    TOCOL: (args) => toLine(args, true),
    TOROW: (args) => toLine(args, false),
    WRAPROWS: (args) => wrap(args, true),
    WRAPCOLS: (args) => wrap(args, false),
    EXPAND: (args) => {
        const array = matrix(args[0] ?? null);
        const rows = numberArg(args, 1, array.length);
        const cols = numberArg(args, 2, array[0]?.length ?? 0);
        if (isError(rows)) return rows;
        if (isError(cols)) return cols;
        const fill = args.length > 3 ? scalar(args[3]) : ERR("#N/A");
        if (rows < array.length || cols < (array[0]?.length ?? 0)) return ERR("#VALUE!");
        return result(
            Array.from({ length: Math.trunc(rows) }, (_, r) =>
                Array.from({ length: Math.trunc(cols) }, (_, c) => array[r]?.[c] ?? fill),
            ),
        );
    },
    MAP: (_args, raw, context) => {
        const fn = lambdaArg(context, raw.at(-1));
        if (fn === undefined) return ERR("#VALUE!");
        const arrays = raw.slice(0, -1).map((node) => matrix(context.evaluate(node)));
        if (arrays.length === 0) return ERR("#VALUE!");
        return result(
            arrays[0].map((row, r) =>
                row.map((_, c) =>
                    scalar(
                        context.call(
                            fn,
                            arrays.map((a) => a[r]?.[c] ?? null),
                        ),
                    ),
                ),
            ),
        );
    },
    BYROW: (_args, raw, context) => {
        const fn = lambdaArg(context, raw[1]);
        if (fn === undefined) return ERR("#VALUE!");
        const array = matrix(context.evaluate(raw[0]));
        return result(array.map((row) => [scalar(context.call(fn, [[row]]))]));
    },
    BYCOL: (_args, raw, context) => {
        const fn = lambdaArg(context, raw[1]);
        if (fn === undefined) return ERR("#VALUE!");
        const array = matrix(context.evaluate(raw[0]));
        return result([transpose(array).map((col) => scalar(context.call(fn, [col.map((v) => [v])])))]);
    },
    REDUCE: (_args, raw, context) => {
        const fn = lambdaArg(context, raw[2]);
        if (fn === undefined) return ERR("#VALUE!");
        let accumulator: Value = context.evaluate(raw[0]);
        for (const value of flatten([context.evaluate(raw[1])]))
            accumulator = context.call(fn, [accumulator, value]);
        return accumulator;
    },
    SCAN: (_args, raw, context) => {
        const fn = lambdaArg(context, raw[2]);
        if (fn === undefined) return ERR("#VALUE!");
        let accumulator: Value = context.evaluate(raw[0]);
        const array = matrix(context.evaluate(raw[1]));
        return result(
            array.map((row) =>
                row.map((value) => {
                    accumulator = context.call(fn, [accumulator, value]);
                    return scalar(accumulator);
                }),
            ),
        );
    },
    MAKEARRAY: (_args, raw, context) => {
        const rows = toNumber(scalar(context.evaluate(raw[0])));
        const cols = toNumber(scalar(context.evaluate(raw[1])));
        const fn = lambdaArg(context, raw[2]);
        if (isError(rows)) return rows;
        if (isError(cols)) return cols;
        if (fn === undefined || rows < 1 || cols < 1) return ERR("#VALUE!");
        return result(
            Array.from({ length: Math.trunc(rows) }, (_, r) =>
                Array.from({ length: Math.trunc(cols) }, (_, c) => scalar(context.call(fn, [r + 1, c + 1]))),
            ),
        );
    },
};

/** LET's binding: a value evaluated inside the names bound so far, LAMBDAs kept. */
function bindWith(context: EvalContext, node: Ast, names: ReadonlyMap<string, Value | LambdaValue>) {
    if (node.type === "call" && node.name.replace(/^(_xlfn\.)?/i, "").toUpperCase() === "LAMBDA") {
        const params = node.args.slice(0, -1).map((arg) => (arg.type === "name" ? arg.name : ""));
        const body = node.args.at(-1);
        if (body !== undefined && params.every(Boolean)) {
            return new LambdaValue(params, body, new Map([...(context.scope ?? []), ...names]));
        }
    }
    if (node.type === "name" && names.get(node.name) instanceof LambdaValue) return names.get(node.name)!;
    return context.evaluateWith(node, names);
}

function pad(row: Scalar[], width: number): Scalar[] {
    return Array.from({ length: width }, (_, i) => (i < row.length ? row[i] : ERR("#N/A")));
}

function takeDrop(args: Value[], take: boolean): Value {
    const array = matrix(args[0] ?? null);
    const rows = numberArg(args, 1, take ? array.length : 0);
    const cols = numberArg(args, 2, take ? (array[0]?.length ?? 0) : 0);
    if (isError(rows)) return rows;
    if (isError(cols)) return cols;
    const slice = <T>(items: T[], n: number) => {
        const k = Math.trunc(n);
        if (take) return k >= 0 ? items.slice(0, k) : items.slice(items.length + k);
        return k >= 0 ? items.slice(k) : items.slice(0, items.length + k);
    };
    return result(slice(array, rows).map((row) => slice(row, cols)));
}

function toLine(args: Value[], column: boolean): Value {
    const array = matrix(args[0] ?? null);
    const ignore = numberArg(args, 1, 0);
    const byCol = args.length > 2 ? toBoolean(scalar(args[2])) : false;
    if (isError(ignore)) return ignore;
    if (isError(byCol)) return byCol;
    const values = flatten([byCol ? transpose(array) : array]).filter(
        (v) =>
            !((ignore === 1 || ignore === 3) && v === null) &&
            !((ignore === 2 || ignore === 3) && isError(v)),
    );
    return result(column ? values.map((v) => [v]) : [values]);
}

function wrap(args: Value[], rows: boolean): Value {
    const values = flatten([args[0] ?? null]);
    const count = numberArg(args, 1, 0);
    if (isError(count)) return count;
    const n = Math.trunc(count);
    if (n < 1) return ERR("#VALUE!");
    const fill = args.length > 2 ? scalar(args[2]) : ERR("#N/A");
    const lines: Scalar[][] = [];
    for (let i = 0; i < values.length; i += n)
        lines.push(pad(values.slice(i, i + n), n).map((v, j) => (i + j < values.length ? v : fill)));
    return result(rows ? lines : transpose(lines));
}

/** OFFSET(reference, rows, cols, [height], [width]) as a reference. */
export function offsetRef(raw: Ast[], context: EvalContext) {
    const base = raw[0] === undefined ? undefined : context.referenceOf(raw[0]);
    if (base === undefined) return undefined;
    const num = (i: number, fallback: number) => {
        if (isOmitted(raw[i])) return fallback;
        const n = toNumber(scalar(context.evaluate(raw[i])));
        return isError(n) ? Number.NaN : Math.trunc(n);
    };
    const rows = num(1, 0);
    const cols = num(2, 0);
    const height = num(3, base.end.row - base.start.row + 1);
    const width = num(4, base.end.col - base.start.col + 1);
    if (![rows, cols, height, width].every(Number.isFinite) || height < 1 || width < 1) return undefined;
    const top = base.start.row + rows;
    const left = base.start.col + cols;
    if (top < 0 || left < 0) return undefined;
    return {
        sheet: base.sheet,
        start: { row: top, col: left },
        end: { row: top + height - 1, col: left + width - 1 },
    };
}
