// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Line-level text algorithms for the version store: a Myers diff, the line delta a text object
 * is stored as against its previous version, unified hunks for the diff view, and a diff3 merge
 * for Feature Studio sources.
 */

/** Splits into lines that keep their terminator, so `lines.join("")` restores the text exactly. */
export function splitLines(text: string): string[] {
    if (text.length === 0) return [];
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            lines.push(text.slice(start, i + 1));
            start = i + 1;
        }
    }
    if (start < text.length) lines.push(text.slice(start));
    return lines;
}

/** A run of the edit script: `n` lines kept (`eq`), dropped from `a` (`del`) or added from `b` (`ins`). */
export interface DiffRun {
    readonly op: "eq" | "del" | "ins";
    /** Start in `a` (for `eq`/`del`) — for `ins`, the position in `a` it is inserted before. */
    readonly a: number;
    /** Start in `b` (for `eq`/`ins`) — for `del`, the position in `b` it was removed at. */
    readonly b: number;
    readonly n: number;
}

/** Maps every distinct line to a small integer so the diff compares numbers, not strings. */
function internLines(a: readonly string[], b: readonly string[]): [Int32Array, Int32Array] {
    const ids = new Map<string, number>();
    const intern = (lines: readonly string[]) => {
        const out = new Int32Array(lines.length);
        for (let i = 0; i < lines.length; i++) {
            let id = ids.get(lines[i]);
            if (id === undefined) {
                id = ids.size;
                ids.set(lines[i], id);
            }
            out[i] = id;
        }
        return out;
    };
    return [intern(a), intern(b)];
}

/**
 * Myers' O((N+M)·D) shortest edit script between two line lists, after trimming the common
 * prefix and suffix (which is all a typical edit leaves to diff). Returns runs covering both
 * inputs in order.
 */
export function diffLines(a: readonly string[], b: readonly string[]): DiffRun[] {
    const [x, y] = internLines(a, b);
    let prefix = 0;
    while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix++;
    let suffix = 0;
    while (
        suffix < x.length - prefix &&
        suffix < y.length - prefix &&
        x[x.length - 1 - suffix] === y[y.length - 1 - suffix]
    ) {
        suffix++;
    }
    const middle = myers(x.subarray(prefix, x.length - suffix), y.subarray(prefix, y.length - suffix));
    // The trimmed middle starts and ends on a difference, so no two pushed runs need merging.
    const runs: DiffRun[] = [];
    const push = (op: DiffRun["op"], ai: number, bi: number, n: number) => {
        if (n > 0) runs.push({ op, a: ai, b: bi, n });
    };
    push("eq", 0, 0, prefix);
    for (const run of middle) push(run.op, run.a + prefix, run.b + prefix, run.n);
    push("eq", x.length - suffix, y.length - suffix, suffix);
    return runs;
}

function myers(a: Int32Array, b: Int32Array): DiffRun[] {
    const n = a.length;
    const m = b.length;
    if (n === 0 && m === 0) return [];
    if (n === 0) return [{ op: "ins", a: 0, b: 0, n: m }];
    if (m === 0) return [{ op: "del", a: 0, b: 0, n }];
    const max = n + m;
    const offset = max;
    const v = new Int32Array(2 * max + 2);
    // trace[d] holds v[-d..d] after step d — O(D²) memory instead of O(D·(N+M)).
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= max; d++) {
        for (let k = -d; k <= d; k += 2) {
            let px: number;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
                px = v[offset + k + 1];
            } else {
                px = v[offset + k - 1] + 1;
            }
            let py = px - k;
            while (px < n && py < m && a[px] === b[py]) {
                px++;
                py++;
            }
            v[offset + k] = px;
            if (px >= n && py >= m) {
                found = d;
                break;
            }
        }
        trace.push(v.slice(offset - d, offset + d + 1));
        if (found >= 0) break;
    }

    // Backtrack from (n, m) to (0, 0), collecting single-line steps in reverse.
    const steps: ("eq" | "del" | "ins")[] = [];
    let px = n;
    let py = m;
    for (let d = found; d > 0; d--) {
        const prev = trace[d - 1];
        const at = (k: number) => prev[k + (d - 1)];
        const k = px - py;
        const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
        const prevK = down ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (px > prevX && py > prevY) {
            steps.push("eq");
            px--;
            py--;
        }
        if (down) {
            steps.push("ins");
            py--;
        } else {
            steps.push("del");
            px--;
        }
    }
    while (px > 0 && py > 0) {
        steps.push("eq");
        px--;
        py--;
    }
    steps.reverse();

    const runs: DiffRun[] = [];
    let ai = 0;
    let bi = 0;
    for (const op of steps) {
        const last = runs.at(-1);
        if (last?.op === op) {
            runs[runs.length - 1] = { ...last, n: last.n + 1 };
        } else {
            runs.push({ op, a: ai, b: bi, n: 1 });
        }
        if (op !== "ins") ai++;
        if (op !== "del") bi++;
    }
    return runs;
}

