// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { bytesToBase64 } from "@chili3d/core";
import { drawingBounds, writeSvg } from "@chili3d/parametric";
import { importDwg } from "../cad/dwg";
import { importDxf } from "../cad/dxfToDrawing";
import type { DocumentFileNode } from "../documentFileNode";
import { mimeTypeOf } from "../documentFormats";

/** Fit the whole drawing in the tab preview without opening a viewer or changing its zoom. */
export async function documentTabThumbnail(node: DocumentFileNode): Promise<string | undefined> {
    if (node.viewKind === "image")
        return `data:${mimeTypeOf(node.format)};base64,${bytesToBase64(node.bytes)}`;
    if (node.viewKind !== "drawing") return undefined;
    const result = node.format === "dwg" ? await importDwg(node.bytes) : importDxf(node.bytes);
    if (!result.isOk) return undefined;
    const bounds = drawingBounds(result.value.drawing);
    if (!bounds) return undefined;
    const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], 1);
    const svg = writeSvg(result.value.drawing, { margin: size * 0.04, strokeWidth: size / 400 });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
