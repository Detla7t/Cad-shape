// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { NcProgram, ToolpathData, ToolpathMove, Vec3 } from "../../src";
import { arcPoints, drillPlanes, planeAxes } from "../../src/posts/motion";

/**
 * Compares a program read back from G-code with the toolpaths it was posted from, the way
 * a machinist would: positioning (runs of rapids) by where it ends, feed moves by their
 * geometry — a line or arc read back as the same line or arc, or as pieces lying on it
 * (posts that linearize or split arcs) — drilling cycles by their parameters or, when the
 * post expanded them, by motion at the hole reaching its bottom; dwells, beam on/off,
 * extrusion and wire tapers one for one. Reference returns the reader inserted (home
 * moves) and comments are left out.
 */

export interface RoundTripOptions {
    /** Position tolerance, mm (posts round to 3–4 decimals). */
    readonly tolerance?: number;
    /** Compare X and Y only (2D cutting posts without Z output). */
    readonly xyOnly?: boolean;
    /** Feeds are not comparable (inverse time feeds, printer travel feeds). */
    readonly ignoreFeed?: boolean;
    /** Printers: feed moves without extrusion are travels. */
    readonly printer?: boolean;
    /** Relative feed tolerance (feeds are rounded by the posts). */
    readonly feedTolerance?: number;
}

type Item =
    | { readonly kind: "goto"; readonly to: Vec3; readonly axis?: Vec3 }
    | {
          readonly kind: "line";
          readonly from: Vec3;
          readonly to: Vec3;
          readonly feed: number;
          readonly axis?: Vec3;
      }
    | { readonly kind: "arc"; readonly from: Vec3; readonly move: Extract<ToolpathMove, { kind: "arc" }> }
    | { readonly kind: "drill"; readonly move: Extract<ToolpathMove, { kind: "drill" }>; readonly from: Vec3 }
    | { readonly kind: "dwell"; readonly seconds: number }
    | { readonly kind: "on"; readonly pierceDelay?: number }
    | { readonly kind: "off" }
    | { readonly kind: "extrude"; readonly from: Vec3; readonly to: Vec3; readonly extrude: number }
    | { readonly kind: "taper"; readonly from: Vec3; readonly to: Vec3; readonly upper: Vec3 };

interface Sequence {
    readonly items: Item[];
    readonly start?: Vec3;
}

