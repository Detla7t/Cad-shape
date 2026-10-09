// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { drawingToSketchData } from "@chili3d/documents";
import { convertDrawing } from "@chili3d/drawing";
import type { SketchData } from "@chili3d/parametric";
import { type EndCapParams, endCapPattern } from "../endcap/endCap";
import { ONSHAPE_LAYERS, toDrawing } from "../geometry/toDrawing";

/**
 * The cap as sketch data on the XY plane (millimetres, the kernel's unit): the cut outline on
 * Onshape's `ModelSketch_Visible` layer, the rim bend lines as dashed construction geometry so
 * they mark the fold without splitting the regions. Each half and strip closes into a region
 * the sheet metal, extrude and CAM tools can pick.
 */
export function endCapSketchData(params: EndCapParams): Result<{ name: string; data: SketchData }> {
    const pattern = endCapPattern(params);
    if (!pattern.isOk) return Result.err(pattern.error);
    const drawing = convertDrawing(toDrawing(pattern.value, { bendLines: true }), "mm");
    const { data } = drawingToSketchData(drawing);
    const bend = ONSHAPE_LAYERS.bend.name;
    return Result.ok({
        name: pattern.value.name,
        data: {
            ...data,
            entities: data.entities.map((entity) =>
                entity.layer === bend ? { ...entity, construction: true } : entity,
            ),
            activeLayer: ONSHAPE_LAYERS.outline.name,
        },
    });
}
