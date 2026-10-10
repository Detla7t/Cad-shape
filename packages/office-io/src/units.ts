// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Lengths in office files (ODF `svg:width`, `style:column-width`, …) and CSS pixels (96 per inch). */

const PX_PER = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72, pc: 16, px: 1 } as const;

/** A length such as "2.54cm" or "12pt" in whole CSS pixels; undefined for anything else. */
export function lengthToPx(value: string | null | undefined): number | undefined {
    const match = /^([\d.]+)(cm|mm|in|pt|pc|px)$/.exec(value ?? "");
    if (!match) return undefined;
    const n = Number(match[1]);
    return Number.isFinite(n) ? Math.round(n * PX_PER[match[2] as keyof typeof PX_PER]) : undefined;
}

/** CSS pixels as an ODF length in centimetres ("2.540cm"). */
export function pxToCm(px: number): string {
    return `${(px / PX_PER.cm).toFixed(3)}cm`;
}
