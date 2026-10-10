// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { INode } from "./model/node";
import type { ShapeType } from "./shape/shapeType";

/**
 * A node whose parts are what a plain click in the viewport selects — a sketch's curves and
 * points (Onshape selects one line, arc or vertex of an inactive sketch, never the whole
 * sketch): the node selection handler picks a sub-shape of these types instead of the node,
 * so the measure readout, the picks and the highlight are the curve's or the point's.
 */
export interface ISubShapeSelectableNode extends INode {
    readonly selectsSubShapes: ShapeType;
}

export function selectsSubShapes(node: INode | undefined): node is ISubShapeSelectableNode {
    return typeof (node as Partial<ISubShapeSelectableNode> | undefined)?.selectsSubShapes === "number";
}
