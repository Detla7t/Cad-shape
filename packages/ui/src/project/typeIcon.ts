// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createCadIcon, svg } from "@chili3d/element";

/** Iconfont keys that have a drawn CAD icon (`createCadIcon`) instead of the font glyph. */
const CAD_ICONS: Readonly<Record<string, string>> = {
    "icon-setWorkingPlane": "plane",
    "icon-sketchEdit": "sketch",
    "icon-box": "part",
    "icon-tag": "variable",
    "icon-folder": "folder",
    "icon-component": "component",
    "icon-annotation": "annotation",
};

/**
 * The type icon of a model-tree row or timeline step, from an iconfont key (`INodeIcon.icon`,
 * `FeatureItem.icon`): the drawn CAD icon where one exists, else the font glyph. The feature
 * tree and the Part Studio timeline both draw their icons through here.
 */
export function createTypeIcon(icon: string, className?: string): SVGSVGElement {
    const mapped = CAD_ICONS[icon];
    if (mapped !== undefined) {
        const element = createCadIcon(mapped) as SVGSVGElement;
        if (className) element.classList.add(...className.split(" ").filter((name) => name !== ""));
        return element;
    }
    return svg({ className: className ?? "", icon });
}
