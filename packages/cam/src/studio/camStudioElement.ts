// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { registerElementKind, registerElementView } from "@chili3d/core";
import { type CamStudioNode, isCamStudioNode } from "../camStudioNode";
import { CamStudioView } from "./camStudioView";

/**
 * CAM Studios as document elements: a tab per studio. Its view is a side panel beside the
 * Part Studio's viewport (`besideViewport`), so the toolpaths preview in the model and
 * geometry is picked right there while the studio is open.
 */
export const CAM_STUDIO_KIND = "camStudio";

registerElementKind({
    kind: CAM_STUDIO_KIND,
    icon: "icon-cog",
    display: "cam.studio",
    isElement: isCamStudioNode,
    newCommand: "cam.newStudio",
    besideViewport: true,
});

registerElementView(CAM_STUDIO_KIND, (node, document) => new CamStudioView(node as CamStudioNode, document));