/** Canonical items of moves: rapid runs collapsed to their end. */
function canonical(
    paths: readonly { moves: readonly ToolpathMove[]; home?: ReadonlySet<number>; start?: Vec3 }[],
    options: RoundTripOptions,
): Sequence {
    const items: Item[] = [];
    let at: Vec3 | undefined = paths[0]?.start;
    const start = at;
    let pendingGoto: { to: Vec3; axis?: Vec3 } | undefined;
    /** Wire EDM: the upper guide's offset from the lower one (0 for every move but tapers). */
    let uv: [number, number] = [0, 0];
    const flush = () => {
        if (pendingGoto !== undefined) items.push({ kind: "goto", ...pendingGoto });
        pendingGoto = undefined;
    };
    for (const path of paths) {
        path.moves.forEach((move, index) => {
            if (path.home?.has(index)) {
                if ("to" in move) at = move.to;
                return;
            }
            switch (move.kind) {
                case "rapid":
                    pendingGoto = { to: move.to, ...(move.axis === undefined ? {} : { axis: move.axis }) };
                    at = move.to;
                    return;
                case "linear":
                    uv = [0, 0];
                    if (options.printer) {
                        pendingGoto = { to: move.to };
                        at = move.to;
                        return;
                    }
                    if (
                        at !== undefined &&
                        same(at, move.to, 1e-9, options) &&
                        sameAxis(move.axis, lastAxis(items, pendingGoto))
                    ) {
                        return;
                    }
                    flush();
                    items.push({
                        kind: "line",
                        from: at ?? move.to,
                        to: move.to,
                        feed: move.feed,
                        ...(move.axis === undefined ? {} : { axis: move.axis }),
                    });
                    at = move.to;
                    return;
                case "arc":
                    uv = [0, 0];
                    flush();
                    items.push({ kind: "arc", from: at ?? move.to, move });
                    at = move.to;
                    return;
                case "drill":
                    flush();
                    items.push({ kind: "drill", move, from: at ?? move.at });
                    at = [move.at[0], move.at[1], Math.max(at?.[2] ?? move.retract, drillPlanes(move).r)];
                    return;
                case "dwell":
                    flush();
                    items.push({ kind: "dwell", seconds: move.seconds });
                    return;
                case "cutterOn":
                    flush();
                    items.push({
                        kind: "on",
                        ...(move.pierceDelay === undefined ? {} : { pierceDelay: move.pierceDelay }),
                    });
                    return;
                case "cutterOff":
                    flush();
                    items.push({ kind: "off" });
                    return;
                case "extrude":
                    flush();
                    items.push({ kind: "extrude", from: at ?? move.to, to: move.to, extrude: move.extrude });
                    at = move.to;
                    return;
                case "taper": {
                    const offset: [number, number] = [move.upper[0] - move.to[0], move.upper[1] - move.to[1]];
                    // A taper that moves neither guide moves nothing: posts leave it out.
                    const still =
                        at !== undefined &&
                        same(at, move.to, 1e-9, options) &&
                        Math.abs(offset[0] - uv[0]) < 1e-9 &&
                        Math.abs(offset[1] - uv[1]) < 1e-9;
                    uv = offset;
                    if (still) return;
                    flush();
                    items.push({ kind: "taper", from: at ?? move.to, to: move.to, upper: move.upper });
                    at = move.to;
                    return;
                }
                case "raw":
                    // A program stop passed through verbatim (wire EDM: secure the slug).
                    if (/^\s*M0*[01]\s*$/i.test(move.code)) {
                        flush();
                        items.push({ kind: "dwell", seconds: 0 });
                    }
                    return;
                default:
                    return;
            }
        });
    }
    flush();
    return { items, ...(start === undefined ? {} : { start }) };
}

function lastAxis(items: Item[], pending: { axis?: Vec3 } | undefined): Vec3 | undefined {
    if (pending !== undefined) return pending.axis;
    const last = items.at(-1);
    return last !== undefined && "axis" in last ? last.axis : undefined;
}

function same(a: Vec3, b: Vec3, tolerance: number, options: RoundTripOptions): boolean {
    return (
        Math.abs(a[0] - b[0]) <= tolerance &&
        Math.abs(a[1] - b[1]) <= tolerance &&
        (options.xyOnly || Math.abs(a[2] - b[2]) <= tolerance)
    );
}

function sameAxis(a: Vec3 | undefined, b: Vec3 | undefined, tolerance = 1e-4): boolean {
    const p = a ?? [0, 0, 1];
    const q = b ?? [0, 0, 1];
    return (
        Math.abs(p[0] - q[0]) <= tolerance &&
        Math.abs(p[1] - q[1]) <= tolerance &&
        Math.abs(p[2] - q[2]) <= tolerance
    );
}

const fmt = (p: Vec3 | undefined) => (p === undefined ? "?" : `(${p.map((v) => v.toFixed(4)).join(", ")})`);

function distanceToSegment(p: Vec3, a: Vec3, b: Vec3, xyOnly: boolean): number {
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], xyOnly ? 0 : b[2] - a[2]];
    const w: Vec3 = [p[0] - a[0], p[1] - a[1], xyOnly ? 0 : p[2] - a[2]];
    const ll = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const t = ll === 0 ? 0 : Math.max(0, Math.min(1, (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / ll));
    return Math.hypot(w[0] - d[0] * t, w[1] - d[1] * t, w[2] - d[2] * t);
}

