// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { registerElementKind, registerElementView } from "@chili3d/core";
import { type AssemblyNode, isAssemblyNode } from "../model/assemblyNode";
import { AssemblyView } from "./assemblyView";

/**
 * Assemblies as document elements: a bottom tab per assembly ("Assembly 1"), showing its
 * instances, mates and its own 3D scene. The view stays mounted while other tabs are active,
 * so the camera and selection survive a switch to the Part Studio and back.
 */
export const ASSEMBLY_KIND = "assembly";

registerElementKind({
    kind: ASSEMBLY_KIND,
    icon: "icon-layer-group",
    display: "assembly.element",
    isElement: isAssemblyNode,
    newCommand: "assembly.new",
});

registerElementView(ASSEMBLY_KIND, (node, document) => new AssemblyView(node as AssemblyNode, document));
