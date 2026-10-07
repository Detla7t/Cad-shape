// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Tabs (holding bridges, micro-joints): stretches of a closed contour, by arc length, where
 * the cut is lifted (milling) or the beam is off (cutting) so the part stays attached.
 */

export interface Interval {
    readonly start: number;
    readonly end: number;
}

/** `count` tab centres spread evenly around a contour of `total` length, the first at `first`. */
export function tabCenters(total: number, count: number, first = total / (2 * Math.max(1, count))): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push((((first + (i * total) / count) % total) + total) % total);
    return out.sort((a, b) => a - b);
}

/**
 * The stretches the tool path skips for tabs of `width` (path length per tab) centred at
 * `centers`, merged where they overlap and clipped to [0, total] (a tab across the seam is
 * split in two).
 */
export function tabIntervals(total: number, centers: readonly number[], width: number): Interval[] {
    if (width <= 0 || total <= 0) return [];
    const raw: Interval[] = [];
    for (const center of centers) {
        let start = center - width / 2;
        let end = center + width / 2;
        if (width >= total) return [{ start: 0, end: total }];
        if (start < 0) {
            raw.push({ start: total + start, end: total });
            start = 0;
        }
        if (end > total) {
            raw.push({ start: 0, end: end - total });
            end = total;
        }
        raw.push({ start, end });
    }
    raw.sort((a, b) => a.start - b.start);
    const merged: Interval[] = [];
    for (const interval of raw) {
        const last = merged[merged.length - 1];
        if (last !== undefined && interval.start <= last.end) {
            merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, interval.end) };
        } else merged.push(interval);
    }
    return merged;
}
