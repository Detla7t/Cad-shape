// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    arcSegment,
    lineSegment,
    type Path2,
    type PathSegment,
    pathLength,
    subPath,
} from "../geometry2d/path";
import { bounds, distanceToLoops, pointInLoops } from "../geometry2d/polygon";
import { add, distance, type Point2 } from "../geometry2d/vec";
import { flat, type Piece, ramp } from "./moves";

/**
 * Entering material away from a cleared area: a helix (circular ramp) inside the region the
 * tool centre may move in, a ramp along a closed ring, or a zig-zag ramp along a line.
 */

const slopeOf = (angle: number) => Math.tan((Math.max(0.1, Math.min(89, angle)) * Math.PI) / 180);

/** Whether the straight move a→b keeps the tool centre inside `loops` (within `tolerance`). */
export function segmentInside(
    a: Point2,
    b: Point2,
    loops: readonly (readonly Point2[])[],
    step: number,
    tolerance = 1e-3,
): boolean {
    const n = Math.max(1, Math.ceil(distance(a, b) / Math.max(1e-3, step)));
    for (let i = 0; i <= n; i++) {
        const p: Point2 = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
        if (!pointInLoops(p, loops) && distanceToLoops(p, loops) > tolerance) return false;
    }
    return true;
}

/**
 * The point of a region farthest from its boundary (sampled), with that clearance: where a
 * helix fits best.
 */
export function deepestPoint(
    loops: readonly (readonly Point2[])[],
    within: readonly (readonly Point2[])[] = loops,
    samples = 12,
): { point: Point2; clearance: number } | undefined {
    const box = bounds(loops.flat());
    if (!Number.isFinite(box.min[0])) return undefined;
    let best: { point: Point2; clearance: number } | undefined;
    const consider = (p: Point2) => {
        if (!pointInLoops(p, loops)) return;
        const clearance = distanceToLoops(p, within);
        if (!pointInLoops(p, within)) return;
        if (best === undefined || clearance > best.clearance) best = { point: p, clearance };
    };
    for (let i = 0; i <= samples; i++) {
        for (let j = 0; j <= samples; j++) {
            consider([
                box.min[0] + ((box.max[0] - box.min[0]) * (i + 0.5)) / (samples + 1),
                box.min[1] + ((box.max[1] - box.min[1]) * (j + 0.5)) / (samples + 1),
            ]);
        }
    }
    // Refine around the best sample.
    if (best !== undefined) {
        let step = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]) / (samples + 1);
        for (let k = 0; k < 8; k++) {
            const c = best.point;
            for (const d of [
                [step, 0],
                [-step, 0],
                [0, step],
                [0, -step],
            ] as const) {
                consider(add(c, d));
            }
            step /= 2;
        }
    }
    return best;
}

/**
 * A helix of `radius` around `center` from `z0` down to `z1` at most `angle` degrees
 * steep, starting and ending at center + (radius, 0), then one flat turn at `z1`.
 */
export function helixPieces(
    center: Point2,
    radius: number,
    z0: number,
    z1: number,
    angle: number,
    ccw: boolean,
    feed?: number,
): Piece[] {
    const east = add(center, [radius, 0]);
    const west = add(center, [-radius, 0]);
    const half: PathSegment[] = [arcSegment(east, west, center, ccw), arcSegment(west, east, center, ccw)];
    const drop = 2 * Math.PI * radius * slopeOf(angle);
    const turns = Math.max(1, Math.ceil((z0 - z1) / Math.max(1e-6, drop) - 1e-9));
    const pieces: Piece[] = [];
    for (let t = 0; t < turns; t++) {
        pieces.push(...ramp(half, z0 - ((z0 - z1) * t) / turns, z0 - ((z0 - z1) * (t + 1)) / turns, feed));
    }
    pieces.push(...flat(half, z1, feed));
    return pieces;
}

/**
 * Ramps into a closed ring: down along it from `z0` to `z1` (several turns when one is not
 * long enough), around it at `z1`, and over the ramped stretch again. Ends at the start.
 */
export function rampAroundRing(
    path: Path2,
    z0: number,
    z1: number,
    angle: number,
    rampFeed?: number,
): Piece[] {
    const total = pathLength(path);
    const needed = (z0 - z1) / slopeOf(angle);
    if (needed <= total) {
        return [
            ...ramp(subPath(path, 0, needed), z0, z1, rampFeed),
            ...flat(subPath(path, needed, total), z1),
            ...flat(subPath(path, 0, needed), z1),
        ];
    }
    const turns = Math.ceil(needed / total);
    const out: Piece[] = [];
    for (let t = 0; t < turns; t++) {
        out.push(
            ...ramp(
                path.segments,
                z0 - ((z0 - z1) * t) / turns,
                z0 - ((z0 - z1) * (t + 1)) / turns,
                rampFeed,
            ),
        );
    }
    out.push(...flat(path.segments, z1));
    return out;
}

/**
 * A zig-zag ramp along the line a→b from `z0` down to `z1`: back and forth until the depth
 * is reached, ending at `a` or `b` (returned).
 */
export function zigzagRamp(
    a: Point2,
    b: Point2,
    z0: number,
    z1: number,
    angle: number,
    rampFeed?: number,
): { pieces: Piece[]; end: Point2 } {
    const length = distance(a, b);
    const needed = (z0 - z1) / slopeOf(angle);
    if (length < 1e-6) return { pieces: [], end: a };
    const passes = Math.max(1, Math.ceil(needed / length - 1e-9));
    const pieces: Piece[] = [];
    let from = a;
    let to = b;
    for (let i = 0; i < passes; i++) {
        pieces.push(
            ...ramp(
                [lineSegment(from, to)],
                z0 - ((z0 - z1) * i) / passes,
                z0 - ((z0 - z1) * (i + 1)) / passes,
                rampFeed,
            ),
        );
        [from, to] = [to, from];
    }
    return { pieces, end: from };
}