/** A changed region: base lines `[aStart, aEnd)` replaced by other lines `[bStart, bEnd)`. */
export interface LineHunk {
    readonly aStart: number;
    readonly aEnd: number;
    readonly bStart: number;
    readonly bEnd: number;
}

/** The changed regions of a diff, in order — adjacent `del`/`ins` runs fold into one hunk. */
export function lineHunks(a: readonly string[], b: readonly string[]): LineHunk[] {
    const hunks: LineHunk[] = [];
    let current: { aStart: number; aEnd: number; bStart: number; bEnd: number } | undefined;
    for (const run of diffLines(a, b)) {
        if (run.op === "eq") {
            if (current) hunks.push(current);
            current = undefined;
            continue;
        }
        if (!current) {
            current = { aStart: run.a, aEnd: run.a, bStart: run.b, bEnd: run.b };
        }
        if (run.op === "del") current.aEnd = run.a + run.n;
        else current.bEnd = run.b + run.n;
    }
    if (current) hunks.push(current);
    return hunks;
}

/** Counts of added and removed lines between two texts. */
export function lineStats(before: string, after: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const hunk of lineHunks(splitLines(before), splitLines(after))) {
        added += hunk.bEnd - hunk.bStart;
        removed += hunk.aEnd - hunk.aStart;
    }
    return { added, removed };
}

/** One line of a unified diff view. */
export interface UnifiedLine {
    readonly kind: "context" | "add" | "remove" | "skip";
    readonly text: string;
    /** 1-based line numbers in the old/new text (absent on the side the line is not in). */
    readonly oldLine?: number;
    readonly newLine?: number;
}

/** Unified diff of two texts with `context` unchanged lines around each change. */
export function unifiedDiff(before: string, after: string, context = 3): UnifiedLine[] {
    const a = splitLines(before);
    const b = splitLines(after);
    const hunks = lineHunks(a, b);
    const out: UnifiedLine[] = [];
    const strip = (line: string) => line.replace(/\r?\n$/, "");
    let shownA = 0;
    for (let index = 0; index < hunks.length; index++) {
        const hunk = hunks[index];
        const from = Math.max(shownA, hunk.aStart - context);
        if (from > shownA || (index === 0 && from > 0)) {
            out.push({ kind: "skip", text: `@@ -${from + 1} +${hunk.bStart - (hunk.aStart - from) + 1} @@` });
        }
        for (let i = from; i < hunk.aStart; i++) {
            const bLine = hunk.bStart - (hunk.aStart - i);
            out.push({ kind: "context", text: strip(a[i]), oldLine: i + 1, newLine: bLine + 1 });
        }
        for (let i = hunk.aStart; i < hunk.aEnd; i++) {
            out.push({ kind: "remove", text: strip(a[i]), oldLine: i + 1 });
        }
        for (let i = hunk.bStart; i < hunk.bEnd; i++) {
            out.push({ kind: "add", text: strip(b[i]), newLine: i + 1 });
        }
        const next = hunks[index + 1];
        const until = Math.min(a.length, hunk.aEnd + context, next ? next.aStart : a.length);
        for (let i = hunk.aEnd; i < until; i++) {
            const bLine = hunk.bEnd + (i - hunk.aEnd);
            out.push({ kind: "context", text: strip(a[i]), oldLine: i + 1, newLine: bLine + 1 });
        }
        shownA = until;
    }
    return out;
}

// ------------------------------------------------------------------ Line deltas

/** A delta op: `[start, count]` copies base lines, a string inserts literal text. */
export type DeltaOp = [number, number] | string;

/** The ops that rebuild `target` from `base`, copying unchanged line runs. */
export function encodeDelta(base: string, target: string): DeltaOp[] {
    const a = splitLines(base);
    const b = splitLines(target);
    const ops: DeltaOp[] = [];
    for (const run of diffLines(a, b)) {
        if (run.op === "eq") ops.push([run.a, run.n]);
        else if (run.op === "ins") ops.push(b.slice(run.b, run.b + run.n).join(""));
    }
    return ops;
}

export function applyDelta(base: string, ops: readonly DeltaOp[]): string {
    const lines = splitLines(base);
    let out = "";
    for (const op of ops) {
        if (typeof op === "string") out += op;
        else for (let i = op[0]; i < op[0] + op[1]; i++) out += lines[i];
    }
    return out;
}

