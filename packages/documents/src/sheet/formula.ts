// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { generalNumberText } from "./generalNumber";

export { generalNumberText } from "./generalNumber";

import { FUNCTION_INFO } from "./functionInfo";
import {
    addressOf,
    type CellData,
    type CellValue,
    columnIndex,
    parseAddress,
    type WorkbookData,
} from "./model";
import { formatCellValue } from "./numberFormat";

/**
 * A spreadsheet formula engine for the grid editor and `readDocumentTable`: Excel
 * operators and precedence (`-2^2` = 4, `%`, `&`, comparisons), A1 / absolute / ranged /
 * cross-sheet references (`'Sheet 2'!B3`), and the common functions (SUM, AVERAGE, MIN,
 * MAX, COUNT, IF, ROUND, VLOOKUP, …). Evaluation is lazy and memoized per workbook
 * revision; reference cycles evaluate to `#CIRC!`. A formula using a function the engine
 * lacks keeps the result stored in the file, so imported workbooks still show their values.
 */

export type FormulaErrorCode = "#DIV/0!" | "#VALUE!" | "#REF!" | "#NAME?" | "#N/A" | "#NUM!" | "#CIRC!";

export class FormulaError {
    constructor(readonly code: FormulaErrorCode) {}
    toString(): string {
        return this.code;
    }
}

/** An evaluated cell: a value, an error, or null for an empty cell. */
export type Scalar = CellValue | FormulaError | null;
type Value = Scalar | Scalar[][];

// ------------------------------------------------------------------ Tokens

type Token =
    | { kind: "number"; value: number }
    | { kind: "string"; value: string }
    | { kind: "ref"; sheet?: string; text: string }
    | { kind: "name"; value: string }
    | { kind: "error"; value: FormulaErrorCode }
    | { kind: "op"; value: string };

