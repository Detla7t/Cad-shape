// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Declaration } from "./declarations";
import { type ScanToken, tokenIndexAt, tokenIndexBefore } from "./scanner";

/**
 * Questions about a position in a studio's source, answered from its tokens: which call's
 * argument the cursor is in, which map literal, which local names are in scope, what
 * precedes a member access. Pure functions over `scanTokens` output, shared by
 * completion, hover, signature help and go-to-definition.
 */

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const NOT_CALLEES = new Set([
    "if",
    "while",
    "for",
    "switch",
    "function",
    "return",
    "catch",
    "typecheck",
    "try",
]);
/** Tokens after which `{` starts a map literal rather than a block. */
const MAP_PRECEDERS = new Set([
    "(",
    ",",
    ":",
    "=",
    "[",
    "?",
    "return",
    "+",
    "-",
    "*",
    "&&",
    "||",
    "??",
    "==",
    "!=",
    "annotation",
    "+=",
    "=>",
]);

function significant(token: ScanToken | undefined): boolean {
    return token !== undefined && token.kind !== "comment" && token.kind !== "doc";
}

/** Index of the first significant token before index `i`, or -1. */
export function previousSignificant(tokens: readonly ScanToken[], i: number): number {
    for (let j = i - 1; j >= 0; j--) if (significant(tokens[j])) return j;
    return -1;
}

export function nextSignificant(tokens: readonly ScanToken[], i: number): number {
    for (let j = i + 1; j < tokens.length; j++) if (significant(tokens[j])) return j;
    return -1;
}

function isPunct(token: ScanToken | undefined, text: string): boolean {
    return token !== undefined && (token.kind === "punct" || token.kind === "keyword") && token.text === text;
}

/** The innermost bracket open at `pos` (index of its token), or -1 at the top level. */
export function enclosingOpener(tokens: readonly ScanToken[], pos: number): number {
    let depth = 0;
    for (let i = tokenIndexBefore(tokens, pos); i >= 0; i--) {
        const token = tokens[i];
        if (token.kind !== "punct") continue;
        if (CLOSERS.has(token.text)) depth++;
        else if (OPENERS.has(token.text)) {
            if (depth === 0) return i;
            depth--;
        }
    }
    return -1;
}

/** Whether the `{` at token index `i` opens a map literal (rather than a block). */
export function isMapBrace(tokens: readonly ScanToken[], i: number): boolean {
    const before = tokens[previousSignificant(tokens, i)];
    if (before === undefined) return false;
    if (before.kind === "keyword" && before.text === "annotation") return true;
    return (before.kind === "punct" || before.kind === "keyword") && MAP_PRECEDERS.has(before.text);
}

export interface CallContext {
    /** The callee name (`opExtrude`), with its namespace when qualified. */
    readonly callee: string;
    readonly namespace?: string;
    /** Token index of the call's `(`. */
    readonly open: number;
    /** 0-based index of the argument holding the position. */
    readonly argument: number;
}

/** The call whose argument list holds `pos` — through map and array literals, not through blocks. */
export function callAt(tokens: readonly ScanToken[], pos: number): CallContext | undefined {
    let depth = 0;
    let commas = 0;
    for (let i = tokenIndexBefore(tokens, pos); i >= 0; i--) {
        const token = tokens[i];
        if (token.kind !== "punct") continue;
        if (CLOSERS.has(token.text)) {
            depth++;
            continue;
        }
        if (OPENERS.has(token.text)) {
            if (depth > 0) {
                depth--;
                continue;
            }
            if (token.text === "{" && !isMapBrace(tokens, i)) return undefined;
            if (token.text !== "(") {
                commas = 0;
                continue;
            }
            const calleeIndex = previousSignificant(tokens, i);
            const callee = tokens[calleeIndex];
            if (callee === undefined || callee.kind !== "ident") {
                // A parenthesized expression or a keyword's condition: keep looking outwards.
                if (callee !== undefined && callee.kind === "keyword" && NOT_CALLEES.has(callee.text))
                    return undefined;
                commas = 0;
                continue;
            }
            const sep = previousSignificant(tokens, calleeIndex);
            const namespaceToken = isPunct(tokens[sep], "::")
                ? tokens[previousSignificant(tokens, sep)]
                : undefined;
            return {
                callee: callee.text,
                namespace: namespaceToken?.kind === "ident" ? namespaceToken.text : undefined,
                open: i,
                argument: commas,
            };
        }
        if (depth === 0 && token.text === ",") commas++;
        if (depth === 0 && token.text === ";") return undefined;
    }
    return undefined;
}

