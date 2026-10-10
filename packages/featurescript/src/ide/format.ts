// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsScanner } from "./scanner";

/**
 * "Format document": re-indents every line by its brackets, the way Onshape lays out
 * FeatureScript. A line inside brackets is indented one unit per bracket still open from
 * the line that opened the innermost one (so `newSketch(context, id, {` puts its entries
 * two units in), and a line starting with a closer lines up with the line that opened
 * it — `precondition` sits one unit inside `defineFeature(`, and the final `});` back on
 * the body's `{` column. Brackets in strings and comments do not count; the inside of a
 * block comment keeps its ` * ` alignment; trailing whitespace goes. Nothing else
 * changes, so formatting is safe on code that does not compile.
 */

export const INDENT_UNIT = 4;

/** An open bracket: the indentation of the line it is on, and that line. */
export interface OpenBracket {
    readonly indent: number;
    readonly line: number;
}

/** Whether a line's text (after its indentation) starts with a closing bracket. */
export function startsWithCloser(text: string): boolean {
    const first = text.trimStart()[0];
    return first === "}" || first === ")" || first === "]";
}

/** The indentation for a line, given the brackets open before it. */
export function indentFor(open: readonly OpenBracket[], text: string, unit = INDENT_UNIT): number {
    const top = open[open.length - 1];
    if (top === undefined) return 0;
    if (startsWithCloser(text)) return top.indent;
    let count = 0;
    for (let i = open.length - 1; i >= 0 && open[i].line === top.line; i--) count++;
    return top.indent + unit * count;
}

export interface LineLayout {
    /** The indentation (columns) the line should have. */
    readonly indent: number;
    /** The line starts inside a block comment. */
    readonly inComment: boolean;
}

/** The formatted indentation of every line of `source`. */
export function layoutLines(source: string): LineLayout[] {
    const lines = source.split("\n");
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of lines) {
        lineStarts.push(offset);
        offset += line.length + 1;
    }
    const lineOf = (pos: number): number => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (lineStarts[mid] <= pos) low = mid;
            else high = mid - 1;
        }
        return low;
    };
    const layout: LineLayout[] = new Array(lines.length);
    const open: OpenBracket[] = [];
    let next = 0;
    const layoutUpTo = (line: number) => {
        for (; next <= line && next < lines.length; next++) {
            layout[next] = { indent: indentFor(open, lines[next]), inComment: false };
        }
    };
    const scanner = new FsScanner(source);
    while (scanner.next() !== "eof") {
        const line = lineOf(scanner.start);
        layoutUpTo(line);
        if (scanner.kind === "comment" || scanner.kind === "doc") {
            const last = lineOf(Math.max(scanner.start, scanner.end - 1));
            for (let inner = line + 1; inner <= last; inner++) {
                layout[inner] = { indent: layout[line].indent, inComment: true };
            }
            next = Math.max(next, last + 1);
            continue;
        }
        if (scanner.kind !== "punct" || scanner.end - scanner.start !== 1) continue;
        const code = source.charCodeAt(scanner.start);
        if (code === 123 || code === 40 || code === 91) open.push({ indent: layout[line].indent, line });
        else if (code === 125 || code === 41 || code === 93) open.pop();
    }
    layoutUpTo(lines.length - 1);
    return layout;
}

export function formatFeatureScript(source: string): string {
    const layout = layoutLines(source);
    return source
        .split("\n")
        .map((raw, index) => {
            const line = raw.replace(/\s+$/, "");
            const text = line.trimStart();
            if (text === "") return "";
            const { indent, inComment } = layout[index];
            if (inComment) {
                // Keep comment stars one column in; leave other comment text as written.
                return text.startsWith("*") ? `${" ".repeat(indent)} ${text}` : line;
            }
            return " ".repeat(indent) + text;
        })
        .join("\n");
}
