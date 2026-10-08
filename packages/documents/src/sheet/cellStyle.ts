// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Border, Color } from "exceljs";
import type { CellStyle } from "./model";

const THEME = [
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

export function styleColor(color?: Partial<Color> & { indexed?: number; tint?: number }): string | undefined {
    if (!color) return undefined;
    const rgb =
        color.argb?.slice(-6) ??
        (color.theme === undefined ? undefined : THEME[color.theme]) ??
        (color.indexed === undefined ? undefined : INDEXED[color.indexed]);
    if (!rgb || !/^[\da-f]{6}$/i.test(rgb)) return undefined;
    const tint = (color as Partial<Color> & { tint?: number }).tint ?? 0;
    const tinted = (rgb.match(/../g) ?? [])
        .map((part) => {
            const n = Number.parseInt(part, 16);
            return Math.round(tint < 0 ? n * (1 + tint) : n + (255 - n) * tint)
                .toString(16)
                .padStart(2, "0");
        })
        .join("");
    return `#${tinted}`;
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

/** Render the same font, colors, borders and alignment stored in the XLSX cell. */
export function applyCellStyle(element: HTMLElement, style?: CellStyle): void {
    if (!style) return;
    const css = element.style;
    const font = style.font;
    if (font) {
        if (font.name) css.fontFamily = font.name;
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