export interface MapKeyContext {
    /** Token index of the map literal's `{`. */
    readonly open: number;
    /** True for an `annotation { ... }` map. */
    readonly annotation: boolean;
    /** The call the map is an argument of, if any. */
    readonly call?: CallContext;
}

/**
 * When the string token at index `i` sits where a map literal expects a key (right after
 * the `{` or a `,`), the map it belongs to.
 */
export function mapKeyAt(tokens: readonly ScanToken[], i: number): MapKeyContext | undefined {
    const token = tokens[i];
    if (token === undefined) return undefined;
    const before = tokens[previousSignificant(tokens, i)];
    if (!isPunct(before, "{") && !isPunct(before, ",")) return undefined;
    const open = enclosingOpener(tokens, token.from);
    if (open < 0 || tokens[open].text !== "{" || !isMapBrace(tokens, open)) return undefined;
    const keyword = tokens[previousSignificant(tokens, open)];
    const annotation = keyword?.kind === "keyword" && keyword.text === "annotation";
    return { open, annotation, call: annotation ? undefined : callAt(tokens, tokens[open].from) };
}

export interface MemberContext {
    /** The identifier before the `.` (`BoundingType` in `BoundingType.BL`). */
    readonly object: string;
    readonly objectIndex: number;
}

/** When the word ending at `wordFrom` follows `ident.`, that identifier. */
export function memberBefore(tokens: readonly ScanToken[], wordFrom: number): MemberContext | undefined {
    const dot = tokenIndexBefore(tokens, wordFrom);
    if (dot < 0) return undefined;
    const dotToken = tokens[dot];
    if (!(isPunct(dotToken, ".") || isPunct(dotToken, "?."))) return undefined;
    const objectIndex = previousSignificant(tokens, dot);
    const object = tokens[objectIndex];
    if (object === undefined || object.kind !== "ident") return undefined;
    return { object: object.text, objectIndex };
}

/** The identifier token at `pos` (including one ending at `pos`), or undefined. */
export function wordAt(
    tokens: readonly ScanToken[],
    pos: number,
): { index: number; token: ScanToken } | undefined {
    const index = tokenIndexAt(tokens, pos);
    const token = tokens[index];
    if (
        token === undefined ||
        (token.kind !== "ident" && token.kind !== "keyword" && token.kind !== "builtin")
    ) {
        return undefined;
    }
    return { index, token };
}

/** The top-level declaration whose span holds `pos`. */
export function declarationAt(declarations: readonly Declaration[], pos: number): Declaration | undefined {
    return declarations.find((declaration) => declaration.from <= pos && pos <= declaration.to);
}

export interface LocalName {
    readonly name: string;
    readonly kind: "variable" | "constant" | "parameter";
    readonly from: number;
    readonly to: number;
    readonly type?: string;
}

/**
 * Local variables, constants and parameters visible at `pos` inside the declaration that
 * holds it — `var`/`const` statements, function parameters, `for (var x in ...)`,
 * `catch (e)` — scoped by braces. Innermost first.
 */
