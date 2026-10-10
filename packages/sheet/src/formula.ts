// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { offsetRef } from "./formulaArrays";
import { ELEMENTWISE, LIBRARY, setCoreFunctions } from "./formulaLibrary";
import {
    type Ast,
    compare,
    ERR,
    ERROR_CODES,
    type EvalContext,
    excelSerial,
    type Fn,
    FormulaError,
    type FormulaErrorCode,
    flatten,
    isError,
    LambdaValue,
    lift,
    localNowSerial,
    lookupValue,
    matrix,
    numbers,
    numeric1,
    type RangeRef,
    round,
    type Scalar,
    type StructuredSpec,
    sameSize,
    scalar,
    serialDate,
    toBoolean,
    toNumber,
    toText,
    type Value,
    wildcard,
} from "./formulaValues";
import { FUNCTION_INFO } from "./functionInfo";
import { MORE_FUNCTION_INFO } from "./functionInfoMore";
import {
    addressOf,
    type CellData,
    columnIndex,
    parseAddress,
    parseRange,
    type TableData,
    usedSize,
    type WorkbookData,
} from "./model";
import { formatCellValue } from "./numberFormat";
import { resolveRanges } from "./ranges";

export { type Ast, FormulaError, type FormulaErrorCode, type Scalar } from "./formulaValues";
export { generalNumberText } from "./generalNumber";

/**
 * A spreadsheet formula engine for the grid editor and `readDocumentTable`: Excel
 * operators and precedence (`-2^2` = 4, `%`, `&`, comparisons), A1 / absolute / ranged /
 * cross-sheet references (`'Sheet 2'!B3`), structured references to tables
 * (`Sales[Amount]`, `Sales[[#This Row],[Qty]]`, `[@Qty]`), array constants, names (also
 * defined by a formula), and a broad function library (`formulaLibrary.ts`). Values are
 * arrays where Excel's are: operators and per-value functions work element by element, and
 * a formula whose result is an array spills it into the cells below and to the right
 * (`#SPILL!` when one of them holds a value; `A1#` refers to the whole spill). Evaluation
 * is lazy and memoized per workbook revision; reference cycles evaluate to `#CIRC!`. A
 * formula using a function the engine lacks keeps the result stored in the file, so
 * imported workbooks still show their values.
 */

// ------------------------------------------------------------------ Tokens

type Token =
    | { kind: "number"; value: number }
    | { kind: "string"; value: string }
    | { kind: "ref"; sheet?: string; text: string; spill?: boolean }
    | { kind: "structured"; table?: string; spec: StructuredSpec }
    | { kind: "name"; value: string }
    | { kind: "error"; value: FormulaErrorCode }
    | { kind: "op"; value: string };

/** Excel's storage prefixes for newer functions and LET/LAMBDA parameters. */
const PREFIXES = /^(?:_xlfn\.|_xlws\.|_xludf\.|_xlpm\.)+/i;

export function normalizeName(name: string): string {
    return name.replace(PREFIXES, "").toUpperCase();
}

/** The text between the bracket at `start` and its match; `'` escapes the next character. */
function bracket(text: string, start: number): { inner: string; end: number } {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (c === "'") {
            i++;
            continue;
        }
        if (c === "[") depth++;
        else if (c === "]" && --depth === 0) return { inner: text.slice(start + 1, i), end: i + 1 };
    }
    throw new Error("unterminated [");
}

const ITEMS = ["#All", "#Data", "#Headers", "#Totals", "#This Row"] as const;

