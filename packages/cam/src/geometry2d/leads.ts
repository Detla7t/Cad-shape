// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { arcSegment, lineSegment, type PathSegment } from "./path";
import { add, type Point2, perpLeft, rotate, scale, sub } from "./vec";

/**
 * Lead-ins and lead-outs: short moves that take the tool (or beam) onto and off a contour
 * tangentially from the side away from the part, so the entry leaves no mark on the wall.
 * `side` is +1 for the left of the direction of travel, −1 for the right.
 */

export type LeadKind = "arc" | "line" | "none";

/** An arc of `radius` (and `sweep`, default 90°) ending tangent at `start`, from `side`. */
export function arcLeadIn(
    start: Point2,
    tangent: Point2,
    radius: number,
    side: 1 | -1,
    sweep = Math.PI / 2,
): PathSegment {
    const center = add(start, scale(perpLeft(tangent), side * radius));
    const from = add(center, rotate(sub(start, center), -side * sweep));
    return arcSegment(from, start, center, side > 0);
}

/** An arc of `radius` leaving `end` tangent to `tangent`, curving towards `side`. */
export function arcLeadOut(
    end: Point2,
    tangent: Point2,
    radius: number,
    side: 1 | -1,
    sweep = Math.PI / 2,
): PathSegment {
    const center = add(end, scale(perpLeft(tangent), side * radius));
    const to = add(center, rotate(sub(end, center), side * sweep));
    return arcSegment(end, to, center, side > 0);
}

/** A straight approach of `length` square to the contour, from `side`. */
export function lineLeadIn(start: Point2, tangent: Point2, length: number, side: 1 | -1): PathSegment {
    return lineSegment(add(start, scale(perpLeft(tangent), side * length)), start);
}

export function lineLeadOut(end: Point2, tangent: Point2, length: number, side: 1 | -1): PathSegment {
    return lineSegment(end, add(end, scale(perpLeft(tangent), side * length)));
}

/** The lead-in of a kind, or none. */
export function leadIn(
    kind: LeadKind,
    start: Point2,
    tangent: Point2,
    size: number,
    side: 1 | -1,
): PathSegment[] {
    if (kind === "none" || size <= 1e-9) return [];
    return [kind === "arc" ? arcLeadIn(start, tangent, size, side) : lineLeadIn(start, tangent, size, side)];
}

export function leadOut(
    kind: LeadKind,
    end: Point2,
    tangent: Point2,
    size: number,
    side: 1 | -1,
): PathSegment[] {
    if (kind === "none" || size <= 1e-9) return [];
    return [kind === "arc" ? arcLeadOut(end, tangent, size, side) : lineLeadOut(end, tangent, size, side)];
}
