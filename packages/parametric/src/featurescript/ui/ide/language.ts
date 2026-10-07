// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    foldService,
    LanguageSupport,
    StreamLanguage,
    type StreamParser,
    type StringStream,
} from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import { KEYWORDS } from "../../lang/lexer";
import { type FoldRange, foldRanges } from "./folding";
import { indentFor, type OpenBracket } from "./format";
import { UNIT_NAMES } from "./scanner";

/**
 * FeatureScript for CodeMirror: a streaming tokenizer (incremental and viewport-driven,
 * so multi-thousand-line std modules highlight as fast as a studio), brace-depth
 * indentation, comment tokens, auto-closed brackets and quotes, and folding of bracket
 * pairs and block comments.
 *
 * Token styles are CodeMirror tag names: `typeName` after `is`/`returns`/`as`, `meta`
 * for `annotation`, `attributeName` for annotation keys, `variableName.standard` for
 * `@builtins`, `unit` for `millimeter`/`degree`/..., `escape` inside strings,
 * `docComment` + `labelName` (doc tags like `@param`) for `/** *\/` comments.
 */

export interface FsStreamState {
    /** Inside a multi-line comment: a plain block or a doc comment. */
    comment: "none" | "block" | "doc";
    /** Inside a string (strings cannot span lines): its quote. */
    string: string | undefined;
    /** The string's role, decided when it opened. */
    stringStyle: string;
    /** Bracket depth (annotation maps are tracked by it). */
    depth: number;
    /** The open brackets with the indentation of the line each is on — what indentation follows. */
    open: OpenBracket[];
    /** The current line's number (counting non-blank lines) and indentation. */
    line: number;
    lineIndent: number;
    /** The indentation of the line a multi-line comment started on. */
    commentIndent: number;
    /** The next identifier is a type (`is`, `returns`, `as`, `typecheck`, `::`). */
    expectType: boolean;
    /** The next identifier is being declared. */
    expectDefinition: "none" | "function" | "variable" | "type";
    /** Saw `annotation`; the next `{` opens an annotation map. */
    annotationPending: boolean;
    /** Depth inside the innermost open annotation map, or -1. */
    annotationDepth: number;
    afterDot: boolean;
}

const CONTROL = new Set([
    "if",
    "else",
    "for",
    "while",
    "do",
    "return",
    "break",
    "continue",
    "throw",
    "try",
    "catch",
    "switch",
    "in",
]);
const DEFINITION = new Set([
    "function",
    "predicate",
    "operator",
    "const",
    "var",
    "enum",
    "type",
    "export",
    "import",
]);
const TYPE_INTRODUCERS = new Set(["is", "returns", "as", "typecheck"]);
const OPERATOR = /^(?:\|\|=|&&=|->|=>|\?\?|==|!=|<=|>=|&&|\|\||[+\-*/%^~]=|[+\-*/%^~=<>!?])/;

export function startState(): FsStreamState {
    return {
        comment: "none",
        string: undefined,
        stringStyle: "string",
        depth: 0,
        open: [],
        line: 0,
        lineIndent: 0,
        commentIndent: 0,
        expectType: false,
        expectDefinition: "none",
        annotationPending: false,
        annotationDepth: -1,
        afterDot: false,
    };
}