/** Parses the inside of a structured reference's brackets. */
export function parseStructuredSpec(inner: string): StructuredSpec {
    const unquote = (name: string) => name.replace(/'(.)/g, "$1").trim();
    const item = (part: string) =>
        ITEMS.find((candidate) => candidate.toLowerCase() === part.trim().toLowerCase());
    let text = inner.trim();
    const items: StructuredSpec["items"][number][] = [];
    if (text.startsWith("@")) {
        items.push("#This Row");
        text = text.slice(1).trim();
        if (text === "") return { items };
        if (!text.startsWith("[")) return { items, startColumn: unquote(text) };
    }
    if (!text.startsWith("[")) {
        const found = item(text);
        return found ? { items: [found] } : { items, startColumn: unquote(text) };
    }
    let startColumn: string | undefined;
    let endColumn: string | undefined;
    let i = 0;
    while (i < text.length) {
        if (/[\s,]/.test(text[i])) {
            i++;
            continue;
        }
        if (text[i] !== "[") throw new Error("bad structured reference");
        const { inner: part, end } = bracket(text, i);
        i = end;
        const found = item(part);
        if (found) {
            items.push(found);
            continue;
        }
        startColumn = unquote(part);
        // [A]:[B]
        const rest = text.slice(i);
        const span = /^\s*:\s*\[/.exec(rest);
        if (span) {
            const second = bracket(text, i + span[0].length - 1);
            endColumn = unquote(second.inner);
            i = second.end;
        }
    }
    return { items, startColumn, endColumn };
}

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
        if (char === "[") {
            // A structured reference inside the table: [@Amount], [[#This Row],[Qty]].
            const { inner, end } = bracket(text, i);
            tokens.push({ kind: "structured", spec: parseStructuredSpec(inner) });
            i = end;
            continue;
        }
        const start = i;
        const sheet = sheetPrefix();
        const reference =
            /^(\$?[A-Za-z]{1,3}\$?\d+(:\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+)(?![\w(.[])/.exec(
                text.slice(i),
            );
        if (reference) {
            i += reference[0].length;
            // A1# — the spill range anchored at A1 (an error literal never follows a reference).
            const spill =
                text[i] === "#" && !ERROR_CODES.some((c) => text.slice(i).toUpperCase().startsWith(c));
            if (spill) i++;
            tokens.push({ kind: "ref", sheet, text: reference[0], ...(spill ? { spill } : {}) });
            continue;
        }
        if (sheet !== undefined) throw new Error(`bad reference after ${text.slice(start, i)}`);
        const name = /^[A-Za-z_\\][\w.\\]*/.exec(rest);
        if (name) {
            i += name[0].length;
            if (text[i] === "[") {
                const { inner, end } = bracket(text, i);
                tokens.push({ kind: "structured", table: name[0], spec: parseStructuredSpec(inner) });
                i = end;
                continue;
            }
            tokens.push({ kind: "name", value: normalizeName(name[0]) });
            continue;
        }
        const op = /^(<=|>=|<>|[-+*/^&=<>(),;%{}])/.exec(rest);
        if (op) {
            tokens.push({ kind: "op", value: op[0] });
            i += op[0].length;
            continue;
        }
        throw new Error(`unexpected "${char}"`);
    }
    return tokens;
}

// ------------------------------------------------------------------ Syntax

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

    /** An argument separator: "," or the ";" of locales with a decimal comma. */
    private isSeparator(): boolean {
        return this.isOp(",") || this.isOp(";");
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

    private arrayLiteral(): Ast {
        const rows: Ast[][] = [[]];
        if (this.isOp("}")) throw new Error("empty array");
        for (;;) {
            rows[rows.length - 1].push(this.expression(0));
            if (this.isOp(",")) {
                this.at++;
                continue;
            }
            if (this.isOp(";")) {
                this.at++;
                rows.push([]);
                continue;
            }
            break;
        }
        if (!this.isOp("}")) throw new Error("missing }");
        this.at++;
        if (rows.some((row) => row.length !== rows[0].length)) throw new Error("ragged array");
        return { type: "array", rows };
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
                return {
                    type: "ref",
                    sheet: token.sheet,
                    text: token.text,
                    ...(token.spill ? { spill: true } : {}),
                };
            case "structured":
                return { type: "structured", table: token.table, spec: token.spec };
            case "name": {
                if (this.isOp("(")) {
                    this.at++;
                    const args: Ast[] = [];
                    if (!this.isOp(")")) {
                        for (;;) {
                            // An omitted argument (FN(a,,b)) is an empty value.
                            if (this.isSeparator() || this.isOp(")")) args.push({ type: "name", name: "" });
                            else args.push(this.expression(0));
                            if (this.isSeparator()) {
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
                return { type: "name", name: token.value };
            }
            case "op":
                if (token.value === "(") {
                    const inner = this.expression(0);
                    if (!this.isOp(")")) throw new Error("missing )");
                    this.at++;
                    return inner;
                }
                if (token.value === "{") return this.arrayLiteral();
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
        if (parsed.size > 20000) parsed.clear();
        parsed.set(formula, ast);
    }
    if (ast instanceof Error) throw ast;
    return ast;
}

// ------------------------------------------------------------------ Values

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

// The library adds the rest of Excel's functions and array-aware replacements of a few above.
Object.assign(FUNCTIONS, LIBRARY);
setCoreFunctions((name) => FUNCTIONS[name]);

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

/** The functions the engine evaluates (for the editor's hints). */
export const FORMULA_FUNCTIONS: readonly string[] = Object.keys(FUNCTIONS).sort();

/** Functions whose arguments are evaluated by the function itself (short-circuiting, bindings). */
const LAZY = new Set(["IF", "IFERROR", "IFNA", "IFS", "LET", "LAMBDA", "SWITCH", "CHOOSE"]);

type Binding = Value | LambdaValue;

interface Frame {
    readonly sheet: number;
    readonly cell?: { row: number; col: number };
    readonly scope?: ReadonlyMap<string, Binding>;
}

/** An evaluated formula cell: its full result and whether it came from the engine or the file. */
interface CellResult {
    readonly value: Value;
    readonly live: boolean;
}

interface SpillEntry {
    readonly anchor: string;
    readonly row: number;
    readonly col: number;
}

interface SheetSpills {
    /** Spilled cell address → where its value comes from. */
    readonly cells: Map<string, SpillEntry>;
    /** Anchor address → the spill area ("O10:O24"). */
    readonly areas: Map<string, string>;
    /** Cached spill outputs from the file that the live spill no longer covers. */
    readonly cleared: Set<string>;
}

/**
 * Evaluates every cell of a workbook on demand. Create a new one (or call `invalidate`)
 * after editing the workbook.
 */
export class WorkbookEvaluator {
    private readonly memo = new Map<string, Scalar>();
    private readonly results = new Map<string, CellResult>();
    private readonly active = new Set<string>();
    private readonly spills = new Map<number, SheetSpills>();
    private readonly spillBuilding = new Set<number>();
    private readonly activeNames = new Set<string>();
    private tableIndex?: Map<string, { sheet: number; table: TableData }>;

    constructor(private readonly workbook: WorkbookData) {}

    invalidate(): void {
        this.memo.clear();
        this.results.clear();
        this.spills.clear();
        this.tableIndex = undefined;
    }

    private sheetIndex(name: string | undefined, current: number): number {
        if (name === undefined) return current;
        const lower = name.toLowerCase();
        return this.workbook.sheets.findIndex((sheet) => sheet.name.toLowerCase() === lower);
    }

    /** The evaluated value of a cell (null when empty); a spilled cell shows its part of the spill. */
    value(sheet: number, address: string): Scalar {
        const key = `${sheet}!${address}`;
        const memo = this.memo.get(key);
        if (memo !== undefined || this.memo.has(key)) return memo ?? null;
        const cell = this.workbook.sheets[sheet]?.cells[address];
        if (cell?.f === undefined) {
            const spilled = this.spilledValue(sheet, address, cell);
            if (spilled !== undefined) return spilled;
        }
        const result = this.cellResult(sheet, address);
        let value = scalar(result.value);
        // An array result spills: the anchor shows #SPILL! when its area is blocked.
        if (Array.isArray(result.value) && isSpill(result.value) && !this.spillBuilding.has(sheet)) {
            const spills = this.sheetSpills(sheet);
            if (!spills.areas.has(address)) value = ERR("#SPILL!");
        }
        this.memo.set(key, value);
        return value;
    }

    /** The anchor of the spill a cell is part of (the anchor itself included), if any. */
    spillAnchor(sheet: number, address: string): string | undefined {
        const spills = this.sheetSpills(sheet);
        if (spills.areas.has(address)) return address;
        return spills.cells.get(address)?.anchor;
    }

    /** The area a spilling formula fills ("B2:B9"), or undefined. */
    spillArea(sheet: number, anchor: string): string | undefined {
        return this.sheetSpills(sheet).areas.get(anchor);
    }

    private cellResult(sheet: number, address: string): CellResult {
        const key = `${sheet}!${address}`;
        const done = this.results.get(key);
        if (done !== undefined) return done;
        if (this.active.has(key)) return { value: ERR("#CIRC!"), live: true };
        this.active.add(key);
        let result: CellResult;
        try {
            const at = parseAddress(address);
            result = this.evaluateCell(sheet, at, this.workbook.sheets[sheet]?.cells[address]);
        } finally {
            this.active.delete(key);
        }
        this.results.set(key, result);
        return result;
    }

    private evaluateCell(
        sheet: number,
        at: { row: number; col: number } | undefined,
        cell: CellData | undefined,
    ): CellResult {
        const stored = (): Scalar =>
            cell?.v === undefined
                ? null
                : cell.e === true && typeof cell.v === "string"
                  ? errorOf(cell.v)
                  : cell.v;
        if (cell === undefined) return { value: null, live: true };
        if (cell.f === undefined) return { value: stored(), live: true };
        let ast: Ast;
        try {
            ast = parseFormula(cell.f);
        } catch {
            return { value: cell.v !== undefined && cell.e !== true ? cell.v : ERR("#NAME?"), live: false };
        }
        let value: Value;
        try {
            // A LAMBDA left uncalled in a cell is #CALC!, as in Excel.
            value = this.plain(this.evaluate(ast, { sheet, cell: at }));
        } catch {
            value = ERR("#VALUE!");
        }
        if (Array.isArray(value) && value.length === 0) value = ERR("#CALC!");
        const first = scalar(value);
        // A function the engine lacks: keep the value the file stored.
        if (isError(first) && first.code === "#NAME?" && cell.v !== undefined) {
            return { value: stored(), live: false };
        }
        return { value: Array.isArray(value) && !isSpill(value) ? first : value, live: true };
    }

    /** The value of a cell that holds no formula of its own, when a spill covers it. */
    private spilledValue(sheet: number, address: string, cell: CellData | undefined): Scalar | undefined {
        const blank = cell === undefined || cell.v === undefined || cell.sp === true;
        if (!blank) return undefined;
        if (this.spillBuilding.has(sheet)) return cell?.sp === true ? undefined : null;
        const spills = this.sheetSpills(sheet);
        const entry = spills.cells.get(address);
        if (entry !== undefined) {
            const anchor = this.cellResult(sheet, entry.anchor).value;
            return Array.isArray(anchor) ? (anchor[entry.row]?.[entry.col] ?? null) : null;
        }
        if (cell?.sp === true && spills.cleared.has(address)) return null;
        return undefined;
    }

    /** Evaluates the sheet's formulas once and lays out their spills. */
    private sheetSpills(sheet: number): SheetSpills {
        const known = this.spills.get(sheet);
        if (known !== undefined) return known;
        const spills: SheetSpills = { cells: new Map(), areas: new Map(), cleared: new Set() };
        const data = this.workbook.sheets[sheet];
        if (data === undefined || this.spillBuilding.has(sheet)) return spills;
        this.spillBuilding.add(sheet);
        try {
            for (const [address, cell] of Object.entries(data.cells)) {
                if (cell.f === undefined) continue;
                const at = parseAddress(address);
                if (at === undefined) continue;
                const result = this.cellResult(sheet, address);
                const covered = new Set<string>();
                if (Array.isArray(result.value) && isSpill(result.value)) {
                    const rows = result.value.length;
                    const cols = result.value[0]?.length ?? 0;
                    const targets: string[] = [];
                    let blocked = false;
                    for (let r = 0; r < rows && !blocked; r++) {
                        for (let c = 0; c < cols; c++) {
                            if (r === 0 && c === 0) continue;
                            const target = addressOf(at.row + r, at.col + c);
                            const other = data.cells[target];
                            const occupied =
                                other?.f !== undefined ||
                                (other?.v !== undefined && other.sp !== true) ||
                                spills.cells.has(target);
                            if (occupied) {
                                blocked = true;
                                break;
                            }
                            targets.push(target);
                        }
                    }
                    if (!blocked) {
                        targets.forEach((target) => {
                            const t = parseAddress(target)!;
                            spills.cells.set(target, {
                                anchor: address,
                                row: t.row - at.row,
                                col: t.col - at.col,
                            });
                            covered.add(target);
                        });
                        spills.areas.set(
                            address,
                            `${address}:${addressOf(at.row + rows - 1, at.col + cols - 1)}`,
                        );
                    }
                }
                // The file's cached spill outputs the live result no longer reaches are empty.
                if (cell.a && result.live) {
                    const area = parseRange(cell.a);
                    if (area) {
                        for (let r = area.start.row; r <= area.end.row; r++)
                            for (let c = area.start.col; c <= area.end.col; c++) {
                                const target = addressOf(r, c);
                                if (target !== address && !covered.has(target) && data.cells[target]?.sp)
                                    spills.cleared.add(target);
                            }
                    }
                }
            }
        } finally {
            this.spillBuilding.delete(sheet);
        }
        this.spills.set(sheet, spills);
        // Formulas evaluated while the layout was being built read spilled cells as empty:
        // evaluate them again against it.
        const prefix = `${sheet}!`;
        for (const key of [...this.memo.keys()]) if (key.startsWith(prefix)) this.memo.delete(key);
        for (const key of [...this.results.keys()]) if (key.startsWith(prefix)) this.results.delete(key);
        return spills;
    }

    /** Evaluates a formula (without "=") as if it were in `sheet`. */
    evaluateFormula(formula: string, sheet = 0): Scalar {
        try {
            const value = this.evaluate(parseFormula(formula), { sheet });
            return value instanceof LambdaValue ? ERR("#CALC!") : scalar(value);
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
        const data = this.workbook.sheets[sheet];
        return data === undefined ? { rows: 0, cols: 0 } : usedSize(data);
    }

    // -------------------------------------------------------------- References

    private refOf(ast: Extract<Ast, { type: "ref" }>, current: number): RangeRef | undefined {
        const sheet = this.sheetIndex(ast.sheet, current);
        if (sheet < 0) return undefined;
        const [a, b] = ast.text.replace(/\$/g, "").split(":");
        if (b === undefined) {
            const at = parseAddress(a);
            if (at === undefined) return undefined;
            if (ast.spill) {
                // The anchor's whole result (also while the sheet's spills are being laid out).
                const result = this.cellResult(sheet, addressOf(at.row, at.col)).value;
                if (Array.isArray(result)) {
                    return {
                        sheet,
                        start: at,
                        end: { row: at.row + result.length - 1, col: at.col + (result[0]?.length ?? 1) - 1 },
                    };
                }
            }
            return { sheet, start: at, end: at };
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
        if (start === undefined || end === undefined || start.col < 0 || end.col < 0) return undefined;
        return {
            sheet,
            start: { row: Math.min(start.row, end.row), col: Math.min(start.col, end.col) },
            end: { row: Math.max(start.row, end.row), col: Math.max(start.col, end.col) },
        };
    }

    private tables(): Map<string, { sheet: number; table: TableData }> {
        if (this.tableIndex === undefined) {
            this.tableIndex = new Map();
            this.workbook.sheets.forEach((sheet, index) => {
                for (const table of sheet.tables ?? [])
                    this.tableIndex!.set(table.name.toLowerCase(), { sheet: index, table });
            });
        }
        return this.tableIndex;
    }

    private structuredRef(ast: Extract<Ast, { type: "structured" }>, frame: Frame): RangeRef | FormulaError {
        let found: { sheet: number; table: TableData } | undefined;
        if (ast.table !== undefined) found = this.tables().get(ast.table.toLowerCase());
        else if (frame.cell !== undefined) {
            const { row, col } = frame.cell;
            found = [...this.tables().values()].find((entry) => {
                if (entry.sheet !== frame.sheet) return false;
                const area = parseRange(entry.table.ref);
                return (
                    area !== undefined &&
                    row >= area.start.row &&
                    row <= area.end.row &&
                    col >= area.start.col &&
                    col <= area.end.col
                );
            });
        }
        if (found === undefined) return ERR(ast.table === undefined ? "#REF!" : "#NAME?");
        const { sheet, table } = found;
        const area = parseRange(table.ref);
        if (area === undefined) return ERR("#REF!");
        const header = table.headerRow !== false;
        const totals = table.totalsRow === true;
        const headerRow = area.start.row;
        const firstData = area.start.row + (header ? 1 : 0);
        const lastData = area.end.row - (totals ? 1 : 0);
        const totalsRow = area.end.row;
        const items = ast.spec.items.length === 0 ? ["#Data"] : ast.spec.items;
        let top = Number.POSITIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        const span = (from: number, to: number) => {
            top = Math.min(top, from);
            bottom = Math.max(bottom, to);
        };
        for (const item of items) {
            if (item === "#All") span(area.start.row, area.end.row);
            else if (item === "#Data") span(firstData, lastData);
            else if (item === "#Headers") {
                if (!header) return ERR("#REF!");
                span(headerRow, headerRow);
            } else if (item === "#Totals") {
                if (!totals) return ERR("#REF!");
                span(totalsRow, totalsRow);
            } else {
                const row = frame.cell?.row;
                if (row === undefined || row < firstData || row > lastData || frame.sheet !== sheet)
                    return ERR("#VALUE!");
                span(row, row);
            }
        }
        const columnAt = (name: string) =>
            table.columns.findIndex((column) => column.name.toLowerCase() === name.toLowerCase());
        let left = area.start.col;
        let right = area.end.col;
        if (ast.spec.startColumn !== undefined) {
            const first = columnAt(ast.spec.startColumn);
            const last = ast.spec.endColumn === undefined ? first : columnAt(ast.spec.endColumn);
            if (first < 0 || last < 0) return ERR("#REF!");
            left = area.start.col + Math.min(first, last);
            right = area.start.col + Math.max(first, last);
        }
        if (bottom < top) return ERR("#CALC!");
        return { sheet, start: { row: top, col: left }, end: { row: bottom, col: right } };
    }

    private referenceOf(ast: Ast, frame: Frame): RangeRef | undefined {
        if (ast.type === "ref") return this.refOf(ast, frame.sheet);
        if (ast.type === "structured") {
            const ref = this.structuredRef(ast, frame);
            return isError(ref) ? undefined : ref;
        }
        if (ast.type === "name" && !frame.scope?.has(ast.name)) {
            const ranges = resolveRanges(this.workbook, ast.name, frame.sheet);
            const first = ranges[0];
            return first === undefined ? undefined : { sheet: first.sheet, ...first.range };
        }
        if (ast.type === "call") {
            const name = normalizeName(ast.name);
            // INDEX, OFFSET and INDIRECT return references (e.g. A1:INDEX(…) or ROW(OFFSET(…))).
            const context = this.context(frame);
            const handler = REFERENCE_FUNCTIONS[name];
            return handler?.(ast.args, context);
        }
        return undefined;
    }

    private rangeValues(ref: RangeRef): Value {
        if (ref.start.row === ref.end.row && ref.start.col === ref.end.col) {
            return this.value(ref.sheet, addressOf(ref.start.row, ref.start.col));
        }
        return this.range(ref.sheet, ref.start, ref.end);
    }

    private parseReference(text: string, sheet: number): RangeRef | undefined {
        try {
            const ast = parseFormula(text.trim().replace(/^=/, ""));
            return this.referenceOf(ast, { sheet });
        } catch {
            return undefined;
        }
    }

    private context(frame: Frame): EvalContext {
        return {
            evaluate: (node) => this.plain(this.evaluate(node, frame)),
            evaluateWith: (node, names) => {
                const scope = new Map(frame.scope ?? []);
                for (const [name, value] of names) scope.set(name, value);
                return this.plain(this.evaluate(node, { ...frame, scope }));
            },
            referenceOf: (node) => this.referenceOf(node, frame),
            values: (ref) => this.range(ref.sheet, ref.start, ref.end),
            parseReference: (text) => this.parseReference(text, frame.sheet),
            sheet: frame.sheet,
            cell: frame.cell,
            formulaAt: (sheet, row, col) => this.workbook.sheets[sheet]?.cells[addressOf(row, col)]?.f,
            call: (fn, args) => this.apply(fn, args, frame),
            bind: (node) => this.evaluate(node, frame),
            scope: frame.scope,
        };
    }

    /** A lambda where a value is expected is a #CALC! error, as in Excel. */
    private plain(value: Binding): Value {
        return value instanceof LambdaValue ? ERR("#CALC!") : value;
    }

    private apply(fn: Value | LambdaValue, args: Value[], frame: Frame): Value {
        if (!(fn instanceof LambdaValue)) return ERR("#VALUE!");
        if (args.length > fn.params.length) return ERR("#VALUE!");
        const scope = new Map(fn.closure);
        fn.params.forEach((param, i) => {
            scope.set(param, args[i] ?? null);
        });
        return this.plain(this.evaluate(fn.body, { ...frame, scope }));
    }

    // -------------------------------------------------------------- Expressions

    private evaluate(ast: Ast, frame: Frame): Binding {
        switch (ast.type) {
            case "number":
            case "string":
            case "boolean":
                return ast.value;
            case "error":
                return ERR(ast.code);
            case "ref": {
                const ref = this.refOf(ast, frame.sheet);
                if (ref === undefined) return ERR("#REF!");
                // A1#: the anchor's result itself, whether or not its spill is laid out yet.
                if (ast.spill) {
                    const result = this.cellResult(ref.sheet, addressOf(ref.start.row, ref.start.col)).value;
                    if (Array.isArray(result)) return result;
                }
                return this.rangeValues(ref);
            }
            case "structured": {
                const ref = this.structuredRef(ast, frame);
                return isError(ref) ? ref : this.rangeValues(ref);
            }
            case "array":
                return ast.rows.map((row) =>
                    row.map((item) => scalar(this.plain(this.evaluate(item, frame)))),
                );
            case "name":
                return this.name(ast.name, frame);
            case "unary": {
                const arg = this.plain(this.evaluate(ast.arg, frame));
                return lift([arg], ([x]) => {
                    const n = toNumber(x);
                    return isError(n) ? n : -n;
                });
            }
            case "percent": {
                const arg = this.plain(this.evaluate(ast.arg, frame));
                return lift([arg], ([x]) => {
                    const n = toNumber(x);
                    return isError(n) ? n : n / 100;
                });
            }
            case "binary": {
                const left = this.plain(this.evaluate(ast.left, frame));
                const right = this.plain(this.evaluate(ast.right, frame));
                return lift([left, right], ([a, b]) => binary(ast.op, a, b));
            }
            case "call":
                return this.call(ast, frame);
        }
    }

    private name(name: string, frame: Frame): Binding {
        if (name === "") return null;
        const bound = frame.scope?.get(name);
        if (bound !== undefined || frame.scope?.has(name)) return bound ?? null;
        const named = this.workbook.names?.find((n) => n.name.toUpperCase() === name);
        if (!named) {
            // A table name alone is its data body.
            if (this.tables().has(name.toLowerCase()))
                return this.evaluate({ type: "structured", table: name, spec: { items: [] } }, frame);
            return ERR("#NAME?");
        }
        const ranges = resolveRanges(this.workbook, name, frame.sheet);
        if (ranges.length === named.ranges.length && ranges.length > 0) {
            if (ranges.length === 1) return this.rangeValues({ sheet: ranges[0].sheet, ...ranges[0].range });
            return ranges.flatMap((r) => this.range(r.sheet, r.range.start, r.range.end));
        }
        // A name defined by a formula ("=categories[Subcategory]", "=Rate*12").
        if (named.ranges.length !== 1 || this.activeNames.has(name)) return ERR("#REF!");
        this.activeNames.add(name);
        try {
            return this.evaluate(parseFormula(String(named.ranges[0]).replace(/^=/, "")), frame);
        } catch {
            return ERR("#NAME?");
        } finally {
            this.activeNames.delete(name);
        }
    }

    private call(ast: Extract<Ast, { type: "call" }>, frame: Frame): Binding {
        const name = normalizeName(ast.name);
        const local = frame.scope?.get(name);
        if (local instanceof LambdaValue) {
            return this.apply(
                local,
                ast.args.map((arg) => this.plain(this.evaluate(arg, frame))),
                frame,
            );
        }
        if (name === "LAMBDA") {
            const params = ast.args.slice(0, -1).map((arg) => (arg.type === "name" ? arg.name : ""));
            const body = ast.args.at(-1);
            if (body === undefined || params.some((param) => param === "")) return ERR("#VALUE!");
            return new LambdaValue(params, body, new Map(frame.scope ?? []));
        }
        const fn = FUNCTIONS[name];
        if (fn === undefined) return ERR("#NAME?");
        const info = FUNCTION_INFO[name] ?? MORE_FUNCTION_INFO[name];
        if (info && (ast.args.length < info[2] || ast.args.length > (info[3] ?? Number.POSITIVE_INFINITY)))
            return ERR("#VALUE!");
        const context = this.context(frame);
        if (LAZY.has(name)) return fn([], ast.args, context);
        const args = ast.args.map((arg) => this.plain(this.evaluate(arg, frame)));
        // Per-value functions map over arrays (MONTH(A2:A9) is an array of months).
        if (ELEMENTWISE.has(name) && args.some(Array.isArray)) {
            return lift(args, (scalars) => scalar(fn(scalars, ast.args, context)));
        }
        return fn(args, ast.args, context);
    }
}

/** A result that occupies more than one cell. */
function isSpill(value: Scalar[][]): boolean {
    return value.length > 1 || (value[0]?.length ?? 0) > 1;
}

function binary(op: string, left: Scalar, right: Scalar): Scalar {
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

/** Functions that also return a reference, for ROW(INDEX(…)), A1:INDEX(…), OFFSET(…). */
const REFERENCE_FUNCTIONS: Record<string, (args: Ast[], context: EvalContext) => RangeRef | undefined> = {
    INDEX: (args, context) => {
        const ref = args[0] === undefined ? undefined : context.referenceOf(args[0]);
        if (ref === undefined) return undefined;
        const row = toNumber(scalar(args[1] === undefined ? null : context.evaluate(args[1])));
        const col = toNumber(scalar(args[2] === undefined ? 1 : context.evaluate(args[2])));
        if (isError(row) || isError(col)) return undefined;
        const height = ref.end.row - ref.start.row + 1;
        const width = ref.end.col - ref.start.col + 1;
        const r = height === 1 && args.length === 2 ? 0 : Math.trunc(row) - 1;
        const c = height === 1 && args.length === 2 ? Math.trunc(row) - 1 : Math.trunc(col) - 1;
        if (r >= height || c >= width) return undefined;
        return {
            sheet: ref.sheet,
            start: {
                row: r < 0 ? ref.start.row : ref.start.row + r,
                col: c < 0 ? ref.start.col : ref.start.col + c,
            },
            end: {
                row: r < 0 ? ref.end.row : ref.start.row + r,
                col: c < 0 ? ref.end.col : ref.start.col + c,
            },
        };
    },
    OFFSET: (args, context) => offsetRef(args, context),
    INDIRECT: (args, context) => {
        const text = toText(scalar(args[0] === undefined ? null : context.evaluate(args[0])));
        return isError(text) ? undefined : context.parseReference(text);
    },
};

function errorOf(code: string): FormulaError {
    return ERR((ERROR_CODES as string[]).includes(code) ? (code as FormulaErrorCode) : "#N/A");
}

export function isFormulaError(value: unknown): value is FormulaError {
    return value instanceof FormulaError;
}
