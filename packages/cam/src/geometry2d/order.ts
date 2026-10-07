// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { distance, type Point2 } from "./vec";

/**
 * Cut ordering: greedy nearest neighbour (each next item is the one whose entry is closest
 * to where the previous one ended), refined by 2-opt for point sets (drilling).
 */

export function nearestNeighborOrder<T>(
    items: readonly T[],
    from: Point2,
    entry: (item: T, at: Point2) => Point2,
    exit: (item: T) => Point2 = (item) => entry(item, from),
): T[] {
    const remaining = [...items];
    const out: T[] = [];
    let at = from;
    while (remaining.length > 0) {
        let best = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        remaining.forEach((item, i) => {
            const d = distance(at, entry(item, at));
            if (d < bestDistance - 1e-9) {
                bestDistance = d;
                best = i;
            }
        });
        const [next] = remaining.splice(best, 1);
        out.push(next);
        at = exit(next);
    }
    return out;
}

/** Length of the open tour start → points[0] → … → points[n−1]. */
export function tourLength(points: readonly Point2[], start?: Point2): number {
    let total = start !== undefined && points.length > 0 ? distance(start, points[0]) : 0;
    for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
    return total;
}

/**
 * A short open tour through the points from `start`: nearest neighbour, then 2-opt
 * segment reversals until none shortens it. Returns the visiting order as indices.
 */
export function shortPathOrder(points: readonly Point2[], start: Point2, maxPasses = 50): number[] {
    const order = nearestNeighborOrder(
        points.map((_, i) => i),
        start,
        (i) => points[i],
    );
    const n = order.length;
    if (n < 3) return order;
    const at = (i: number) => (i < 0 ? start : points[order[i]]);
    for (let pass = 0; pass < maxPasses; pass++) {
        let improved = false;
        for (let i = 0; i < n - 1; i++) {
            for (let k = i + 1; k < n; k++) {
                // Reverse order[i..k]: edges (i−1, i) and (k, k+1) become (i−1, k) and (i, k+1).
                const a = at(i - 1);
                const b = at(i);
                const c = at(k);
                const before = distance(a, b) + (k + 1 < n ? distance(c, at(k + 1)) : 0);
                const after = distance(a, c) + (k + 1 < n ? distance(b, at(k + 1)) : 0);
                if (after < before - 1e-9) {
                    order.splice(i, k - i + 1, ...order.slice(i, k + 1).reverse());
                    improved = true;
                }
            }
        }
        if (!improved) break;
    }
    return order;
}
