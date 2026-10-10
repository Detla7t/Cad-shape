// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Border, Color } from "exceljs";
import type { CellStyle } from "./model";

/** Office's default theme palette in SpreadsheetML order: lt1, dk1, lt2, dk2, accent1–6, hlink, folHlink. */
export const DEFAULT_THEME_COLORS: readonly string[] = [
    "FFFFFF",
    "000000",
    "E7E6E6",
    "44546A",
    "4472C4",
    "ED7D31",
    "A5A5A5",
    "FFC000",
    "5B9BD5",
    "70AD47",
    "0563C1",
    "954F72",
];
/** The legacy 64-colour palette (`indexed`); 64/65 are the system foreground/background. */
export const DEFAULT_INDEXED_COLORS: readonly string[] = (() => {
    const INDEXED = [
        "000000",
        "FFFFFF",
        "FF0000",
        "00FF00",
        "0000FF",
        "FFFF00",
        "FF00FF",
        "00FFFF",
        "000000",
        "FFFFFF",
        "FF0000",
        "00FF00",
        "0000FF",
        "FFFF00",
        "FF00FF",
        "00FFFF",
        "800000",
        "008000",
        "000080",
        "808000",
        "800080",
        "008080",
        "C0C0C0",
        "808080",
        "9999FF",
        "993366",
        "FFFFCC",
        "CCFFFF",
        "660066",
        "FF8080",
        "0066CC",
        "CCCCFF",
        "000080",
        "FF00FF",
        "FFFF00",
        "00FFFF",
        "800080",
        "800000",
        "008080",
        "0000FF",
        "00CCFF",
        "CCFFFF",
        "CCFFCC",
        "FFFF99",
        "99CCFF",
        "FF99CC",
        "CC99FF",
        "FFCC99",
        "3366FF",
        "33CCCC",
        "99CC00",
        "FFCC00",
        "FF9900",
        "FF6600",
        "666699",
        "969696",
        "003366",
        "339966",
        "003300",
        "333300",
        "993300",
        "993366",
        "333399",
        "333333",
    ];
    return [...INDEXED, "000000", "FFFFFF"];
})();

export type StyleColorData = Partial<Color> & { indexed?: number; tint?: number };