export function localsAt(tokens: readonly ScanToken[], declaration: Declaration, pos: number): LocalName[] {
    const scopes: LocalName[][] = [[]];
    let pending: LocalName[] = [];
    let start = tokenIndexAt(tokens, declaration.from);
    if (start < 0) start = 0;
    const last = tokenIndexBefore(tokens, pos);
    for (let i = start; i <= last; i++) {
        const token = tokens[i];
        if (!significant(token)) continue;
        if (token.kind === "punct") {
            if (token.text === "{") {
                // A precondition block and the body after it both see the parameters.
                const before = tokens[previousSignificant(tokens, i)];
                if (before?.kind === "keyword" && before.text === "precondition") {
                    scopes.push([...pending]);
                } else if (isMapBrace(tokens, i)) {
                    // A map literal (an annotation, a definition) is no block: parameters wait for the body.
                    scopes.push([]);
                } else {
                    scopes.push(pending);
                    pending = [];
                }
            } else if (token.text === "}") {
                if (scopes.length > 1) scopes.pop();
            }
            continue;
        }
        if (token.kind !== "keyword") continue;
        if (token.text === "var" || token.text === "const") {
            // Outside every brace is the declaration's own `const NAME` — not a local.
            if (scopes.length === 1) continue;
            for (let j = nextSignificant(tokens, i); j >= 0 && j <= last; ) {
                const name = tokens[j];
                if (name.kind !== "ident") break;
                const after = nextSignificant(tokens, j);
                const typed = isPunct(tokens[after], "is")
                    ? tokens[nextSignificant(tokens, after)]
                    : undefined;
                const local: LocalName = {
                    name: name.text,
                    kind: token.text === "const" ? "constant" : "variable",
                    from: name.from,
                    to: name.to,
                    type: typed?.text,
                };
                // `for (var x in ...)`: the variable belongs to the loop body.
                const inLoop = isPunct(tokens[previousSignificant(tokens, i)], "(");
                (inLoop ? pending : scopes[scopes.length - 1]).push(local);
                // `for (var key, value in map)`
                if (inLoop && isPunct(tokens[after], ",")) {
                    j = nextSignificant(tokens, after);
                    continue;
                }
                break;
            }
            continue;
        }
        if (token.text === "function" || token.text === "catch" || token.text === "predicate") {
            let j = nextSignificant(tokens, i);
            if (tokens[j]?.kind === "ident") j = nextSignificant(tokens, j);
            if (!isPunct(tokens[j], "(")) continue;
            const params: LocalName[] = [];
            let depth = 0;
            for (let k = j + 1; k < tokens.length && k <= last + 64; k++) {
                const t = tokens[k];
                if (!significant(t)) continue;
                if (isPunct(t, "(")) depth++;
                if (isPunct(t, ")")) {
                    if (depth === 0) break;
                    depth--;
                }
                const before = tokens[previousSignificant(tokens, k)];
                if (t.kind === "ident" && depth === 0 && (isPunct(before, "(") || isPunct(before, ","))) {
                    const after = nextSignificant(tokens, k);
                    const type = isPunct(tokens[after], "is")
                        ? tokens[nextSignificant(tokens, after)]?.text
                        : undefined;
                    params.push({ name: t.text, kind: "parameter", from: t.from, to: t.to, type });
                }
            }
            pending = params;
        }
    }
    const result: LocalName[] = [];
    const seen = new Set<string>();
    for (let s = scopes.length - 1; s >= 0; s--) {
        const scope = scopes[s];
        for (let k = scope.length - 1; k >= 0; k--) {
            if (seen.has(scope[k].name)) continue;
            seen.add(scope[k].name);
            result.push(scope[k]);
        }
    }
    return result;
}

/** The feature declaration whose precondition or body holds `pos`. */
export function featureAt(declarations: readonly Declaration[], pos: number): Declaration | undefined {
    const declaration = declarationAt(declarations, pos);
    return declaration?.kind === "feature" ? declaration : undefined;
}

/** Whether `pos` is inside the precondition block of a feature or function. */
export function inPrecondition(declarations: readonly Declaration[], pos: number): boolean {
    const declaration = declarationAt(declarations, pos);
    const range = declaration?.precondition;
    return range !== undefined && range.from < pos && pos < range.to;
}

/** Whether `pos` is inside a declaration's body or precondition (not at the module's top level). */
export function inCode(tokens: readonly ScanToken[], pos: number): boolean {
    return enclosingOpener(tokens, pos) >= 0;
}
