// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    InternalClassName,
    PROJECT_HISTORY_FOLDER,
    type ProjectManifest,
    packProject,
    projectElementKind,
    registerProjectSourceElement,
    type Serialized,
    safeProjectFileName,
    sha256Hex,
    unpackProject,
} from "../src";

// Any node class can keep a text property as its own file — here a made-up notes element.
registerProjectSourceElement({
    className: "NoteStudioNode",
    kind: "noteStudio",
    field: "text",
    folder: "notes/",
    extension: ".md",
});

const serialized = (): Serialized => ({
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
                [InternalClassName]: "NoteStudioNode",
                id: "n1",
                name: "Read me",
                text: "# Notes\n",
                parentId: "root",
            },
        ],
    },
    variables: [],
    acts: [],
    userData: {},
});

const pack = (extra: Partial<Parameters<typeof packProject>[0]> = {}) =>
    packProject({
        document: serialized(),
        app: { name: "Chili3D", version: "1.0.0" },
        createdAt: "2026-01-01T00:00:00.000Z",
        modifiedAt: "2026-01-02T00:00:00.000Z",
        ...extra,
    });

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("project archive", () => {
    test("sha256Hex matches the standard test vectors", () => {
        expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    test.each([
        ["Bracket", [], "Bracket.fs"],
        ["bracket", ["bracket.fs"], "bracket (2).fs"],
        ["a/b:c*?", [], "a_b_c__.fs"],
        ["  .hidden. ", [], "hidden.fs"],
        ["CON", [], "_CON.fs"],
        ["", [], "untitled.fs"],
        ["Équerre ✓", [], "Équerre ✓.fs"],
    ])("safe file name for %j", (name, used, expected) => {
        expect(safeProjectFileName(name, ".fs", new Set(used))).toBe(expected);
    });

    test("element kinds: registered, else derived from the class name", () => {
        expect(projectElementKind("NoteStudioNode")).toBe("noteStudio");
        expect(projectElementKind("VariableStudioNode")).toBe("variableStudio");
        expect(projectElementKind("Node")).toBe("node");
    });

    test("externalizes any registered element kind and lists every element", () => {
        const files = pack({ elements: [{ id: "v1", kind: "variableStudio", name: "Variables" }] });
        expect(files.isOk).toBe(true);
        expect([...files.value.keys()]).toEqual(["manifest.json", "document.json", "notes/Read me.md"]);
        expect(text(files.value.get("notes/Read me.md"))).toBe("# Notes\n");
        const manifest = JSON.parse(text(files.value.get("manifest.json"))) as ProjectManifest;
        expect(manifest.elements).toEqual([
            { id: "root", kind: "partStudio", name: "Job" },
            { id: "n1", kind: "noteStudio", name: "Read me", path: "notes/Read me.md" },
            { id: "v1", kind: "variableStudio", name: "Variables" },
        ]);

        const unpacked = unpackProject(files.value);
        expect(unpacked.isOk).toBe(true);
        expect(unpacked.value.document).toEqual(serialized());
        expect(unpacked.value.warnings).toEqual([]);
    });

    test("finds history/ even when the manifest does not list it, and ignores bad extension entries", () => {
        const files = pack().value;
        const manifest = JSON.parse(text(files.get("manifest.json")));
        manifest.extensions = [{ prefix: "../evil/", files: [] }, "junk"];
        files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
        files.set("history/refs.json", new TextEncoder().encode("{}"));
        files.set("../evil/x", new Uint8Array([1]));

        const unpacked = unpackProject(files);
        expect(unpacked.isOk).toBe(true);
        expect([...unpacked.value.extensions.keys()]).toEqual([PROJECT_HISTORY_FOLDER]);
        expect(Object.keys(unpacked.value.extensions.get(PROJECT_HISTORY_FOLDER)!.files)).toEqual([
            "refs.json",
        ]);
    });

    test("refuses unsafe extension entry names and reserved folders", () => {
        const bad = pack({ extensions: [{ prefix: "history/", files: { "../escape": "x" } }] });
        expect(bad.isOk).toBe(false);
        expect(bad.error).toMatch(/Invalid entry/);
        const reserved = pack({ extensions: [{ prefix: "geometry/", files: { a: "x" } }] });
        expect(reserved.isOk).toBe(false);
    });

    test("geometry caches are listed as non-authoritative", () => {
        const files = pack({ geometry: [{ nodeId: "b1", name: "Body", data: "DBRep_DrawableShape" }] }).value;
        const manifest = JSON.parse(text(files.get("manifest.json"))) as ProjectManifest;
        expect(manifest.geometry).toEqual({
            authoritative: false,
            entries: [{ nodeId: "b1", name: "Body", path: "geometry/Body.brep" }],
        });
        expect(manifest.files.find((file) => file.path === "geometry/Body.brep")).toMatchObject({
            role: "cache",
            authoritative: false,
        });
    });

    test("a document reference to a file that is not UTF-8 is an error", () => {
        const files = pack().value;
        files.set("notes/Read me.md", new Uint8Array([0xff, 0xfe, 0xfd]));
        const unpacked = unpackProject(files);
        expect(unpacked.isOk).toBe(false);
        expect(unpacked.error).toMatch(/not UTF-8/);
    });
});
