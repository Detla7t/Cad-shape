// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import mapping from "./icons/onshapeIconMap.json";
import artwork from "./icons/onshapeToolbar.svg";

let source: Document | undefined;
let instance = 0;
const icons: Record<string, string> = mapping;

/** Preserve source fills and isolate gradient/clip ids when the same icon appears twice. */
export function createOnshapeIcon(command: string): SVGSVGElement | undefined {
    const name = icons[command] ?? icons[command.split(".").at(-1)!];
    if (!name) return undefined;
    source ??= new DOMParser().parseFromString(artwork, "image/svg+xml");
    const symbol = source.getElementById(`svg-icon-${name}`);
    if (!symbol) return undefined;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", symbol.getAttribute("viewBox") ?? "0 0 20 20");
    icon.setAttribute("width", "20");
    icon.setAttribute("height", "20");
    icon.setAttribute("aria-hidden", "true");
    icon.dataset["sourceIcon"] = name;
    // Toolbar styles often inherit stroke/fill; the source artwork already declares its own.
    icon.style.fill = "none";
    icon.style.stroke = "none";
    icon.style.setProperty("--os-icon-outline-primary", "currentColor");
    icon.style.setProperty("--os-icon-accent-primary", "var(--primary-color, #1651b0)");
    for (const child of symbol.children) icon.append(document.importNode(child, true));
    const prefix = `cad-icon-${++instance}-`;
    const ids = new Map<string, string>();
    for (const child of icon.querySelectorAll("[id]")) {
        ids.set(child.id, prefix + child.id);
        child.id = prefix + child.id;
    }
    for (const child of icon.querySelectorAll("*")) {
        for (const attr of [...child.attributes]) {
            const value = attr.value.replace(/url\(#([^)]*)\)/g, (match, id: string) =>
                ids.has(id) ? `url(#${ids.get(id)})` : match,
            );
            const reference =
                attr.name.endsWith("href") && value.startsWith("#") ? ids.get(value.slice(1)) : undefined;
            if (reference || value !== attr.value)
                child.setAttribute(attr.name, reference ? `#${reference}` : value);
        }
    }
    return icon;
}
