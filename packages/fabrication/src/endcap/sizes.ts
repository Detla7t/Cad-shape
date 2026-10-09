// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { formatFractionalInches } from "./inches";

/**
 * The duct sizes of the End Cap Configurator (Onshape document "End Cap Configurator",
 * Part Studio 1): outside diameters in inches, each with the configuration option id
 * Onshape gave it. The OD list (`OD_Table`) and the ID list (`List_tBoS7KHF1hLsDf`) hold the
 * same sizes; only the ids of the first two entries differ, as they did in Onshape.
 */
export interface DuctSize {
    /** Diameter, inches. */
    readonly inches: number;
    /** `9 5/8"`. */
    readonly label: string;
    /** Option id in the OD configuration list. */
    readonly odOption: string;
    /** Option id in the ID configuration list. */
    readonly idOption: string;
}

const PRESET_INCHES = [
    4, 4.5, 5, 5.5625, 6.625, 7.625, 8.625, 9.625, 10.75, 11.75, 12.75, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    23, 24,
];

/** Onshape's option id for a size: `9 5/8"` → `_9_5_8_`. */
function optionId(label: string): string {
    return `_${label.replace(/["/ ]/g, "_").replace(/_+$/, "")}_`;
}

export const DUCT_SIZES: readonly DuctSize[] = PRESET_INCHES.map((inches, index) => {
    const label = formatFractionalInches(inches);
    const option = optionId(label);
    return {
        inches,
        label,
        odOption: index === 0 ? "Default" : index === 1 ? "_4_" : option,
        idOption: index === 0 ? "Default" : index === 1 ? "Copy_of_4_" : option,
    };
});

export function ductSize(inches: number): DuctSize | undefined {
    return DUCT_SIZES.find((size) => Math.abs(size.inches - inches) < 1e-9);
}

/**
 * Flange allowance (inches) added to the radius beyond the bend line, by OD: 3/8 up to 5",
 * 1/2 for 5 9/16–8 5/8, 5/8 for 9 5/8–12 3/4, 3/4 for 14–18, 1 for 19–24 (read off every
 * preset export). Custom diameters between two bands take the band they round into.
 */
export function flangeAllowance(od: number): number {
    if (od < 5.25) return 0.375;
    if (od < 9.125) return 0.5;
    if (od < 13.375) return 0.625;
    if (od < 18.5) return 0.75;
    return 1;
}

/** Finish wall height of the reducer's collar, inches, unless overridden: 2 1/8 up to 6 5/8" OD, else 2 7/8. */
export function defaultWallHeight(od: number): number {
    return od <= 7.125 ? 2.125 : 2.875;
}

/** Smallest finish wall height: the collar's crimp band alone (Onshape's lower bound). */
export const MIN_WALL_HEIGHT = 0.6875;
