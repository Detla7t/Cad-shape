// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Simple nesting: parts' bounding rectangles packed onto a sheet by MaxRects (best short
 * side fit), largest parts first, each optionally turned 90°. Spacing is kept between
 * parts and a margin along the sheet's edges.
 */

export interface NestItem {
    readonly id: string;
    readonly width: number;
    readonly height: number;
}

export interface NestPlacement {
    readonly id: string;
    /** Lower-left corner of the (possibly rotated) rectangle on the sheet. */
    readonly x: number;
    readonly y: number;
    /** True when the part is turned 90° counter-clockwise. */
    readonly rotated: boolean;
    /** The placed rectangle's size (width/height swapped when rotated). */
    readonly width: number;
    readonly height: number;
}

export interface NestOptions {
    /** Sheet size and its lower-left corner. */
    readonly sheet: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    };
    /** Gap between parts, mm. */
    readonly spacing: number;
    /** Gap between parts and the sheet's edges, mm. */
    readonly margin: number;
    readonly allowRotation: boolean;
}

export interface NestResult {
    readonly placed: readonly NestPlacement[];
    readonly unplaced: readonly string[];
}

interface FreeRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

const EPS = 1e-9;

export function nestRectangles(items: readonly NestItem[], options: NestOptions): NestResult {
    const { spacing, margin } = options;
    // Every part claims its rectangle plus `spacing` to its right and top; the usable sheet
    // grows by the same amount so the last column/row may touch the margin.
    let free: FreeRect[] = [
        {
            x: options.sheet.x + margin,
            y: options.sheet.y + margin,
            w: options.sheet.width - 2 * margin + spacing,
            h: options.sheet.height - 2 * margin + spacing,
        },
    ];
    const order = [...items].sort(
        (a, b) =>
            Math.max(b.width, b.height) - Math.max(a.width, a.height) ||
            b.width * b.height - a.width * a.height,
    );
    const placed: NestPlacement[] = [];
    const unplaced: string[] = [];
    for (const item of order) {
        let best: { rect: FreeRect; rotated: boolean; short: number; long: number } | undefined;
        for (const rect of free) {
            for (const rotated of options.allowRotation ? [false, true] : [false]) {
                const w = (rotated ? item.height : item.width) + spacing;
                const h = (rotated ? item.width : item.height) + spacing;
                if (w > rect.w + EPS || h > rect.h + EPS) continue;
                const short = Math.min(rect.w - w, rect.h - h);
                const long = Math.max(rect.w - w, rect.h - h);
                if (
                    best === undefined ||
                    short < best.short - EPS ||
                    (Math.abs(short - best.short) <= EPS && long < best.long - EPS) ||
                    (Math.abs(short - best.short) <= EPS &&
                        Math.abs(long - best.long) <= EPS &&
                        (rect.y < best.rect.y - EPS ||
                            (Math.abs(rect.y - best.rect.y) <= EPS && rect.x < best.rect.x)))
                ) {
                    best = { rect, rotated, short, long };
                }
            }
        }
        if (best === undefined) {
            unplaced.push(item.id);
            continue;
        }
        const width = best.rotated ? item.height : item.width;
        const height = best.rotated ? item.width : item.height;
        const used: FreeRect = { x: best.rect.x, y: best.rect.y, w: width + spacing, h: height + spacing };
        placed.push({ id: item.id, x: used.x, y: used.y, rotated: best.rotated, width, height });
        free = splitFree(free, used);
    }
    return { placed, unplaced };
}

function overlaps(a: FreeRect, b: FreeRect): boolean {
    return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

function contains(a: FreeRect, b: FreeRect): boolean {
    return (
        b.x >= a.x - EPS && b.y >= a.y - EPS && b.x + b.w <= a.x + a.w + EPS && b.y + b.h <= a.y + a.h + EPS
    );
}

function splitFree(free: readonly FreeRect[], used: FreeRect): FreeRect[] {
    const out: FreeRect[] = [];
    for (const rect of free) {
        if (!overlaps(rect, used)) {
            out.push(rect);
            continue;
        }
        if (used.x > rect.x + EPS) out.push({ x: rect.x, y: rect.y, w: used.x - rect.x, h: rect.h });
        if (used.x + used.w < rect.x + rect.w - EPS)
            out.push({ x: used.x + used.w, y: rect.y, w: rect.x + rect.w - (used.x + used.w), h: rect.h });
        if (used.y > rect.y + EPS) out.push({ x: rect.x, y: rect.y, w: rect.w, h: used.y - rect.y });
        if (used.y + used.h < rect.y + rect.h - EPS)
            out.push({ x: rect.x, y: used.y + used.h, w: rect.w, h: rect.y + rect.h - (used.y + used.h) });
    }
    // Drop free rectangles inside others.
    return out.filter(
        (rect, i) =>
            !out.some((other, j) => j !== i && contains(other, rect) && (j < i || !contains(rect, other))),
    );
}
