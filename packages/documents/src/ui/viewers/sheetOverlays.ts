// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CellRange, HyperlinkData, SheetData, SheetImage, WorkbookData } from "@chili3d/sheet/model";
import { resolveRanges } from "@chili3d/sheet/ranges";
import chrome from "../spreadsheet.module.css";

/**
 * What the grid shows over and inside its cells from an imported workbook: pictures at
 * their cell anchors (an absolutely positioned layer that scrolls with the grid) and
 * hyperlinks (external URLs open in a new tab; in-workbook locations select their cell).
 */

/** Pixel positions of the grid's column and row edges (in the scroller's content box). */
export interface GridGeometry {
    left(col: number): number;
    top(row: number): number;
}

/** Image types an `<img>` can show; EMF/WMF (Windows metafiles) only through their fallback. */
const DISPLAYABLE = /^image\/(png|jpeg|gif|svg\+xml|bmp|webp)$/;

function imageSource(image: SheetImage): string | undefined {
    if (DISPLAYABLE.test(image.mime)) return `data:${image.mime};base64,${image.data}`;
    if (image.fallback && DISPLAYABLE.test(image.fallback.mime))
        return `data:${image.fallback.mime};base64,${image.fallback.data}`;
    return undefined;
}

export function imageRect(image: SheetImage, grid: GridGeometry) {
    const left = grid.left(image.from.col) + (image.from.colOffset ?? 0);
    const top = grid.top(image.from.row) + (image.from.rowOffset ?? 0);
    const right = image.to
        ? grid.left(image.to.col) + (image.to.colOffset ?? 0)
        : left + (image.size?.width ?? 0);
    const bottom = image.to
        ? grid.top(image.to.row) + (image.to.rowOffset ?? 0)
        : top + (image.size?.height ?? 0);
    return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** URL schemes a link may open; anything else (javascript:, data:, file:) is refused. */
const SAFE_TARGET = /^(https?:|mailto:|ftp:|tel:)/i;

/** The external URL a hyperlink opens, normalized; undefined when it has none or an unsafe one. */
export function externalTarget(link: HyperlinkData): string | undefined {
    const target = link.target?.trim();
    if (!target) return undefined;
    if (SAFE_TARGET.test(target)) return target;
    // Excel accepts "www.example.com" as a web address.
    if (/^www\./i.test(target)) return `https://${target}`;
    return undefined;
}

/** Where an in-workbook link (`Sheet2!A1`, `'My sheet'!B2:C4`, a defined name) leads. */
export function linkLocation(
    workbook: WorkbookData,
    location: string,
    current: number,
): { sheet: number; range: CellRange } | undefined {
    const text = location.replace(/^#/, "").trim();
    return resolveRanges(workbook, text, current)[0];
}

export function hyperlinkTitle(link: HyperlinkData): string {
    const where = link.tooltip ?? link.target ?? link.location ?? "";
    const modifier = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "") ? "⌘" : "Ctrl";
    return `${where} — ${modifier}+click to follow`;
}

/**
 * Follows a link: an external target opens in a new tab without access to this window,
 * a location calls `navigate`. Returns whether the link led anywhere.
 */
export function followHyperlink(
    link: HyperlinkData,
    workbook: WorkbookData,
    current: number,
    navigate: (sheet: number, range: CellRange) => void,
): boolean {
    const url = externalTarget(link);
    if (url) {
        const location = link.location ? `#${link.location.replace(/^#/, "")}` : "";
        window.open(url + (url.includes("#") ? "" : location), "_blank", "noopener,noreferrer");
        return true;
    }
    const at = link.location ? linkLocation(workbook, link.location, current) : undefined;
    if (!at) return false;
    navigate(at.sheet, at.range);
    return true;
}

/**
 * Keeps `layer` showing the sheet's pictures; rebuilds only when a picture's position or
 * the sheet changes. `onLink` follows a clicked picture's link.
 */
export function createImageLayer(onLink: (link: HyperlinkData) => void) {
    const layer = document.createElement("div");
    layer.className = chrome.imageLayer;
    let key = "";
    let images: SheetImage[] | undefined;
    return {
        element: layer,
        render(sheet: SheetData, grid: GridGeometry): void {
            const list = sheet.images ?? [];
            const rects = list.map((image) => imageRect(image, grid));
            const next = rects.map((r) => `${r.left},${r.top},${r.width},${r.height}`).join(";");
            if (images === list && next === key) return;
            images = list;
            key = next;
            layer.replaceChildren(
                ...list.flatMap((image, i) => {
                    const src = imageSource(image);
                    if (!src) return [];
                    const img = document.createElement("img");
                    const rect = rects[i];
                    img.src = src;
                    img.alt = image.description ?? image.name ?? "";
                    img.draggable = false;
                    img.style.left = `${rect.left}px`;
                    img.style.top = `${rect.top}px`;
                    img.style.width = `${rect.width}px`;
                    img.style.height = `${rect.height}px`;
                    const link = image.hyperlink;
                    if (link && (link.target || link.location)) {
                        img.dataset["link"] = link.target ?? link.location ?? "";
                        img.title = link.tooltip ?? link.target ?? link.location ?? "";
                        img.addEventListener("mousedown", (e) => e.stopPropagation());
                        img.addEventListener("click", (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onLink(link);
                        });
                    } else if (image.description) img.title = image.description;
                    return [img];
                }),
            );
        },
    };
}
