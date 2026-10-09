// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DrawingUnits, Point2 } from "@chili3d/drawing";

/**
 * What a fabrication template produces: flat parts made of lines and arcs, with the cut
 * outline kept apart from the fold lines. Layers, colors and file formats are decided later
 * (`toDrawing`), so the same pattern feeds a DXF, an SVG preview or a Chili3d sketch. Arcs run
 * counter-clockwise from `startAngle` to `endAngle` (degrees), the DXF convention.
 */

export interface LineSegment {
    readonly kind: "line";
    readonly a: Point2;
    readonly b: Point2;
}

export interface ArcSegment {
    readonly kind: "arc";
    readonly center: Point2;
    readonly radius: number;
    readonly startAngle: number;
    readonly endAngle: number;
}

export type Segment = LineSegment | ArcSegment;

/** One piece of sheet: the cut outline plus the lines it is folded along. */
export interface FlatPart {
    readonly name: string;
    readonly outline: readonly Segment[];
    /** Fold lines (not cut). */
    readonly bendLines: readonly Segment[];
}

export interface FlatPattern {
    readonly name: string;
    readonly units: DrawingUnits;
    readonly parts: readonly FlatPart[];
}

export function line(a: Point2, b: Point2): LineSegment {
    return { kind: "line", a, b };
}

export function arc(center: Point2, radius: number, startAngle: number, endAngle: number): ArcSegment {
    return { kind: "arc", center, radius, startAngle, endAngle };
}

/** A closed polyline through `points` (the last point joins back to the first). */
export function polygon(points: readonly Point2[]): LineSegment[] {
    return points.map((point, i) => line(point, points[(i + 1) % points.length]));
}