/** Distance of a point from an arc's path (sampled finely). */
function distanceToArc(
    p: Vec3,
    from: Vec3,
    arc: Extract<ToolpathMove, { kind: "arc" }>,
    xyOnly: boolean,
): number {
    const points = arcPoints(from, arc, 0.0005);
    let best = Number.POSITIVE_INFINITY;
    let previous = from;
    for (const point of points) {
        best = Math.min(best, distanceToSegment(p, previous, point, xyOnly));
        previous = point;
    }
    return best;
}

/** Throws with a readable message at the first difference. */
export function expectSameToolpaths(
    original: readonly ToolpathData[],
    read: NcProgram,
    options: RoundTripOptions = {},
): void {
    const tolerance = options.tolerance ?? 0.002;
    const feedTolerance = options.feedTolerance ?? 0.01;
    const a = canonical(
        original.map((path) => ({ moves: path.moves })),
        options,
    ).items;
    const readSequence = canonical(
        read.toolpaths.map((path) => ({
            moves: path.toolpath.moves,
            home: path.homeMoves,
            start: path.start,
        })),
        options,
    );
    const b = readSequence.items;
    let j = 0;
    let at: Vec3 | undefined = readSequence.start;
    const fail: (i: number, message: string) => never = (i, message) => {
        const context = b
            .slice(Math.max(0, j - 2), j + 3)
            .map((item) => JSON.stringify(item))
            .join("\n    ");
        throw new Error(`item ${i} (${JSON.stringify(a[i])}): ${message}\n  read near ${j}:\n    ${context}`);
    };
    const near = (p: Vec3, q: Vec3) => same(p, q, tolerance, options);
    const checkFeed = (i: number, expected: number, actual: number) => {
        if (options.ignoreFeed) return;
        if (Math.abs(expected - actual) > Math.max(0.5, Math.abs(expected) * feedTolerance)) {
            fail(i, `feed ${actual} instead of ${expected}`);
        }
    };
    const endOf = (item: Item): Vec3 | undefined => {
        switch (item.kind) {
            case "goto":
            case "line":
            case "extrude":
            case "taper":
                return item.to;
            case "arc":
                return item.move.to;
            case "drill":
                return undefined;
            default:
                return undefined;
        }
    };
    for (let i = 0; i < a.length; i++) {
        const expected = a[i];
        switch (expected.kind) {
            case "goto": {
                const next = b[j];
                // A post expanding the next drilling cycle positions over the hole in the same rapids.
                const hole =
                    a[i + 1]?.kind === "drill"
                        ? (a[i + 1] as Extract<Item, { kind: "drill" }>).move.at
                        : undefined;
                const overHole = (p: Vec3) =>
                    hole !== undefined &&
                    Math.abs(p[0] - hole[0]) <= tolerance &&
                    Math.abs(p[1] - hole[1]) <= tolerance;
                if (
                    next?.kind === "goto" &&
                    !near(next.to, expected.to) &&
                    overHole(next.to) &&
                    overHole(expected.to)
                ) {
                    break;
                }
                if (next?.kind === "goto") {
                    if (!near(next.to, expected.to)) fail(i, `positions at ${fmt(next.to)}`);
                    if (!sameAxis(next.axis, expected.axis)) fail(i, `axis ${fmt(next.axis)}`);
                    at = next.to;
                    j++;
                } else if (at === undefined || !near(at, expected.to)) {
                    fail(i, `the read program is at ${fmt(at)} without positioning`);
                }
                break;
            }
            case "line":
            case "arc": {
                const target = expected.kind === "line" ? expected.to : expected.move.to;
                // Consume read feed pieces until one ends at the target; each must lie on the original.
                let reached = false;
                while (j < b.length) {
                    const piece = b[j];
                    if (piece.kind !== "line" && piece.kind !== "arc")
                        fail(i, `a ${piece.kind} instead of a feed move`);
                    const end = endOf(piece)!;
                    const offPath =
                        expected.kind === "line"
                            ? distanceToSegment(end, expected.from, expected.to, options.xyOnly ?? false)
                            : distanceToArc(end, expected.from, expected.move, options.xyOnly ?? false);
                    if (offPath > tolerance * 2)
                        fail(i, `a feed piece ends ${offPath.toFixed(4)} off the path at ${fmt(end)}`);
                    if (piece.kind === "arc" && expected.kind === "arc") {
                        const [u, v] = planeAxes(expected.move.plane);
                        if (piece.move.plane !== expected.move.plane) fail(i, `arc in ${piece.move.plane}`);
                        if (piece.move.clockwise !== expected.move.clockwise) fail(i, "arc direction");
                        if (
                            Math.abs(piece.move.center[u] - expected.move.center[u]) > tolerance * 2 ||
                            Math.abs(piece.move.center[v] - expected.move.center[v]) > tolerance * 2
                        ) {
                            fail(i, `arc centre ${fmt(piece.move.center)}`);
                        }
                    }
                    if (piece.kind === "arc" && expected.kind === "line") fail(i, "an arc instead of a line");
                    const feed = piece.kind === "line" ? piece.feed : piece.move.feed;
                    checkFeed(i, expected.kind === "line" ? expected.feed : expected.move.feed, feed);
                    j++;
                    at = end;
                    if (near(end, target)) {
                        if (expected.kind === "line" && expected.axis !== undefined) {
                            const axis = piece.kind === "line" ? piece.axis : undefined;
                            if (!sameAxis(axis, expected.axis, 2e-4)) fail(i, `tool axis ${fmt(axis)}`);
                        }
                        reached = true;
                        break;
                    }
                }
                if (!reached) fail(i, "the read program ends before the move does");
                break;
            }
            case "drill": {
                const next = b[j];
                const { bottom, r } = drillPlanes(expected.move);
                const [x, y] = expected.move.at;
                if (next?.kind === "drill") {
                    const got = drillPlanes(next.move);
                    if (
                        Math.abs(next.move.at[0] - x) > tolerance ||
                        Math.abs(next.move.at[1] - y) > tolerance
                    )
                        fail(i, `hole at ${fmt(next.move.at)}`);
                    if (Math.abs(got.bottom - bottom) > tolerance) fail(i, `bottom ${got.bottom}`);
                    if (Math.abs(got.r - r) > tolerance) fail(i, `R ${got.r}`);
                    if (next.move.cycle !== expected.move.cycle) fail(i, `cycle ${next.move.cycle}`);
                    if (
                        Math.abs(
                            (next.move.peck ?? 0) -
                                (expected.move.cycle === "peck" || expected.move.cycle === "chipBreak"
                                    ? (expected.move.peck ?? Math.abs(expected.move.depth))
                                    : 0),
                        ) > tolerance
                    )
                        fail(i, `peck ${next.move.peck}`);
                    if (Math.abs((next.move.dwell ?? 0) - (expected.move.dwell ?? 0)) > 1e-3)
                        fail(i, `dwell ${next.move.dwell}`);
                    checkFeed(i, expected.move.feed, next.move.feed);
                    j++;
                    at = [x, y, Math.max(at?.[2] ?? r, r)];
                    break;
                }
                // Expanded: motion at the hole (positioning included) reaching the bottom.
                let deepest = Number.POSITIVE_INFINITY;
                let consumed = 0;
                let dwells = expected.move.dwell !== undefined && expected.move.dwell > 0 ? 1 : 0;
                while (j < b.length) {
                    const piece = b[j];
                    if (piece.kind === "dwell") {
                        // The cycle's own dwell at the bottom; a stop after the hole is not part of it.
                        if (dwells === 0) break;
                        dwells--;
                        j++;
                        continue;
                    }
                    const end = endOf(piece);
                    if (piece.kind === "drill") {
                        // A rigid tap (G33.1) inside an expansion.
                        if (
                            Math.abs(piece.move.at[0] - x) > tolerance ||
                            Math.abs(piece.move.at[1] - y) > tolerance
                        )
                            break;
                        deepest = Math.min(deepest, drillPlanes(piece.move).bottom);
                        j++;
                        consumed++;
                        continue;
                    }
                    if (end === undefined) break;
                    if (Math.abs(end[0] - x) > tolerance || Math.abs(end[1] - y) > tolerance) break;
                    if (piece.kind === "line") deepest = Math.min(deepest, end[2]);
                    at = end;
                    j++;
                    consumed++;
                }
                if (consumed === 0) fail(i, "no motion at the hole");
                if (Math.abs(deepest - bottom) > tolerance)
                    fail(i, `the expansion reaches ${deepest}, not ${bottom}`);
                break;
            }
            case "dwell": {
                const next = b[j];
                if (next?.kind !== "dwell") fail(i, `${next?.kind ?? "the end"} instead of a dwell`);
                const got = (next as Extract<Item, { kind: "dwell" }>).seconds;
                if (Math.abs(got - expected.seconds) > 1e-3) fail(i, `dwell ${got}`);
                j++;
                break;
            }
            case "on":
            case "off": {
                const next = b[j];
                if (next?.kind !== expected.kind)
                    fail(i, `${next?.kind ?? "the end"} instead of ${expected.kind}`);
                if (
                    expected.kind === "on" &&
                    expected.pierceDelay !== undefined &&
                    expected.pierceDelay > 0
                ) {
                    const got = (next as Extract<Item, { kind: "on" }>).pierceDelay;
                    if (got === undefined || Math.abs(got - expected.pierceDelay) > 1e-3)
                        fail(i, `pierce delay ${got}`);
                }
                j++;
                break;
            }
            case "extrude": {
                let total = 0;
                let reached = false;
                while (j < b.length) {
                    const piece = b[j];
                    if (piece.kind !== "extrude") fail(i, `a ${piece.kind} instead of an extrusion`);
                    const extrusion = piece as Extract<Item, { kind: "extrude" }>;
                    total += extrusion.extrude;
                    j++;
                    at = extrusion.to;
                    if (near(extrusion.to, expected.to)) {
                        reached = true;
                        break;
                    }
                }
                if (!reached) fail(i, "the read program ends before the extrusion does");
                if (Math.abs(total - expected.extrude) > 1e-4) fail(i, `extrudes ${total}`);
                break;
            }
            case "taper": {
                const next = b[j];
                if (
                    next?.kind === "line" &&
                    Math.abs(expected.upper[0] - expected.to[0]) < tolerance &&
                    Math.abs(expected.upper[1] - expected.to[1]) < tolerance
                ) {
                    // A taper with the guides aligned is a vertical cut.
                    if (!near(next.to, expected.to)) fail(i, `cuts to ${fmt(next.to)}`);
                    j++;
                    at = next.to;
                    break;
                }
                if (next?.kind !== "taper") fail(i, `${next?.kind ?? "the end"} instead of a taper`);
                const taper = next as Extract<Item, { kind: "taper" }>;
                if (!near(taper.to, expected.to)) fail(i, `cuts to ${fmt(taper.to)}`);
                if (
                    Math.abs(taper.upper[0] - expected.upper[0]) > tolerance ||
                    Math.abs(taper.upper[1] - expected.upper[1]) > tolerance
                )
                    fail(i, `upper guide at ${fmt(taper.upper)}`);
                if (Math.abs(taper.upper[2] - expected.upper[2]) > tolerance)
                    fail(i, `UV plane at ${taper.upper[2]}`);
                j++;
                at = taper.to;
                break;
            }
        }
    }
    // Trailing positioning in the read program (a final retract) is fine; nothing else may be left.
    const rest = b.slice(j).filter((item) => item.kind !== "goto");
    if (rest.length > 0) throw new Error(`the read program has more: ${JSON.stringify(rest.slice(0, 3))}`);
}

/** Tool numbers in order of use, repeats folded. */
export function toolSequence(numbers: readonly number[]): number[] {
    return numbers.filter((number, index) => index === 0 || numbers[index - 1] !== number);
}
