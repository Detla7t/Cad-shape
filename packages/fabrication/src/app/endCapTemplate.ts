// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DocumentTemplate, type IApplication, type IDocument, Result, Transaction } from "@chili3d/core";
import { DocumentFileNode } from "@chili3d/documents";
import { writeSvg } from "@chili3d/drawing";
import { endCapDxf } from "../endcap/batch";
import { endCapPattern } from "../endcap/endCap";
import { toDrawing } from "../geometry/toDrawing";
import { addConfiguredEndCap } from "./endCapCommand";

/** The default reducer's flat pattern, drawn for the dashboard. */
function thumbnail(): string | undefined {
    const pattern = endCapPattern({ reducing: true, od: 9.625, id: 6.625 });
    if (!pattern.isOk) return undefined;
    const svg = writeSvg(toDrawing(pattern.value, { bendLines: true }), { strokeWidth: 0.3, margin: 1 });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function createEndCapDocument(application: IApplication): Promise<Result<IDocument>> {
    const document = await application.newDocument("End Cap Configurator", {
        length: "in",
        angle: "deg",
        lengthPrecision: 4,
        anglePrecision: 1,
    });
    const node = addConfiguredEndCap(document);
    const params = node.resolve();
    if (!params.isOk) return Result.err(params.error);
    const dxf = endCapDxf(params.value);
    if (!dxf.isOk) return Result.err(dxf.error);
    Transaction.execute(document, "End Cap drawing", () => {
        // The shop drawing: the cut-ready DXF, rewritten by the end cap on every configuration change.
        const drawing = new DocumentFileNode({
            document,
            name: "End Cap Drawing",
            fileName: dxf.value.name,
            text: dxf.value.text,
        });
        document.modelManager.addNode(drawing);
        node.drawingId = drawing.id;
    });
    document.selection.setSelectedNodes([node], false);
    application.activeView?.cameraController.fitContent();
    return Result.ok(document);
}

/**
 * "End Cap Configurator" in the dashboard's Public section (and `/?template=end-cap-configurator`):
 * a Part Studio with the End Cap configuration (Endcap, OD, ID, Wall Height) driving an end cap
 * sketch, and its DXF drawing — like the Onshape document of the same name.
 */
export const END_CAP_TEMPLATE: DocumentTemplate = {
    id: "end-cap-configurator",
    name: "End Cap Configurator",
    description:
        "Round duct end caps and reducers, configured in the Part Studio's Configurations panel (Endcap, OD, ID, Wall Height), with a cut-ready DXF drawing that follows the configuration.",
    owner: "Chili3D",
    tags: ["sheet metal", "duct", "end cap", "reducer", "dxf", "drawing", "configuration"],
    thumbnail: thumbnail(),
    create: createEndCapDocument,
};
