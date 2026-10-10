// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { addressOf, type CellAddress, type CellRange, parseAddress } from "./model";
import { quoteSheet } from "./ranges";

/**
 * Point mode, as LibreOffice and Excel do it: while a formula is being typed, a click on a
 * cell (a drag over a range, an arrow key) puts its reference into the formula instead of
 * ending the edit — wherever the caret follows the `=`, an operator, an opening
 * parenthesis or an argument separator. The reference just pointed stays "hot": the next
 * click replaces it, until something is typed. Everything here is pure text work; the
 * viewer owns the mouse.
 */

/** A span of the formula text, `[start, end)`. */
export interface TextSpan {
    readonly start: number;
    readonly end: number;
}

/** What a reference may follow: the `=` that opens the formula, an operator, `(`, a separator. */
const BEFORE_REFERENCE = /[=+\-*/^&<>(,;]\s*$/;

/**
 * Where a pointed reference goes: the selection, when the caret follows a character a
 * reference may come after. Undefined for a non-formula or for a caret inside typed text —
 * a click there ends the edit and selects the cell, as it always did.
 */
export function referenceInsertion(text: string, start: number, end: number = start): TextSpan | undefined {
    if (!text.startsWith("=")) return undefined;
    return BEFORE_REFERENCE.test(text.slice(0, start)) ? { start, end } : undefined;
}

/** A sheet name as a formula writes it before `!`: bare when it is a plain identifier, quoted otherwise. */
export function sheetPrefix(name: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !parseAddress(name) ? name : quoteSheet(name);
}

/** The text of a reference to `from` (through `to` for a range), on `sheet` when that is not the formula's own. */
export function referenceText(from: CellAddress, to: CellAddress = from, sheet?: string): string {
    const start = { row: Math.min(from.row, to.row), col: Math.min(from.col, to.col) };
    const end = { row: Math.max(from.row, to.row), col: Math.max(from.col, to.col) };
    const first = addressOf(start.row, start.col);
    const cells =
        start.row === end.row && start.col === end.col ? first : `${first}:${addressOf(end.row, end.col)}`;
    return sheet === undefined ? cells : `${sheetPrefix(sheet)}!${cells}`;
}

/** Puts `reference` into `text` over `span`; the span it then occupies comes back with the text. */
export function insertReference(
    text: string,
    span: TextSpan,
    reference: string,
): { text: string; span: TextSpan } {
    return {
        text: text.slice(0, span.start) + reference + text.slice(span.end),
        span: { start: span.start, end: span.start + reference.length },
    };
}

export interface FormulaReference extends TextSpan {
    /** The reference as written. */
    readonly text: string;
    /** The sheet it names, unquoted; undefined for the formula's own sheet. */
    readonly sheet?: string;
    /** The cell or range part, upper-case, `$` kept. */
    readonly cells: string;
}

const REFERENCE =
    /"(?:[^"]|"")*"|(?:'((?:[^']|'')*)'|([A-Za-z_][\w.]*))!(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)|(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)(?![\w(])/gi;

/** Every cell or range reference of a formula with its position; string literals and function names are not references. */
export function formulaReferences(text: string): FormulaReference[] {
    if (!text.startsWith("=")) return [];
    const references: FormulaReference[] = [];
    for (const match of text.matchAll(REFERENCE)) {
        if (match[0].startsWith('"')) continue;
        // the tail of a longer word (a name such as `tax1`) is no reference
        if (match.index > 0 && /[\w.]/.test(text[match.index - 1])) continue;
        const cells = match[3] ?? match[4];
        if (cells === undefined) continue;
        references.push({
            start: match.index,
            end: match.index + match[0].length,
            text: match[0],
            ...(match[1] !== undefined
                ? { sheet: match[1].replace(/''/g, "'") }
                : match[2] !== undefined
                  ? { sheet: match[2] }
                  : {}),
            cells: cells.toUpperCase(),
        });
    }
    return references;
}

/** The reference the caret touches, if any. */
export function referenceAt(text: string, caret: number): FormulaReference | undefined {
    return formulaReferences(text).find((ref) => caret >= ref.start && caret <= ref.end);
}

/** The cells a reference's cell part covers, normalized; undefined when it does not parse. */
export function referenceRange(cells: string): CellRange | undefined {
    const [first, second] = cells.replace(/\$/g, "").split(":");
    const start = parseAddress(first);
    const end = second === undefined ? start : parseAddress(second);
    if (!start || !end) return undefined;
    return {
        start: { row: Math.min(start.row, end.row), col: Math.min(start.col, end.col) },
        end: { row: Math.max(start.row, end.row), col: Math.max(start.col, end.col) },
    };
}

/** F4: `A1` → `$A$1` → `A$1` → `$A1` → `A1`; both ends of a range turn together. */
export function cycleAbsolute(cells: string): string {
    const part = (address: string) => {
        const match = /^(\$?)([A-Z]{1,3})(\$?)(\d+)$/i.exec(address);
        if (!match) return address;
        const [, column, letters, row, digits] = match;
        const state = (column ? 2 : 0) + (row ? 1 : 0);
        const next = { 0: 3, 3: 1, 1: 2, 2: 0 }[state] ?? 0;
        return `${next & 2 ? "$" : ""}${letters}${next & 1 ? "$" : ""}${digits}`;
    };
    return cells.split(":").map(part).join(":");
}

/** Closes the parentheses a formula left open, as LibreOffice does on Enter; a non-formula is untouched. */
export function closeParentheses(text: string): string {
    if (!text.startsWith("=")) return text;
    let depth = 0;
    let quoted = false;
    for (const char of text) {
        if (char === '"') quoted = !quoted;
        else if (!quoted && char === "(") depth++;
        else if (!quoted && char === ")" && depth > 0) depth--;
    }
    return text + ")".repeat(depth);
}

/** The range finder's colours: a formula's references are framed in turn. */
export const REFERENCE_COLORS: readonly string[] = [
    "#2a7de1",
    "#e0462e",
    "#8e44ad",
    "#1e9e5a",
    "#d98c0b",
    "#0a9fb5",
    "#c2185b",
    "#5b6b2f",
];
