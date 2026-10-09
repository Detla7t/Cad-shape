// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type IApplication, type ICommand, type IDocument, Transaction } from "@chili3d/core";
import { ensureEndCapConfiguration } from "./endCapConfiguration";
import { EndCapSketchNode } from "./endCapSketchNode";

/** Inches, like the Onshape workspace the end caps come from. */
const INCH_UNITS = { length: "in", angle: "deg", lengthPrecision: 4, anglePrecision: 1 } as const;

export async function endCapDocument(application: IApplication, name = "End Cap"): Promise<IDocument> {
    return application.activeView?.document ?? application.newDocument(name, { ...INCH_UNITS });
}

/**
 * Adds a configured end cap to `document` as one undo step: the End Cap configuration inputs
 * (when the document lacks them) and an `EndCapSketchNode` following them.
 */
export function addConfiguredEndCap(document: IDocument): EndCapSketchNode {
    let node: EndCapSketchNode | undefined;
    Transaction.execute(document, "End Cap", () => {
        ensureEndCapConfiguration(document);
        node = EndCapSketchNode.create(document);
        document.modelManager.addNode(node);
    });
    document.selection.setSelectedNodes([node!], false);
    document.visual.update();
    return node!;
}

/**
 * Sheet Metal ▸ Round Duct ▸ End Cap: adds the end cap to the Part Studio. It is configured
 * where every Part Studio is — the Configurations panel (Endcap, OD, ID, Wall Height, as in
 * the Onshape End Cap Configurator) — and its values are in the properties panel.
 */
@command({ key: "sheetMetal.endCap", icon: "icon-arc" })
export class EndCapCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = await endCapDocument(application);
        addConfiguredEndCap(document);
        application.activeView?.cameraController.fitContent();
    }
}
