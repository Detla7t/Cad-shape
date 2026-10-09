// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import JSZip from "jszip";
import { detectFileFormat, fileExtension, fileFormatByName, sniffFileContent, zipEntryNames } from "../src";

const text = (value: string) => new TextEncoder().encode(value);

async function zip(entries: Record<string, string>, mimetypeFirst?: string): Promise<Uint8Array> {
    const archive = new JSZip();
    if (mimetypeFirst !== undefined) archive.file("mimetype", mimetypeFirst, { compression: "STORE" });
    for (const [name, content] of Object.entries(entries)) archive.file(name, content);
    return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function binaryStl(triangles: number): Uint8Array {
    const bytes = new Uint8Array(84 + 50 * triangles);
    bytes.set(text("solid but actually binary"), 0);
    new DataView(bytes.buffer).setUint32(80, triangles, true);
    return bytes;
}

function ole(stream: string): Uint8Array {
    const bytes = new Uint8Array(2048);
    bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    [...stream].forEach((char, i) => {
        bytes[1024 + i * 2] = char.charCodeAt(0);
    });
    return bytes;
}

const IGES_LINE = `${"Chili3D IGES sample".padEnd(72)}S      1`;

describe("detectFileFormat by content", () => {
    test.each([
        ["STEP", "part.txt", text("ISO-10303-21;\nHEADER;\n"), "step"],
        ["IGES", "part.dat", text(`${IGES_LINE}\n`), "iges"],
        [
            "BREP",
            "shape.bin",
            text("DBRep_DrawableShape\n\nCASCADE Topology V1, (c) Matra-Datavision\n"),
            "brep",
        ],
        ["ASCII STL", "mesh.dat", text("solid cube\n  facet normal 0 0 1\n"), "stl"],
        ["binary STL", "mesh.dat", binaryStl(2), "stl"],
        ["OBJ", "mesh", text("# cube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"), "obj"],
        ["glTF", "scene.json", text('{"asset":{"version":"2.0"},"meshes":[]}'), "gltf"],
        ["GLB", "scene", text("glTF\u0002\u0000\u0000\u0000"), "glb"],
        ["DXF", "drawing.txt", text("  0\nSECTION\n  2\nHEADER\n"), "dxf"],
        ["DWG", "drawing.dxf", text("AC1032\u0000\u0000\u0000"), "dwg"],
        ["PDF", "datasheet", text("%PDF-1.7\n%âãÏÓ\n"), "pdf"],
        ["PNG", "image", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), "png"],
        ["JPEG", "image", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), "jpeg"],
        ["GIF", "image", text("GIF89a"), "gif"],
        [
            "SVG",
            "drawing",
            text('<?xml version="1.0"?>\n<!-- made by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'),
            "svg",
        ],
        [
            "Parasolid text",
            "part.dat",
            text("**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz**************************\n"),
            "parasolid",
        ],
        ["CATIA V5", "part", text("V5_CFV2\u0000\u0000"), "catia"],
        ["Rhino", "model", text("3D Geometry File Format        2"), "rhino"],
        ["Creo", "part", text("#UGC:2 PART 1234"), "creo"],
        [
            "FeatureScript",
            "studio.txt",
            text('FeatureScript 3083;\nimport(path : "onshape/std/geometry.fs", version : "3083.0");\n'),
            "featurescript",
        ],
        ["legacy document", "backup.json", text('{"__cla$$__":"Document","version":"0.7.1"}'), "cd"],
        ["Excel 97", "book", ole("Workbook"), "xls"],
        ["Word 97", "letter", ole("WordDocument"), "doc"],
    ] as const)("%s", (_, name, bytes, id) => {
        expect(detectFileFormat(name, bytes)).toMatchObject({ id, by: "content" });
    });

    test("DWG versions are reported", () => {
        expect(detectFileFormat("a.dwg", text("AC1018xx"))).toMatchObject({ id: "dwg", version: "AC1018" });
        expect(sniffFileContent(text("AC1015"))).toEqual({ id: "dwg", version: "AC1015" });
    });

    test("zip containers are told apart by their entries", async () => {
        const docx = await zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w:document/>" });
        const xlsx = await zip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook/>" });
        const pptx = await zip({ "[Content_Types].xml": "<Types/>", "ppt/presentation.xml": "<p/>" });
        const threeMf = await zip({ "[Content_Types].xml": "<Types/>", "3D/3dmodel.model": "<model/>" });
        const project = await zip({ "manifest.json": "{}", "document.json": "{}" });
        const odt = await zip(
            { "content.xml": "<x/>", "META-INF/manifest.xml": "<m/>" },
            "application/vnd.oasis.opendocument.text",
        );
        const ods = await zip(
            { "content.xml": "<x/>", "META-INF/manifest.xml": "<m/>" },
            "application/vnd.oasis.opendocument.spreadsheet",
        );
        expect(
            [docx, xlsx, pptx, threeMf, project, odt, ods].map((bytes) => detectFileFormat("file", bytes).id),
        ).toEqual(["docx", "xlsx", "pptx", "3mf", "chili3d", "odt", "ods"]);
        expect(zipEntryNames(docx).filter((name) => !name.endsWith("/"))).toEqual([
            "[Content_Types].xml",
            "word/document.xml",
        ]);
    });

    test("an unknown zip or OLE container is refined by the extension", async () => {
        const plain = await zip({ "readme.txt": "hi" });
        expect(detectFileFormat("plugin.chiliplugin", plain)).toMatchObject({
            id: "chiliplugin",
            by: "extension",
        });
        expect(detectFileFormat("part.sldprt", ole("Contents"))).toMatchObject({
            id: "solidworks",
            by: "extension",
        });
        const odfCompressed = await zip({
            mimetype: "application/vnd.oasis.opendocument.spreadsheet",
            "content.xml": "<x/>",
            "META-INF/manifest.xml": "<m/>",
        });
        expect(detectFileFormat("table.ods", odfCompressed)).toMatchObject({ id: "ods", by: "extension" });
    });
});

