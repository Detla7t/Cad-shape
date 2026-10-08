// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { styleColor } from "../../sheet/cellStyle";
import type { CellStyle } from "../../sheet/model";
import style from "../spreadsheet.module.css";

export function createSheetToolbar(
    change: (update: (current: CellStyle) => CellStyle) => void,
    clear: () => void,
    merge: () => void,
) {
    const element = document.createElement("div");
    element.className = style.toolbar;
    element.setAttribute("role", "toolbar");
    element.setAttribute("aria-label", "Cell formatting");
    let current: CellStyle = {};
    const button = (text: string, title: string, action: () => void) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.title = title;
        b.setAttribute("aria-label", title);
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", action);
        element.append(b);
        return b;
    };
    const dropdown = (label: string, options: readonly string[], action: (value: string) => void) => {
        const select = document.createElement("select");
        select.title = label;
        select.setAttribute("aria-label", label);
        for (const value of options) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            select.append(option);
        }
        select.addEventListener("change", () => action(select.value));
        element.append(select);
        return select;
    };
    const font = dropdown(
        "Font",
        ["Arial", "Calibri", "Aptos", "Verdana", "Times New Roman", "Courier New"],
        (name) => change((s) => ({ ...s, font: { ...s.font, name } })),
    );
    const size = dropdown(
        "Font size",
        ["8", "9", "10", "11", "12", "14", "16", "18", "20", "24", "28", "36", "48", "72"],
        (value) => change((s) => ({ ...s, font: { ...s.font, size: Number(value) } })),
    );
    const toggles = (
        [
            ["B", "Bold", "bold"],
            ["I", "Italic", "italic"],
            ["U", "Underline", "underline"],
            ["S", "Strikethrough", "strike"],
        ] as const
    ).map(([text, title, key]) => {
        const b = button(text, title, () => {
            const value = !current.font?.[key];
            change((s) => ({ ...s, font: { ...s.font, [key]: value } }));
        });
        if (key === "bold") b.style.fontWeight = "bold";
        if (key === "italic") b.style.fontStyle = "italic";
        if (key === "underline") b.style.textDecoration = "underline";
        if (key === "strike") b.style.textDecoration = "line-through";
        return { b, key };
    });
    const color = (label: string, text: string, apply: (argb: string) => void) => {
        const wrap = document.createElement("label");
        wrap.className = style.colorControl;
        wrap.title = label;
        const input = document.createElement("input");
        input.type = "color";
        input.setAttribute("aria-label", label);
        input.addEventListener("change", () => apply(`FF${input.value.slice(1).toUpperCase()}`));
        wrap.append(text, input);
        element.append(wrap);
        return input;
    };
    const textColor = color("Text color", "A", (argb) =>
        change((s) => ({ ...s, font: { ...s.font, color: { argb } } })),
    );
    const fill = color("Fill color", "Fill", (argb) =>
        change((s) => ({ ...s, fill: { type: "pattern", pattern: "solid", fgColor: { argb } } })),
    );
    const alignment = dropdown(
        "Horizontal alignment",
        ["General", "Left", "Center", "Right", "Justify"],
        (value) =>
            change((s) => ({
                ...s,
                alignment: {
                    ...s.alignment,
                    horizontal: value === "General" ? undefined : (value.toLowerCase() as "left"),
                },
            })),
    );
    const wrap = button("↵", "Wrap text", () => {
        const value = !current.alignment?.wrapText;
        change((s) => ({ ...s, alignment: { ...s.alignment, wrapText: value } }));
    });
    dropdown("Borders", ["Borders", "All borders", "Bottom border", "No borders"], (value) => {
        if (value === "Borders") return;
        change((s) => ({
            ...s,
            border:
                value === "No borders"
                    ? {}
                    : Object.fromEntries(
                          (value === "Bottom border" ? ["bottom"] : ["top", "right", "bottom", "left"]).map(
                              (side) => [side, { style: "thin", color: { argb: "FF707070" } }],
                          ),
                      ),
        }));
    });
    button("Merge", "Merge or unmerge selected cells", merge);
    button("Clear format", "Clear formatting", clear);
    const setOption = (select: HTMLSelectElement, value: string) => {
        if (![...select.options].some((o) => o.value === value)) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            select.append(option);
        }
        select.value = value;
    };
    return {
        element,
        update: (s?: CellStyle) => {
            current = s ?? {};
            toggles.forEach(({ b, key }) => {
                b.setAttribute("aria-pressed", String(!!current.font?.[key]));
            });
            wrap.setAttribute("aria-pressed", String(!!current.alignment?.wrapText));
            setOption(font, current.font?.name ?? "Arial");
            setOption(size, String(current.font?.size ?? 11));
            textColor.value = styleColor(current.font?.color) ?? "#000000";
            fill.value =
                current.fill?.type === "pattern"
                    ? (styleColor(current.fill.fgColor) ?? "#ffffff")
                    : "#ffffff";
            const align = current.alignment?.horizontal;
            alignment.value = align ? align[0].toUpperCase() + align.slice(1) : "General";
        },
    };
}
