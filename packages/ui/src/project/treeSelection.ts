// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, NodeSelectionHandler, ShapeSelectionHandler, ShapeTypes } from "@chili3d/core";

/**
 * Whether a click in a node list (the model tree, the Part Studio timeline) may select
 * nodes now: while plain node selection runs, or a command that asks for whole nodes.
 */
export function canSelectNodes(document: IDocument): boolean {
    const handler = document.visual.eventHandler;
    if (handler instanceof NodeSelectionHandler) return true;
    if (handler.treeSelection === true) return true;
    if (handler instanceof ShapeSelectionHandler) return handler.shapeType === ShapeTypes.shape;
    return false;
}
