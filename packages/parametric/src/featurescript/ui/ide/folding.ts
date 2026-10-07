// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsScanner } from "./scanner";

/**
 * Foldable regions of a source, by the line they start on: a bracket pair that spans
 * lines folds from just after the opener to just before the closer (the outermost pair
 * opened on a line wins), a multi-line comment from the end of its first line to its
 * `*\/`. Computed in one scan, so folding a several-thousand-line std module stays cheap.
 */

export interface FoldRange {
    readonly from: number;
    readonly to: number;
}

export function foldRanges(source: string): Map<number, FoldRange> {
    const lineStarts = [0];
    for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) lineStarts.push(i + 1);
    const lineOf = (offset: number): number => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (lineStarts[mid] <= offset) low = mid;
            else high = mid - 1;
        }
        return low + 1;
    };
    const ranges = new Map<number, FoldRange>();
    const open: number[] = [];
    const scanner = new FsScanner(source);
    while (scanner.next() !== "eof") {
        if (scanner.kind === "comment" || scanner.kind === "doc") {
            const line = lineOf(scanner.start);
            const lineEnd = source.indexOf("\n", scanner.start);
            if (lineEnd >= 0 && lineEnd < scanner.end && !ranges.has(line)) {
                const to = scanner.closed ? scanner.end - 2 : scanner.end;
                if (to > lineEnd) ranges.set(line, { from: lineEnd, to });
            }
            continue;
        }
        if (scanner.kind !== "punct" || scanner.end - scanner.start !== 1) continue;
        const code = source.charCodeAt(scanner.start);
        if (code === 123 || code === 40 || code === 91) {
            open.push(scanner.start);
        } else if (code === 125 || code === 41 || code === 93) {
            const start = open.pop();
            if (start === undefined) continue;
            const line = lineOf(start);
            if (lineOf(scanner.start) === line) continue;
            // Pairs close inner-first, so a later (outer) pair on the same line replaces an inner one.
            const existing = ranges.get(line);
            if (existing === undefined || start + 1 < existing.from)
                ranges.set(line, { from: start + 1, to: scanner.start });
        }
    }
    return ranges;
}
