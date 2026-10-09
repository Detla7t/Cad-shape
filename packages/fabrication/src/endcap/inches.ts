// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Inch values as a shop writes them: `9 5/8"` on a configuration list, `9.63in` in a file
 * name (the naming Onshape's exports used, so generated files sort beside the old ones).
 */

function gcd(a: number, b: number): number {
    return b === 0 ? a : gcd(b, a % b);
}

/** `9.625` → `9 5/8"`; values off the 1/64 grid fall back to decimals (`9.6`→ `9.6"`). */
export function formatFractionalInches(value: number): string {
    const sixtyFourths = Math.round(value * 64);
    if (Math.abs(sixtyFourths / 64 - value) > 1e-9) return `${trimNumber(value, 4)}"`;
    const whole = Math.trunc(sixtyFourths / 64);
    const rest = Math.abs(sixtyFourths % 64);
    if (rest === 0) return `${whole}"`;
    const divisor = gcd(rest, 64);
    const fraction = `${rest / divisor}/${64 / divisor}`;
    return whole === 0 ? `${fraction}"` : `${whole} ${fraction}"`;
}

/** `9.625` → `9.63in`, `4` → `4in`: two decimals, trailing zeros dropped. */
export function formatFileInches(value: number): string {
    return `${trimNumber(value, 2)}in`;
}

export function trimNumber(value: number, decimals: number): string {
    const text = value.toFixed(decimals).replace(/\.?0+$/, "");
    return text === "-0" ? "0" : text;
}

/**
 * Reads a length typed in inches: `9 5/8`, `9-5/8"`, `9.625`, `5/8 in`. Undefined when the
 * text is not a positive length.
 */
export function parseInches(text: string): number | undefined {
    const match =
        /^\s*(?:(\d+(?:\.\d+)?)(?:[\s-]+(\d+)\/(\d+))?|(\d+)\/(\d+))\s*(?:"|in|inch|inches)?\s*$/i.exec(text);
    if (match === null) return undefined;
    const value =
        match[4] !== undefined
            ? Number(match[4]) / Number(match[5])
            : Number(match[1]) + (match[2] !== undefined ? Number(match[2]) / Number(match[3]) : 0);
    return Number.isFinite(value) && value > 0 ? value : undefined;
}
