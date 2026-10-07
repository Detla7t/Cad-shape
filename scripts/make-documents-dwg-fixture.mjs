// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Regenerates `packages/documents/test/fixtures/plate.dwg` from `plate.dxf` next to it,
 * with acad-ts (MIT): the DWG fixture of the documents tests is this script's output, not
 * a drawing from elsewhere.
 *
 *     node scripts/make-documents-dwg-fixture.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACadVersion, DwgWriter, DxfReader, DxfReaderConfiguration } from "@node-projects/acad-ts";

const here = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../packages/documents/test/fixtures",
);
const dxf = readFileSync(path.join(here, "plate.dxf"));
// The fixture DXF is minimal: let the reader add the standard tables a DWG must have.
const configuration = new DxfReaderConfiguration();
configuration.createDefaults = true;
const bytes = new Uint8Array(dxf.buffer, dxf.byteOffset, dxf.byteLength);
const document = DxfReader.readFromStreamWithConfig(bytes, configuration, () => {});
document.header.version = ACadVersion.AC1018;
const dwg = DwgWriter.writeToBuffer(document);
writeFileSync(path.join(here, "plate.dwg"), dwg);
console.log(
    `plate.dwg: ${dwg.length} bytes, ${[...document.modelSpace.entities].length} model-space entities`,
);
