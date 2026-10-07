// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ANGLE_UNITS, LENGTH_UNITS, type UnitSpec } from "./unitSpec";

/** Length unit names, as the factor to the app's length unit (mm). */
const LENGTH_FACTORS: Record<string, number> = {
    mm: 1,
    millimeter: 1,
    millimeters: 1,
    millimetre: 1,
    millimetres: 1,
    cm: 10,
    centimeter: 10,
    centimeters: 10,
    centimetre: 10,
    centimetres: 10,
    m: 1000,
    meter: 1000,
    meters: 1000,
    metre: 1000,
    metres: 1000,
    km: 1e6,
    um: 0.001,
    µm: 0.001,
    micron: 0.001,
    microns: 0.001,
    in: 25.4,
    inch: 25.4,
    inches: 25.4,
    '"': 25.4,
    ft: 304.8,
    foot: 304.8,
    feet: 304.8,
    "'": 304.8,
    yd: 914.4,
    yard: 914.4,
    yards: 914.4,
};

/** Angle unit names, as the factor to the app's angle unit (degrees). */
const ANGLE_FACTORS: Record<string, number> = {
    deg: 1,
    degree: 1,
    degrees: 1,
    "°": 1,
    rad: 180 / Math.PI,
    radian: 180 / Math.PI,
    radians: 180 / Math.PI,
};

/** One unit: how much of the app's unit it is, and which dimension it measures. */
export interface UnitSuffix {
    readonly factor: number;
    readonly unit: UnitSpec;
}

/**
 * The unit a suffix names — `"mm"`, `"in"`, `"deg"`, `"°"` — or undefined. Lookup ignores
 * case (`"MM"`, `"Inch"`) unless `exact`, which expressions use for a bare unit name so `M`
 * stays an unknown identifier rather than a metre.
 */
export function unitSuffix(name: string, exact = false): UnitSuffix | undefined {
    const key = exact || name === "µm" || name === "°" ? name : name.toLowerCase();
    if (Object.hasOwn(LENGTH_FACTORS, key)) return { factor: LENGTH_FACTORS[key], unit: LENGTH_UNITS };
    if (Object.hasOwn(ANGLE_FACTORS, key)) return { factor: ANGLE_FACTORS[key], unit: ANGLE_UNITS };
    return undefined;
}
