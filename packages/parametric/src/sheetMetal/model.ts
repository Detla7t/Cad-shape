// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IShape, Plane } from "@chili3d/core";

/**
 * The sheet metal model: a FLAT-FIRST description of a part, the way duct and sheet
 * metal shops lay work out — a flat blank, the bend lines on it, the edge treatments
 * (easy edge, Pittsburgh pocket, hem, flange) hanging off its straight edges, an
 * optional roll into a cylinder (round duct) with crimps and beads.
 *
 * The solid is always DERIVED from this description (`build.ts`): folded, or flat
 * (`flat`) with its bend lines marked — so flattening is exact by construction, with
 * bend allowances from the neutral layer (`kFactor`).
 *
 * Sheet metal features hand the model down the body's feature chain beside the shape
 * (`sheetModelOf`): each one reads the model its input carries, adds to it, rebuilds,
 * and registers the result. All 2D coordinates are millimetres in the blank's plane
 * (u along `plane.xvec`, v along `plane.yvec`); the sheet occupies [0, thickness]
 * along `plane.normal`.
 */

export type V2 = readonly [number, number];

export type Segment2 =
    | { readonly kind: "line"; readonly a: V2; readonly b: V2 }
    /** A circular arc through three points (start, a point on the arc, end). */
    | { readonly kind: "arc"; readonly a: V2; readonly mid: V2; readonly b: V2 };

/** A closed loop of segments, each starting where the previous one ended. */
export type Loop2 = readonly Segment2[];

export interface SheetBend {
    readonly a: V2;
    readonly b: V2;
    /** Degrees; positive folds toward the plane normal ("up"). */
    readonly angle: number;
    /** Inner bend radius, mm. */
    readonly radius: number;
}

export type FlangeElement =
    | { readonly kind: "straight"; readonly length: number }
    /** A bend: degrees (positive toward the sheet's top side), inner radius in mm. */
    | { readonly kind: "bend"; readonly angle: number; readonly radius: number };

/** What an edge treatment is, for display and for the seam-fit check. */
export type EdgeTreatmentKind = "easyEdge" | "pittsburgh" | "hem" | "flange";

/** A formed strip along a straight blank edge: the profile `elements`, starting at the edge. */
export interface SheetFlange {
    readonly kind: EdgeTreatmentKind;
    /** The blank edge's endpoints. */
    readonly a: V2;
    readonly b: V2;
    readonly elements: readonly FlangeElement[];
    /** The male leg length an easy edge offers / the pocket depth a Pittsburgh offers. */
    readonly seamDepth?: number;
}

export interface SheetRoll {
    /** The blank axis the cylinder is rolled around. */
    readonly axis: "u" | "v";
    /** Inner radius, mm; undefined closes the blank into a full cylinder. */
    readonly radius?: number;
    /** +1 curls toward the plane normal, -1 away from it. */
    readonly direction: 1 | -1;
}

export interface SheetCrimp {
    readonly end: "start" | "end";
    readonly length: number;
    readonly depth: number;
    readonly count: number;
}

export type SheetBead =
    /** A stiffening rib along a straight line of the flat blank. */
    | {
          readonly kind: "line";
          readonly a: V2;
          readonly b: V2;
          readonly width: number;
          readonly height: number;
          readonly direction: 1 | -1;
      }
    /** A circumferential bead around a rolled sheet, `offset` from one end. */
    | {
          readonly kind: "ring";
          readonly offset: number;
          readonly from: "start" | "end";
          readonly width: number;
          readonly height: number;
          readonly direction: 1 | -1;
      };

export interface SheetMetalModel {
    readonly plane: Plane;
    readonly thickness: number;
    /** Default inner bend radius, mm. */
    readonly radius: number;
    /** Neutral-layer position as a fraction of the thickness from the inner surface. */
    readonly kFactor: number;
    /** Outer loop first, then holes. */
    readonly blank: readonly Loop2[];
    readonly bends: readonly SheetBend[];
    readonly flanges: readonly SheetFlange[];
    readonly roll?: SheetRoll;
    readonly crimps: readonly SheetCrimp[];
    readonly beads: readonly SheetBead[];
    /** True after a Flatten feature: the part is shown as its flat pattern. */
    readonly flat: boolean;
}

/** Bend allowance: the developed (neutral-layer) length of a bend. */
export function bendAllowance(angleDeg: number, radius: number, thickness: number, kFactor: number): number {
    return (Math.abs(angleDeg) * Math.PI * (radius + kFactor * thickness)) / 180;
}

/** Developed (flat) width of a flange profile. */
export function flangeFlatLength(model: SheetMetalModel, elements: readonly FlangeElement[]): number {
    return elements.reduce(
        (sum, element) =>
            sum +
            (element.kind === "straight"
                ? element.length
                : bendAllowance(element.angle, element.radius, model.thickness, model.kFactor)),
        0,
    );
}

// ------------------------------------------------------------------ Model hand-off along the chain

const models = new WeakMap<IShape, SheetMetalModel>();

/** The sheet metal model a feature's output carries, if it is a sheet metal part. */
export function sheetModelOf(shape: IShape | undefined): SheetMetalModel | undefined {
    return shape === undefined ? undefined : models.get(shape);
}

export function registerSheetModel(shape: IShape, model: SheetMetalModel): IShape {
    models.set(shape, model);
    return shape;
}
