// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { KEYWORDS } from "../../lang/lexer";

/**
 * A tolerant FeatureScript scanner for the editor. Unlike the language lexer it never
 * throws, keeps comments (doc comments separately), and reports a token's offsets only —
 * so it can scan half-typed code and multi-megabyte std modules alike. `FsScanner` is a
 * cursor over one source without per-token allocation; `scanTokens` collects a source's
 * tokens for code that wants random access (a studio, not the std).
 */

export type ScanKind =
    | "ident"
    | "keyword"
    | "number"
    | "string"
    | "comment"
    | "doc"
    | "builtin"
    | "punct"
    | "eof";

export interface ScanToken {
    readonly kind: ScanKind;
    readonly from: number;
    readonly to: number;
    readonly text: string;
}

/** Std unit constants — `5 * millimeter` highlights the unit. */
export const UNIT_NAMES: ReadonlySet<string> = new Set([
    "unitless",
    "meter",
    "centimeter",
    "millimeter",
    "inch",
    "foot",
    "yard",
    "radian",
    "degree",
    "kilogram",
    "gram",
    "ounce",
    "pound",
    "second",
    "newton",
    "kilonewton",
    "pascal",
    "kilopascal",
    "megapascal",
    "gigapascal",
    "joule",
    "hertz",
]);

/** The language's built-in type names (what `is` accepts without a declaration). */
export const BUILTIN_TYPES: readonly string[] = [
    "number",
    "string",
    "boolean",
    "map",
    "array",
    "function",
    "box",
    "undefined",
    "builtin",
    "ValueWithUnits",
];

const TWO_CHAR = new Set([
    "::",
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "^=",
    "~=",
    "->",
    "=>",
    "??",
]);
/** Two-character punctuation keyed by `first * 128 + second` — no string slicing per token. */
const TWO_CHAR_CODES = new Set([...TWO_CHAR].map((text) => text.charCodeAt(0) * 128 + text.charCodeAt(1)));
/** Keywords are lowercase (and `FeatureScript`) and at most 13 characters long. */
const MAX_KEYWORD = Math.max(...[...KEYWORDS].map((keyword) => keyword.length));

export function isIdentStart(code: number): boolean {
    return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95;
}

export function isIdentPart(code: number): boolean {
    return isIdentStart(code) || (code >= 48 && code <= 57);
}

function isDigit(code: number): boolean {
    return code >= 48 && code <= 57;
}

export class FsScanner {
    kind: ScanKind = "eof";
    start = 0;
    end = 0;
    /** For strings and comments: whether the closing quote / `*\/` was found. */
    closed = true;
    pos: number;

    constructor(
        readonly source: string,
        from = 0,
        private readonly limit = source.length,
    ) {
        this.pos = from;
    }

    text(): string {
        return this.source.slice(this.start, this.end);
    }

    is(text: string): boolean {
        return (
            (this.kind === "punct" || this.kind === "keyword") &&
            this.end - this.start === text.length &&
            this.source.startsWith(text, this.start)
        );
    }

    /** Advances to the next token (comments included) and returns its kind. */
    next(): ScanKind {
        const source = this.source;
        let pos = this.pos;
        const limit = this.limit;
        // Whitespace (and a byte-order mark).
        for (;;) {
            if (pos >= limit) {
                this.kind = "eof";
                this.start = this.end = this.pos = limit;
                return "eof";
            }
            const code = source.charCodeAt(pos);
            if (code === 32 || code === 9 || code === 10 || code === 13 || code === 0xfeff) pos++;
            else break;
        }
        this.start = pos;
        this.closed = true;
        const code = source.charCodeAt(pos);
        const nextCode = pos + 1 < limit ? source.charCodeAt(pos + 1) : -1;
        if (code === 47 && nextCode === 47) {
            // Line comment.
            const newline = source.indexOf("\n", pos + 2);
            pos = newline < 0 || newline > limit ? limit : newline;
            this.kind = "comment";
        } else if (code === 47 && nextCode === 42) {
            const doc = source.charCodeAt(pos + 2) === 42 && source.charCodeAt(pos + 3) !== 47;
            const close = source.indexOf("*/", pos + 2);
            if (close < 0 || close + 2 > limit) {
                pos = limit;
                this.closed = false;
            } else {
                pos = close + 2;
            }
            this.kind = doc ? "doc" : "comment";
        } else if (code === 34 || code === 39) {
            pos++;
            for (;;) {
                if (pos >= limit) {
                    this.closed = false;
                    break;
                }
                const c = source.charCodeAt(pos);
                if (c === 10) {
                    this.closed = false;
                    break;
                }
                if (c === 92) {
                    pos += 2;
                    continue;
                }
                pos++;
                if (c === code) break;
            }
            if (pos > limit) pos = limit;
            this.kind = "string";
        } else if (isDigit(code) || (code === 46 && isDigit(nextCode))) {
            pos = scanNumber(source, pos, limit);
            this.kind = "number";
        } else if (isIdentStart(code)) {
            pos++;
            while (pos < limit && isIdentPart(source.charCodeAt(pos))) pos++;
            const maybeKeyword =
                pos - this.start <= MAX_KEYWORD && ((code >= 97 && code <= 122) || code === 70);
            this.kind = maybeKeyword && KEYWORDS.has(source.slice(this.start, pos)) ? "keyword" : "ident";
        } else if (code === 64 && isIdentStart(nextCode)) {
            pos += 2;
            while (pos < limit && isIdentPart(source.charCodeAt(pos))) pos++;
            this.kind = "builtin";
        } else {
            if ((code === 124 || code === 38) && nextCode === code && source.charCodeAt(pos + 2) === 61)
                pos += 3;
            else if (code === 63 && nextCode === 46 && !isDigit(source.charCodeAt(pos + 2))) pos += 2;
            else if (
                code < 128 &&
                nextCode >= 0 &&
                nextCode < 128 &&
                TWO_CHAR_CODES.has(code * 128 + nextCode)
            ) {
                pos += 2;
            } else pos += 1;
            this.kind = "punct";
        }
        this.end = pos;
        this.pos = pos;
        return this.kind;
    }