// ------------------------------------------------------------------ diff3

/** A region of a three-way text merge: settled lines, or a conflict between the sides. */
export type MergeChunk =
    | { readonly kind: "ok"; readonly lines: readonly string[] }
    | {
          readonly kind: "conflict";
          readonly base: readonly string[];
          readonly ours: readonly string[];
          readonly theirs: readonly string[];
      };

interface SideHunk extends LineHunk {
    readonly side: 0 | 1;
}

/**
 * Three-way line merge (diff3). Changes of one side apply as they are; where both sides changed
 * overlapping base lines — or inserted at the same spot — differently, the region is a conflict.
 * Changes separated by at least one untouched line never conflict; identical changes on both
 * sides apply once.
 */
export function mergeText(base: string, ours: string, theirs: string): MergeChunk[] {
    const b = splitLines(base);
    const sides = [splitLines(ours), splitLines(theirs)] as const;
    const hunks: SideHunk[] = [
        ...lineHunks(b, sides[0]).map((h) => ({ ...h, side: 0 as const })),
        ...lineHunks(b, sides[1]).map((h) => ({ ...h, side: 1 as const })),
    ].sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd || x.side - y.side);

    const chunks: MergeChunk[] = [];
    const pushOk = (lines: readonly string[]) => {
        if (lines.length === 0) return;
        const last = chunks.at(-1);
        if (last?.kind === "ok") chunks[chunks.length - 1] = { kind: "ok", lines: [...last.lines, ...lines] };
        else chunks.push({ kind: "ok", lines });
    };
    // Line offset between base and each side, accumulated over the hunks already passed.
    const shift = [0, 0];
    let cursor = 0;
    let i = 0;
    while (i < hunks.length) {
        const group = [hunks[i]];
        let start = hunks[i].aStart;
        let end = hunks[i].aEnd;
        i++;
        while (i < hunks.length && touches(hunks[i], start, end, group)) {
            group.push(hunks[i]);
            start = Math.min(start, hunks[i].aStart);
            end = Math.max(end, hunks[i].aEnd);
            i++;
        }
        pushOk(b.slice(cursor, start));
        const versions = ([0, 1] as const).map((side) => {
            const own = group.filter((h) => h.side === side);
            if (own.length === 0) return undefined;
            const from = start + shift[side];
            const delta = own.reduce((sum, h) => sum + (h.bEnd - h.bStart) - (h.aEnd - h.aStart), 0);
            const to = end + shift[side] + delta;
            shift[side] += delta;
            return sides[side].slice(from, to);
        });
        const [o, t] = versions;
        if (o === undefined) pushOk(t!);
        else if (t === undefined) pushOk(o);
        else if (o.join("") === t.join("")) pushOk(o);
        else chunks.push({ kind: "conflict", base: b.slice(start, end), ours: o, theirs: t });
        cursor = end;
    }
    pushOk(b.slice(cursor));
    return chunks;
}

/**
 * Whether `next` belongs to the region `[start, end)` gathered so far: it overlaps it, or one of
 * them is an insertion at the other's edge (two insertions at one spot, or an insertion against
 * a replaced range, have no defined order — a conflict unless identical).
 */
function touches(next: LineHunk, start: number, end: number, group: readonly LineHunk[]): boolean {
    if (next.aStart < end) return true;
    if (next.aStart > end) return false;
    const nextIsInsert = next.aStart === next.aEnd;
    const regionEndsInInsert = group.some((h) => h.aStart === h.aEnd && h.aStart === end);
    return nextIsInsert || regionEndsInInsert || start === end;
}

/** How one text conflict is settled. */
export type TextChoice = "ours" | "theirs" | "both";

/** Joins merge chunks into text, settling the n-th conflict with `choices[n]` (default ours). */
export function resolveMergeChunks(
    chunks: readonly MergeChunk[],
    choices: readonly TextChoice[] = [],
): string {
    let out = "";
    let index = 0;
    for (const chunk of chunks) {
        if (chunk.kind === "ok") {
            out += chunk.lines.join("");
            continue;
        }
        const choice = choices[index++] ?? "ours";
        if (choice === "ours") out += chunk.ours.join("");
        else if (choice === "theirs") out += chunk.theirs.join("");
        else out += joinBoth(chunk.ours, chunk.theirs);
    }
    return out;
}

/** Ours then theirs; a final line without a newline gets one so the two do not run together. */
function joinBoth(ours: readonly string[], theirs: readonly string[]): string {
    const first = ours.join("");
    const second = theirs.join("");
    if (first.length > 0 && second.length > 0 && !first.endsWith("\n")) return `${first}\n${second}`;
    return first + second;
}
