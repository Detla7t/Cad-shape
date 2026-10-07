// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The NC block lexer: one line of a program into a block — block delete, sequence number,
 * address words (a letter and a number, a `#` parameter or a `[ ]` expression), comments
 * in `( )` or after `;`, `#` parameter assignments, LinuxCNC o-word statements, Fanuc
 * macro B control flow (`IF [..] GOTO n`, `WHILE [..] DOm`, `ENDm`, `GOTO n`), Siemens
 * named words (`CR=5`, `A3=0.5`) and keyword statements (`TRAORI`, `CYCLE800(…)`), and
 * printer extended commands (`SET_PRINT_STATS_INFO TOTAL_LAYER=3`). It never throws: what
 * it cannot read lands in `errors` and the rest of the block still counts.
 *
 * Values are kept as written (program units); the interpreter evaluates expressions
 * against its parameters when the block runs.
 */

export type Expr =
    | { readonly k: "num"; readonly v: number }
    /** `#n` (or `#[expr]`). */
    | { readonly k: "var"; readonly index: Expr }
    /** `#<name>` (LinuxCNC named parameter, case-insensitive). */
    | { readonly k: "named"; readonly name: string }
    | { readonly k: "un"; readonly op: "-" | "+" | "NOT"; readonly a: Expr }
    | { readonly k: "bin"; readonly op: string; readonly a: Expr; readonly b: Expr }
    | { readonly k: "fn"; readonly name: string; readonly args: readonly Expr[] };

export interface NcWord {
    /** Upper-case address letter ("$" for a `$n` word). */
    readonly letter: string;
    /** The value when it is a literal number; NaN for a bare letter (`G28 X`) or an expression. */
    readonly value: number;
    /** The value when it must be evaluated (`X#1`, `X[#2*2]`). */
    readonly expr?: Expr;
    /** The literal had a decimal point (Haas dwell P, Fanuc "calculator" input). */
    readonly decimal: boolean;
    /** Column of the word in the line (0-based). */
    readonly column: number;
}

export interface NcAssignment {
    readonly target: Expr;
    readonly value: Expr;
}

export type NcMacro =
    | { readonly kind: "if"; readonly condition: Expr; readonly goto?: Expr; readonly then?: NcAssignment[] }
    | { readonly kind: "goto"; readonly target: Expr }
    | { readonly kind: "while"; readonly condition: Expr; readonly label: number }
    | { readonly kind: "end"; readonly label: number };

export interface NcOWord {
    /** The label, lower case: "100" or "<name>". */
    readonly label: string;
    readonly keyword: string;
    readonly args: readonly Expr[];
}

export interface NcNamed {
    /** Upper-case name: "CR", "A3", "X" (Siemens `X=AC(1)`), a printer command key. */
    readonly name: string;
    readonly value?: Expr;
    /** The value as written when it is not a number (printer command arguments). */
    readonly text: string;
}

export interface NcBlock {
    /** 1-based line number. */
    readonly line: number;
    readonly deleted: boolean;
    /** A `%` tape mark line. */
    readonly percent: boolean;
    readonly sequence?: number;
    /** `O1234` / `:1234` program number (not an o-word statement). */
    readonly programNumber?: string;
    readonly oword?: NcOWord;
    readonly words: readonly NcWord[];
    readonly assignments: readonly NcAssignment[];
    readonly named: readonly NcNamed[];
    /** Multi-letter keywords in order (`TRAORI`, `SUPA`, a printer extended command). */
    readonly keywords: readonly string[];
    /** Keyword calls with their raw argument text (`CYCLE800`, `MSG`). */
    readonly calls: readonly { readonly name: string; readonly args: string }[];
    readonly macro?: NcMacro;
    readonly comments: readonly string[];
    /** Free text after M117/M118 (printer messages). */
    readonly message?: string;
    /** A GRBL `$` system command line. */
    readonly system?: string;
    readonly errors: readonly string[];
    /** The line has nothing executable (blank, comments only). */
    readonly empty: boolean;
}

