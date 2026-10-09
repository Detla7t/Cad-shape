// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Point2 } from "@chili3d/drawing";
import {
    arc,
    type FlatPart,
    type FlatPattern,
    type LineSegment,
    line,
    polygon,
    type Segment,
} from "../geometry/types";
import { formatFileInches, formatFractionalInches } from "./inches";
import { defaultWallHeight, ductSize, flangeAllowance, MIN_WALL_HEIGHT } from "./sizes";

/**
 * Round duct end caps, flat — a recreation of the "End Cap" and "Reducing End Cap" sketches
 * of the Onshape End Cap Configurator, matching its DXF exports entity for entity (inches).
 *
 * A cap is two half discs. Their radius is the duct's (the bend line, where the rim folds
 * over the duct) plus a flange allowance that grows with the size. The second half carries
 * the lap seam: a 1" tab along its straight edge whose ends are cut in to clear the folded rim.
 * A reducing cap has a hole for the smaller duct, 3/32 under its radius, and two collar
 * strips that roll into the short duct stub: one plain, one with a 1" lap at each end
 * below the crimp band. The configurator's "Custom Crimp" and "Wall Inner Edge" options are
 * not modelled: every reference export used their defaults, so their effect is unknown.
 *
 * Layout matches Onshape's: half discs hanging below y = 0 and y = c (their straight edges on
 * those lines), collar strips above.
 */

export interface EndCapParams {
    /** A reducing cap (a hole and a collar for a smaller duct) instead of a plain one. */
    readonly reducing: boolean;
    /** Outside diameter of the duct the cap closes, inches. */
    readonly od: number;
    /** Diameter of the smaller duct (reducing caps), inches. */
    readonly id?: number;
    /** Finish wall height of the collar, inches; `defaultWallHeight(od)` when absent. */
    readonly wallHeight?: number;
}

/** Success or a message for the user (the shape of core's `Result`, without depending on core). */
export type Outcome<T> =
    | { readonly isOk: true; readonly value: T }
    | { readonly isOk: false; readonly error: string };

export type EndCapOutcome = Outcome<FlatPattern>;

/** Lap seam tab of a plain cap, and the tallest one of a reducing cap. */
const SEAM_TAB = 1;
/** Tab ends sit this far off the bend circle (in for a plain cap, out for a reducing one). */
const TAB_CLEARANCE = 1 / 16;
/** The hole is this much under the small duct's radius… */
const HOLE_UNDERSIZE = 3 / 32;
/** …and the seam tab starts this much over it. */
const TAB_INNER_OFFSET = 1 / 32;
/** A reducing ring narrower than this gets a tab as tall as the ring, not 1". */
const NARROW_RING = 0.75;
/** Collar strip height over the finish wall height (the part that turns into the cap). */
const COLLAR_ALLOWANCE = 0.8125;
/** Lap added to the second collar strip's length (half at each end). */
const COLLAR_LAP = 2;
/**
 * The lap stops this far under the finish wall height, leaving the crimp band above it plain.
 * 0.687 rather than 11/16: the value as typed in the Onshape sketch, kept so the strips match
 * its exports to the thousandth.
 */
const LAP_SHORTFALL = 0.687;

export function validateEndCap(params: EndCapParams): string | undefined {
    const { od, id } = params;
    if (!(od > 2 * SEAM_TAB)) return "The outside diameter must be over 2 in.";
    if (params.reducing) {
        if (id === undefined || !(id > 0)) return "A reducing end cap needs an inside diameter.";
        if (!(id < od)) return "The inside diameter must be smaller than the outside diameter.";
        if (!(id / 2 - HOLE_UNDERSIZE > 0)) return "The inside diameter is too small.";
    }
    const wall = params.wallHeight;
    if (wall !== undefined && !(wall >= MIN_WALL_HEIGHT)) {
        return `The wall height must be at least ${formatFractionalInches(MIN_WALL_HEIGHT)}.`;
    }
    return undefined;
}

export function endCapName(params: EndCapParams): string {
    return params.reducing && params.id !== undefined
        ? `${formatFileInches(params.od)} x ${formatFileInches(params.id)} Reducing End Cap`
        : `${formatFileInches(params.od)} End Cap`;
}

/** The configuration string Onshape exports this cap under, when both sizes are presets. */
export function onshapeConfiguration(params: EndCapParams): string | undefined {
    const od = ductSize(params.od);
    if (od === undefined) return undefined;
    if (!params.reducing) return `Endcap=true;OD_Table=${od.odOption}`;
    const id = params.id === undefined ? undefined : ductSize(params.id);
    if (id === undefined) return undefined;
    return `Endcap=false;OD_Table=${od.odOption};List_tBoS7KHF1hLsDf=${id.idOption}`;
}