function commentBody(stream: StringStream, state: FsStreamState): string {
    const doc = state.comment === "doc";
    const style = doc ? "docComment" : "comment";
    if (doc && stream.match(/^@\w+/)) return "labelName";
    while (!stream.eol()) {
        if (stream.match("*/")) {
            state.comment = "none";
            return style;
        }
        if (doc && stream.peek() === "@" && /\w/.test(stream.string.charAt(stream.pos + 1))) {
            const before = stream.string.charAt(stream.pos - 1);
            if (before === "" || /[\s*{]/.test(before)) return style;
        }
        stream.next();
    }
    return style;
}

function stringBody(stream: StringStream, state: FsStreamState): string {
    const quote = state.string as string;
    if (stream.peek() === "\\") {
        stream.next();
        if (!stream.match(/^u[0-9a-fA-F]{4}/)) stream.next();
        return "escape";
    }
    while (!stream.eol()) {
        const ch = stream.peek();
        if (ch === "\\") return state.stringStyle;
        stream.next();
        if (ch === quote) {
            state.string = undefined;
            return state.stringStyle;
        }
    }
    // An unterminated string ends with its line.
    state.string = undefined;
    return state.stringStyle;
}

/** Whether a string starting at the stream position is followed by `:` (a map key). */
function isMapKey(stream: StringStream, quote: string): boolean {
    const text = stream.string;
    let i = stream.pos + 1;
    while (i < text.length) {
        const ch = text[i];
        if (ch === "\\") i += 2;
        else if (ch === quote) break;
        else i++;
    }
    return /^\s*:(?!:)/.test(text.slice(i + 1));
}

function identifierStyle(word: string, stream: StringStream, state: FsStreamState): string {
    if (KEYWORDS.has(word)) {
        state.expectDefinition = "none";
        if (word === "true" || word === "false") return "bool";
        if (word === "undefined") {
            if (!state.expectType) return "null";
            state.expectType = false;
            return "typeName";
        }
        if (word === "annotation") {
            state.annotationPending = true;
            return "meta";
        }
        if (word === "FeatureScript") return "meta";
        if (TYPE_INTRODUCERS.has(word)) {
            state.expectType = true;
            return "operatorKeyword";
        }
        if (word === "function" && state.expectType) {
            state.expectType = false;
            return "typeName";
        }
        if (word === "function" || word === "predicate") state.expectDefinition = "function";
        else if (word === "const" || word === "var") state.expectDefinition = "variable";
        else if (word === "enum" || word === "type") state.expectDefinition = "type";
        if (CONTROL.has(word)) return "controlKeyword";
        if (DEFINITION.has(word))
            return word === "import" || word === "export" ? "moduleKeyword" : "definitionKeyword";
        return "keyword";
    }
    if (state.expectType) {
        state.expectType = Boolean(stream.match(/^\s*::/, false));
        return "typeName";
    }
    const definition = state.expectDefinition;
    state.expectDefinition = "none";
    if (definition === "function") return "variableName.function.definition";
    if (definition === "variable") return "variableName.definition";
    if (definition === "type") return "typeName.definition";
    const call = stream.match(/^\s*\(/, false);
    if (state.afterDot) {
        if (call) return "propertyName.function";
        return /^[A-Z][A-Z0-9_]*$/.test(word) ? "variableName.constant" : "propertyName";
    }
    if (UNIT_NAMES.has(word)) return "unit";
    if (call) return "variableName.function";
    if (/^[A-Z][A-Z0-9_]+$/.test(word)) return "variableName.constant";
    if (/^[A-Z]/.test(word) && /[a-z]/.test(word)) return "typeName";
    return "variableName";
}

/** One token of FeatureScript; the `StreamParser.token` of the language. */
export function fsToken(stream: StringStream, state: FsStreamState): string | null {
    if (stream.sol()) {
        state.string = undefined;
        state.line++;
        state.lineIndent = stream.indentation();
    }
    if (state.comment !== "none") return commentBody(stream, state);
    if (state.string !== undefined) return stringBody(stream, state);
    if (stream.eatSpace()) return null;

    const afterDot = state.afterDot;
    state.afterDot = false;

    if (stream.match("//")) {
        stream.skipToEnd();
        return "comment";
    }
    if (stream.match(/^\/\*\*(?!\/)/)) {
        state.comment = "doc";
        state.commentIndent = state.lineIndent;
        return commentBody(stream, state);
    }
    if (stream.match("/*")) {
        state.comment = "block";
        state.commentIndent = state.lineIndent;
        return commentBody(stream, state);
    }
    const ch = stream.peek() as string;
    if (ch === '"' || ch === "'") {
        const key = isMapKey(stream, ch);
        state.stringStyle = key && state.annotationDepth === state.depth ? "attributeName" : "string";
        stream.next();
        state.string = ch;
        state.expectType = false;
        // The opening quote stays its own token when an escape follows it.
        if (stream.peek() === "\\") return state.stringStyle;
        return stringBody(stream, state);
    }
    if (stream.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)) {
        state.expectType = false;
        return "number";
    }
    if (stream.match(/^@[A-Za-z_]\w*/)) return "variableName.standard";
    const word = stream.match(/^[A-Za-z_]\w*/);
    if (word && typeof word === "object") {
        state.afterDot = afterDot;
        const style = identifierStyle(word[0], stream, state);
        state.afterDot = false;
        return style;
    }
    if (stream.match("::")) {
        state.expectType = true;
        return "punctuation";
    }
    state.expectType = false;
    if (stream.match("?.") || stream.match(".")) {
        state.afterDot = true;
        return "punctuation";
    }
    const next = stream.next() as string;
    if (next === "{" || next === "(" || next === "[") {
        state.depth++;
        state.open.push({ indent: state.lineIndent, line: state.line });
        if (next === "{" && state.annotationPending) {
            state.annotationPending = false;
            state.annotationDepth = state.depth;
        }
        return "bracket";
    }
    if (next === "}" || next === ")" || next === "]") {
        if (next === "}" && state.annotationDepth === state.depth) state.annotationDepth = -1;
        state.depth = Math.max(0, state.depth - 1);
        state.open.pop();
        return "bracket";
    }
    if (next === "," || next === ";" || next === ":") {
        if (next === ";") state.expectDefinition = "none";
        return "punctuation";
    }
    stream.backUp(1);
    if (stream.match(OPERATOR)) return "operator";
    stream.next();
    return "invalid";
}

export const fsStreamParser: StreamParser<FsStreamState> = {
    name: "featurescript",
    startState,
    token: fsToken,
    copyState: (state) => ({ ...state, open: state.open.slice() }),
    indent(state, textAfter, context) {
        if (state.comment !== "none") return state.commentIndent + 1;
        return indentFor(state.open, textAfter, context.unit);
    },
    languageData: {
        commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
        closeBrackets: { brackets: ["(", "[", "{", '"', "'"] },
        indentOnInput: /^\s*[}\])]$/,
    },
};

export const featureScriptLanguage = StreamLanguage.define(fsStreamParser);

/** Fold ranges of a document, computed once per document version. */
const foldCache = new WeakMap<Text, Map<number, FoldRange>>();

function foldsOf(state: EditorState): Map<number, FoldRange> {
    let ranges = foldCache.get(state.doc);
    if (ranges === undefined) {
        ranges = foldRanges(state.doc.toString());
        foldCache.set(state.doc, ranges);
    }
    return ranges;
}

const fsFolding = foldService.of((state, lineStart) => {
    const range = foldsOf(state).get(state.doc.lineAt(lineStart).number);
    return range === undefined ? null : { from: range.from, to: range.to };
});

export function featureScript(): LanguageSupport {
    return new LanguageSupport(featureScriptLanguage, [fsFolding]);
}