const OWORD_KEYWORDS = new Set([
    "SUB",
    "ENDSUB",
    "CALL",
    "DO",
    "WHILE",
    "ENDWHILE",
    "IF",
    "ELSEIF",
    "ELSE",
    "ENDIF",
    "REPEAT",
    "ENDREPEAT",
    "RETURN",
    "BREAK",
    "CONTINUE",
]);

const FUNCTIONS = new Set([
    "SIN",
    "COS",
    "TAN",
    "ASIN",
    "ACOS",
    "ATAN",
    "ATN",
    "SQRT",
    "SQR",
    "ABS",
    "ROUND",
    "RND",
    "FIX",
    "FUP",
    "LN",
    "EXP",
    "EXISTS",
    "BIN",
    "BCD",
    "POW",
]);

/** Binary operator precedence (higher binds tighter); LinuxCNC's table, Fanuc's operators. */
const PRECEDENCE: Record<string, number> = {
    "**": 5,
    "*": 4,
    "/": 4,
    MOD: 4,
    "+": 3,
    "-": 3,
    EQ: 2,
    NE: 2,
    GT: 2,
    GE: 2,
    LT: 2,
    LE: 2,
    AND: 1,
    OR: 1,
    XOR: 1,
};

/** Printer text arguments: the rest of the line after these M codes is free text (M115 U5.1.2). */
const MESSAGE_CODES = new Set([115, 117, 118]);

const NO_ERRORS: readonly string[] = Object.freeze([]);

class Cursor {
    pos = 0;
    private list: string[] | undefined;
    constructor(
        readonly text: string,
        /** Upper-case copy for matching. */
        readonly upper: string,
    ) {}

    get done(): boolean {
        return this.pos >= this.text.length;
    }

    /** What could not be read (shared and empty until the first error). */
    get errors(): readonly string[] {
        return this.list ?? NO_ERRORS;
    }

    error(message: string): void {
        this.list ??= [];
        this.list.push(message);
    }

    get errorCount(): number {
        return this.list?.length ?? 0;
    }

    /** Drops errors past `count` (a speculative parse that is retried another way). */
    truncateErrors(count: number): void {
        if (this.list !== undefined) this.list.length = count;
    }

    peek(offset = 0): number {
        return this.upper.charCodeAt(this.pos + offset);
    }

    skipSpaces(): void {
        while (this.pos < this.text.length) {
            const c = this.upper.charCodeAt(this.pos);
            if (c !== 32 && c !== 9) break;
            this.pos++;
        }
    }

    /** Skips spaces and inline `( )` comments (inside expressions and between words). */
    skipFiller(comments?: string[]): void {
        for (;;) {
            this.skipSpaces();
            if (this.peek() !== 40) return;
            const close = this.text.indexOf(")", this.pos + 1);
            const end = close < 0 ? this.text.length : close;
            comments?.push(this.text.slice(this.pos + 1, end).trim());
            this.pos = close < 0 ? this.text.length : close + 1;
        }
    }
}

const isDigit = (c: number) => c >= 48 && c <= 57;
const isLetter = (c: number) => (c >= 65 && c <= 90) || c === 95;

/** Whether the last number `readNumber` read had a decimal point. */
let numberDecimal = false;

/** A number literal at the cursor: `12`, `-1.5`, `.5`, `+3.`; NaN when there is none. */
function readNumber(cursor: Cursor): number {
    const start = cursor.pos;
    let at = start;
    const text = cursor.upper;
    let c = text.charCodeAt(at);
    let spaced = false;
    if (c === 43 || c === 45) {
        at++;
        // Fanuc allows a space after the sign rarely; LinuxCNC allows spaces anywhere.
        while (text.charCodeAt(at) === 32) {
            at++;
            spaced = true;
        }
        c = text.charCodeAt(at);
    }
    let digits = 0;
    let decimal = false;
    while (isDigit(c) || (c === 46 && !decimal)) {
        if (c === 46) decimal = true;
        else digits++;
        at++;
        c = text.charCodeAt(at);
    }
    if (digits === 0) return Number.NaN;
    const literal = spaced ? text.slice(start, at).replace(/\s+/g, "") : text.slice(start, at);
    cursor.pos = at;
    numberDecimal = decimal;
    return Number(literal);
}