describe("detectFileFormat by name", () => {
    test("text the content cannot identify keeps its extension", () => {
        // Markdown starting like JSON or HTML is still Markdown.
        expect(detectFileFormat("notes.md", text("[link](https://x)\n# Title"))).toMatchObject({
            id: "markdown",
            mismatch: false,
        });
        expect(detectFileFormat("notes.md", text("<div>html in markdown</div>"))).toMatchObject({
            id: "markdown",
        });
        expect(detectFileFormat("data.csv", text("a,b\n1,2\n"))).toMatchObject({
            id: "csv",
            by: "extension",
        });
        expect(detectFileFormat("data.json", text('{"a":1}'))).toMatchObject({ id: "json" });
        expect(detectFileFormat("README", text("plain words"))).toMatchObject({ id: "text", by: "content" });
    });

    test("binary formats without a signature come from the extension", () => {
        expect(detectFileFormat("part.x_b", new Uint8Array([0x50, 0x53, 0, 0, 0, 1, 2, 3]))).toMatchObject({
            id: "parasolid",
            category: "proprietary",
            vendor: "Siemens",
            by: "extension",
        });
        expect(detectFileFormat("assembly.iam", new Uint8Array([1, 2, 3]))).toMatchObject({ id: "inventor" });
        expect(detectFileFormat("nothing.xyz", new Uint8Array([1, 2, 3]))).toMatchObject({
            id: "unknown",
            by: "none",
        });
    });

    test("a content signature wins over a wrong extension and is flagged", () => {
        expect(detectFileFormat("model.stl", text("ISO-10303-21;\n"))).toMatchObject({
            id: "step",
            mismatch: true,
        });
        expect(detectFileFormat("model.step", text("ISO-10303-21;\n"))).toMatchObject({
            id: "step",
            mismatch: false,
        });
    });

    test("extension helpers", () => {
        expect(fileExtension("C:\\work\\Part.STEP")).toBe(".step");
        expect(fileExtension(".hidden")).toBe("");
        expect(fileFormatByName("sheet.XLSX")?.id).toBe("xlsx");
        expect(fileFormatByName("noextension")).toBeUndefined();
    });
});

describe("NC programs (G-code)", () => {
    const fanuc = text(
        "%\nO1001 (BRACKET)\nG90 G21\nT1 M6\nS8000 M3\nG0 X0 Y0\nG43 Z15. H1\nG1 Z-1. F300.\nM30\n%\n",
    );
    const printer = text("; generated by PrusaSlicer\nG90\nM83\nG28\nG1 Z0.2 F720\nG1 X10 Y10 E0.5\n");

    test.each([
        ["an extensionless Fanuc program", "PROGRAM", fanuc, "content"],
        ["an odd extension", "part.001", fanuc, "content"],
        ["printer G-code named .gcode", "benchy.gcode", printer, "extension"],
        ["a tiny program named .nc", "probe.nc", text("G0 Z5\n"), "extension"],
        [
            "Heidenhain conversational named .h",
            "part.h",
            text("0 BEGIN PGM PART MM\n1 END PGM PART MM\n"),
            "extension",
        ],
        ["Siemens named .mpf", "main.mpf", text("; ROUGH\nN10 G17 G90\nN20 T1\nN30 M6\n"), "extension"],
    ])("%s is an NC program", (_name, fileName, bytes, by) => {
        expect(detectFileFormat(fileName, bytes)).toMatchObject({ id: "nc", category: "nc", by });
    });

    test("G-code-like text named as another text format keeps its format", () => {
        expect(detectFileFormat("notes.txt", fanuc)).toMatchObject({ id: "text", by: "extension" });
        expect(detectFileFormat("notes.md", fanuc)).toMatchObject({ id: "markdown" });
        expect(detectFileFormat("README", text("Use G1 X10 to move.\nG0 is rapid.\n"))).toMatchObject({
            id: "text",
        });
    });

    test.each([
        "a.nc",
        "a.ngc",
        "a.tap",
        "a.cnc",
        "a.gcode",
        "a.gc",
        "a.g",
        "a.iso",
        "a.eia",
        "a.mpf",
        "a.spf",
        "a.min",
        "a.ptp",
        "a.h",
    ])("%s is named as an NC program", (name) => {
        expect(fileFormatByName(name)?.id).toBe("nc");
    });
});
