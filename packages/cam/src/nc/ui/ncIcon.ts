// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { NC_PROGRAM_ICON } from "../ncProgramNode";

/**
 * The NC Program icon — a page with a zigzag toolpath — added to the page as an SVG symbol
 * next to the iconfont's (which has none), so `svg({ icon: "icon-nc-program" })` finds it.
 */

const PATH =
    "M5 2h10l5 5v15H5zM7 4v16h11V8h-4V4zM8 17.5l2.2-4.6 2 3 2.2-4.6 1.8 2.6 1.2-.8-3.1-4.5-2.2 4.6-2-3L6.7 16.9z";

let installed = false;

/** Adds the symbol to the page once (a no-op without a DOM). */
export function installNcIcon(): void {
    if (installed || typeof document === "undefined" || document.body === null) return;
    installed = true;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    const symbol = document.createElementNS(ns, "symbol");
    symbol.setAttribute("id", NC_PROGRAM_ICON);
    symbol.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", PATH);
    path.setAttribute("fill-rule", "evenodd");
    symbol.append(path);
    svg.append(symbol);
    document.body.append(svg);
}