/** Excel's tint: the colour's HLS luminance moved toward black (tint < 0) or white (tint > 0). */
export function tintColor(rgb: string, tint: number): string {
    if (!tint) return rgb.toUpperCase();
    const [r, g, b] = (rgb.match(/../g) ?? []).map((part) => Number.parseInt(part, 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r1, g1, b1] =
        h < 60
            ? [c, x, 0]
            : h < 120
              ? [x, c, 0]
              : h < 180
                ? [0, c, x]
                : h < 240
                  ? [0, x, c]
                  : h < 300
                    ? [x, 0, c]
                    : [c, 0, x];
    return [r1, g1, b1]
        .map((v) =>
            Math.round(Math.min(1, Math.max(0, v + m)) * 255)
                .toString(16)
                .padStart(2, "0"),
        )
        .join("")
        .toUpperCase();
}

/**
 * A style colour as RRGGBB (no "#"): `argb`, a `theme` slot (against `theme`) or an
 * `indexed` palette entry, with its `tint` applied; undefined when it names no colour.
 */
export function resolveColor(
    color: StyleColorData | undefined,
    theme: readonly string[] = DEFAULT_THEME_COLORS,
    indexed: readonly string[] = DEFAULT_INDEXED_COLORS,
): string | undefined {
    if (!color) return undefined;
    const rgb =
        color.argb?.slice(-6) ??
        (color.theme === undefined ? undefined : theme[color.theme]) ??
        (color.indexed === undefined ? undefined : indexed[color.indexed]);
    if (!rgb || !/^[\da-f]{6}$/i.test(rgb)) return undefined;
    return tintColor(rgb, color.tint ?? 0);
}

export function styleColor(color?: StyleColorData): string | undefined {
    const rgb = resolveColor(color);
    return rgb === undefined ? undefined : `#${rgb.toLowerCase()}`;
}

/**
 * A copy of `style` whose theme / indexed / tinted colours are plain ARGB, resolved against
 * the workbook's own theme and palette — so the model renders the same without the theme.
 */
export function resolveStyleColors(
    style: CellStyle,
    theme: readonly string[],
    indexed: readonly string[],
): CellStyle {
    const fix = (color: StyleColorData | undefined): StyleColorData | undefined => {
        if (!color || (color.theme === undefined && color.indexed === undefined && !color.tint)) return color;
        const rgb = resolveColor(color, theme, indexed);
        return rgb === undefined ? undefined : { argb: `FF${rgb}` };
    };
    const out = structuredClone(style) as CellStyle;
    if (out.font?.color) {
        const color = fix(out.font.color as StyleColorData);
        if (color) out.font.color = color as Color;
        else delete out.font.color;
    }
    const fill = out.fill as
        | { fgColor?: StyleColorData; bgColor?: StyleColorData; stops?: { color: StyleColorData }[] }
        | undefined;
    if (fill) {
        for (const key of ["fgColor", "bgColor"] as const) {
            if (!fill[key]) continue;
            const color = fix(fill[key]);
            if (color) fill[key] = color;
            else delete fill[key];
        }
        for (const stop of fill.stops ?? []) stop.color = fix(stop.color) ?? { argb: "FF000000" };
    }
    const border = out.border as Record<string, Partial<Border> | undefined> | undefined;
    for (const side of Object.values(border ?? {})) {
        if (side?.color) {
            const color = fix(side.color as StyleColorData);
            if (color) side.color = color as Color;
            else delete side.color;
        }
    }
    return out;
}

function borderCss(border?: Partial<Border>): string | undefined {
    if (!border?.style) return undefined;
    const width =
        border.style === "thick" ? 3 : border.style.startsWith("medium") || border.style === "double" ? 2 : 1;
    const line =
        border.style === "double"
            ? "double"
            : /dot/i.test(border.style)
              ? "dotted"
              : /dash/i.test(border.style)
                ? "dashed"
                : "solid";
    return `${width}px ${line} ${styleColor(border.color) ?? "currentColor"}`;
}

/**
 * A CSS font list for a workbook font: the font itself, then metric-similar fonts most
 * systems have, then the generic family — so an Office font the browser lacks ("Aptos
 * Narrow", "Calibri") falls back to a sans-serif instead of the browser's serif default.
 */
export function fontStack(name: string): string {
    const quoted = `"${name.replace(/["\\]/g, "")}"`;
    if (/courier|consolas|mono|menlo/i.test(name)) return `${quoted}, Consolas, "Liberation Mono", monospace`;
    if (/times|georgia|cambria|garamond|book antiqua|palatino|serif$/i.test(name) && !/sans/i.test(name))
        return `${quoted}, "Times New Roman", "Liberation Serif", serif`;
    if (/narrow|condensed/i.test(name))
        return `${quoted}, "Arial Narrow", "Liberation Sans Narrow", Carlito, Calibri, Arial, sans-serif`;
    return `${quoted}, Carlito, Calibri, Arial, "Liberation Sans", sans-serif`;
}

/** Render the same font, colors, borders and alignment stored in the XLSX cell. */
export function applyCellStyle(element: HTMLElement, style?: CellStyle): void {
    if (!style) return;
    const css = element.style;
    const font = style.font;
    if (font) {
        if (font.name) css.fontFamily = fontStack(font.name);
        if (font.size) css.fontSize = `${font.size}pt`;
        if (font.bold) css.fontWeight = "700";
        if (font.italic) css.fontStyle = "italic";
        css.textDecoration = [font.underline ? "underline" : "", font.strike ? "line-through" : ""]
            .filter(Boolean)
            .join(" ");
        const color = styleColor(font.color);
        if (color) css.color = color;
    }
    if (style.fill?.type === "pattern" && style.fill.pattern !== "none") {
        const color = styleColor(style.fill.fgColor ?? style.fill.bgColor);
        if (color) css.backgroundColor = color;
    }
    if (style.fill?.type === "gradient") {
        const stops = style.fill.stops.map(
            (stop) => `${styleColor(stop.color) ?? "transparent"} ${stop.position * 100}%`,
        );
        css.backgroundImage =
            style.fill.gradient === "angle"
                ? `linear-gradient(${style.fill.degree + 90}deg, ${stops.join(",")})`
                : `radial-gradient(${stops.join(",")})`;
    }
    const alignment = style.alignment;
    if (alignment?.horizontal)
        css.textAlign = alignment.horizontal === "centerContinuous" ? "center" : alignment.horizontal;
    if (alignment?.vertical)
        css.verticalAlign = alignment.vertical === "middle" ? "middle" : alignment.vertical;
    if (alignment?.wrapText) css.whiteSpace = "pre-wrap";
    if (alignment?.indent) css.paddingLeft = `${alignment.indent * 12 + 4}px`;
    for (const side of ["top", "right", "bottom", "left"] as const) {
        const border = borderCss(style.border?.[side]);
        if (border) css.setProperty(`border-${side}`, border);
    }
}