/** A primary of an expression: number, parameter, bracketed expression, function, unary. */
function parsePrimary(cursor: Cursor): Expr | undefined {
    cursor.skipFiller();
    const c = cursor.peek();
    if (c === 91) {
        cursor.pos++;
        const inner = parseExpression(cursor);
        cursor.skipFiller();
        if (cursor.peek() === 93) cursor.pos++;
        else cursor.error("missing ]");
        return inner;
    }
    if (c === 35) return parseParameter(cursor);
    if (c === 45 || c === 43) {
        const next = cursor.peek(1);
        if (isDigit(next) || next === 46) {
            const number = readNumber(cursor);
            if (!Number.isNaN(number)) return { k: "num", v: number };
        }
        cursor.pos++;
        const a = parsePrimary(cursor);
        if (a === undefined) return undefined;
        return c === 45 ? { k: "un", op: "-", a } : a;
    }
    if (isDigit(c) || c === 46) {
        const number = readNumber(cursor);
        return Number.isNaN(number) ? undefined : { k: "num", v: number };
    }
    if (isLetter(c)) {
        const start = cursor.pos;
        while (isLetter(cursor.peek())) cursor.pos++;
        const name = cursor.upper.slice(start, cursor.pos);
        if (name === "NOT") {
            const a = parsePrimary(cursor);
            return a === undefined ? undefined : { k: "un", op: "NOT", a };
        }
        if (FUNCTIONS.has(name)) {
            cursor.skipFiller();
            if (cursor.peek() !== 91) {
                cursor.error(`${name} needs [ ]`);
                return undefined;
            }
            const args: Expr[] = [];
            const first = parsePrimary(cursor);
            if (first !== undefined) args.push(first);
            // ATAN[a]/[b]: the second argument is part of the call.
            if (name === "ATAN" || name === "ATN") cursor.skipFiller();
            if ((name === "ATAN" || name === "ATN") && cursor.peek() === 47) {
                const save = cursor.pos;
                cursor.pos++;
                cursor.skipFiller();
                if (cursor.peek() === 91) {
                    const second = parsePrimary(cursor);
                    if (second !== undefined) args.push(second);
                } else {
                    cursor.pos = save;
                }
            }
            return { k: "fn", name, args };
        }
        cursor.pos = start;
        return undefined;
    }
    return undefined;
}

/** `#12`, `#<name>`, `#[expr]`, `##1`. */
function parseParameter(cursor: Cursor): Expr | undefined {
    cursor.pos++; // '#'
    cursor.skipSpaces();
    const c = cursor.peek();
    if (c === 60) {
        const close = cursor.text.indexOf(">", cursor.pos);
        if (close < 0) {
            cursor.error("missing > in a named parameter");
            cursor.pos = cursor.text.length;
            return undefined;
        }
        const name = cursor.upper.slice(cursor.pos + 1, close).replace(/\s+/g, "");
        cursor.pos = close + 1;
        return { k: "named", name };
    }
    if (c === 91 || c === 35) {
        const index = parsePrimary(cursor);
        return index === undefined ? undefined : { k: "var", index };
    }
    const start = cursor.pos;
    while (isDigit(cursor.peek())) cursor.pos++;
    if (cursor.pos === start) {
        cursor.error("# needs a parameter number");
        return undefined;
    }
    return { k: "var", index: { k: "num", v: Number(cursor.upper.slice(start, cursor.pos)) } };
}

