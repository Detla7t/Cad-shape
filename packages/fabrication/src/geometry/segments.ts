// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { arcSweep, type Point2 } from "@chili3d/drawing";
import type { ArcSegment, Segment } from "./types";

const DEG = Math.PI / 180;

export function pointOnArc(arc: ArcSegment, angle: number): Point2 {
    return [
        arc.center[0] + arc.radius * Math.cos(angle * DEG),
        arc.center[1] + arc.radius * Math.sin(angle * DEG),
    ];
}

/** The point at parameter `t` ∈ [0, 1] along the segment (arcs counter-clockwise). */
export function segmentPointAt(segment: Segment, t: number): Point2 {
    if (segment.kind === "line") {
        return [
            segment.a[0] + (segment.b[0] - segment.a[0]) * t,
            segment.a[1] + (segment.b[1] - segment.a[1]) * t,
        ];
    }
    return pointOnArc(segment, segment.startAngle + arcSweep(segment.startAngle, segment.endAngle) * t);
}

export function segmentLength(segment: Segment): number {
    if (segment.kind === "line") return Math.hypot(segment.b[0] - segment.a[0], segment.b[1] - segment.a[1]);
    return segment.radius * arcSweep(segment.startAngle, segment.endAngle) * DEG;
}

/** Shortest distance from `point` to the segment. */
export function distanceToSegment(segment: Segment, point: Point2): number {
    if (segment.kind === "line") {
        const dx = segment.b[0] - segment.a[0];
        const dy = segment.b[1] - segment.a[1];
        const lengthSq = dx * dx + dy * dy;
        const along = ((point[0] - segment.a[0]) * dx + (point[1] - segment.a[1]) * dy) / lengthSq;
        const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, along));
        return Math.hypot(point[0] - segment.a[0] - t * dx, point[1] - segment.a[1] - t * dy);
    }
    const angle = Math.atan2(point[1] - segment.center[1], point[0] - segment.center[0]) / DEG;
    const into = (((angle - segment.startAngle) % 360) + 360) % 360;
    if (into <= arcSweep(segment.startAngle, segment.endAngle)) {
        return Math.abs(
            Math.hypot(point[0] - segment.center[0], point[1] - segment.center[1]) - segment.radius,
        );
    }
    const ends = [segmentPointAt(segment, 0), segmentPointAt(segment, 1)];
    return Math.min(...ends.map((end) => Math.hypot(point[0] - end[0], point[1] - end[1])));
}

/**
 * Whether two segment sets draw the same geometry, however each splits it into pieces:
 * every sampled point of one lies within `tolerance` of the other, both ways, and the
 * total lengths agree. How Onshape's exports are compared with the generated patterns.
 */
export function sameGeometry(a: readonly Segment[], b: readonly Segment[], tolerance = 1e-6): boolean {
    const covered = (from: readonly Segment[], onto: readonly Segment[]) =>
        from.every((segment) =>
            [0, 0.25, 0.5, 0.75, 1].every((t) => {
                const point = segmentPointAt(segment, t);
                return onto.some((other) => distanceToSegment(other, point) <= tolerance);
            }),
        );
    const total = (segments: readonly Segment[]) => segments.reduce((sum, s) => sum + segmentLength(s), 0);
    return (
        covered(a, b) && covered(b, a) && Math.abs(total(a) - total(b)) <= tolerance * (a.length + b.length)
    );
}
