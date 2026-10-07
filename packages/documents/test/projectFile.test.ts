// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Document, openProjectFile, unzipProjectFiles, writeProjectFile } from "@chili3d/app";
import {
    bytesToBase64,
    type IApplication,
    type ProjectManifest,
    type Serialized,
    sha256Hex,
    Transaction,
} from "@chili3d/core";
import { createMockApplication } from "@chili3d/core/test-utils";
import { DocumentFileNode } from "../src/documentFileNode";

/**
 * Document elements in `.chili3d` projects: each file is a real file under `files/` (raw
 * bytes, not base64), `document.json` keeps a `{ "$file", "$encoding" }` reference, and
 * the bytes come back identical.
 */

const NOW = new Date("2026-10-07T12:00:00.000Z");

function newApp(): IApplication {
    const app = createMockApplication();
    app.loadDocument = (data: Serialized) => Document.load(app, data);
    return app;
}

/** Bytes that are not UTF-8 and compress badly, like a real binary file. */
function binary(size: number): Uint8Array {
    const bytes = new Uint8Array(size);
    let seed = 12345;
    for (let i = 0; i < size; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        bytes[i] = seed & 0xff;
    }
    bytes[0] = 0xff;
    return bytes;
}

function sample(app: IApplication) {
    const document = new Document(app, "Duct job");
    const sheet = new DocumentFileNode({
        document,
        name: "Cut list",
        fileName: "cut-list.xlsx",
        format: "xlsx",
        bytes: binary(50_000),
    });
    const notes = new DocumentFileNode({
        document,
        name: "Notes",
        fileName: "notes.md",
        format: "markdown",
        text: "# Notes\r\n\r\nünïcode ✓\n",
    });
    const picture = new DocumentFileNode({
        document,
        name: "Notes",
        fileName: "photo.png",
        format: "png",
        bytes: binary(300),
    });
    Transaction.execute(document, "add", () => document.modelManager.addNode(sheet, notes, picture));
    return { document, sheet, notes, picture };
}

describe(".chili3d projects with document elements", () => {
    test("files are stored under files/ with their bytes, referenced from document.json", async () => {
        const app = newApp();
        const { document, sheet, notes, picture } = sample(app);
        const written = await writeProjectFile(document, { now: NOW, thumbnail: new Uint8Array() });
        expect(written.isOk).toBe(true);
        const files = (await unzipProjectFiles(written.value)).value;

        expect(files.get("files/Cut list.xlsx")).toEqual(sheet.bytes);
        expect(new TextDecoder().decode(files.get("files/Notes.md"))).toBe("# Notes\r\n\r\nünïcode ✓\n");
        // Two elements named "Notes": their files differ by extension.
        expect(files.get("files/Notes.png")).toEqual(picture.bytes);

        const json = new TextDecoder().decode(files.get("document.json"));
        expect(json).not.toContain(bytesToBase64(sheet.bytes).slice(0, 200));
        expect(json.length).toBeLessThan(20_000);
        const nodes = (JSON.parse(json) as Serialized)["models"]["nodes"] as Record<string, unknown>[];
        const stored = Object.fromEntries(nodes.map((node) => [node["id"], node["content"]]));
        expect(stored[sheet.id]).toEqual({ $file: "files/Cut list.xlsx", $encoding: "base64" });
        expect(stored[notes.id]).toEqual({ $file: "files/Notes.md" });

        const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as ProjectManifest;
        expect(manifest.files.find((file) => file.path === "files/Cut list.xlsx")).toEqual({
            path: "files/Cut list.xlsx",
            size: 50_000,
            sha256: sha256Hex(sheet.bytes),
            role: "source",
        });
        expect(
            manifest.elements.filter((element) => element.kind === "document").map((element) => element.path),
        ).toEqual(["files/Cut list.xlsx", "files/Notes.md", "files/Notes.png"]);
    });

    test("opening the project restores every file byte for byte", async () => {
        const { document, sheet, notes, picture } = sample(newApp());
        const written = await writeProjectFile(document, { now: NOW, thumbnail: new Uint8Array() });
        const opened = await openProjectFile(newApp(), written.value);
        expect(opened.isOk).toBe(true);
        const loaded = opened.value.modelManager.findNodes(
            (node) => node instanceof DocumentFileNode,
        ) as DocumentFileNode[];
        const byId = new Map(loaded.map((node) => [node.id, node]));
        expect(byId.get(sheet.id)?.bytes).toEqual(sheet.bytes);
        expect(byId.get(sheet.id)?.encoding).toBe("base64");
        expect(byId.get(sheet.id)?.fileName).toBe("cut-list.xlsx");
        expect(byId.get(notes.id)?.text).toBe(notes.text);
        expect(byId.get(notes.id)?.encoding).toBe("text");
        expect(byId.get(picture.id)?.bytes).toEqual(picture.bytes);
        expect(opened.value.serialize()["models"]).toEqual(document.serialize()["models"]);
    });

    test("in the serialized document (IndexedDB, version history, clipboard) the bytes are inline", () => {
        const { document, sheet, notes } = sample(newApp());
        const nodes = document.serialize()["models"]["nodes"] as Record<string, unknown>[];
        const stored = nodes.find((node) => node["id"] === sheet.id);
        expect(stored).toMatchObject({
            encoding: "base64",
            content: bytesToBase64(sheet.bytes),
            format: "xlsx",
        });
        expect(nodes.find((node) => node["id"] === notes.id)).toMatchObject({
            encoding: "text",
            content: notes.text,
        });
        const copy = sheet.clone();
        expect(copy.bytes).toEqual(sheet.bytes);
    });

    test("replacing a file is one undoable change", () => {
        const { document, notes } = sample(newApp());
        Transaction.execute(document, "edit", () => notes.setText("changed"));
        expect(notes.text).toBe("changed");
        document.history.undo();
        expect(notes.text).toBe("# Notes\r\n\r\nünïcode ✓\n");
    });
});