/** The next binary operator at the cursor, without consuming it. */
function peekOperator(cursor: Cursor): { op: string; length: number } | undefined {
    cursor.skipFiller();
    const c = cursor.peek();
    if (c === 42) return cursor.peek(1) === 42 ? { op: "**", length: 2 } : { op: "*", length: 1 };
    if (c === 47) return { op: "/", length: 1 };
    if (c === 43) return { op: "+", length: 1 };
    if (c === 45) return { op: "-", length: 1 };
    if (isLetter(c)) {
        const word = /^[A-Z]+/.exec(cursor.upper.slice(cursor.pos, cursor.pos + 4))?.[0] ?? "";
        for (const op of ["MOD", "AND", "XOR", "EQ", "NE", "GT", "GE", "LT", "LE", "OR"]) {
            if (word === op) return { op, length: op.length };
        }
    }
    return undefined;
}

/** A full expression (precedence climbing). */
export function parseExpression(cursor: Cursor, minPrecedence = 1): Expr {
    let left = parsePrimary(cursor);
    if (left === undefined) {
        cursor.error("expected a value");
        return { k: "num", v: Number.NaN };
    }
    for (;;) {
        const operator = peekOperator(cursor);
        if (operator === undefined) break;
        const precedence = PRECEDENCE[operator.op];
        if (precedence < minPrecedence) break;
        cursor.pos += operator.length;
        const right = parseExpression(cursor, operator.op === "**" ? precedence : precedence + 1);
        left = { k: "bin", op: operator.op, a: left, b: right };
    }
    return left;
}

/** The last word value `readWordValue` read. */
let wordValue = Number.NaN;
let wordExpr: Expr | undefined;
let wordDecimal = false;

/**
 * A word's value — a literal, a parameter, a bracketed expression, or a signed one of
 * those — into `wordValue` / `wordExpr` / `wordDecimal`; false when there is none.
 */
function readWordValue(cursor: Cursor): boolean {
    cursor.skipSpaces();
    const c = cursor.peek();
    wordExpr = undefined;
    wordDecimal = false;
    const next = cursor.peek(1);
    const signed = c === 43 || c === 45;
    if (isDigit(c) || c === 46 || (signed && (isDigit(next) || next === 46 || next === 32))) {
        // "X - 1.5": LinuxCNC tolerates spaces inside numbers.
        const number = readNumber(cursor);
        if (!Number.isNaN(number)) {
            wordValue = number;
            wordDecimal = numberDecimal;
            return true;
        }
    }
    if (c === 35 || c === 91 || signed) {
        const expr = parsePrimary(cursor);
        if (expr === undefined) return false;
        wordDecimal = true;
        if (expr.k === "num") {
            wordValue = expr.v;
            return true;
        }
        wordValue = Number.NaN;
        wordExpr = expr;
        return true;
    }
    wordValue = Number.NaN;
    return false;
}

const NO_WORDS: readonly NcWord[] = Object.freeze([]);

/** `list` with `item` appended; a list is only allocated for its first item. */
function append<T>(list: T[] | undefined, item: T): T[] {
    if (list === undefined) return [item];
    list.push(item);
    return list;
}
const NONE: readonly never[] = Object.freeze([]);

function word(letter: string, column: number, found: boolean): NcWord {
    if (!found) return { letter, value: Number.NaN, decimal: false, column };
    return wordExpr === undefined
        ? { letter, value: wordValue, decimal: wordDecimal, column }
        : { letter, value: Number.NaN, expr: wordExpr, decimal: wordDecimal, column };
}

function makeCursor(text: string): Cursor {
    return new Cursor(text, text.toUpperCase());
}

/** Parses a standalone expression (for tests and tools). */
export function parseExpressionText(text: string): { expr: Expr; errors: readonly string[] } {
    const cursor = makeCursor(text);
    const expr = parseExpression(cursor);
    cursor.skipFiller();
    if (!cursor.done) cursor.error(`unexpected "${text.slice(cursor.pos)}"`);
    return { expr, errors: cursor.errors };
}

/** The argument list of an o-word call: `[1] [2+#3]`. */
function readBracketArgs(cursor: Cursor): Expr[] {
    const args: Expr[] = [];
    for (;;) {
        cursor.skipFiller();
        if (cursor.peek() !== 91) break;
        const value = parsePrimary(cursor);
        if (value !== undefined) args.push(value);
    }
    return args;
}

