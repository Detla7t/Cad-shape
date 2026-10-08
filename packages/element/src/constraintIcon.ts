// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import artwork from "./icons/onshapeConstraints.svg";

const symbols: Record<string, string> = {
    coincident: "coincident",
    pointOn: "coincident",
    horizontal: "horizontal",
    horizontalAlign: "horizontal",
    vertical: "vertical",
    verticalAlign: "vertical",
    perpendicular: "perpendicular",
    parallel: "parallel",
    equal: "equal",
    tangent: "tangent",
    midpoint: "midpoint",
    symmetric: "symmetric",
    fix: "fix",
};
let source: Document | undefined;

/** Inline paths preserve the source's fills and remain sharp at toolbar and ribbon sizes. */
export function createConstraintIcon(command: string): SVGSVGElement | undefined {
    if (!command.startsWith("constraint.")) return undefined;
    const name = symbols[command.slice("constraint.".length)];
    if (!name) return undefined;
    source ??= new DOMParser().parseFromString(artwork, "image/svg+xml");
    const symbol = source.getElementById(`svg-icon-sketch-${name}-button`);
    if (!symbol) return undefined;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", symbol.getAttribute("viewBox")!);
    icon.setAttribute("width", "20");
    icon.setAttribute("height", "20");
    icon.setAttribute("aria-hidden", "true");
    icon.dataset["constraintIcon"] = name;
    icon.style.setProperty("--os-icon-outline-primary", "currentColor");
    icon.style.setProperty("--os-icon-accent-primary", "var(--primary-color, #1651b0)");
    for (const child of symbol.children) icon.append(document.importNode(child, true));
    return icon;
}
