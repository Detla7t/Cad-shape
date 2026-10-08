// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** A number as Excel's General format shows it in text (`&`, TEXT-less concatenation). */
export function generalNumberText(value: number): string {
    if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
    const precise = Number.parseFloat(value.toPrecision(15));
    const text = String(precise);
    return text.includes("e") ? precise.toExponential().replace("e+", "E+").replace("e-", "E-") : text;
}
