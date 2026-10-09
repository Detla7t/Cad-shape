// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type DocumentTemplate, type IApplication, type IDocument, Result, Transaction } from "@chili3d/core";
import { DocumentFileNode } from "@chili3d/documents";
import { writeSvg } from "@chili3d/drawing";
import { endCapDxf } from "../endcap/batch";
import { type EndCapParams, endCapPattern } from "../endcap/endCap";
import { toDrawing } from "../geometry/toDrawing";
import { addEndCapSketch } from "./endCapSketch";

/** The Onshape configurator's defaults: Endcap off, OD 9 5/8", ID 6 5/8". */
const REDUCING: EndCapParams = { reducing: true, od: 9.625, id: 6.625 };
const PLAIN: EndCapParams = { reducing: false, od: 9.625 };

const INCH_UNITS = { length: "in", angle: "deg", lengthPrecision: 4, anglePrecision: 1 } as const;

/** The default reducer's flat pattern, drawn for the dashboard. */
function thumbnail(): string | undefined {
    const pattern = endCapPattern(REDUCING);
    if (!pattern.isOk) return undefined;
    const svg = writeSvg(toDrawing(pattern.value, { bendLines: true }), { strokeWidth: 0.3, margin: 1 });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function createEndCapDocument(application: IApplication): Promise<Result<IDocument>> {
    const document = await application.newDocument("End Cap Configurator", { ...INCH_UNITS });
    // Both sketches of the Onshape Part Studio; the plain cap is hidden there by the default
    // configuration (Endcap off), so it is hidden here too.
    const plain = addEndCapSketch(document, PLAIN);
    if (!plain.isOk) return Result.err(plain.error);
    const reducing = addEndCapSketch(document, REDUCING);
    if (!reducing.isOk) return Result.err(reducing.error);
    const dxf = endCapDxf(REDUCING);
    if (!dxf.isOk) return Result.err(dxf.error);
    Transaction.execute(document, "End Cap drawing", () => {
        plain.value.visible = false;
        // The shop drawing: the export the configurator's profile writes, cut-ready (inches).
        document.modelManager.addNode(
            new DocumentFileNode({
                document,
                name: "Reducing End Cap Drawing",
                fileName: dxf.value.name,
                text: dxf.value.text,
            }),
        );
    });
    document.selection.setSelectedNodes([reducing.value], false);
    document.visual.update();
    application.activeView?.cameraController.fitContent();
    return Result.ok(document);
}

/**
 * "End Cap Configurator" in the dashboard's Public section (and `/?template=end-cap-configurator`):
 * a Part Studio holding the End Cap and Reducing End Cap sketches at the configurator's
 * defaults, plus the reducer's DXF drawing. Insert other sizes with Sheet Metal ▸ End Cap.
 */
export const END_CAP_TEMPLATE: DocumentTemplate = {
    id: "end-cap-configurator",
    name: "End Cap Configurator",
    description:
        'Round duct end cap and reducing end cap flats (9 5/8" × 6 5/8"), with the reducer\'s cut-ready DXF drawing. Other sizes: Sheet Metal ▸ End Cap.',
    owner: "Chili3D",
    tags: ["sheet metal", "duct", "end cap", "reducer", "dxf", "drawing"],
    thumbnail: thumbnail(),
    create: createEndCapDocument,
};
