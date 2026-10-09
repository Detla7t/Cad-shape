// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { generalNumberText } from "./generalNumber";
import type { CellValue } from "./model";

/**
 * The value types and coercions of the formula engine (`formula.ts`), shared with its
 * function library (`formulaLibrary.ts`): Excel's scalar coercions, ordering, wildcard
 * criteria, date serials and the evaluation context a function receives.
 */

export type FormulaErrorCode =
    | "#DIV/0!"
    | "#VALUE!"
    | "#REF!"
    | "#NAME?"
    | "#N/A"
    | "#NUM!"
    | "#CIRC!"
    | "#SPILL!"
    | "#CALC!"
    | "#NULL!";

export class FormulaError {
    constructor(readonly code: FormulaErrorCode) {}
    toString(): string {
        return this.code;
    }
}

/** An evaluated cell: a value, an error, or null for an empty cell. */
export type Scalar = CellValue | FormulaError | null;

/** A scalar or a rectangular array (a range, an array constant, a dynamic array result). */
export type Value = Scalar | Scalar[][];

export const ERROR_CODES: FormulaErrorCode[] = [
    "#DIV/0!",
    "#VALUE!",
    "#REF!",
    "#NAME?",
    "#N/A",
    "#NUM!",
    "#CIRC!",
    "#SPILL!",
    "#CALC!",
    "#NULL!",
];

export type Ast =
    | { type: "number"; value: number }
    | { type: "string"; value: string }
    | { type: "boolean"; value: boolean }
    | { type: "error"; code: FormulaErrorCode }
    | { type: "ref"; sheet?: string; text: string; spill?: boolean }
    | { type: "structured"; table?: string; spec: StructuredSpec }
    | { type: "array"; rows: Ast[][] }
    | { type: "name"; name: string }
    | { type: "unary"; op: string; arg: Ast }
    | { type: "percent"; arg: Ast }
    | { type: "binary"; op: string; left: Ast; right: Ast }
    | { type: "call"; name: string; args: Ast[] };

export const isError = (value: unknown): value is FormulaError => value instanceof FormulaError;
export const ERR = (code: FormulaErrorCode) => new FormulaError(code);

export function toNumber(value: Scalar): number | FormulaError {
    if (value === null) return 0;
    if (isError(value)) return value;
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    const text = value.trim();
    if (text === "") return 0;
    const number = Number(text.endsWith("%") ? text.slice(0, -1) : text);
    if (!Number.isFinite(number)) return ERR("#VALUE!");
    return text.endsWith("%") ? number / 100 : number;
}

export function toText(value: Scalar): string | FormulaError {
    if (value === null) return "";
    if (isError(value)) return value;
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "number") return generalNumberText(value);
    return value;
}

export function toBoolean(value: Scalar): boolean | FormulaError {
    if (value === null) return false;
    if (isError(value)) return value;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const upper = value.toUpperCase();
    if (upper === "TRUE") return true;
    if (upper === "FALSE") return false;
    return ERR("#VALUE!");
}

/** Excel's ordering across types: numbers < text < booleans; text case-insensitive. */
export function compare(a: Scalar, b: Scalar): number {
    const rank = (v: Scalar) => (typeof v === "number" || v === null ? 0 : typeof v === "string" ? 1 : 2);
    const x = a === null ? (typeof b === "string" ? "" : typeof b === "boolean" ? false : 0) : a;
    const y = b === null ? (typeof a === "string" ? "" : typeof a === "boolean" ? false : 0) : b;
    if (rank(x) !== rank(y)) return rank(x) - rank(y);
    if (typeof x === "string" && typeof y === "string") {
        const l = x.toLowerCase();
        const r = y.toLowerCase();
        return l < r ? -1 : l > r ? 1 : 0;
    }
    return Number(x) - Number(y);
}

export const scalar = (value: Value): Scalar => (Array.isArray(value) ? (value[0]?.[0] ?? null) : value);

export function flatten(values: Value[]): Scalar[] {
    const out: Scalar[] = [];
    for (const value of values) {
        if (Array.isArray(value)) for (const row of value) out.push(...row);
        else out.push(value);
    }
    return out;
}

/**
 * The numbers of aggregate arguments: from ranges only numbers count (text, booleans and
 * empty cells are skipped); a direct argument is coerced. The first error wins.
 */
export function numbers(values: Value[]): number[] | FormulaError {
    const out: number[] = [];
    for (const value of values) {
        if (Array.isArray(value)) {
            for (const row of value)
                for (const cell of row) {
                    if (isError(cell)) return cell;
                    if (typeof cell === "number") out.push(cell);
                }
        } else {
            if (value === null) continue;
            const number = toNumber(value);
            if (isError(number)) return number;
            out.push(number);
        }
    }
    return out;
}

export const round = (value: number, digits: number, mode: "half" | "up" | "down") => {
    const factor = 10 ** digits;
    const scaled = Math.abs(value) * factor;
    const fixed = Number.parseFloat(scaled.toPrecision(15));
    const rounded =
        mode === "half" ? Math.round(fixed) : mode === "up" ? Math.ceil(fixed) : Math.floor(fixed);
    return (Math.sign(value) * rounded) / factor;
};

