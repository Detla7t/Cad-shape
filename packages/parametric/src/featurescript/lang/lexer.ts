// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsSyntaxError, type SourcePosition } from "./errors";

export type TokenKind = "number" | "string" | "identifier" | "keyword" | "punct" | "eof";

export interface Token {
    readonly kind: TokenKind;
    /** Identifier/keyword/punctuation text, the decoded string body, or the number literal. */
    readonly text: string;
    readonly value?: number;
    readonly pos: SourcePosition;
    /** Offset of the token's first character, for editor diagnostics. */
    readonly start: number;
    readonly end: number;
}

export const KEYWORDS: ReadonlySet<string> = new Set([
    "FeatureScript",
    "annotation",
    "as",
    "break",
    "catch",
    "const",
    "continue",
    "do",
    "else",
    "enum",
    "export",
    "false",
    "for",
    "function",
    "if",
    "import",
    "in",
    "is",
    "new",
    "operator",
    "precondition",
    "predicate",
    "return",
    "returns",
    "silent",
    "switch",
    "throw",
    "true",
    "try",
    "type",
    "typecheck",
    "undefined",
    "var",
    "while",
]);

/** Longest first, so `::` wins over `:` and `||=` over `||`. */
const PUNCTUATION = [
    "||=",
    "&&=",
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
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    ",",
    ";",
    ":",
    ".",
    "?",
    "@",
    "#",
    "~",
    "!",
    "+",
    "-",
    "*",
    "/",
    "%",
    "^",
    "=",
    "<",
    ">",
];

/**
 * Splits FeatureScript source into tokens. Comments (`//`, `/* *\/`) and whitespace are
 * dropped; every token keeps its line/column so the parser and the interpreter can point
 * an error at the code that caused it.
 */
export function tokenize(source: string, file = "<studio>"): Token[] {
    return new Lexer(source, file).run();
}

class Lexer {
    private pos = 0;
    private line = 1;
    private column = 1;
    private readonly tokens: Token[] = [];

    constructor(
        private readonly source: string,
        private readonly file: string,
    ) {}

    run(): Token[] {
        for (;;) {
            this.skipTrivia();
            if (this.pos >= this.source.length) break;
            this.tokens.push(this.next());
        }
        const pos = this.position();
        this.tokens.push({ kind: "eof", text: "<end of file>", pos, start: this.pos, end: this.pos });
        return this.tokens;
    }

    private position(): SourcePosition {
        return { line: this.line, column: this.column, file: this.file };
    }

    private advance(count = 1): void {
        for (let i = 0; i < count; i++) {
            if (this.source[this.pos] === "\n") {
                this.line++;
                this.column = 1;
            } else {
                this.column++;
            }
            this.pos++;
        }
    }

    private skipTrivia(): void {
        for (;;) {
            const ch = this.source[this.pos];
            if (ch === undefined) return;
            if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "﻿") {
                this.advance();
            } else if (ch === "/" && this.source[this.pos + 1] === "/") {
                while (this.pos < this.source.length && this.source[this.pos] !== "\n") this.advance();
            } else if (ch === "/" && this.source[this.pos + 1] === "*") {
                const start = this.position();
                this.advance(2);
                while (
                    this.pos < this.source.length &&
                    !(this.source[this.pos] === "*" && this.source[this.pos + 1] === "/")
                ) {
                    this.advance();
                }
                if (this.pos >= this.source.length) throw new FsSyntaxError("Unterminated comment", start);
                this.advance(2);
            } else {
                return;
            }
        }
    }

    private next(): Token {
        const ch = this.source[this.pos];
        if (isDigit(ch) || (ch === "." && isDigit(this.source[this.pos + 1]))) return this.number();
        if (ch === '"' || ch === "'") return this.string(ch);
        if (isIdentifierStart(ch)) return this.identifier();
        return this.punctuation();
    }

    private number(): Token {
        const pos = this.position();
        const start = this.pos;
        const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.pos));
        const text = match?.[0] ?? "";
        this.advance(text.length);
        if (isIdentifierStart(this.source[this.pos])) {
            throw new FsSyntaxError(`Invalid number literal "${text}${this.source[this.pos]}"`, pos);
        }
        return { kind: "number", text, value: Number(text), pos, start, end: this.pos };
    }

    private string(quote: string): Token {
        const pos = this.position();
        const start = this.pos;
        this.advance();
        let text = "";
        for (;;) {
            const ch = this.source[this.pos];
            if (ch === undefined || ch === "\n") throw new FsSyntaxError("Unterminated string", pos);
            if (ch === quote) {
                this.advance();
                break;
            }
            if (ch === "\\") {
                text += this.escape(pos);
                continue;
            }
            text += ch;
            this.advance();
        }
        return { kind: "string", text, pos, start, end: this.pos };
    }

    private escape(stringStart: SourcePosition): string {
        this.advance();
        const ch = this.source[this.pos];
        this.advance();
        switch (ch) {
            case "n":
                return "\n";
            case "t":
                return "\t";
            case "r":
                return "\r";
            case "\\":
            case '"':
            case "'":
            case "/":
                return ch;
            case "u": {
                const hex = /^[0-9a-fA-F]{4}/.exec(this.source.slice(this.pos))?.[0];
                if (hex === undefined) throw new FsSyntaxError("Invalid unicode escape", stringStart);
                this.advance(4);
                return String.fromCharCode(Number.parseInt(hex, 16));
            }
            default:
                throw new FsSyntaxError(`Invalid escape sequence "\\${ch ?? ""}"`, stringStart);
        }
    }

    private identifier(): Token {
        const pos = this.position();
        const start = this.pos;
        let end = this.pos;
        while (isIdentifierPart(this.source[end])) end++;
        const text = this.source.slice(this.pos, end);
        this.advance(text.length);
        return { kind: KEYWORDS.has(text) ? "keyword" : "identifier", text, pos, start, end: this.pos };
    }

    private punctuation(): Token {
        const pos = this.position();
        const start = this.pos;
        // `a?.b` is optional chaining; `c ? .5 : 1` is a conditional.
        if (this.source.startsWith("?.", this.pos) && !isDigit(this.source[this.pos + 2])) {
            this.advance(2);
            return { kind: "punct", text: "?.", pos, start, end: this.pos };
        }
        for (const punct of PUNCTUATION) {
            if (this.source.startsWith(punct, this.pos)) {
                this.advance(punct.length);
                return { kind: "punct", text: punct, pos, start, end: this.pos };
            }
        }
        throw new FsSyntaxError(`Unexpected character "${this.source[this.pos]}"`, pos);
    }
}

function isDigit(ch: string | undefined): boolean {
    return ch !== undefined && ch >= "0" && ch <= "9";
}

function isIdentifierStart(ch: string | undefined): boolean {
    return ch !== undefined && /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch: string | undefined): boolean {
    return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}
