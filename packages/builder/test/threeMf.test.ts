// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import JSZip from "jszip";
import { threeMfModel, weldMesh, write3mf } from "../src/threeMf";

/** Two triangles of a unit square, written face by face (vertices duplicated, as OCCT meshes are). */
const square = {
    name: "Plate <1>",
    color: 0x3366cc,
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0],
    indices: [0, 1, 2, 3, 4, 5],
};

describe("3MF writer", () => {
    test("welds shared vertices and drops collapsed triangles", () => {
        expect(weldMesh(square)).toEqual({
            vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
            triangles: [0, 1, 2, 0, 2, 3],
        });
        expect(
            weldMesh({ name: "sliver", positions: [0, 0, 0, 1, 0, 0, 1e-7, 0, 0], indices: [0, 1, 2] }),
        ).toEqual({
            vertices: [0, 0, 0, 1, 0, 0],
            triangles: [],
        });
    });

    test("writes a millimetre model with a named, colored object and a build item", () => {
        const xml = threeMfModel([square]);
        expect(xml).toContain(`<model unit="millimeter"`);
        expect(xml).toContain(`<base name="#3366CC" displaycolor="#3366CC"/>`);
        expect(xml).toContain(`<object id="2" type="model" name="Plate &lt;1&gt;" pid="1" pindex="0">`);
        expect(xml.match(/<vertex /g)).toHaveLength(4);
        expect(xml).toContain(`<triangle v1="0" v2="2" v3="3"/>`);
        expect(xml).toContain(`<item objectid="2"/>`);
    });

    test("packages the model with the OPC content types and relationship", async () => {
        const zip = await JSZip.loadAsync(await write3mf([square]));
        expect(Object.keys(zip.files).sort()).toEqual([
            "3D/",
            "3D/3dmodel.model",
            "[Content_Types].xml",
            "_rels/",
            "_rels/.rels",
        ]);
        expect(await zip.file("_rels/.rels")!.async("string")).toContain(`Target="/3D/3dmodel.model"`);
        expect(await zip.file("[Content_Types].xml")!.async("string")).toContain(
            "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
        );
    });
});
