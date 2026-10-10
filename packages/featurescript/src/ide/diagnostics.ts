// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { isIdentPart } from "./scanner";

/**
 * Turns a studio compile failure (`compileStudioSource`'s error, 1-based line/column and
 * the file the position is in) into a marked range of the studio's source. A failure
 * located in another module (an imported studio, a std function) is pinned where the
 * studio is involved: the innermost call-stack frame inside the studio, else the import
 * that brought the module in, else the first line.
 */

export interface CompileProblem {
    readonly error?: string;
    readonly line?: number;
    readonly column?: number;
    /** The module the position is in; undefined is taken as the studio itself. */
    readonly file?: string;
}

export interface DiagnosticRange {
    readonly from: number;
    readonly to: number;
    readonly severity: "error" | "warning" | "info";
    readonly message: string;
}

function lineStart(source: string, line: number): number | undefined {
    let offset = 0;
    for (let current = 1; current < line; current++) {
        const next = source.indexOf("\n", offset);
        if (next < 0) return undefined;
        offset = next + 1;
    }
    return offset;
}

function lineEnd(source: string, from: number): number {
    const end = source.indexOf("\n", from);
    return end < 0 ? source.length : end;
}

/** The range of the token starting at `offset`: a word, a string, or one character. */
function tokenRange(source: string, offset: number): { from: number; to: number } {
    const end = lineEnd(source, offset);
    if (offset >= end) {
        // At the end of a line (a missing `;`): mark the last character before it.
        const start = source.lastIndexOf("\n", end - 1) + 1;
        return end > start ? { from: end - 1, to: end } : { from: start, to: start };
    }
    const code = source.charCodeAt(offset);
    if (isIdentPart(code)) {
        let to = offset + 1;
        while (to < end && isIdentPart(source.charCodeAt(to))) to++;
        return { from: offset, to };
    }
    if (code === 34 || code === 39) {
        let to = offset + 1;
        while (to < end && source.charCodeAt(to) !== code) to += source.charCodeAt(to) === 92 ? 2 : 1;
        return { from: offset, to: Math.min(end, to + 1) };
    }
    return { from: offset, to: offset + 1 };
}

/** The offset of 1-based `line`:`column`, clamped into the source. */
export function offsetOf(source: string, line: number, column = 1): number | undefined {
    const start = lineStart(source, line);
    if (start === undefined) return undefined;
    return Math.min(start + Math.max(0, column - 1), lineEnd(source, start));
}

const LOCATION = /\(([^()]*?):(\d+):(\d+)\)/g;

function withoutLocation(message: string, file: string): string {
    const [first, ...rest] = message.split("\n");
    const cleaned = first.replace(new RegExp(`\\s*\\(${escapeRegExp(file)}:\\d+:\\d+\\)$`), "");
    return [cleaned, ...rest].join("\n");
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where the studio imports `file` (`import(path : "<file>" ...)`), as a range of the path string. */
function importOf(source: string, file: string): { from: number; to: number } | undefined {
    const candidates = [file, file.startsWith("onshape/std/") ? file : `onshape/std/${file}`];
    for (const path of candidates) {
        const match = new RegExp(`path\\s*:\\s*(["'])${escapeRegExp(path)}\\1`).exec(source);
        if (match !== null) {
            const from = match.index + match[0].indexOf(match[1]);
            return { from, to: from + path.length + 2 };
        }
    }
    return undefined;
}

export function diagnosticsFor(
    source: string,
    problem: CompileProblem,
    studioName: string,
): DiagnosticRange[] {
    if (problem.error === undefined) return [];
    const inStudio = problem.file === undefined || problem.file === studioName;
    if (inStudio && problem.line !== undefined) {
        const offset = offsetOf(source, problem.line, problem.column);
        if (offset !== undefined) {
            return [
                {
                    ...tokenRange(source, offset),
                    severity: "error",
                    message: withoutLocation(problem.error, studioName),
                },
            ];
        }
    }
    // A failure inside another module: the innermost frame in the studio, if the stack has one.
    for (const match of problem.error.matchAll(LOCATION)) {
        if (match[1] !== studioName) continue;
        const offset = offsetOf(source, Number(match[2]), Number(match[3]));
        if (offset !== undefined)
            return [{ ...tokenRange(source, offset), severity: "error", message: problem.error }];
    }
    const imported = problem.file === undefined ? undefined : importOf(source, problem.file);
    if (imported !== undefined) return [{ ...imported, severity: "error", message: problem.error }];
    return [{ from: 0, to: lineEnd(source, 0), severity: "error", message: problem.error }];
}
