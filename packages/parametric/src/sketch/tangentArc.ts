// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { UV } from "./curveGeometry";
import type { SketchEntityData } from "./sketchModel";

/** Relative tolerance below which an end on the start tangent makes no arc. */
const STRAIGHT_TOLERANCE = 1e-9;

/**
 * Unit direction in which a tangent continuation leaves the curve at its end
 * `pointIndex` — away from the curve. Lines end at points 0 and 1, arcs at their start
 * (1) and end (2); anything else has no end to continue from.
 */
export function endTangent(entity: SketchEntityData, pointIndex: number): UV | undefined {
    const p = entity.params;
    let direction: UV | undefined;
    if (entity.type === "line" && (pointIndex === 0 || pointIndex === 1)) {
        direction = pointIndex === 1 ? [p[2] - p[0], p[3] - p[1]] : [p[0] - p[2], p[1] - p[3]];
    } else if (entity.type === "arc" && (pointIndex === 1 || pointIndex === 2)) {
        const [cx, cy] = p;
        // arcs run counter-clockwise from start to end: leaving the end keeps turning that
        // way, leaving the start turns back against it
        const [x, y] = pointIndex === 2 ? [p[4], p[5]] : [p[2], p[3]];
        direction = pointIndex === 2 ? [-(y - cy), x - cx] : [y - cy, -(x - cx)];
    }
    if (direction === undefined) return undefined;
    const length = Math.hypot(...direction);
    return length < 1e-12 ? undefined : [direction[0] / length, direction[1] / length];
}

/** An arc entity's params and which of its points (start 1, end 2) is the tangent start. */
export interface TangentArc {
    params: [number, number, number, number, number, number];
    startIndex: 1 | 2;
}

/**
 * The arc leaving `start` along the unit `direction` and ending at `end`: its center
 * lies on the start normal, as far from `end` as from `start`. Arc params are
 * counter-clockwise, so a right turn puts `start` at the arc's end. Undefined when
 * `end` is on the tangent line (a straight continuation) or on `start`.
 */
export function tangentArc(start: UV, direction: UV, end: UV): TangentArc | undefined {
    const d: UV = [end[0] - start[0], end[1] - start[1]];
    const chordSq = d[0] * d[0] + d[1] * d[1];
    const normal: UV = [-direction[1], direction[0]];
    const across = normal[0] * d[0] + normal[1] * d[1];
    if (chordSq < 1e-18 || Math.abs(across) <= STRAIGHT_TOLERANCE * Math.sqrt(chordSq)) return undefined;
    // signed distance from start to the center along the left normal
    const offset = chordSq / (2 * across);
    const cx = start[0] + normal[0] * offset;
    const cy = start[1] + normal[1] * offset;
    return offset > 0
        ? { params: [cx, cy, start[0], start[1], end[0], end[1]], startIndex: 1 }
        : { params: [cx, cy, end[0], end[1], start[0], start[1]], startIndex: 2 };
}