const ERROR_CODES: FormulaErrorCode[] = ["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#N/A", "#NUM!", "#CIRC!"];

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const sheetPrefix = (): string | undefined => {
        if (text[i] === "'") {
            let j = i + 1;
            let name = "";
            while (j < text.length) {
                if (text[j] === "'" && text[j + 1] === "'") {
                    name += "'";
                    j += 2;
                } else if (text[j] === "'") break;
                else name += text[j++];
            }
            if (text[j] === "'" && text[j + 1] === "!") {
                i = j + 2;
                return name;
            }
            throw new Error("bad sheet name");
        }
        const match = /^([A-Za-z_][\w.]*)!/.exec(text.slice(i));
        if (match) {
            i += match[0].length;
            return match[1];
        }
        return undefined;
    };
    while (i < text.length) {
        const char = text[i];
        if (/\s/.test(char)) {
            i++;
            continue;
        }
        const rest = text.slice(i);
        const number = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(rest);
        // "2:5" is a row range, not a number.
        if (number && !/^\$?\d+:\$?\d+/.test(rest)) {
            tokens.push({ kind: "number", value: Number.parseFloat(number[0]) });
            i += number[0].length;
            continue;
        }
        if (char === '"') {
            let value = "";
            let j = i + 1;
            for (; j < text.length; j++) {
                if (text[j] === '"' && text[j + 1] === '"') {
                    value += '"';
                    j++;
                } else if (text[j] === '"') break;
                else value += text[j];
            }
            if (j >= text.length) throw new Error("unterminated string");
            tokens.push({ kind: "string", value });
            i = j + 1;
            continue;
        }
        if (char === "#") {
            const code = ERROR_CODES.find((c) => rest.toUpperCase().startsWith(c));
            if (code === undefined) throw new Error(`unknown error literal at ${i}`);
            tokens.push({ kind: "error", value: code });
            i += code.length;
            continue;
        }
        const start = i;
        const sheet = sheetPrefix();
        const reference =
            /^(\$?[A-Za-z]{1,3}\$?\d+(:\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+)(?![\w(])/.exec(
                text.slice(i),
            );
        if (reference) {
            tokens.push({ kind: "ref", sheet, text: reference[0] });
            i += reference[0].length;
            continue;
        }
        if (sheet !== undefined) throw new Error(`bad reference after ${text.slice(start, i)}`);
        const name = /^[A-Za-z_][\w.]*/.exec(rest);
        if (name) {
            tokens.push({ kind: "name", value: name[0].toUpperCase() });
            i += name[0].length;
            continue;
        }
        const op = /^(<=|>=|<>|[-+*/^&=<>(),;%])/.exec(rest);
        if (op) {
            tokens.push({ kind: "op", value: op[0] === ";" ? "," : op[0] });
            i += op[0].length;
            continue;
        }
        throw new Error(`unexpected "${char}"`);
    }
    return tokens;
}

// ------------------------------------------------------------------ Syntax

export type Ast =
    | { type: "number"; value: number }
    | { type: "string"; value: string }
    | { type: "boolean"; value: boolean }
    | { type: "error"; code: FormulaErrorCode }
    | { type: "ref"; sheet?: string; text: string }
    | { type: "unary"; op: string; arg: Ast }
    | { type: "percent"; arg: Ast }
    | { type: "binary"; op: string; left: Ast; right: Ast }
    | { type: "call"; name: string; args: Ast[] };

const BINARY: Record<string, number> = {
    "=": 1,
    "<>": 1,
    "<": 1,
    ">": 1,
    "<=": 1,
    ">=": 1,
    "&": 2,
    "+": 3,
    "-": 3,
    "*": 4,
    "/": 4,
    "^": 5,
};

class Parser {
    private at = 0;
    constructor(private readonly tokens: Token[]) {}

    parse(): Ast {
        const ast = this.expression(0);
        if (this.at < this.tokens.length) throw new Error("unexpected input after the formula");
        return ast;
    }

    private peek(): Token | undefined {
        return this.tokens[this.at];
    }

    private isOp(value: string): boolean {
        const token = this.peek();
        return token?.kind === "op" && token.value === value;
    }

    private expression(minPrecedence: number): Ast {
        let left = this.unary();
        for (;;) {
            const token = this.peek();
            if (token?.kind !== "op") return left;
            const precedence = BINARY[token.value];
            if (precedence === undefined || precedence < minPrecedence) return left;
            this.at++;
            // Left-associative, ^ included (Excel evaluates 2^3^2 as 64).
            const right = this.expression(precedence + 1);
            left = { type: "binary", op: token.value, left, right };
        }
    }

    private unary(): Ast {
        if (this.isOp("-") || this.isOp("+")) {
            const op = (this.tokens[this.at++] as { value: string }).value;
            const arg = this.unary();
            return op === "-" ? { type: "unary", op, arg } : arg;
        }
        return this.postfix();
    }

    private postfix(): Ast {
        let ast = this.primary();
        while (this.isOp("%")) {
            this.at++;
            ast = { type: "percent", arg: ast };
        }
        return ast;
    }

    private primary(): Ast {
        const token = this.tokens[this.at++];
        if (token === undefined) throw new Error("the formula ends early");
        switch (token.kind) {
            case "number":
                return { type: "number", value: token.value };
            case "string":
                return { type: "string", value: token.value };
            case "error":
                return { type: "error", code: token.value };
            case "ref":
                return { type: "ref", sheet: token.sheet, text: token.text };
            case "name": {
                if (this.isOp("(")) {
                    this.at++;
                    const args: Ast[] = [];
                    if (!this.isOp(")")) {
                        for (;;) {
                            args.push(this.expression(0));
                            if (this.isOp(",")) {
                                this.at++;
                                continue;
                            }
                            break;
                        }
                    }
                    if (!this.isOp(")")) throw new Error(`missing ) after ${token.value}(`);
                    this.at++;
                    return { type: "call", name: token.value, args };
                }
                if (token.value === "TRUE" || token.value === "FALSE") {
                    return { type: "boolean", value: token.value === "TRUE" };
                }
                return { type: "error", code: "#NAME?" };
            }
            case "op":
                if (token.value === "(") {
                    const inner = this.expression(0);
                    if (!this.isOp(")")) throw new Error("missing )");
                    this.at++;
                    return inner;
                }
                throw new Error(`unexpected "${token.value}"`);
        }
    }
}

const parsed = new Map<string, Ast | Error>();

/** The syntax tree of a formula (without "="), cached; throws on a syntax error. */
export function parseFormula(formula: string): Ast {
    let ast = parsed.get(formula);
    if (ast === undefined) {
        try {
            ast = new Parser(tokenize(formula)).parse();
        } catch (error) {
            ast = error instanceof Error ? error : new Error(String(error));
        }
        if (parsed.size > 5000) parsed.clear();
        parsed.set(formula, ast);
    }
    if (ast instanceof Error) throw ast;
    return ast;
}

// ------------------------------------------------------------------ Values

const isError = (value: unknown): value is FormulaError => value instanceof FormulaError;
const ERR = (code: FormulaErrorCode) => new FormulaError(code);

function toNumber(value: Scalar): number | FormulaError {
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

function toText(value: Scalar): string | FormulaError {
    if (value === null) return "";
    if (isError(value)) return value;
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "number") return generalNumberText(value);
    return value;
}

function toBoolean(value: Scalar): boolean | FormulaError {
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
function compare(a: Scalar, b: Scalar): number {
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

const scalar = (value: Value): Scalar => (Array.isArray(value) ? (value[0]?.[0] ?? null) : value);

function flatten(values: Value[]): Scalar[] {
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
function numbers(values: Value[]): number[] | FormulaError {
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

const round = (value: number, digits: number, mode: "half" | "up" | "down") => {
    const factor = 10 ** digits;
    const scaled = Math.abs(value) * factor;
    const fixed = Number.parseFloat(scaled.toPrecision(15));
    const rounded =
        mode === "half" ? Math.round(fixed) : mode === "up" ? Math.ceil(fixed) : Math.floor(fixed);
    return (Math.sign(value) * rounded) / factor;
};

type Fn = (args: Value[], raw: Ast[], context: EvalContext) => Value;

function numeric1(f: (x: number) => number): Fn {
    return (args) => {
        if (args.length !== 1) return ERR("#VALUE!");
        const x = toNumber(scalar(args[0]));
        if (isError(x)) return x;
        const result = f(x);
        return Number.isFinite(result) ? result : ERR("#NUM!");
    };
}

function lookupValue(array: Scalar[][], row: number, col: number): Scalar {
    return array[row]?.[col] ?? null;
}

const FUNCTIONS: Record<string, Fn> = {
    SUM: (args) => {
        const list = numbers(args);
        return isError(list) ? list : list.reduce((a, b) => a + b, 0);
    },
    PRODUCT: (args) => {
        const list = numbers(args);
        return isError(list) ? list : list.reduce((a, b) => a * b, 1);
    },
    AVERAGE: (args) => {
        const list = numbers(args);
        if (isError(list)) return list;
        return list.length === 0 ? ERR("#DIV/0!") : list.reduce((a, b) => a + b, 0) / list.length;
    },
    MIN: (args) => {
        const list = numbers(args);
        return isError(list) ? list : list.length === 0 ? 0 : Math.min(...list);
    },
    MAX: (args) => {
        const list = numbers(args);
        return isError(list) ? list : list.length === 0 ? 0 : Math.max(...list);
    },
    MEDIAN: (args) => {
        const list = numbers(args);
        if (isError(list)) return list;
        if (list.length === 0) return ERR("#NUM!");
        const sorted = [...list].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    },
    COUNT: (args) => flatten(args).filter((v) => typeof v === "number").length,
    COUNTA: (args) => flatten(args).filter((v) => v !== null && v !== "").length,
    COUNTBLANK: (args) => flatten(args).filter((v) => v === null || v === "").length,
    ABS: numeric1(Math.abs),
    SQRT: numeric1((x) => (x < 0 ? Number.NaN : Math.sqrt(x))),
    INT: numeric1(Math.floor),
    EXP: numeric1(Math.exp),
    LN: numeric1((x) => (x <= 0 ? Number.NaN : Math.log(x))),
    LOG10: numeric1((x) => (x <= 0 ? Number.NaN : Math.log10(x))),
    SIN: numeric1(Math.sin),
    COS: numeric1(Math.cos),
    TAN: numeric1(Math.tan),
    ASIN: numeric1(Math.asin),
    ACOS: numeric1(Math.acos),
    ATAN: numeric1(Math.atan),
    RADIANS: numeric1((x) => (x * Math.PI) / 180),
    DEGREES: numeric1((x) => (x * 180) / Math.PI),
    SIGN: numeric1(Math.sign),
    PI: (args) => (args.length === 0 ? Math.PI : ERR("#VALUE!")),
    ATAN2: (args) => {
        const x = toNumber(scalar(args[0] ?? null));
        const y = toNumber(scalar(args[1] ?? null));
        if (isError(x)) return x;
        if (isError(y)) return y;
        return x === 0 && y === 0 ? ERR("#DIV/0!") : Math.atan2(y, x);
    },
    LOG: (args) => {
        const x = toNumber(scalar(args[0] ?? null));
        const base = args.length > 1 ? toNumber(scalar(args[1])) : 10;
        if (isError(x)) return x;
        if (isError(base)) return base;
        return x <= 0 || base <= 0 || base === 1 ? ERR("#NUM!") : Math.log(x) / Math.log(base);
    },
    POWER: (args) => {
        const x = toNumber(scalar(args[0] ?? null));
        const y = toNumber(scalar(args[1] ?? null));
        if (isError(x)) return x;
        if (isError(y)) return y;
        const result = x ** y;
        return Number.isFinite(result) ? result : ERR("#NUM!");
    },
    MOD: (args) => {
        const x = toNumber(scalar(args[0] ?? null));
        const y = toNumber(scalar(args[1] ?? null));
        if (isError(x)) return x;
        if (isError(y)) return y;
        if (y === 0) return ERR("#DIV/0!");
        return x - y * Math.floor(x / y);
    },
    ROUND: (args) => roundFn(args, "half"),
    ROUNDUP: (args) => roundFn(args, "up"),
    ROUNDDOWN: (args) => roundFn(args, "down"),
    IF: (_args, raw, context) => {
        if (raw.length < 2 || raw.length > 3) return ERR("#VALUE!");
        const condition = toBoolean(scalar(context.evaluate(raw[0])));
        if (isError(condition)) return condition;
        if (condition) return context.evaluate(raw[1]);
        return raw.length === 3 ? context.evaluate(raw[2]) : false;
    },
    IFERROR: (_args, raw, context) => {
        if (raw.length !== 2) return ERR("#VALUE!");
        const value = context.evaluate(raw[0]);
        return isError(scalar(value)) ? context.evaluate(raw[1]) : value;
    },
    AND: (args) => {
        let result = true;
        for (const value of flatten(args)) {
            if (value === null || typeof value === "string") continue;
            const b = toBoolean(value);
            if (isError(b)) return b;
            result = result && b;
        }
        return result;
    },
    OR: (args) => {
        let result = false;
        for (const value of flatten(args)) {
            if (value === null || typeof value === "string") continue;
            const b = toBoolean(value);
            if (isError(b)) return b;
            result = result || b;
        }
        return result;
    },
    NOT: (args) => {
        const b = toBoolean(scalar(args[0] ?? null));
        return isError(b) ? b : !b;
    },
    CONCAT: (args) => concat(flatten(args)),
    CONCATENATE: (args) => concat(args.map(scalar)),
    LEN: (args) => {
        const text = toText(scalar(args[0] ?? null));
        return isError(text) ? text : text.length;
    },
    UPPER: (args) => mapText(args, (t) => t.toUpperCase()),
    LOWER: (args) => mapText(args, (t) => t.toLowerCase()),
    TRIM: (args) => mapText(args, (t) => t.trim().replace(/ +/g, " ")),
    LEFT: (args) => sliceText(args, (t, n) => t.slice(0, n)),
    RIGHT: (args) => sliceText(args, (t, n) => (n === 0 ? "" : t.slice(-n))),
    MID: (args) => {
        const text = toText(scalar(args[0] ?? null));
        const start = toNumber(scalar(args[1] ?? null));
        const count = toNumber(scalar(args[2] ?? null));
        if (isError(text)) return text;
        if (isError(start)) return start;
        if (isError(count)) return count;
        if (start < 1 || count < 0) return ERR("#VALUE!");
        return text.substr(start - 1, count);
    },
    VLOOKUP: (args) => {
        const key = scalar(args[0] ?? null);
        const table = args[1];
        const col = toNumber(scalar(args[2] ?? null));
        const approximate = args.length > 3 ? toBoolean(scalar(args[3])) : true;
        if (!Array.isArray(table)) return ERR("#VALUE!");
        if (isError(col)) return col;
        if (isError(approximate)) return approximate;
        if (col < 1 || col > (table[0]?.length ?? 0)) return ERR("#REF!");
        let found = -1;
        for (let r = 0; r < table.length; r++) {
            const c = compare(table[r][0], key);
            if (c === 0) {
                found = r;
                break;
            }
            if (approximate && c < 0) found = r;
            if (approximate && c > 0) break;
        }
        return found < 0 ? ERR("#N/A") : lookupValue(table, found, col - 1);
    },
    INDEX: (args) => {
        const table = args[0];
        const row = toNumber(scalar(args[1] ?? null));
        const col = args.length > 2 ? toNumber(scalar(args[2])) : 1;
        if (isError(row)) return row;
        if (isError(col)) return col;
        if (!Array.isArray(table)) return row <= 1 && col <= 1 ? (table ?? null) : ERR("#REF!");
        if (row < 1 || col < 1 || row > table.length || col > (table[0]?.length ?? 0)) return ERR("#REF!");
        return lookupValue(table, row - 1, col - 1);
    },
    MATCH: (args) => {
        const key = scalar(args[0] ?? null);
        const list = flatten([args[1] ?? null]);
        const type = args.length > 2 ? toNumber(scalar(args[2])) : 1;
        if (isError(type)) return type;
        let found = -1;
        for (let i = 0; i < list.length; i++) {
            const c = compare(list[i], key);
            if (c === 0) return i + 1;
            if (type === 1 && c < 0) found = i;
            if (type === -1 && c > 0) found = i;
        }
        return type !== 0 && found >= 0 ? found + 1 : ERR("#N/A");
    },
    SUMIF: (args) => conditional(args, "sum"),
    COUNTIF: (args) => conditional(args, "count"),
    AVERAGEIF: (args) => conditionalMany([args[2] ?? args[0], args[0], args[1]], "average"),
    SUMIFS: (args) => conditionalMany(args, "sum"),
    COUNTIFS: (args) => conditionalMany([args[0], ...args], "count"),
    AVERAGEIFS: (args) => conditionalMany(args, "average"),
    MINIFS: (args) => conditionalMany(args, "min"),
    MAXIFS: (args) => conditionalMany(args, "max"),
    SUMPRODUCT: (args) => {
        if (!args.length) return ERR("#VALUE!");
        const arrays = args.map(matrix);
        if (!arrays.every((a) => sameSize(a, arrays[0]))) return ERR("#VALUE!");
        let sum = 0;
        for (let r = 0; r < arrays[0].length; r++) {
            for (let c = 0; c < arrays[0][r].length; c++) {
                let product = 1;
                for (const array of arrays) {
                    const value = array[r][c];
                    if (isError(value)) return value;
                    product *= typeof value === "number" ? value : 0;
                }
                sum += product;
            }
        }
        return sum;
    },
    IFNA: (_args, raw, context) => {
        if (raw.length !== 2) return ERR("#VALUE!");
        const value = context.evaluate(raw[0]);
        const first = scalar(value);
        return isError(first) && first.code === "#N/A" ? context.evaluate(raw[1]) : value;
    },
    IFS: (_args, raw, context) => {
        if (!raw.length || raw.length % 2) return ERR("#VALUE!");
        for (let i = 0; i < raw.length; i += 2) {
            const condition = toBoolean(scalar(context.evaluate(raw[i])));
            if (isError(condition)) return condition;
            if (condition) return context.evaluate(raw[i + 1]);
        }
        return ERR("#N/A");
    },
    ISNUMBER: (args) => typeof scalar(args[0] ?? null) === "number",
    ISTEXT: (args) => typeof scalar(args[0] ?? null) === "string",
    ISBLANK: (args) => scalar(args[0] ?? null) === null,
    ISERROR: (args) => isError(scalar(args[0] ?? null)),
    ISNA: (args) => {
        const value = scalar(args[0] ?? null);
        return isError(value) && value.code === "#N/A";
    },
    TRUE: () => true,
    FALSE: () => false,
    NA: () => ERR("#N/A"),
    TRUNC: (args) => roundFn(args, "down"),
    CLEAN: (args) => mapText(args, (text) => [...text].filter((char) => char.charCodeAt(0) >= 32).join("")),
    PROPER: (args) =>
        mapText(args, (text) =>
            text
                .toLowerCase()
                .replace(
                    /(^|[^a-z])([a-z])/g,
                    (_, before: string, char: string) => before + char.toUpperCase(),
                ),
        ),
    EXACT: (args) => textArgs(args, (a, b) => a === b),
    TEXT: (args) => {
        const value = scalar(args[0] ?? null);
        const format = toText(scalar(args[1] ?? null));
        if (isError(value)) return value;
        return isError(format) ? format : formatCellValue(value, format);
    },
    VALUE: (args) => {
        const text = toText(scalar(args[0] ?? null));
        if (isError(text)) return text;
        const cleaned = text.trim().replace(/[$£€]/g, "").replace(/,/g, "");
        const percent = cleaned.endsWith("%");
        const n = Number(percent ? cleaned.slice(0, -1) : cleaned);
        return cleaned && Number.isFinite(n) ? n / (percent ? 100 : 1) : ERR("#VALUE!");
    },
    TEXTJOIN: (args) => {
        const separator = toText(scalar(args[0] ?? null));
        const ignore = toBoolean(scalar(args[1] ?? null));
        if (isError(separator)) return separator;
        if (isError(ignore)) return ignore;
        const parts: string[] = [];
        for (const value of flatten(args.slice(2))) {
            const text = toText(value);
            if (isError(text)) return text;
            if (!ignore || text !== "") parts.push(text);
        }
        return parts.join(separator);
    },
    SUBSTITUTE: (args) => {
        const texts = args.slice(0, 3).map((a) => toText(scalar(a)));
        const error = texts.find(isError);
        if (error) return error;
        const [text, old, replacement] = texts as string[];
        if (!old) return text;
        const nth = args.length > 3 ? toNumber(scalar(args[3])) : 0;
        if (isError(nth)) return nth;
        if (args.length > 3 && nth < 1) return ERR("#VALUE!");
        const parts = text.split(old);
        if (!nth) return parts.join(replacement);
        const i = Math.trunc(nth);
        return i >= parts.length
            ? text
            : parts.slice(0, i).join(old) + replacement + parts.slice(i).join(old);
    },
    REPT: (args) => {
        const text = toText(scalar(args[0] ?? null));
        const count = toNumber(scalar(args[1] ?? null));
        if (isError(text)) return text;
        if (isError(count)) return count;
        return count < 0 || text.length * count > 32767 ? ERR("#VALUE!") : text.repeat(Math.trunc(count));
    },
    FIND: (args) => findText(args, false),
    SEARCH: (args) => findText(args, true),
    DATE: (args) => {
        const list = args.map((a) => toNumber(scalar(a)));
        const error = list.find(isError);
        if (error) return error;
        let [year, month, day] = (list as number[]).map(Math.trunc);
        if (year >= 0 && year < 1900) year += 1900;
        if (year < 1900 || year > 9999) return ERR("#NUM!");
        // Use serial arithmetic for days so Excel's fictitious 1900-02-29 is retained.
        const start = Date.UTC(year, month - 1, 1);
        return excelSerial(start) + day - 1;
    },
    TIME: (args) => {
        const list = args.map((a) => toNumber(scalar(a)));
        const error = list.find(isError);
        if (error) return error;
        const [h, m, sec] = (list as number[]).map(Math.trunc);
        const seconds = h * 3600 + m * 60 + sec;
        return seconds < 0 ? ERR("#NUM!") : (seconds % 86400) / 86400;
    },
    YEAR: (args) => datePart(args, (d) => d.getUTCFullYear()),
    MONTH: (args) => datePart(args, (d) => d.getUTCMonth() + 1),
    DAY: (args) => (scalar(args[0] ?? null) === 60 ? 29 : datePart(args, (d) => d.getUTCDate())),
    HOUR: (args) => datePart(args, (d) => d.getUTCHours()),
    MINUTE: (args) => datePart(args, (d) => d.getUTCMinutes()),
    SECOND: (args) => datePart(args, (d) => d.getUTCSeconds()),
    TODAY: () => Math.floor(localNowSerial()),
    NOW: () => localNowSerial(),
    EDATE: (args) => shiftMonth(args, false),
    EOMONTH: (args) => shiftMonth(args, true),
    DAYS: (args) => {
        const end = toNumber(scalar(args[0] ?? null));
        const start = toNumber(scalar(args[1] ?? null));
        return isError(end) ? end : isError(start) ? start : Math.floor(end) - Math.floor(start);
    },
    HLOOKUP: (args, raw, context) => {
        const a = matrix(args[1] ?? null);
        const transposed = (a[0] ?? []).map((_, c) => a.map((row) => row[c]));
        return FUNCTIONS["VLOOKUP"]([args[0], transposed, ...args.slice(2)], raw, context);
    },
    XLOOKUP: (args) => xlookup(args),
};

function roundFn(args: Value[], mode: "half" | "up" | "down"): Value {
    const x = toNumber(scalar(args[0] ?? null));
    const digits = args.length > 1 ? toNumber(scalar(args[1])) : 0;
    if (isError(x)) return x;
    if (isError(digits)) return digits;
    return round(x, Math.trunc(digits), mode);
}

function concat(values: Scalar[]): Value {
    let out = "";
    for (const value of values) {
        const text = toText(value);
        if (isError(text)) return text;
        out += text;
    }
    return out;
}

function mapText(args: Value[], f: (text: string) => string): Value {
    const text = toText(scalar(args[0] ?? null));
    return isError(text) ? text : f(text);
}

function sliceText(args: Value[], f: (text: string, count: number) => string): Value {
    const text = toText(scalar(args[0] ?? null));
    const count = args.length > 1 ? toNumber(scalar(args[1])) : 1;
    if (isError(text)) return text;
    if (isError(count)) return count;
    return count < 0 ? ERR("#VALUE!") : f(text, Math.trunc(count));
}

/** SUMIF/COUNTIF criteria: "=5", ">3", "<>x", "abc" (case-insensitive), or a value. */
function matchesCriterion(value: Scalar, criterion: Scalar): boolean {
    if (typeof criterion === "string") {
        const match = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(criterion);
        const op = match?.[1] ?? "=";
        const operandText = match?.[2] ?? criterion;
        const asNumber = Number(operandText);
        const operand: Scalar = operandText !== "" && Number.isFinite(asNumber) ? asNumber : operandText;
        if (typeof operand === "string" && typeof value !== "string" && (op === "=" || op === "<>")) {
            return op === "=" ? operand === "" && value === null : !(operand === "" && value === null);
        }
        if (typeof operand === "number" && typeof value !== "number") return op === "<>";
        if (typeof operand === "string" && typeof value === "string" && (op === "=" || op === "<>")) {
            const match = wildcard(operand).test(value);
            return op === "=" ? match : !match;
        }
        const c = compare(value, operand);
        return op === "="
            ? c === 0
            : op === "<>"
              ? c !== 0
              : op === "<"
                ? c < 0
                : op === ">"
                  ? c > 0
                  : op === "<="
                    ? c <= 0
                    : c >= 0;
    }
    return compare(value, criterion) === 0;
}

function conditional(args: Value[], mode: "sum" | "count"): Value {
    const range = args[0];
    const criterion = scalar(args[1] ?? null);
    const target = args.length > 2 ? args[2] : range;
    if (!Array.isArray(range) || !Array.isArray(target)) return ERR("#VALUE!");
    let total = 0;
    for (let r = 0; r < range.length; r++) {
        for (let c = 0; c < range[r].length; c++) {
            if (!matchesCriterion(range[r][c], criterion)) continue;
            if (mode === "count") total++;
            else {
                const value = lookupValue(target, r, c);
                if (typeof value === "number") total += value;
            }
        }
    }
    return total;
}

const matrix = (value: Value): Scalar[][] => (Array.isArray(value) ? value : [[value]]);
const sameSize = (a: Scalar[][], b: Scalar[][]) =>
    a.length === b.length && a.every((row, i) => row.length === b[i].length);

function wildcard(text: string): RegExp {
    let pattern = "";
    const escapeRegex = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "~" && i + 1 < text.length) pattern += escapeRegex(text[++i]);
        else pattern += c === "*" ? ".*" : c === "?" ? "." : escapeRegex(c);
    }
    return new RegExp(`^${pattern}$`, "i");
}

function conditionalMany(args: Value[], mode: "sum" | "count" | "average" | "min" | "max"): Value {
    if (args.length < 3 || args.length % 2 !== 1) return ERR("#VALUE!");
    const target = matrix(args[0]);
    const ranges: Scalar[][][] = [];
    const criteria: Scalar[] = [];
    for (let i = 1; i < args.length; i += 2) {
        const range = matrix(args[i]);
        const criterion = scalar(args[i + 1]);
        if (isError(criterion)) return criterion;
        if (!sameSize(target, range)) return ERR("#VALUE!");
        ranges.push(range);
        criteria.push(criterion);
    }
    const values: number[] = [];
    let count = 0;
    for (let r = 0; r < target.length; r++) {
        for (let c = 0; c < target[r].length; c++) {
            if (!ranges.every((range, i) => matchesCriterion(range[r][c], criteria[i]))) continue;
            count++;
            const value = target[r][c];
            if (mode !== "count" && isError(value)) return value;
            if (typeof value === "number") values.push(value);
        }
    }
    if (mode === "count") return count;
    if (mode === "min" || mode === "max") return values.length ? Math[mode](...values) : 0;
    if (mode === "average" && !values.length) return ERR("#DIV/0!");
    const total = values.reduce((a, b) => a + b, 0);
    return mode === "average" ? total / values.length : total;
}

function textArgs(args: Value[], fn: (a: string, b: string) => Value): Value {
    const a = toText(scalar(args[0] ?? null));
    const b = toText(scalar(args[1] ?? null));
    return isError(a) ? a : isError(b) ? b : fn(a, b);
}

function findText(args: Value[], insensitive: boolean): Value {
    return textArgs(args, (needle, haystack) => {
        const start = args.length > 2 ? toNumber(scalar(args[2])) : 1;
        if (isError(start)) return start;
        if (start < 1 || start > haystack.length) return ERR("#VALUE!");
        const index = insensitive
            ? (new RegExp(wildcard(needle).source.slice(1, -1), "i").exec(
                  haystack.slice(Math.trunc(start) - 1),
              )?.index ?? -1)
            : haystack.slice(Math.trunc(start) - 1).indexOf(needle);
        return index < 0 ? ERR("#VALUE!") : index + Math.trunc(start);
    });
}

const DAY_MS = 86400000;
function excelSerial(ms: number): number {
    const n = (ms - Date.UTC(1899, 11, 31)) / DAY_MS;
    return n >= 60 ? n + 1 : n;
}
function serialDate(n: number): Date {
    return new Date(Date.UTC(1899, 11, 31) + (n >= 60 ? n - 1 : n) * DAY_MS);
}
function localNowSerial(): number {
    const now = new Date();
    return excelSerial(now.getTime() - now.getTimezoneOffset() * 60000);
}
function datePart(args: Value[], get: (d: Date) => number): Value {
    const n = toNumber(scalar(args[0] ?? null));
    if (isError(n)) return n;
    return n < 0 || n > 2958465 ? ERR("#NUM!") : get(serialDate(n));
}
function shiftMonth(args: Value[], end: boolean): Value {
    const n = toNumber(scalar(args[0] ?? null));
    const months = toNumber(scalar(args[1] ?? null));
    if (isError(n)) return n;
    if (isError(months)) return months;
    if (n < 0) return ERR("#NUM!");
    const d = serialDate(n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + Math.trunc(months) + 1, 0));
    if (!end) last.setUTCDate(Math.min(d.getUTCDate(), last.getUTCDate()));
    const value = excelSerial(last.getTime());
    return Number.isFinite(value) && value >= 0 && value <= 2958465 ? value : ERR("#NUM!");
}

function xlookup(args: Value[]): Value {
    const key = scalar(args[0] ?? null);
    if (isError(key)) return key;
    const a = matrix(args[1] ?? null);
    const b = matrix(args[2] ?? null);
    if (!sameSize(a, b) || (a.length > 1 && a[0].length > 1)) return ERR("#VALUE!");
    const lookup = flatten([a]);
    const result = flatten([b]);
    const mode = args.length > 4 ? toNumber(scalar(args[4])) : 0;
    const order = args.length > 5 ? toNumber(scalar(args[5])) : 1;
    if (isError(mode)) return mode;
    if (isError(order)) return order;
    if (![0, -1, 1, 2].includes(mode) || ![1, -1, 2, -2].includes(order)) return ERR("#VALUE!");
    let best = -1;
    const indices = lookup.map((_, i) => i);
    if (order < 0) indices.reverse();
    for (const i of indices) {
        const item = lookup[i];
        if (isError(item)) return item;
        const c = compare(item, key);
        if (
            mode === 2 && typeof key === "string" && typeof item === "string"
                ? wildcard(key).test(item)
                : c === 0
        )
            return result[i] ?? 0;
        if ((mode === -1 && c < 0) || (mode === 1 && c > 0)) {
            if (best < 0 || (mode === -1 ? compare(item, lookup[best]) > 0 : compare(item, lookup[best]) < 0))
                best = i;
        }
    }
    return best >= 0 ? (result[best] ?? 0) : args.length > 3 ? args[3] : ERR("#N/A");
}

// ------------------------------------------------------------------ Evaluation

interface EvalContext {
    evaluate(ast: Ast): Value;
}

/** The functions the engine evaluates (for the editor's hints). */
export const FORMULA_FUNCTIONS: readonly string[] = Object.keys(FUNCTIONS).sort();

/**
 * Evaluates every cell of a workbook on demand. Create a new one (or call `invalidate`)
 * after editing the workbook.
 */
export class WorkbookEvaluator {
    private readonly memo = new Map<string, Scalar>();
    private readonly active = new Set<string>();

    constructor(private readonly workbook: WorkbookData) {}

    invalidate(): void {
        this.memo.clear();
    }

    private sheetIndex(name: string | undefined, current: number): number {
        if (name === undefined) return current;
        const lower = name.toLowerCase();
        return this.workbook.sheets.findIndex((sheet) => sheet.name.toLowerCase() === lower);
    }

    /** The evaluated value of a cell (null when empty). */
    value(sheet: number, address: string): Scalar {
        const key = `${sheet}!${address}`;
        const memo = this.memo.get(key);
        if (memo !== undefined || this.memo.has(key)) return memo ?? null;
        const cell = this.workbook.sheets[sheet]?.cells[address];
        if (this.active.has(key)) return ERR("#CIRC!");
        this.active.add(key);
        let result: Scalar;
        try {
            result = this.evaluateCell(sheet, cell);
        } finally {
            this.active.delete(key);
        }
        this.memo.set(key, result);
        return result;
    }

    private evaluateCell(sheet: number, cell: CellData | undefined): Scalar {
        if (cell === undefined) return null;
        if (cell.f === undefined) {
            if (cell.v === undefined) return null;
            return cell.e === true && typeof cell.v === "string" ? errorOf(cell.v) : cell.v;
        }
        let ast: Ast;
        try {
            ast = parseFormula(cell.f);
        } catch {
            return cell.v !== undefined && cell.e !== true ? cell.v : ERR("#NAME?");
        }
        const result = scalar(this.evaluate(ast, sheet));
        // A function the engine lacks: keep the value the file stored.
        if (isError(result) && result.code === "#NAME?" && cell.v !== undefined) {
            return cell.e === true && typeof cell.v === "string" ? errorOf(cell.v) : cell.v;
        }
        return result;
    }

    /** Evaluates a formula (without "=") as if it were in `sheet`. */
    evaluateFormula(formula: string, sheet = 0): Scalar {
        try {
            return scalar(this.evaluate(parseFormula(formula), sheet));
        } catch {
            return ERR("#NAME?");
        }
    }

    /** The values of a range, row by row. */
    range(sheet: number, start: { row: number; col: number }, end: { row: number; col: number }): Scalar[][] {
        const rows: Scalar[][] = [];
        for (let r = start.row; r <= end.row; r++) {
            const row: Scalar[] = [];
            for (let c = start.col; c <= end.col; c++) row.push(this.value(sheet, addressOf(r, c)));
            rows.push(row);
        }
        return rows;
    }

    private bounds(sheet: number): { rows: number; cols: number } {
        let rows = 0;
        let cols = 0;
        for (const key of Object.keys(this.workbook.sheets[sheet]?.cells ?? {})) {
            const at = parseAddress(key);
            if (at === undefined) continue;
            rows = Math.max(rows, at.row + 1);
            cols = Math.max(cols, at.col + 1);
        }
        return { rows, cols };
    }

    private reference(ast: Extract<Ast, { type: "ref" }>, current: number): Value {
        const sheet = this.sheetIndex(ast.sheet, current);
        if (sheet < 0) return ERR("#REF!");
        const [a, b] = ast.text.replace(/\$/g, "").split(":");
        if (b === undefined) {
            const at = parseAddress(a);
            return at === undefined ? ERR("#REF!") : this.value(sheet, a.toUpperCase());
        }
        let start: { row: number; col: number } | undefined;
        let end: { row: number; col: number } | undefined;
        if (/^[A-Za-z]+$/.test(a)) {
            const rows = Math.max(1, this.bounds(sheet).rows);
            start = { row: 0, col: columnIndex(a) };
            end = { row: rows - 1, col: columnIndex(b) };
        } else if (/^\d+$/.test(a)) {
            const cols = Math.max(1, this.bounds(sheet).cols);
            start = { row: Number(a) - 1, col: 0 };
            end = { row: Number(b) - 1, col: cols - 1 };
        } else {
            start = parseAddress(a);
            end = parseAddress(b);
        }
        if (start === undefined || end === undefined || start.col < 0 || end.col < 0) return ERR("#REF!");
        return this.range(
            sheet,
            { row: Math.min(start.row, end.row), col: Math.min(start.col, end.col) },
            { row: Math.max(start.row, end.row), col: Math.max(start.col, end.col) },
        );
    }

    private evaluate(ast: Ast, sheet: number): Value {
        switch (ast.type) {
            case "number":
            case "string":
            case "boolean":
                return ast.value;
            case "error":
                return ERR(ast.code);
            case "ref":
                return this.reference(ast, sheet);
            case "unary": {
                const x = toNumber(scalar(this.evaluate(ast.arg, sheet)));
                return isError(x) ? x : -x;
            }
            case "percent": {
                const x = toNumber(scalar(this.evaluate(ast.arg, sheet)));
                return isError(x) ? x : x / 100;
            }
            case "binary":
                return this.binary(
                    ast.op,
                    scalar(this.evaluate(ast.left, sheet)),
                    scalar(this.evaluate(ast.right, sheet)),
                );
            case "call": {
                const fn = FUNCTIONS[ast.name.replace(/^_xlfn\./i, "")];
                if (fn === undefined) return ERR("#NAME?");
                const info = FUNCTION_INFO[ast.name.replace(/^_xlfn\./i, "")];
                if (info && (ast.args.length < info[2] || ast.args.length > (info[3] ?? Infinity)))
                    return ERR("#VALUE!");
                const context: EvalContext = { evaluate: (node) => this.evaluate(node, sheet) };
                const lazy = ["IF", "IFERROR", "IFNA", "IFS"].includes(ast.name.replace(/^_xlfn\./i, ""));
                const args = lazy ? [] : ast.args.map((arg) => this.evaluate(arg, sheet));
                return fn(args, ast.args, context);
            }
        }
    }

    private binary(op: string, left: Scalar, right: Scalar): Scalar {
        if (isError(left)) return left;
        if (isError(right)) return right;
        if (op === "&") {
            const a = toText(left);
            const b = toText(right);
            return isError(a) ? a : isError(b) ? b : a + b;
        }
        if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
            const c = compare(left, right);
            return op === "="
                ? c === 0
                : op === "<>"
                  ? c !== 0
                  : op === "<"
                    ? c < 0
                    : op === ">"
                      ? c > 0
                      : op === "<="
                        ? c <= 0
                        : c >= 0;
        }
        const a = toNumber(left);
        const b = toNumber(right);
        if (isError(a)) return a;
        if (isError(b)) return b;
        switch (op) {
            case "+":
                return a + b;
            case "-":
                return a - b;
            case "*":
                return a * b;
            case "/":
                return b === 0 ? ERR("#DIV/0!") : a / b;
            case "^": {
                const result = a ** b;
                return Number.isFinite(result) ? result : ERR("#NUM!");
            }
        }
        return ERR("#VALUE!");
    }
}

function errorOf(code: string): FormulaError {
    return ERR((ERROR_CODES as string[]).includes(code) ? (code as FormulaErrorCode) : "#N/A");
}

export function isFormulaError(value: unknown): value is FormulaError {
    return value instanceof FormulaError;
}
