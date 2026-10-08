// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation/result";
import type { IShape } from "../shape";

export interface ShapeProperties {
    dimension: number;
    /** mm^dimension, centroid in mm, inertia per unit density in mm^(dimension+2). */
    measure: number;
    centroid: readonly number[];
    inertia: readonly (readonly number[])[];
}
let provider: ((shapes: readonly IShape[]) => Result<ShapeProperties>) | undefined;
export function registerShapeProperties(value: NonNullable<typeof provider>) {
    provider = value;
}
export function evaluateShapeProperties(shapes: readonly IShape[]): Result<ShapeProperties> {
    return provider?.(shapes) ?? Result.err("Mass properties provider is unavailable.");
}
