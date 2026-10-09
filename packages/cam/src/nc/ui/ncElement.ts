// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { registerElementKind, registerElementView } from "@chili3d/core";
import { isNcProgramNode, NC_PROGRAM_ICON, type NcProgramNode } from "../ncProgramNode";
import { installNcIcon } from "./ncIcon";
import { NcProgramView } from "./ncProgramView";

/**
 * NC Programs as document elements: a tab per program. Like the CAM Studio its view is a
 * side panel beside the Part Studio's viewport (`besideViewport`), so the backplot draws in
 * the model and a click on it finds the move's line.
 */
export const NC_PROGRAM_KIND = "ncProgram";

registerElementKind({
    kind: NC_PROGRAM_KIND,
    icon: NC_PROGRAM_ICON,
    display: "nc.program",
    isElement: isNcProgramNode,
    newCommand: "nc.newProgram",
    besideViewport: true,
});

registerElementView(NC_PROGRAM_KIND, (node, document) => {
    installNcIcon();
    return new NcProgramView(node as NcProgramNode, document);
});

installNcIcon();
