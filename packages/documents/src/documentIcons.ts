// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Tab and tree icons of document elements, added to the page as SVG symbols next to the
 * iconfont's (which has no file-type icons) — `svg({ icon: "icon-doc-sheet" })` finds them.
 */

const PAGE = "M5 2h10l5 5v15H5zM7 4v16h11V8h-4V4z";

const ICONS: Record<string, string> = {
    "icon-doc-file": PAGE,
    "icon-doc-text": `${PAGE}M9 11h7v1.5H9zM9 14h7v1.5H9zM9 17h5v1.5H9z`,
    "icon-doc-markdown": `${PAGE}M8.5 18v-7h1.6l1.4 2.2 1.4-2.2h1.6v7h-1.5v-4.4l-1.5 2.3-1.5-2.3V18z`,
    "icon-doc-code": `${PAGE}M9.6 11.6l-2.4 2.9 2.4 2.9 1.1-.9-1.6-2 1.6-2zM14.4 11.6l2.4 2.9-2.4 2.9-1.1-.9 1.6-2-1.6-2z`,
    "icon-doc-pdf": `${PAGE}M3 12h13v6H3zM5 13.5v3h1v-1h1.2a1 1 0 000-2zM9 13.5v3h1.5a1.5 1.5 0 000-3zM13 13.5v3h1v-1h1.2v-.8H14v-.4h1.5v-.8z`,
    "icon-doc-sheet":
        "M3 4h18v16H3zM5 6v3h6V6zM13 6v3h6V6zM5 11v3h6v-3zM13 11v3h6v-3zM5 16v2h6v-2zM13 16v2h6v-2z",
    "icon-doc-image":
        "M3 5h18v14H3zM5 7v10h14V7zM6 16l4-5 3 3.5 2-2 3 3.5zM15.5 8.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z",
    "icon-doc-drawing":
        "M12 5a7 7 0 110 14 7 7 0 010-14zm0 1.6a5.4 5.4 0 100 10.8 5.4 5.4 0 000-10.8zM3 20.3L20.3 3l.7.7L3.7 21z",
};

let installed = false;

/** Adds the symbols to the page once (a no-op without a DOM). */
export function installDocumentIcons(): void {
    if (installed || typeof document === "undefined" || document.body === null) return;
    installed = true;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    for (const [id, d] of Object.entries(ICONS)) {
        const symbol = document.createElementNS(ns, "symbol");
        symbol.setAttribute("id", id);
        symbol.setAttribute("viewBox", "0 0 24 24");
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", d);
        path.setAttribute("fill-rule", "evenodd");
        symbol.append(path);
        svg.append(symbol);
    }
    document.body.append(svg);
}
