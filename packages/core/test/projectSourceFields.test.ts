// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    bytesToBase64,
    InternalClassName,
    packProject,
    projectSourceElementSpec,
    projectSourceElementSpecs,
    registerProjectSourceElement,
    type Serialized,
    unpackProject,
} from "../src";

// A made-up element keeping three properties as files: a text, an optional text attachment
// named after its file, and a binary attachment stored as base64 in the document.
const CLASS = "AttachmentStudioNode";
registerProjectSourceElement({
    className: CLASS,
    kind: "attachment",
    field: "notes",
    folder: "att/",
    extension: ".md",
});
registerProjectSourceElement({
    className: CLASS,
    kind: "attachment",
    field: "text",
    folder: "att/",
    extension: ".txt",
    extensionOf: (node) => (typeof node["ext"] === "string" ? node["ext"] : undefined),
    skipEmpty: true,
});
registerProjectSourceElement({
    className: CLASS,
    kind: "attachment",
    field: "bytes",
    folder: "att/",
    extension: ".bin",
    encoding: "base64",
    skipEmpty: true,
});

const BINARY = new Uint8Array([0, 1, 2, 250, 255, 0x50, 0x4b]);

const documentWith = (...nodes: Record<string, unknown>[]): Serialized => ({
    [InternalClassName]: "Document",
    version: "0.7.1",
    id: "doc",
    name: "Job",
    models: {
        components: [],
        materials: [],
        nodes: [{ [InternalClassName]: "FolderNode", id: "root", name: "Job" }, ...nodes],
    },
});

const pack = (document: Serialized) =>
    packProject({
        document,
        app: { name: "Chili3D", version: "test" },
        createdAt: "2026-01-01T00:00:00.000Z",
        modifiedAt: "2026-01-01T00:00:00.000Z",
    });

describe("several externalized properties per class", () => {
    test("each property is its own file; binary ones are raw bytes; the round trip is exact", () => {
        const node = {
            [InternalClassName]: CLASS,
            id: "a1",
            name: "Prices",
            parentId: "root",
            ext: ".csv",
            notes: "# Notes",
            text: "a,b\n1,2",
            bytes: bytesToBase64(BINARY),
        };
        const files = pack(documentWith(node)).value;
        expect(new TextDecoder().decode(files.get("att/Prices.md"))).toBe("# Notes");
        expect(new TextDecoder().decode(files.get("att/Prices.csv"))).toBe("a,b\n1,2");
        expect(files.get("att/Prices.bin")).toEqual(BINARY);
        const documentJson = JSON.parse(new TextDecoder().decode(files.get("document.json")));
        expect(documentJson.models.nodes[1].bytes).toEqual({ $file: "att/Prices.bin", $encoding: "base64" });
        expect(documentJson.models.nodes[1].text).toEqual({ $file: "att/Prices.csv" });
        const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
        expect(manifest.elements).toContainEqual({
            id: "a1",
            kind: "attachment",
            name: "Prices",
            path: "att/Prices.md",
        });

        const unpacked = unpackProject(files);
        expect(unpacked.isOk).toBe(true);
        expect((unpacked.value.document["models"] as { nodes: unknown[] }).nodes[1]).toEqual(node);
    });

    test("an empty optional property stays inline; the first spec is the element's", () => {
        const node = {
            [InternalClassName]: CLASS,
            id: "a2",
            name: "Empty",
            parentId: "root",
            notes: "n",
            text: "",
            bytes: "",
        };
        const files = pack(documentWith(node)).value;
        expect([...files.keys()].filter((path) => path.startsWith("att/"))).toEqual(["att/Empty.md"]);
        const documentJson = JSON.parse(new TextDecoder().decode(files.get("document.json")));
        expect(documentJson.models.nodes[1]).toMatchObject({ text: "", bytes: "" });
        expect(projectSourceElementSpec(CLASS)?.field).toBe("notes");
        expect(projectSourceElementSpecs(CLASS).map((spec) => spec.field)).toEqual([
            "notes",
            "text",
            "bytes",
        ]);
    });

    test("re-registering a field replaces its spec instead of adding one", () => {
        registerProjectSourceElement({
            className: CLASS,
            kind: "attachment",
            field: "notes",
            folder: "att/",
            extension: ".md",
        });
        expect(projectSourceElementSpecs(CLASS)).toHaveLength(3);
    });
});
