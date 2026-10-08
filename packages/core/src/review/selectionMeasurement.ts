// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Result } from "../foundation/result";
import type { XYZLike } from "../math";

export type MeasurementMode = "length" | "distance" | "maxDistance" | "diameter" | "radius";
export const MEASUREMENT_LABELS: Record<MeasurementMode, string> = {
    length: "Length",
    distance: "Minimum distance",
    maxDistance: "Maximum distance",
    diameter: "Diameter",
    radius: "Radius",
};
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
    measurement: MeasurementResult;
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