    /** Advances to the next token that is not a comment. */
    nextSignificant(): ScanKind {
        for (;;) {
            const kind = this.next();
            if (kind !== "comment" && kind !== "doc") return kind;
        }
    }

    /**
     * With the current token an opening bracket, skips to just past its matching closer
     * (or the end of the source) and leaves that closer as the current token.
     */
    skipBalanced(): void {
        let depth = 0;
        do {
            if (this.kind === "punct") {
                const code = this.source.charCodeAt(this.start);
                if (this.end - this.start === 1) {
                    if (code === 123 || code === 40 || code === 91) depth++;
                    else if (code === 125 || code === 41 || code === 93) depth--;
                }
            }
            if (depth === 0) return;
        } while (this.next() !== "eof");
    }
}

function scanNumber(source: string, pos: number, limit: number): number {
    while (pos < limit && isDigit(source.charCodeAt(pos))) pos++;
    if (source.charCodeAt(pos) === 46) {
        pos++;
        while (pos < limit && isDigit(source.charCodeAt(pos))) pos++;
    }
    const e = source.charCodeAt(pos);
    if (e === 101 || e === 69) {
        let p = pos + 1;
        const sign = source.charCodeAt(p);
        if (sign === 43 || sign === 45) p++;
        if (isDigit(source.charCodeAt(p))) {
            pos = p;
            while (pos < limit && isDigit(source.charCodeAt(pos))) pos++;
        }
    }
    return pos;
}

/** `\r\n` and `\r` → `\n`: what the editor's document holds, so offsets agree with it. */
export function normalizeNewlines(text: string): string {
    return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** Every token of `source`, comments included (the final `eof` excluded). */
export function scanTokens(source: string): ScanToken[] {
    const scanner = new FsScanner(source);
    const tokens: ScanToken[] = [];
    while (scanner.next() !== "eof") {
        tokens.push({ kind: scanner.kind, from: scanner.start, to: scanner.end, text: scanner.text() });
    }
    return tokens;
}

/** Whether a string token's text ends with its (unescaped) closing quote. */
export function isClosedString(text: string): boolean {
    if (text.length < 2 || !text.endsWith(text[0])) return false;
    let backslashes = 0;
    for (let i = text.length - 2; i > 0 && text[i] === "\\"; i--) backslashes++;
    return backslashes % 2 === 0;
}

/** The decoded body of a string token's text (quotes removed, escapes resolved). */
export function stringValue(text: string): string {
    const quote = text[0];
    let body = text.slice(1);
    if (body.endsWith(quote) && !body.endsWith(`\\${quote}`)) body = body.slice(0, -1);
    return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, sequence: string) => {
        if (sequence[0] === "u" && sequence.length === 5)
            return String.fromCharCode(Number.parseInt(sequence.slice(1), 16));
        if (sequence === "n") return "\n";
        if (sequence === "t") return "\t";
        if (sequence === "r") return "\r";
        return sequence;
    });
}

/**
 * Index of the token containing `pos`, or -1. A token ending at `pos` counts — except
 * that a word starting exactly there wins over the token before it (`(|bar` is `bar`).
 */
export function tokenIndexAt(tokens: readonly ScanToken[], pos: number): number {
    // The first token ending at or after pos.
    let low = 0;
    let high = tokens.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (tokens[mid].to < pos) low = mid + 1;
        else high = mid;
    }
    const token = tokens[low];
    if (token === undefined || token.from > pos) return -1;
    const next = tokens[low + 1];
    if (token.to === pos && next?.from === pos && (next.kind === "ident" || next.kind === "keyword")) {
        return low + 1;
    }
    return low;
}

/** Index of the last token that ends at or before `pos`, or -1. */
export function tokenIndexBefore(tokens: readonly ScanToken[], pos: number): number {
    let low = 0;
    let high = tokens.length - 1;
    let found = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (tokens[mid].to <= pos) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return found;
}
