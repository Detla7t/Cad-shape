// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { action, textElement } from "./helpers";
import style from "./review.module.css";

/** Keep the Onshape analysis menu recognizable without advertising missing render/solver capabilities. */
export const ANALYSIS_TOOLS = [
    [
        "Curve/surface analysis…",
        "Numerical geometry inspection is available; curvature combs are not yet supported.",
    ],
    ["Deviation analysis…", "Deviation visualization is not yet implemented."],
    ["Connection analysis…", "Connection analysis is not yet implemented."],
    ["Dihedral analysis…", "Dihedral angle visualization is not yet implemented."],
    ["Interference detection…", "Exact common volume of two selected solid parts."],
    ["Zebra stripes…", "Zebra rendering is not yet implemented."],
    ["Reflection analysis…", "Reflection analysis rendering is not yet implemented."],
    ["Curvature color map", "Curvature color map rendering is not yet implemented."],
    ["Draft analysis…", "Draft angle rendering is not yet implemented."],
    [
        "Flatten surfaces…",
        "General surface flattening is not yet implemented. Sheet-metal flattening is a separate tool.",
    ],
] as const;

export function analysisMenu(inspect: (tool: "geometry" | "interference") => void): HTMLElement {
    const menu = document.createElement("div");
    menu.className = style.analysisMenu;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Analysis tools");
    for (const [index, [label, description]] of ANALYSIS_TOOLS.entries()) {
        const button = action(label, () => inspect(index === 4 ? "interference" : "geometry"));
        button.setAttribute("role", "menuitem");
        button.title = description;
        button.disabled = index !== 0 && index !== 4;
        if (button.disabled) button.append(textElement("small", "Not available"));
        menu.append(button);
    }
    menu.append(
        textElement(
            "p",
            "Unavailable tools are listed for compatibility tracking. They do not yet reproduce Onshape analysis.",
            style.muted,
        ),
    );
    return menu;
}
