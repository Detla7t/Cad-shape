// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Result } from "../foundation/result";
import type { XYZLike } from "../math";

/**
 * What a measurement reads off the selection. The first six are the main values the readout
 * offers; the rest are the other rows of Onshape's Measure panel — a distance's components
 * along the axes, the angle between two entities, an area, the coordinates of a point or of
 * a circle's center — each of which can also become a measured variable.
 */
export type MeasurementMode =
    | "length"
    | "distance"
    | "maxDistance"
    | "centerDistance"
    | "diameter"
    | "radius"
    | "angle"
    | "tangentAngle"
    | "area"
    | "deltaX"
    | "deltaY"
    | "deltaZ"
    | "positionX"
    | "positionY"
    | "positionZ";
export const MEASUREMENT_LABELS: Record<MeasurementMode, string> = {
    length: "Length",
    distance: "Minimum distance",
    maxDistance: "Maximum distance",
    centerDistance: "Center distance",
    diameter: "Diameter",
    radius: "Radius",
    angle: "Angle",
    tangentAngle: "Face tangent angle",
    area: "Area",
    deltaX: "ΔX",
    deltaY: "ΔY",
    deltaZ: "ΔZ",
    positionX: "X",
    positionY: "Y",
    positionZ: "Z",
};

export type MeasurementQuantity = "length" | "angle" | "area";

/** Millimetres, degrees or square millimetres: what a mode's value is in. */
export function measurementQuantity(mode: MeasurementMode): MeasurementQuantity {
    if (mode === "angle" || mode === "tangentAngle") return "angle";
    if (mode === "area") return "area";
    return "length";
}

/** The axis a component or coordinate mode reads, if it reads one. */
export function measurementAxis(mode: MeasurementMode): "x" | "y" | "z" | undefined {
    const match = /^(?:delta|position)([XYZ])$/.exec(mode);
    return match ? (match[1].toLowerCase() as "x" | "y" | "z") : undefined;
}

/**
 * A reference coordinate system (Onshape's mate connector): positions and the components
 * of a distance are expressed along its axes instead of the world's. World when absent.
 */
export interface MeasurementFrame {
    readonly origin: XYZLike;
    readonly xvec: XYZLike;
    readonly yvec: XYZLike;
    readonly zvec: XYZLike;
}

/**
 * One more value Onshape's measure panel shows beside the main measurement: a distance's
 * ΔX/ΔY/ΔZ components (drawn in the axis colours), the angle between two straight edges or
 * planar faces, an area, a point's coordinates.
 */
export interface MeasurementDetail {
    readonly label: string;
    /** Millimetres, degrees or square millimetres, by `quantity`. */
    readonly value: number;
    readonly quantity: MeasurementQuantity;
    /** The axis of a distance component or coordinate (`ΔX`, `X`…). */
    readonly axis?: "x" | "y" | "z";
    /** World-space geometry to draw for it. */
    readonly segments?: readonly (readonly [XYZLike, XYZLike])[];
    /** The mode that measures this value on its own — what a variable made of it reads. */
    readonly mode?: MeasurementMode;
}
export interface MeasurementResult {
    mode: MeasurementMode;
    value: number;
    label: string;
    /** World-space geometry of the actual measured extent. */
    segments: readonly (readonly [XYZLike, XYZLike])[];
}
/** One entity of the selection, as the panel's "Select entities to measure" lists it. */
export interface MeasuredEntity {
    readonly label: string;
    readonly nodeId: string;
}
export interface SelectionMeasurement {
    key: string;
    modes: readonly MeasurementMode[];
    /** The main value; absent when the selection only has details (a point's coordinates). */
    measurement?: MeasurementResult;
    /** Everything else the selection measures, in panel order. */
    details?: readonly MeasurementDetail[];
    /** What was selected, in pick order. */
    entities?: readonly MeasuredEntity[];
    createVariable(mode: MeasurementMode): Promise<void>;
}
export interface ISelectionMeasurementProvider {
    evaluate(
        document: IDocument,
        mode?: MeasurementMode,
        frame?: MeasurementFrame,
    ): Result<SelectionMeasurement>;
}
let provider: ISelectionMeasurementProvider | undefined;
export function registerSelectionMeasurementProvider(value: ISelectionMeasurementProvider): void {
    provider = value;
}
export function evaluateSelectionMeasurement(
    document: IDocument,
    mode?: MeasurementMode,
    frame?: MeasurementFrame,
): Result<SelectionMeasurement> {
    return provider?.evaluate(document, mode, frame) ?? Result.err("Select geometry to measure.");
}
