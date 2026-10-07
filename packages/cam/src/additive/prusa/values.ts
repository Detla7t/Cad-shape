// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * PrusaSlicer configuration values. A config is kept exactly as PrusaSlicer serializes it —
 * a map from option key to its text (`perimeters = 2`, `nozzle_diameter = 0.4,0.4`,
 * `start_gcode = G28\nG1 Z5`, `filament_settings_id = "Generic PLA"`) — so a preset read from
 * a bundle is written back unchanged. These helpers read the typed values out of that text.
 */

/** Option key → serialized value. */
export type PrusaConfig = Readonly<Record<string, string>>;

/** Undoes PrusaSlicer's C-style string escaping (`\n`, `\r`, `\t`, `\\`, `\"`). */
export function unescapeString(value: string): string {
    let text = value;
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
    if (!text.includes("\\")) return text;
    let out = "";
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c !== "\\" || i + 1 >= text.length) {
            out += c;
            continue;
        }
        const n = text[++i];
        out += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
    }
    return out;
}

/** C-style escaping of a multi-line string value (what PrusaSlicer writes for G-code options). */
export function escapeString(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/\r\n|\r|\n/g, "\\n")
        .replace(/\t/g, "\\t");
}

/** A string-vector value: `"Generic PLA";"Generic PETG"`. */
export function serializeStrings(values: readonly string[]): string {
    return values
        .map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
        .join(";");
}

/** Splits a string-vector value (`"a";"b"` or a bare `a;b`). */
export function parseStrings(value: string): string[] {
    const out: string[] = [];
    let i = 0;
    const text = value.trim();
    if (text === "") return [];
    while (i <= text.length) {
        if (text[i] === '"') {
            let item = "";
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === "\\" && i + 1 < text.length) {
                    const n = text[i + 1];
                    item += n === "n" ? "\n" : n;
                    i += 2;
                } else item += text[i++];
            }
            out.push(item);
            i++;
            while (i < text.length && text[i] !== ";") i++;
            i++;
        } else {
            const end = text.indexOf(";", i);
            out.push(text.slice(i, end < 0 ? text.length : end).trim());
            if (end < 0) break;
            i = end + 1;
        }
    }
    return out;
}

/** Splits a numeric vector (`0.4,0.4`); a scalar is a one-element vector. */
export function parseNumbers(value: string | undefined): number[] {
    if (value === undefined || value.trim() === "") return [];
    return value.split(",").map((part) => Number.parseFloat(part));
}

/** The first number of a (possibly vector) value; `fallback` when missing, nil or not numeric. */
export function firstNumber(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const n = Number.parseFloat(value.split(",")[0]);
    return Number.isFinite(n) ? n : fallback;
}

export function firstBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value.trim() === "" || value.trim() === "nil") return fallback;
    const first = value.split(",")[0].trim().toLowerCase();
    return first === "1" || first === "true";
}

/**
 * A float-or-percent option (`75%` or `0.45`): percentages resolve against `base`; zero (or
 * missing) means "auto" and gives `auto`.
 */
export function floatOrPercent(value: string | undefined, base: number, auto: number): number {
    if (value === undefined) return auto;
    const text = value.split(",")[0].trim();
    if (text === "" || text === "nil") return auto;
    const n = Number.parseFloat(text);
    if (!Number.isFinite(n) || n === 0) return auto;
    return text.endsWith("%") ? (base * n) / 100 : n;
}

/** A percent option (`15%`) as a fraction; plain numbers are read as percent too. */
export function percent(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n / 100 : fallback;
}

/** `bed_shape = 0x0,250x0,250x210,0x210` → points. */
export function parsePoints(value: string | undefined): [number, number][] {
    if (value === undefined) return [];
    return value
        .split(",")
        .map((point) => point.split("x").map((n) => Number.parseFloat(n)))
        .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map((p) => [p[0], p[1]] as [number, number]);
}

export function serializePoints(points: readonly (readonly [number, number])[]): string {
    return points.map(([x, y]) => `${formatNumber(x)}x${formatNumber(y)}`).join(",");
}

/** Shortest decimal text of a number (6 decimals at most, no exponent, no `-0`). */
export function formatNumber(value: number, decimals = 6): string {
    const text = Number(value.toFixed(decimals)).toString();
    return text === "-0" ? "0" : text;
}