function readAssignment(cursor: Cursor): NcAssignment | undefined {
    const target = parseParameter(cursor);
    cursor.skipSpaces();
    if (target === undefined) return undefined;
    if (cursor.peek() !== 61) {
        cursor.error("a parameter outside a word needs = (an assignment)");
        return undefined;
    }
    cursor.pos++;
    return { target, value: parseExpression(cursor) };
}

function readMacro(cursor: Cursor, keyword: string, comments: string[]): NcMacro | undefined {
    if (keyword === "GOTO") {
        cursor.skipSpaces();
        return { kind: "goto", target: parseExpression(cursor) };
    }
    if (keyword === "IF") {
        cursor.skipFiller(comments);
        if (cursor.peek() !== 91) {
            cursor.error("IF needs a [condition]");
            return undefined;
        }
        const condition = parsePrimary(cursor) ?? { k: "num", v: 0 };
        cursor.skipFiller(comments);
        const next = /^[A-Z]+/.exec(cursor.upper.slice(cursor.pos))?.[0];
        if (next === "GOTO") {
            cursor.pos += 4;
            cursor.skipSpaces();
            return { kind: "if", condition, goto: parseExpression(cursor) };
        }
        if (next === "THEN") {
            cursor.pos += 4;
            const then: NcAssignment[] = [];
            for (;;) {
                cursor.skipFiller(comments);
                if (cursor.peek() !== 35) break;
                const assignment = readAssignment(cursor);
                if (assignment === undefined) break;
                then.push(assignment);
            }
            return { kind: "if", condition, then };
        }
        cursor.error("IF needs GOTO or THEN");
        return undefined;
    }
    if (keyword === "WHILE") {
        cursor.skipFiller(comments);
        const condition = parsePrimary(cursor) ?? { k: "num", v: 0 };
        cursor.skipFiller(comments);
        const match = /^DO\s*(\d+)/.exec(cursor.upper.slice(cursor.pos));
        if (match === null) {
            cursor.error("WHILE needs DOm");
            return undefined;
        }
        cursor.pos += match[0].length;
        return { kind: "while", condition, label: Number(match[1]) };
    }
    return undefined;
}

