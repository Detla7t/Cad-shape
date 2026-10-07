// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    base64ToBytes,
    bytesToBase64,
    InternalClassName,
    isValidProjectPrefix,
    type ProjectManifest,
    packProject,
    registerProjectSourceElement,
    type Serialized,
    unpackProject,
} from "../src";

// A made-up attachment element: binary files as base64, text files as text, named by their own file name.
registerProjectSourceElement({
    className: "AttachmentNode",
    kind: "attachment",
    field: "data",
    folder: "attachments/",
    extension: ".bin",
    encoding: (node) => (node["encoding"] === "text" ? "text" : "base64"),
    fileName: (node) => (typeof node["fileName"] === "string" ? node["fileName"] : undefined),
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128, 7]);

const serialized = (data: string, encoding: string, fileName?: string): Serialized => ({
    [InternalClassName]: "Document",
    version: "0.7.1",
    id: "doc-1",
    name: "Job",
    models: {
        components: [],
        materials: [],
        nodes: [
            { [InternalClassName]: "FolderNode", id: "root", name: "Job" },
            {
                [InternalClassName]: "AttachmentNode",
                id: "a1",
                name: "Photo",
                fileName,
                encoding,
                data,
                parentId: "root",
            },
        ],
    },
    variables: [],
    acts: [],
    userData: {},
});

const pack = (document: Serialized) =>
    packProject({
        document,
        app: { name: "Chili3D", version: "1.0.0" },
        createdAt: "2026-01-01T00:00:00.000Z",
        modifiedAt: "2026-01-01T00:00:00.000Z",
    });

const nodeOf = (document: Serialized) => (document["models"]["nodes"] as Record<string, unknown>[])[1];

describe("base64", () => {
    test.each([0, 1, 2, 3, 4, 5, 100, 100_000])("%i bytes round-trip", (size) => {
        const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 37 + 11) & 0xff);
        const encoded = bytesToBase64(bytes);
        expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
        expect(base64ToBytes(encoded)).toEqual(bytes);
    });

    test("invalid input is rejected; whitespace is ignored", () => {
        expect(base64ToBytes("abc")).toBeUndefined();
        expect(base64ToBytes("ab!=")).toBeUndefined();
        expect(base64ToBytes("aGVs\nbG8=")).toEqual(new TextEncoder().encode("hello"));
    });
});

describe("binary source elements", () => {
    test("a base64 property is written as the raw file, referenced with its encoding", () => {
        const files = pack(serialized(bytesToBase64(PNG), "base64", "photo.png"));
        expect(files.isOk).toBe(true);
        expect(files.value.get("attachments/photo.png")).toEqual(PNG);
        const document = JSON.parse(new TextDecoder().decode(files.value.get("document.json"))) as Serialized;
        expect(nodeOf(document)["data"]).toEqual({ $file: "attachments/photo.png", $encoding: "base64" });
        const manifest = JSON.parse(
            new TextDecoder().decode(files.value.get("manifest.json")),
        ) as ProjectManifest;
        expect(manifest.elements).toContainEqual({
            id: "a1",
            kind: "attachment",
            name: "Photo",
            path: "attachments/photo.png",
        });

        const unpacked = unpackProject(files.value);
        expect(unpacked.isOk).toBe(true);
        expect(nodeOf(unpacked.value.document)["data"]).toBe(bytesToBase64(PNG));
    });

    test("a text attachment stays text; without a file name the element name is used", () => {
        const files = pack(serialized("a,b\n1,2\n", "text"));
        expect(new TextDecoder().decode(files.value.get("attachments/Photo.bin"))).toBe("a,b\n1,2\n");
        expect(nodeOf(unpackProject(files.value).value.document)["data"]).toBe("a,b\n1,2\n");
    });

    test("a value that is not valid base64 stays inline instead of being lost", () => {
        const files = pack(serialized("not base64!", "base64", "photo.png"));
        expect(files.value.has("attachments/photo.png")).toBe(false);
        const document = JSON.parse(new TextDecoder().decode(files.value.get("document.json"))) as Serialized;
        expect(nodeOf(document)["data"]).toBe("not base64!");
    });

    test("an unknown encoding is refused when reading", () => {
        const files = pack(serialized(bytesToBase64(PNG), "base64", "photo.png"));
        const document = JSON.parse(new TextDecoder().decode(files.value.get("document.json"))) as Serialized;
        nodeOf(document)["data"] = { $file: "attachments/photo.png", $encoding: "rot13" };
        files.value.set("document.json", new TextEncoder().encode(JSON.stringify(document)));
        expect(unpackProject(files.value).error).toContain("unknown encoding");
    });

    test("registered source folders cannot be taken by an entry provider", () => {
        expect(isValidProjectPrefix("attachments/")).toBe(false);
        expect(isValidProjectPrefix("attachments-extra/")).toBe(true);
    });
});
