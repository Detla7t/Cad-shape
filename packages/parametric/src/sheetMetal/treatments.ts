// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { EdgeTreatmentKind, FlangeElement } from "./model";

/**
 * Edge treatment profiles, as the sequence a roll former or brake puts into the edge.
 * Directions: +1 forms toward the sheet's top side (the plane normal), −1 away from it.
 *
 * - **Easy edge** — the male half of a Pittsburgh lock: a single 90° bend leaving a
 *   straight leg (1/4" by default) that slides into the mating pocket.
 * - **Pittsburgh pocket** — the female half: the edge runs out the pocket depth, folds
 *   back on itself leaving a slot one sheet thick plus clearance (where the easy edge
 *   goes), and turns up into the lip that is hammered over once the seam is closed.
 * - **Hem** — the edge folded flat onto itself (a safe edge).
 * - **Flange** — a single bend of any angle with a straight leg.
 *
 * Defaults follow common 24–26 ga duct practice: 5/16" pocket, 3/8" lip, 1/4" easy edge.
 */

export const INCH = 25.4;

export const DEFAULTS = {
    easyEdgeLength: INCH / 4,
    pocketDepth: (5 * INCH) / 16,
    lipHeight: (3 * INCH) / 8,
    hemLength: INCH / 2,
    flangeLength: INCH / 2,
};

export interface TreatmentParameters {
    readonly kind: EdgeTreatmentKind;
    readonly direction: 1 | -1;
    /** Easy edge / flange leg, hem length, or Pittsburgh pocket depth. */
    readonly length: number;
    /** Pittsburgh lip height. */
    readonly height: number;
    /** Pittsburgh slot clearance over one sheet thickness. */
    readonly clearance: number;
    /** Flange angle, degrees. */
    readonly angle: number;
    readonly radius: number;
    readonly thickness: number;
}

export function treatmentElements(p: TreatmentParameters): FlangeElement[] {
    const d = p.direction;
    switch (p.kind) {
        case "easyEdge":
            return [
                { kind: "bend", angle: 90 * d, radius: p.radius },
                { kind: "straight", length: p.length },
            ];
        case "flange":
            return [
                { kind: "bend", angle: p.angle * d, radius: p.radius },
                { kind: "straight", length: p.length },
            ];
        case "hem":
            // A closed hem: the layers lie 2 × the fold's inner radius apart, so a (near) zero
            // inner radius makes them touch.
            return [
                { kind: "bend", angle: 180 * d, radius: p.thickness * 1e-3 },
                { kind: "straight", length: p.length },
            ];
        case "pittsburgh": {
            // The slot between the layers is one sheet (the easy edge) plus clearance wide.
            const fold = (p.thickness + p.clearance) / 2;
            const back = p.length - p.radius - p.thickness;
            if (back <= 0)
                throw new Error("The pocket depth is too small for the sheet thickness and lip radius");
            return [
                { kind: "straight", length: p.length },
                { kind: "bend", angle: 180 * d, radius: fold },
                { kind: "straight", length: back },
                { kind: "bend", angle: -90 * d, radius: p.radius },
                { kind: "straight", length: p.height },
            ];
        }
    }
}
