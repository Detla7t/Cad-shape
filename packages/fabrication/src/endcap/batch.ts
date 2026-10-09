// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { writeDxf } from "@chili3d/drawing";
import JSZip from "jszip";
import { type ToDrawingOptions, toDrawing } from "../geometry/toDrawing";
import { type EndCapParams, endCapName, endCapPattern, type Outcome } from "./endCap";
import { DUCT_SIZES } from "./sizes";

/**
 * Every preset cap: a plain cap per size and a reducing cap per pair of sizes (the smaller
 * inside the larger) — the "End caps — all preset sizes" export profile, 253 parts.
 */
export function presetEndCaps(): EndCapParams[] {
    const caps: EndCapParams[] = [];
    for (const od of DUCT_SIZES) {
        caps.push({ reducing: false, od: od.inches });
        for (const id of DUCT_SIZES) {
            if (id.inches < od.inches) caps.push({ reducing: true, od: od.inches, id: id.inches });
        }
    }
    return caps;
}

export interface TextFile {
    readonly name: string;
    readonly text: string;
}

/** The cap as a DXF file (inches). */
export function endCapDxf(params: EndCapParams, options: ToDrawingOptions = {}): Outcome<TextFile> {
    const pattern = endCapPattern(params);
    if (!pattern.isOk) return pattern;
    return {
        isOk: true,
        value: { name: `${endCapName(params)}.dxf`, text: writeDxf(toDrawing(pattern.value, options)) },
    };
}

/** A zip of DXFs, one per cap, named like the Onshape exports (`9.63in x 6.63in Reducing End Cap.dxf`). */
export async function endCapDxfZip(
    caps: readonly EndCapParams[] = presetEndCaps(),
    options: ToDrawingOptions = {},
): Promise<Outcome<Blob>> {
    const zip = new JSZip();
    for (const cap of caps) {
        const file = endCapDxf(cap, options);
        if (!file.isOk) return { isOk: false, error: `${endCapName(cap)}: ${file.error}` };
        zip.file(file.value.name, file.value.text);
    }
    return { isOk: true, value: await zip.generateAsync({ type: "blob", compression: "DEFLATE" }) };
}