export function endCapPattern(params: EndCapParams): EndCapOutcome {
    const error = validateEndCap(params);
    if (error !== undefined) return { isOk: false, error };
    return {
        isOk: true,
        value: {
            name: endCapName(params),
            units: "inch",
            parts: params.reducing ? reducingParts(params, params.id!) : plainParts(params.od),
        },
    };
}

/** The lower half of a ring (radius `outer`, hole `inner`, none when 0) hanging below `cy`. */
function halfArcs(cy: number, outer: number, inner: number): Segment[] {
    const arcs = [arc([0, cy], outer, 180, 0)];
    if (inner > 0) arcs.push(arc([0, cy], inner, 180, 0));
    return arcs;
}

/** Bend line where the flange folds over the duct. */
function rimBend(cy: number, od: number): Segment[] {
    return [arc([0, cy], od / 2, 180, 0)];
}

/** The right-hand edges plus their mirror images on the left (x → −x). */
function mirrored(lines: readonly LineSegment[]): LineSegment[] {
    const flip = ([x, y]: Point2): Point2 => [-x, y];
    return [...lines, ...lines.map((s) => line(flip(s.b), flip(s.a)))];
}

function plainParts(od: number): FlatPart[] {
    const half = od / 2;
    const outer = half + flangeAllowance(od);
    const cy = od + SEAM_TAB;
    const tabEnd = Math.sqrt(half * half - SEAM_TAB * SEAM_TAB) - TAB_CLEARANCE;
    const top = cy + SEAM_TAB;
    return [
        {
            name: "Half",
            outline: [
                ...halfArcs(0, outer, 0),
                line([-outer, 0], [-half, 0]),
                line([-half, 0], [half, 0]),
                line([half, 0], [outer, 0]),
            ],
            bendLines: rimBend(0, od),
        },
        {
            name: "Half with seam",
            outline: [
                ...halfArcs(cy, outer, 0),
                ...mirrored([line([outer, cy], [half, cy])]),
                line([half, cy], [tabEnd, top]),
                line([tabEnd, top], [0, top]),
                line([0, top], [-tabEnd, top]),
                line([-tabEnd, top], [-half, cy]),
            ],
            bendLines: rimBend(cy, od),
        },
    ];
}

function reducingParts(params: EndCapParams, id: number): FlatPart[] {
    const { od } = params;
    const half = od / 2;
    const outer = half + flangeAllowance(od);
    const hole = id / 2 - HOLE_UNDERSIZE;
    const tabStart = id / 2 + TAB_INNER_OFFSET;
    const ring = (od - id) / 2;
    const tab = ring < NARROW_RING ? ring : SEAM_TAB;
    const cy = od;
    const top = cy + tab;
    // The outer end of the tab sits 1/16 outside the bend circle at the tab's height; the inner
    // end leans out by the same amount the outer one moved, as the Onshape sketch drew it.
    const outerEnd = Math.sqrt(half * half - tab * tab) + TAB_CLEARANCE;
    const innerEnd = tabStart + Math.abs(outerEnd - half);

    const wall = params.wallHeight ?? defaultWallHeight(od);
    const height = wall + COLLAR_ALLOWANCE;
    const rolled = (Math.PI / 2) * (id + 1 / 8);
    // Fitted exactly to every preset export: the plain strip is the rolled half circumference
    // plus 1/32, plus 1/156 of the diameter.
    const plainLength = rolled + 1 / 32 + id / 156;
    const lapLength = rolled + COLLAR_LAP;
    const plain = plainLength / 2;
    const lapped = lapLength / 2;
    const y1 = od + 2 * height;
    const y2 = od + 4 * height;
    const lapTop = y2 + Math.max(0, wall - LAP_SHORTFALL);

    return [
        {
            name: "Half",
            outline: [
                ...halfArcs(0, outer, hole),
                ...mirrored([line([outer, 0], [half, 0]), line([half, 0], [hole, 0])]),
            ],
            bendLines: rimBend(0, od),
        },
        {
            name: "Half with seam",
            outline: [
                ...halfArcs(cy, outer, hole),
                ...mirrored([
                    line([outer, cy], [half, cy]),
                    line([half, cy], [outerEnd, top]),
                    line([outerEnd, top], [innerEnd, top]),
                    line([innerEnd, top], [tabStart, cy]),
                    line([tabStart, cy], [hole, cy]),
                ]),
            ],
            bendLines: rimBend(cy, od),
        },
        {
            name: "Collar",
            outline: polygon([
                [-plain, y1],
                [plain, y1],
                [plain, y1 + height],
                [-plain, y1 + height],
            ]),
            bendLines: [],
        },
        {
            name: "Collar with lap",
            outline: polygon([
                [-lapped, y2],
                [lapped, y2],
                [lapped, lapTop],
                [plain, lapTop],
                [plain, y2 + height],
                [-plain, y2 + height],
                [-plain, lapTop],
                [-lapped, lapTop],
            ]),
            bendLines: [],
        },
    ];
}
