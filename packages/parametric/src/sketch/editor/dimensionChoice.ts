// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ConstraintKind, type DimensionAnchor, type SketchPointRef } from "../sketchModel";
import type { SketchSolver } from "../solver";
import { lineIntersection, segmentOffset } from "./dimensionLayout";
import type { DimensionPreview } from "./sketchAnnotations";

type UV = [number, number];

/** Placement outside the points' horizontal/vertical span selects a projected distance.
 * Diagonal placement selects the direct distance. Degenerate projections stay aligned.
 * This works in sketch coordinates at every camera scale, including reversed picks.
 */
export function pointDimensionChoice(
    p1: UV,
    p2: UV,
    position: UV,
): {
    kind: ConstraintKind;
    datum: number;
    anchor: DimensionAnchor;
    preview: DimensionPreview;
} {
    const dx = p2[0] - p1[0],
        dy = p2[1] - p1[1];
    const insideX = position[0] >= Math.min(p1[0], p2[0]) && position[0] <= Math.max(p1[0], p2[0]);
    const insideY = position[1] >= Math.min(p1[1], p2[1]) && position[1] <= Math.max(p1[1], p2[1]);
    const axis =
        Math.abs(dx) > 1e-8 && Math.abs(dy) > 1e-8
            ? insideX && !insideY
                ? "h"
                : insideY && !insideX
                  ? "v"
                  : undefined
            : undefined;
    if (axis) {
        const index = axis === "h" ? 1 : 0;
        return {
            kind: axis === "h" ? ConstraintKind.HorizontalDistance : ConstraintKind.VerticalDistance,
            datum: axis === "h" ? dx : dy,
            anchor: { kind: "offset", offset: position[index] - (p1[index] + p2[index]) / 2 },
            preview: { kind: "axisDistance", p1, p2, axis, position },
        };
    }
    return {
        kind: ConstraintKind.P2PDistance,
        datum: Math.hypot(dx, dy),
        anchor: { kind: "offset", offset: segmentOffset(p1, p2, position) },
        preview: { kind: "distance", p1, p2, position },
    };
}

/** Select the two rays bounding the cursor's quadrant, independent of line endpoint order. */
export function angleDimensionChoice(solver: SketchSolver, first: number, second: number, position: UV) {
    const refs = [first, second].flatMap((entityId) => [
        { entityId, pointIndex: 0 },
        { entityId, pointIndex: 1 },
    ]);
    const points = refs.map((ref) => solver.pointOf(ref));
    const vertex = lineIntersection(points[0], points[1], points[2], points[3]);
    if (!vertex) return undefined;
    const tau = Math.PI * 2;
    const angle = (v: UV) => (Math.atan2(v[1], v[0]) + tau) % tau;
    const cursor = angle([position[0] - vertex[0], position[1] - vertex[1]]);
    const rays = [0, 2]
        .flatMap((i) => {
            const forward = angle([points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]]);
            return [
                { angle: forward, index: i, reverse: false },
                { angle: (forward + Math.PI) % tau, index: i, reverse: true },
            ];
        })
        .sort((a, b) => a.angle - b.angle);
    let index = rays.findLastIndex((ray) => ray.angle <= cursor);
    if (index < 0) index = rays.length - 1;
    const a = rays[index],
        b = rays[(index + 1) % rays.length];
    const ordered = [a, b].flatMap((ray): SketchPointRef[] =>
        ray.reverse ? [refs[ray.index + 1], refs[ray.index]] : [refs[ray.index], refs[ray.index + 1]],
    );
    const [a1, a2, b1, b2] = ordered.map((ref) => solver.pointOf(ref));
    const datum = (b.angle - a.angle + tau) % tau;
    return {
        refs: ordered,
        datum,
        anchor: {
            kind: "vector",
            dx: position[0] - vertex[0],
            dy: position[1] - vertex[1],
        } as DimensionAnchor,
        preview: { kind: "angle", a1, a2, b1, b2, position } as DimensionPreview,
    };
}

export function parallelLines(solver: SketchSolver, first: number, second: number): boolean {
    const a = solver.entity(first)!.params,
        b = solver.entity(second)!.params;
    const ax = a[2] - a[0],
        ay = a[3] - a[1],
        bx = b[2] - b[0],
        by = b[3] - b[1];
    return Math.abs(ax * by - ay * bx) <= 1e-8 * Math.hypot(ax, ay) * Math.hypot(bx, by);
}