export type Fn = (args: Value[], raw: Ast[], context: EvalContext) => Value;

export function numeric1(f: (x: number) => number): Fn {
    return (args) => {
        if (args.length !== 1) return ERR("#VALUE!");
        const x = toNumber(scalar(args[0]));
        if (isError(x)) return x;
        const result = f(x);
        return Number.isFinite(result) ? result : ERR("#NUM!");
    };
}

export function lookupValue(array: Scalar[][], row: number, col: number): Scalar {
    return array[row]?.[col] ?? null;
}

export const matrix = (value: Value): Scalar[][] => (Array.isArray(value) ? value : [[value]]);
export const sameSize = (a: Scalar[][], b: Scalar[][]) =>
    a.length === b.length && a.every((row, i) => row.length === b[i].length);

export function wildcard(text: string): RegExp {
    let pattern = "";
    const escapeRegex = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "~" && i + 1 < text.length) pattern += escapeRegex(text[++i]);
        else pattern += c === "*" ? ".*" : c === "?" ? "." : escapeRegex(c);
    }
    return new RegExp(`^${pattern}$`, "i");
}

export const DAY_MS = 86400000;
export function excelSerial(ms: number): number {
    const n = (ms - Date.UTC(1899, 11, 31)) / DAY_MS;
    return n >= 60 ? n + 1 : n;
}
export function serialDate(n: number): Date {
    return new Date(Date.UTC(1899, 11, 31) + (n >= 60 ? n - 1 : n) * DAY_MS);
}
export function localNowSerial(): number {
    const now = new Date();
    return excelSerial(now.getTime() - now.getTimezoneOffset() * 60000);
}

/** A rectangular area of one sheet, zero-based and inclusive. */
export interface RangeRef {
    readonly sheet: number;
    readonly start: { row: number; col: number };
    readonly end: { row: number; col: number };
}

/** What a function sees of the evaluation it runs in. */
export interface EvalContext {
    evaluate(ast: Ast): Value;
    /** `ast` evaluated with extra names bound (LET, LAMBDA parameters). */
    evaluateWith(ast: Ast, names: ReadonlyMap<string, Value | LambdaValue>): Value;
    /** `ast` evaluated keeping a LAMBDA as a value (what LET binds a name to). */
    bind(ast: Ast): Value | LambdaValue;
    /** The names LET/LAMBDA have bound around this call. */
    readonly scope?: ReadonlyMap<string, Value | LambdaValue>;
    /** Where a reference argument points (ROW, COLUMN, OFFSET, ISREF, …); undefined for a non-reference. */
    referenceOf(ast: Ast): RangeRef | undefined;
    /** The values of a range. */
    values(ref: RangeRef): Scalar[][];
    /** A reference written as text ("Sheet2!B3", a name), for INDIRECT. */
    parseReference(text: string): RangeRef | undefined;
    /** The sheet and cell being evaluated (no cell for a formula evaluated on its own). */
    readonly sheet: number;
    readonly cell?: { row: number; col: number };
    /** The cell's stored formula, for ISFORMULA/FORMULATEXT. */
    formulaAt(sheet: number, row: number, col: number): string | undefined;
    /** Applies a callable value (a LAMBDA) to arguments. */
    call(fn: Value | LambdaValue, args: Value[]): Value;
}

/**
 * Parts of a structured reference (`Table[[#This Row],[Amount]]`): the row items (`#All`,
 * `#Data`, `#Headers`, `#Totals`, `#This Row`; none means `#Data`) and a column span.
 */
export interface StructuredSpec {
    readonly items: readonly ("#All" | "#Data" | "#Headers" | "#Totals" | "#This Row")[];
    readonly startColumn?: string;
    readonly endColumn?: string;
}

/** A LAMBDA: parameters bound to the call's arguments, then the body evaluated. */
export class LambdaValue {
    constructor(
        readonly params: readonly string[],
        readonly body: Ast,
        readonly closure: ReadonlyMap<string, Value | LambdaValue>,
    ) {}
}

/**
 * Applies `f` per element when an argument is an array, broadcasting a single row or
 * column (or a 1×1) across the others as Excel does; mismatched sizes give #N/A outside
 * the overlap. Scalars only: returns `f(args)`.
 */
export function lift(args: Value[], f: (args: Scalar[]) => Scalar): Value {
    if (!args.some(Array.isArray)) return f(args as Scalar[]);
    const arrays = args.map(matrix);
    const rows = Math.max(...arrays.map((a) => a.length));
    const cols = Math.max(...arrays.map((a) => a[0]?.length ?? 0));
    const at = (a: Scalar[][], r: number, c: number): Scalar => {
        const rr = a.length === 1 ? 0 : r;
        const cc = (a[0]?.length ?? 0) === 1 ? 0 : c;
        if (rr >= a.length || cc >= (a[rr]?.length ?? 0)) return ERR("#N/A");
        return a[rr][cc] ?? null;
    };
    const out: Scalar[][] = [];
    for (let r = 0; r < rows; r++) {
        const row: Scalar[] = [];
        for (let c = 0; c < cols; c++) row.push(f(arrays.map((a) => at(a, r, c))));
        out.push(row);
    }
    return out;
}
