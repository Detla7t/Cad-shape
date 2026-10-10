// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DialogButton,
    type DownloadedFile,
    type I18nKeys,
    type IApplication,
    Plane,
    PubSub,
    setDownloadDelivery,
    type VisualNode,
} from "@chili3d/core";
import { createMockApplication, TestDocument } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { BoxNode } from "../../src/bodys/box";
import {
    exportParts,
    exportTypeOf,
    PART_EXPORT_FORMATS,
    partExportFormats,
    showExportPartDialog,
} from "../../src/commands/exportPartDialog";

function setup(formats = [".step", ".iges", ".stl", ".stl binary", ".obj", ".glb"]) {
    const exported = rs.fn(async (_type: string, _nodes: VisualNode[]) => ["bytes"] as BlobPart[]);
    const app = createMockApplication({
        dataExchange: { exportFormats: () => formats, export: exported },
    } as unknown as Partial<IApplication>);
    const doc = new TestDocument({ application: app });
    const box = new BoxNode({ document: doc, plane: Plane.XY, dx: 10, dy: 10, dz: 10 });
    box.name = "Box";
    const lid = new BoxNode({ document: doc, plane: Plane.XY, dx: 10, dy: 10, dz: 2 });
    lid.name = "Lid";
    doc.modelManager.addNode(box);
    doc.modelManager.addNode(lid);
    const files: DownloadedFile[] = [];
    setDownloadDelivery((file) => {
        files.push(file);
        return true;
    });
    return { app, doc, box, lid, exported, files };
}
afterEach(() => setDownloadDelivery(undefined));

test("Onshape's format list, in its order: the closed formats explained, the kernel's marked by what it writes", () => {
    expect(PART_EXPORT_FORMATS.map((format) => format.name)).toEqual([
        "PARASOLID",
        "ACIS",
        "STEP",
        "IGES",
        "PVZ",
        "JT",
        "RHINO",
        "GLTF",
        "GLB",
        "OBJ",
        "3MF",
        "STL",
        "PLY",
        "BREP",
        "Inspection list",
    ]);
    const { app } = setup([".step", ".stl"]);
    const formats = partExportFormats(app);
    const unavailable = (name: string) => formats.find((format) => format.name === name)?.unavailable;
    expect(unavailable("STEP")).toBeUndefined();
    expect(unavailable("STL")).toBeUndefined();
    expect(unavailable("Inspection list")).toBeUndefined();
    expect(unavailable("IGES")).toBe("IGES is not available in this build.");
    expect(unavailable("PARASOLID")).toContain("closed format");
    expect(unavailable("RHINO")).toContain("openNURBS");
    const stl = PART_EXPORT_FORMATS.find((format) => format.id === ".stl")!;
    expect(exportTypeOf(stl, true)).toBe(".stl binary");
    expect(exportTypeOf(stl, false)).toBe(".stl");
    expect(exportTypeOf(PART_EXPORT_FORMATS[2], true)).toBe(".step");
});

test("exportParts writes one file, one zip of files per part, or the inspection list", async () => {
    const { app, box, lid, exported, files } = setup();
    const stl = PART_EXPORT_FORMATS.find((format) => format.id === ".stl")!;
    await exportParts(app, [box], { fileName: "Box.stl", format: stl, binary: true, individual: false });
    expect(exported).toHaveBeenCalledWith(".stl binary", [box]);
    expect(files.map((file) => file.name)).toEqual(["Box.stl"]);

    await exportParts(app, [box, lid], {
        fileName: "Parts.stl",
        format: stl,
        binary: false,
        individual: true,
    });
    expect(exported.mock.calls.slice(1).map((call) => [call[0], call[1].map((n) => n.name)])).toEqual([
        [".stl", ["Box"]],
        [".stl", ["Lid"]],
    ]);
    expect(files.at(-1)?.name).toBe("Parts.zip");
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await files.at(-1)!.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["Box.stl", "Lid.stl"]);

    const inspection = PART_EXPORT_FORMATS.find((format) => format.id === "inspection")!;
    await exportParts(app, [box], {
        fileName: "Box.csv",
        format: inspection,
        binary: false,
        individual: false,
    });
    expect(files.at(-1)?.name).toBe("Box.csv");
    expect(await files.at(-1)!.blob.text()).toMatch(/^"inspection\.characteristic","inspection\.nominal"/);

    const parasolid = PART_EXPORT_FORMATS[0];
    await expect(
        exportParts(app, [box], { fileName: "Box.x_t", format: parasolid, binary: false, individual: false }),
    ).rejects.toThrow(/closed format/);
});

test("the dialog suggests the name from the export rules, follows the format, and exports on OK", async () => {
    const { app, box, lid, exported } = setup();
    let shown: { title: I18nKeys; content: HTMLElement; buttons?: DialogButton[] | (() => void) } | undefined;
    const onDialog = (title: I18nKeys, content: HTMLElement, buttons?: DialogButton[] | (() => void)) => {
        shown = { title, content, buttons };
    };
    PubSub.default.sub("showDialog", onDialog);
    try {
        showExportPartDialog(app, [box, lid]);
        expect(shown?.title).toBe("export.dialog.title");
        const content = shown!.content;
        const name = content.querySelector<HTMLInputElement>(
            'input[aria-label="documents.exportDialog.fileName"]',
        );
        const format = content.querySelector<HTMLSelectElement>(
            'select[aria-label="documents.exportDialog.format"]',
        );
        expect(name).not.toBeNull();
        expect(format).not.toBeNull();
        // two parts: the document names the file; STEP is the default
        expect(format!.value).toBe(".step");
        expect(name!.value.endsWith(".step")).toBe(true);
        expect([...format!.options].filter((o) => o.disabled).map((o) => o.textContent)).toEqual([
            "PARASOLID",
            "ACIS",
            "PVZ",
            "JT",
            "RHINO",
            "GLTF",
            "3MF",
            "PLY",
            "BREP",
        ]);
        const binary = content.querySelector<HTMLInputElement>('input[aria-label="export.dialog.binary"]');
        expect(binary!.closest("label")!.hidden).toBe(true);
        format!.value = ".stl";
        format!.dispatchEvent(new Event("change"));
        expect(name!.value.endsWith(".stl")).toBe(true);
        expect(binary!.closest("label")!.hidden).toBe(false);
        const individual = content.querySelector<HTMLInputElement>(
            'input[aria-label="export.dialog.individual"]',
        );
        expect(individual!.checked).toBe(true);
        individual!.checked = false;
        const buttons = shown!.buttons as DialogButton[];
        expect(buttons[0].content).toBe("documents.exportDialog.export");
        await buttons[0].onclick?.();
        expect(exported).toHaveBeenCalledWith(".stl binary", [box, lid]);
    } finally {
        PubSub.default.remove("showDialog", onDialog);
    }
});
