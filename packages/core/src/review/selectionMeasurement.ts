// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Result } from "../foundation/result";
import type { XYZLike } from "../math";

export type MeasurementMode =
    | "length"
    | "distance"
    | "maxDistance"
    | "centerDistance"
    | "diameter"
    | "radius";
export const MEASUREMENT_LABELS: Record<MeasurementMode, string> = {
    length: "Length",
    distance: "Minimum distance",
    maxDistance: "Maximum distance",
    centerDistance: "Center distance",
    diameter: "Diameter",
    radius: "Radius",
};

/**
 * One more value Onshape's measure panel shows beside the main measurement: a distance's
 * ΔX/ΔY/ΔZ components (drawn in the axis colours), the angle between two straight edges or
 * planar faces, an area, a point's coordinates.
 */
export interface MeasurementDetail {
    readonly label: string;
    /** Millimetres, degrees or square millimetres, by `quantity`. */
    readonly value: number;
    readonly quantity: "length" | "angle" | "area";
    /** The world axis of a distance component (`ΔX`…). */
    readonly axis?: "x" | "y" | "z";
    /** World-space geometry to draw for it. */
    readonly segments?: readonly (readonly [XYZLike, XYZLike])[];
}
export interface MeasurementResult {
    mode: MeasurementMode;
    value: number;
    label: string;
    /** World-space geometry of the actual measured extent. */
    segments: readonly (readonly [XYZLike, XYZLike])[];
}
export interface SelectionMeasurement {
    key: string;
    modes: readonly MeasurementMode[];
    /** The main value; absent when the selection only has details (a point's coordinates). */
    measurement?: MeasurementResult;
    /** Everything else the selection measures, in panel order. */
    details?: readonly MeasurementDetail[];
    createVariable(mode: MeasurementMode): Promise<void>;
}
export interface ISelectionMeasurementProvider {
    evaluate(document: IDocument, mode?: MeasurementMode): Result<SelectionMeasurement>;
}
let provider: ISelectionMeasurementProvider | undefined;
export function registerSelectionMeasurementProvider(value: ISelectionMeasurementProvider): void {
    provider = value;
}
export function evaluateSelectionMeasurement(
    document: IDocument,
    mode?: MeasurementMode,
): Result<SelectionMeasurement> {
    return provider?.evaluate(document, mode) ?? Result.err("Select geometry to measure.");
}