/** Reads one line into a block. */
export function lexBlock(text: string, line: number): NcBlock {
    const cursor = makeCursor(text.endsWith("\r") ? text.slice(0, -1) : text);
    let words: NcWord[] | undefined;
    let assignments: NcAssignment[] | undefined;
    let named: NcNamed[] | undefined;
    let keywords: string[] | undefined;
    let calls: { name: string; args: string }[] | undefined;
    const comments: string[] = [];
    let deleted = false;
    let percent = false;
    let sequence: number | undefined;
    let programNumber: string | undefined;
    let oword: NcOWord | undefined;
    let macro: NcMacro | undefined;
    let message: string | undefined;
    let system: string | undefined;

    cursor.skipSpaces();
    if (cursor.peek() === 47) {
        deleted = true;
        cursor.pos++;
        if (isDigit(cursor.peek())) cursor.pos++; // "/1".."/9" switch number
    }
    cursor.skipSpaces();
    if (cursor.peek() === 37) {
        percent = true;
        const rest = cursor.text.slice(cursor.pos + 1).trim();
        if (rest !== "") comments.push(rest.replace(/^\(|\)$/g, ""));
        cursor.pos = cursor.text.length;
    } else if (cursor.peek() === 36) {
        system = cursor.text.slice(cursor.pos).trim();
        cursor.pos = cursor.text.length;
    }

    let first = true;
    while (!cursor.done) {
        cursor.skipSpaces();
        if (cursor.done) break;
        const c = cursor.peek();
        const column = cursor.pos;
        if (c === 40) {
            const close = cursor.text.indexOf(")", cursor.pos + 1);
            if (close < 0) {
                comments.push(cursor.text.slice(cursor.pos + 1).trim());
                cursor.error("comment without )");
                break;
            }
            comments.push(cursor.text.slice(cursor.pos + 1, close).trim());
            cursor.pos = close + 1;
            continue;
        }
        if (c === 59) {
            comments.push(cursor.text.slice(cursor.pos + 1).trim());
            break;
        }
        if (c === 42 && /^\*\d+\s*$/.test(cursor.text.slice(cursor.pos))) break; // printer checksum
        if (c === 35) {
            const assignment = readAssignment(cursor);
            if (assignment !== undefined) assignments = append(assignments, assignment);
            else {
                // Skip to the next space so one bad parameter does not swallow the line.
                while (!cursor.done && cursor.peek() !== 32) cursor.pos++;
            }
            first = false;
            continue;
        }
        if (c === 58 && first) {
            // ISO ":1234" program number.
            const match = /^:\s*(\d+)/.exec(cursor.text.slice(cursor.pos));
            if (match) {
                programNumber = match[1];
                cursor.pos += match[0].length;
                first = false;
                continue;
            }
        }
        if (c === 36) {
            cursor.pos++;
            words = append(words, word("$", column, readWordValue(cursor)));
            first = false;
            continue;
        }
        if (c === 44 && isLetter(cursor.peek(1))) {
            // Fanuc ",R2." corner rounding / ",C1." chamfer.
            const letter = cursor.upper[cursor.pos + 1];
            cursor.pos += 2;
            words = append(words, word(`,${letter}`, column, readWordValue(cursor)));
            first = false;
            continue;
        }
        if (!isLetter(c)) {
            if (c === 34) {
                // A quoted string argument (Marlin M862.3 P "MK4"): skip it.
                const close = cursor.text.indexOf('"', cursor.pos + 1);
                cursor.pos = close < 0 ? cursor.text.length : close + 1;
                continue;
            }
            cursor.error(`unexpected "${cursor.text[cursor.pos]}"`);
            cursor.pos++;
            continue;
        }
        // Letters: an address letter, or a keyword.
        const start = cursor.pos;
        while (isLetter(cursor.peek())) cursor.pos++;
        const run = cursor.upper.slice(start, cursor.pos);
        if (run === "O" && first) {
            const match = /^\s*(\d+|<[^>]*>)\s*([A-Z]+)?/.exec(cursor.upper.slice(cursor.pos));
            if (match?.[2] !== undefined && OWORD_KEYWORDS.has(match[2])) {
                cursor.pos += match[0].length;
                const keyword = match[2];
                let args: Expr[] = [];
                if (keyword === "CALL") args = readBracketArgs(cursor);
                else if (["IF", "ELSEIF", "WHILE", "REPEAT", "RETURN", "ENDSUB"].includes(keyword)) {
                    cursor.skipFiller(comments);
                    if (cursor.peek() === 91) {
                        const value = parsePrimary(cursor);
                        if (value !== undefined) args = [value];
                    }
                }
                const label = /^\d+$/.test(match[1])
                    ? String(Number(match[1]))
                    : match[1].toLowerCase().replace(/\s+/g, "");
                oword = { label, keyword, args };
                first = false;
                continue;
            }
            const number = /^\s*(\d+)/.exec(cursor.text.slice(cursor.pos));
            if (number) {
                programNumber = number[1];
                cursor.pos += number[0].length;
                first = false;
                continue;
            }
        }
        if (run.length === 1) {
            // "A3=…", "R1=…" (Siemens): a letter with digits then '='.
            let digitsEnd = cursor.pos;
            while (isDigit(cursor.upper.charCodeAt(digitsEnd))) digitsEnd++;
            if (digitsEnd > cursor.pos) {
                let after = digitsEnd;
                while (cursor.upper.charCodeAt(after) === 32) after++;
                if (cursor.upper.charCodeAt(after) === 61) {
                    const name = `${run}${cursor.upper.slice(cursor.pos, digitsEnd)}`;
                    cursor.pos = after + 1;
                    named = append(named, readNamedValue(cursor, name));
                    first = false;
                    continue;
                }
            }
            cursor.skipSpaces();
            if (cursor.peek() === 61) {
                cursor.pos++;
                named = append(named, readNamedValue(cursor, run));
                first = false;
                continue;
            }
            if (run === "N" && sequence === undefined) {
                const number = readNumber(cursor);
                if (!Number.isNaN(number)) {
                    sequence = number;
                    continue;
                }
            }
            const found = readWordValue(cursor);
            words = append(words, word(run, column, found));
            if (run === "M" && found && MESSAGE_CODES.has(wordValue)) {
                message = cursor.text.slice(cursor.pos).replace(/^\s/, "");
                break;
            }
            first = false;
            continue;
        }
        // A keyword: macro control flow, a keyword call, a named value, or a bare keyword.
        if (run === "DO" || run === "END") {
            const label = /^\s*(\d+)/.exec(cursor.text.slice(cursor.pos));
            if (label !== null) cursor.pos += label[0].length;
            // A lone "DOm" opens an endless loop, which is not supported (ENDm then does nothing).
            if (run === "END" && label !== null) macro = { kind: "end", label: Number(label[1]) };
            first = false;
            continue;
        }
        if (run === "IF" || run === "GOTO" || run === "WHILE") {
            macro = readMacro(cursor, run, comments);
            first = false;
            continue;
        }
        // Keywords may carry digits: CYCLE800, PRINT_START2.
        while (isLetter(cursor.peek()) || isDigit(cursor.peek())) cursor.pos++;
        const keyword = cursor.upper.slice(start, cursor.pos);
        cursor.skipSpaces();
        if (cursor.peek() === 61) {
            cursor.pos++;
            named = append(named, readNamedValue(cursor, keyword));
        } else if (cursor.peek() === 40) {
            let depth = 0;
            let end = cursor.pos;
            for (; end < cursor.text.length; end++) {
                const ch = cursor.text[end];
                if (ch === "(") depth++;
                else if (ch === ")" && --depth === 0) break;
            }
            calls = append(calls, { name: keyword, args: cursor.text.slice(cursor.pos + 1, end) });
            cursor.pos = Math.min(cursor.text.length, end + 1);
        } else {
            keywords = append(keywords, keyword);
        }
        first = false;
    }
    const empty =
        words === undefined &&
        assignments === undefined &&
        named === undefined &&
        keywords === undefined &&
        calls === undefined &&
        macro === undefined &&
        oword === undefined &&
        programNumber === undefined &&
        system === undefined &&
        !percent;
    return {
        line,
        deleted,
        percent,
        sequence,
        programNumber,
        oword,
        words: words ?? NO_WORDS,
        assignments: assignments ?? NONE,
        named: named ?? NONE,
        keywords: keywords ?? NONE,
        calls: calls ?? NONE,
        macro,
        comments,
        message,
        system,
        errors: cursor.errors,
        empty,
    };
}

/** The value of `NAME=value`: a number or expression, else the text up to the next space. */
function readNamedValue(cursor: Cursor, name: string): NcNamed {
    cursor.skipSpaces();
    const start = cursor.pos;
    const c = cursor.peek();
    // Siemens AC(…)/IC(…) absolute/incremental values.
    const mode = /^(AC|IC)\s*\(/.exec(cursor.upper.slice(cursor.pos));
    if (mode !== null) {
        cursor.pos += mode[0].length;
        const value = parseExpression(cursor);
        cursor.skipSpaces();
        if (cursor.peek() === 41) cursor.pos++;
        return { name, value: { k: "fn", name: mode[1], args: [value] }, text: "" };
    }
    if (isDigit(c) || c === 46 || c === 45 || c === 43 || c === 35 || c === 91) {
        const save = cursor.errorCount;
        const value = parseExpression(cursor);
        // The expression must end the value: the line ends, or a space, comment or word follows.
        const ended =
            cursor.done ||
            /[\s;(]/.test(cursor.text[cursor.pos] ?? "") ||
            /\s/.test(cursor.text[cursor.pos - 1] ?? "");
        if (cursor.errorCount === save && ended) {
            return { name, value, text: cursor.text.slice(start, cursor.pos).trim() };
        }
        cursor.truncateErrors(save);
        cursor.pos = start;
    }
    if (c === 34) {
        const close = cursor.text.indexOf('"', cursor.pos + 1);
        cursor.pos = close < 0 ? cursor.text.length : close + 1;
        return { name, text: cursor.text.slice(start + 1, close < 0 ? undefined : close) };
    }
    while (!cursor.done && cursor.peek() !== 32 && cursor.peek() !== 9) cursor.pos++;
    return { name, text: cursor.text.slice(start, cursor.pos) };
}

/** Evaluates an expression; `read` resolves parameters (unset ones read as NaN, "empty"). */
export function evaluate(expr: Expr, read: (index: number | string) => number): number {
    switch (expr.k) {
        case "num":
            return expr.v;
        case "var": {
            const index = evaluate(expr.index, read);
            return read(Math.round(index));
        }
        case "named":
            return read(expr.name);
        case "un": {
            const a = evaluate(expr.a, read);
            if (expr.op === "-") return -a;
            if (expr.op === "NOT") return a === 0 ? 1 : 0;
            return a;
        }
        case "bin": {
            const a = evaluate(expr.a, read);
            const b = evaluate(expr.b, read);
            switch (expr.op) {
                case "+":
                    return a + b;
                case "-":
                    return a - b;
                case "*":
                    return a * b;
                case "/":
                    return a / b;
                case "**":
                    return a ** b;
                case "MOD":
                    return a - b * Math.floor(a / b);
                case "EQ":
                    return Math.abs(a - b) < 1e-9 ? 1 : 0;
                case "NE":
                    return Math.abs(a - b) < 1e-9 ? 0 : 1;
                case "GT":
                    return a > b ? 1 : 0;
                case "GE":
                    return a >= b ? 1 : 0;
                case "LT":
                    return a < b ? 1 : 0;
                case "LE":
                    return a <= b ? 1 : 0;
                case "AND":
                    return a !== 0 && b !== 0 ? 1 : 0;
                case "OR":
                    return a !== 0 || b !== 0 ? 1 : 0;
                case "XOR":
                    return (a !== 0) !== (b !== 0) ? 1 : 0;
                default:
                    return Number.NaN;
            }
        }
        case "fn": {
            const args = expr.args.map((arg) => evaluate(arg, read));
            const x = args[0] ?? Number.NaN;
            const DEG = Math.PI / 180;
            switch (expr.name) {
                case "SIN":
                    return Math.sin(x * DEG);
                case "COS":
                    return Math.cos(x * DEG);
                case "TAN":
                    return Math.tan(x * DEG);
                case "ASIN":
                    return Math.asin(x) / DEG;
                case "ACOS":
                    return Math.acos(x) / DEG;
                case "ATAN":
                case "ATN": {
                    const angle = args.length > 1 ? Math.atan2(x, args[1]) / DEG : Math.atan(x) / DEG;
                    // Fanuc's two-argument ATAN answers 0…360.
                    return args.length > 1 && angle < 0 ? angle + 360 : angle;
                }
                case "SQRT":
                case "SQR":
                    return Math.sqrt(x);
                case "ABS":
                    return Math.abs(x);
                case "ROUND":
                case "RND":
                    return Math.sign(x) * Math.round(Math.abs(x));
                case "FIX":
                    return Math.floor(x);
                case "FUP":
                    return Math.ceil(x);
                case "LN":
                    return Math.log(x);
                case "EXP":
                    return Math.exp(x);
                case "POW":
                    return x ** (args[1] ?? 1);
                case "EXISTS":
                    return Number.isNaN(x) ? 0 : 1;
                case "IC":
                case "AC":
                    return x;
                default:
                    return Number.NaN;
            }
        }
    }
}
