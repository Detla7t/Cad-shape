// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The `.chili3d` project file end to end on a real document: parametric bodies, a sketch,
 * Feature Studios and variables are written, read back into a fresh application and
 * serialize identically; studio sources live in `featurestudios/*.fs`; the manifest
 * describes everything; legacy `.cd` files still open; broken files fail with a message;
 * extension folders (the version history) round-trip through providers or verbatim.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    Document,
    openDocumentFile,
    openProjectFile,
    readProjectFile,
    unzipProjectFiles,
    writeProjectFile,
    zipProjectFiles,
} from "@chili3d/app";
import {
    DOCUMENT_SCHEMA_VERSION,
    DocumentVersionControl,
    type IApplication,
    type IDocument,
    LEGACY_DOCUMENT_VERSION,
    Material,
    MemoryHistoryPersistence,
    Plane,
    PROJECT_FORMAT_VERSION,
    type ProjectEntryProvider,
    type ProjectManifest,
    registerProjectEntryProvider,
    type Serialized,
    sha256Hex,
    Transaction,
    unregisterProjectEntryProvider,
    VERSION_HISTORY_ENTRY_PROVIDER,
} from "@chili3d/core";
import { createMockApplication } from "@chili3d/core/test-utils";
import {
    FeatureStudioNode,
    initGarlicSync,
    type OnshapeStdSource,
    ParametricBodyNode,
    provideOnshapeStd,
    SketchNode,
} from "@chili3d/parametric";
import { initWasm, OccShapeConverter, ShapeFactory } from "@chili3d/wasm";
import JSZip from "jszip";

const here = path.dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
    initGarlicSync(readFileSync(path.resolve(here, "../../parametric/lib/garlic_bg.wasm")));
    await initWasm({ wasmBinary: readFileSync(path.resolve(here, "../../wasm/lib/chili-wasm.wasm")) });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

const NOW = new Date("2026-10-07T12:00:00.000Z");
const BRACKET_SOURCE = `FeatureScript 3083;\nimport(path : "onshape/std/geometry.fs", version : "3083.0");\n\n// a bracket\nexport const answer = 42;\n`;
const PLATE_SOURCE = 'FeatureScript 3083;\r\nexport const plate = "ünïcode ✓";\r\n';
const TAB_SOURCE = "FeatureScript 3083;\nexport const tab = 1;\n";

function newApp(): IApplication {
    const app = createMockApplication();
    app.loadDocument = (data: Serialized) => Document.load(app, data);
    return app;
}

function sampleDocument(app: IApplication): Document {
    const doc = new Document(app, "Duct job");
    doc.modelManager.materials.push(new Material({ document: doc, name: "Galvanized", color: 0xb0b8c0 }));
    doc.variables.setItems([{ id: "v1", name: "h", type: "length", expression: "12" }]);
    const sketch = new SketchNode({
        document: doc,
        plane: Plane.XY,
        data: {
            entities: [
                { id: 1, type: "line", params: [0, 0, 40, 0] },
                { id: 2, type: "line", params: [40, 0, 40, 20] },
                { id: 3, type: "line", params: [40, 20, 0, 20] },
                { id: 4, type: "line", params: [0, 20, 0, 0] },
            ],
            constraints: [],
        },
    });
    doc.modelManager.addNode(sketch);
    doc.modelManager.addNode(
        new ParametricBodyNode({
            document: doc,
            features: [{ id: "f1", type: "extrude", sketchId: sketch.id, depth: "h" }],
        }),
    );
    // "Bracket" and "bracket" collide on case-insensitive file systems; "Tab: A/B" is not a file name.
    doc.modelManager.addNode(
        new FeatureStudioNode({ document: doc, name: "Bracket", source: BRACKET_SOURCE }),
    );
    doc.modelManager.addNode(new FeatureStudioNode({ document: doc, name: "bracket", source: PLATE_SOURCE }));
    doc.modelManager.addNode(new FeatureStudioNode({ document: doc, name: "Tab: A/B", source: TAB_SOURCE }));
    return doc;
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

async function entriesOf(bytes: Uint8Array) {
    const files = await unzipProjectFiles(bytes);
    expect(files.isOk).toBe(true);
    return files.value;
}

async function rezip(files: Map<string, Uint8Array>, change: (files: Map<string, Uint8Array>) => void) {
    const copy = new Map(files);
    change(copy);
    return zipProjectFiles(copy, NOW);
}

describe(".chili3d project file", () => {
    test("round-trips a document: identical serialization after save and open", async () => {
        const doc = sampleDocument(newApp());
        const body = doc.modelManager.findNodes(
            (node) => node instanceof ParametricBodyNode,
        )[0] as ParametricBodyNode;
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.boundingBox().max.z).toBeCloseTo(12, 6);

        const bytes = await writeProjectFile(doc, { now: NOW });
        expect(bytes.isOk).toBe(true);

        const opened = await openProjectFile(newApp(), bytes.value);
        expect(opened.isOk).toBe(true);
        expect(JSON.stringify(opened.value.serialize())).toBe(JSON.stringify(doc.serialize()));
        const reopenedBody = opened.value.modelManager.findNodes(
            (node) => node instanceof ParametricBodyNode,
        )[0];
        expect((reopenedBody as ParametricBodyNode).shape.value.boundingBox().max.z).toBeCloseTo(12, 6);
    });

    test("stores every Feature Studio as a plain .fs file referenced from document.json", async () => {
        const doc = sampleDocument(newApp());
        const files = await entriesOf((await writeProjectFile(doc, { now: NOW })).value);

        expect([...files.keys()]).toEqual([
            "manifest.json",
            "document.json",
            "featurestudios/Bracket.fs",
            "featurestudios/bracket (2).fs",
            "featurestudios/Tab_ A_B.fs",
        ]);
        expect(text(files.get("featurestudios/Bracket.fs"))).toBe(BRACKET_SOURCE);
        expect(text(files.get("featurestudios/bracket (2).fs"))).toBe(PLATE_SOURCE);
        expect(text(files.get("featurestudios/Tab_ A_B.fs"))).toBe(TAB_SOURCE);

        const documentJson = text(files.get("document.json"));
        expect(documentJson).not.toContain("a bracket");
        const nodes = JSON.parse(documentJson).models.nodes as Record<string, unknown>[];
        const studios = nodes.filter((node) => node["__cla$$__"] === "FeatureStudioNode");
        expect(studios.map((node) => node["source"])).toEqual([
            { $file: "featurestudios/Bracket.fs" },
            { $file: "featurestudios/bracket (2).fs" },
            { $file: "featurestudios/Tab_ A_B.fs" },
        ]);
    });

    test("describes the project in manifest.json", async () => {
        const doc = sampleDocument(newApp());
        const thumbnail = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        const files = await entriesOf((await writeProjectFile(doc, { now: NOW, thumbnail })).value);
        const manifest = JSON.parse(text(files.get("manifest.json"))) as ProjectManifest;

        expect(manifest.format).toBe("chili3d-project");
        expect(manifest.formatVersion).toBe(PROJECT_FORMAT_VERSION);
        expect(manifest.app).toEqual({ name: "Chili3D", version: __APP_VERSION__ });
        expect(manifest.createdAt).toBe(NOW.toISOString());
        expect(manifest.modifiedAt).toBe(NOW.toISOString());
        expect(manifest.document).toEqual({
            id: doc.id,
            name: "Duct job",
            version: LEGACY_DOCUMENT_VERSION,
            schemaVersion: DOCUMENT_SCHEMA_VERSION,
        });
        expect(manifest.featureScript).toBeUndefined();
        const studios = doc.modelManager.findNodes((node) => node instanceof FeatureStudioNode);
        expect(manifest.elements).toEqual([
            { id: doc.modelManager.rootNode!.id, kind: "partStudio", name: "Duct job" },
            { id: studios[0].id, kind: "featureStudio", name: "Bracket", path: "featurestudios/Bracket.fs" },
            {
                id: studios[1].id,
                kind: "featureStudio",
                name: "bracket",
                path: "featurestudios/bracket (2).fs",
            },
            {
                id: studios[2].id,
                kind: "featureStudio",
                name: "Tab: A/B",
                path: "featurestudios/Tab_ A_B.fs",
            },
        ]);
        expect(manifest.files.map((file) => [file.path, file.role])).toEqual([
            ["document.json", "document"],
            ["featurestudios/Bracket.fs", "source"],
            ["featurestudios/bracket (2).fs", "source"],
            ["featurestudios/Tab_ A_B.fs", "source"],
            ["thumbnail.png", "thumbnail"],
        ]);
        for (const file of manifest.files) {
            const bytes = files.get(file.path)!;
            expect(file.size).toBe(bytes.length);
            expect(file.sha256).toBe(sha256Hex(bytes));
        }
        expect(manifest.extensions).toEqual([]);
        expect(files.get("thumbnail.png")).toEqual(thumbnail);
    });

    test("records the FeatureScript std version when Onshape's std is in use", async () => {
        provideOnshapeStd({ version: 3083 } as OnshapeStdSource);
        try {
            const files = await entriesOf(
                (await writeProjectFile(sampleDocument(newApp()), { now: NOW })).value,
            );
            const manifest = JSON.parse(text(files.get("manifest.json"))) as ProjectManifest;
            expect(manifest.featureScript).toEqual({ std: "onshape", version: 3083 });
        } finally {
            provideOnshapeStd(undefined);
        }
    });

    test("optionally caches each body's geometry as BREP, flagged non-authoritative", async () => {
        const app = newApp();
        const converter = new OccShapeConverter();
        (app.shapeProvider as { converter: unknown }).converter = converter;
        const doc = sampleDocument(app);
        const files = await entriesOf(
            (await writeProjectFile(doc, { now: NOW, includeGeometry: true })).value,
        );
        const manifest = JSON.parse(text(files.get("manifest.json"))) as ProjectManifest;

        const body = doc.modelManager.findNodes((node) => node instanceof ParametricBodyNode)[0];
        const cache = manifest.geometry!.entries.find((entry) => entry.nodeId === body.id)!;
        expect(manifest.geometry!.authoritative).toBe(false);
        expect(manifest.files.find((file) => file.path === cache.path)).toMatchObject({
            role: "cache",
            authoritative: false,
        });
        const shape = converter.convertFromBrep(text(files.get(cache.path)));
        expect(shape.isOk).toBe(true);
        expect(shape.value.volume()).toBeCloseTo(40 * 20 * 12, 6);

        // Off by default.
        const plain = await entriesOf((await writeProjectFile(doc, { now: NOW })).value);
        expect([...plain.keys()].some((entry) => entry.startsWith("geometry/"))).toBe(false);
    });

    test("keeps createdAt across a reopen and save", async () => {
        const first = await writeProjectFile(sampleDocument(newApp()), { now: NOW });
        const opened = await openProjectFile(newApp(), first.value);
        const later = new Date("2026-12-24T08:00:00.000Z");
        const files = await entriesOf((await writeProjectFile(opened.value, { now: later })).value);
        const manifest = JSON.parse(text(files.get("manifest.json"))) as ProjectManifest;
        expect(manifest.createdAt).toBe(NOW.toISOString());
        expect(manifest.modifiedAt).toBe(later.toISOString());
    });

    test("opens a legacy .cd file and a .chili3d file through the same entry point", async () => {
        const doc = sampleDocument(newApp());
        const legacy = await openDocumentFile(
            newApp(),
            new File([JSON.stringify(doc.serialize())], "old.cd"),
        );
        expect(legacy.isOk).toBe(true);
        expect(JSON.stringify(legacy.value.serialize())).toBe(JSON.stringify(doc.serialize()));

        const project = (await writeProjectFile(doc, { now: NOW })).value;
        const opened = await openDocumentFile(newApp(), new File([project as BlobPart], "job.chili3d"));
        expect(opened.isOk).toBe(true);
        expect(opened.value.name).toBe("Duct job");
    });

    test("a hand-edited studio source loads, with a warning instead of an error", async () => {
        const files = await entriesOf((await writeProjectFile(sampleDocument(newApp()), { now: NOW })).value);
        const edited = await rezip(files, (copy) =>
            copy.set(
                "featurestudios/Bracket.fs",
                new TextEncoder().encode("FeatureScript 3083;\n// edited\n"),
            ),
        );
        const project = await readProjectFile(edited);
        expect(project.isOk).toBe(true);
        expect(project.value.warnings).toEqual(["featurestudios/Bracket.fs was changed outside Chili3D"]);
        const nodes = project.value.document["models"]["nodes"] as Record<string, unknown>[];
        expect(nodes.find((node) => node["name"] === "Bracket")?.["source"]).toBe(
            "FeatureScript 3083;\n// edited\n",
        );
    });

    test("ignores entries it does not know (forward compatibility)", async () => {
        const doc = sampleDocument(newApp());
        const files = await entriesOf((await writeProjectFile(doc, { now: NOW })).value);
        const extended = await rezip(files, (copy) =>
            copy.set("future/feature.bin", new Uint8Array([1, 2, 3])),
        );
        const opened = await openProjectFile(newApp(), extended);
        expect(opened.isOk).toBe(true);
        expect(JSON.stringify(opened.value.serialize())).toBe(JSON.stringify(doc.serialize()));
    });

    describe("broken files fail with a message", () => {
        const manifestWith = async (change: (manifest: Record<string, unknown>) => void) => {
            const files = await entriesOf(
                (await writeProjectFile(sampleDocument(newApp()), { now: NOW })).value,
            );
            return rezip(files, (copy) => {
                const manifest = JSON.parse(text(copy.get("manifest.json")));
                change(manifest);
                copy.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
            });
        };

        test.each([
            [
                "a newer format version",
                (m: Record<string, unknown>) => (m["formatVersion"] = 2),
                /format version 2/,
            ],
            [
                "a format version that is no number",
                (m: Record<string, unknown>) => (m["formatVersion"] = "1"),
                /formatVersion/,
            ],
            [
                "another format",
                (m: Record<string, unknown>) => (m["format"] = "something-else"),
                /Not a Chili3D project/,
            ],
            [
                "a files entry that is no list",
                (m: Record<string, unknown>) => (m["files"] = {}),
                /files is not a list/,
            ],
        ])("%s", async (_name, change, message) => {
            const opened = await openProjectFile(newApp(), await manifestWith(change));
            expect(opened.isOk).toBe(false);
            expect(opened.error).toMatch(message);
        });

        test("not a zip at all", async () => {
            const opened = await openProjectFile(newApp(), new Uint8Array([1, 2, 3, 4, 5]));
            expect(opened.isOk).toBe(false);
            expect(opened.error).toMatch(/not a zip archive/);
        });

        test.each([
            ["manifest.json", /manifest\.json is missing/],
            ["document.json", /missing document\.json/],
            ["featurestudios/Bracket.fs", /missing featurestudios\/Bracket\.fs/],
        ])("a missing %s", async (entry, message) => {
            const files = await entriesOf(
                (await writeProjectFile(sampleDocument(newApp()), { now: NOW })).value,
            );
            const opened = await openProjectFile(newApp(), await rezip(files, (copy) => copy.delete(entry)));
            expect(opened.isOk).toBe(false);
            expect(opened.error).toMatch(message);
        });

        test("a manifest that is not JSON", async () => {
            const files = await entriesOf(
                (await writeProjectFile(sampleDocument(newApp()), { now: NOW })).value,
            );
            const broken = await rezip(files, (copy) =>
                copy.set("manifest.json", new TextEncoder().encode("{oops")),
            );
            const opened = await openProjectFile(newApp(), broken);
            expect(opened.isOk).toBe(false);
            expect(opened.error).toMatch(/manifest\.json is not valid JSON/);
        });
    });
});

describe("project extension folders", () => {
    function historyProvider(log: Record<string, Uint8Array>[], fail = false): ProjectEntryProvider {
        return {
            prefix: "history/",
            name: "version-history",
            version: 1,
            write: async (document: IDocument) => ({
                "refs.json": JSON.stringify({ main: document.name }),
                "history/objects.pack": new Uint8Array([7, 7, 7]),
            }),
            read: async (_document: IDocument, entries: Record<string, Uint8Array>) => {
                log.push(entries);
                if (fail) throw new Error("unreadable history");
            },
        };
    }

    afterEach(() => unregisterProjectEntryProvider("history/"));

    test("a provider writes its folder, is listed in the manifest and reads it back", async () => {
        const reads: Record<string, Uint8Array>[] = [];
        registerProjectEntryProvider(historyProvider(reads));
        const files = await entriesOf((await writeProjectFile(sampleDocument(newApp()), { now: NOW })).value);
        expect(text(files.get("history/refs.json"))).toBe(JSON.stringify({ main: "Duct job" }));
        expect(files.get("history/objects.pack")).toEqual(new Uint8Array([7, 7, 7]));
        const manifest = JSON.parse(text(files.get("manifest.json"))) as ProjectManifest;
        expect(manifest.extensions).toEqual([
            { prefix: "history/", name: "version-history", version: 1, files: ["objects.pack", "refs.json"] },
        ]);
        expect(manifest.files.filter((file) => file.role === "extension").map((file) => file.path)).toEqual([
            "history/refs.json",
            "history/objects.pack",
        ]);

        const opened = await openProjectFile(newApp(), await zipProjectFiles(files, NOW));
        expect(opened.isOk).toBe(true);
        expect(reads).toHaveLength(1);
        expect(Object.keys(reads[0]).sort()).toEqual(["objects.pack", "refs.json"]);
    });

    test("the document's version history travels in history/ and is back after opening the file", async () => {
        registerProjectEntryProvider(VERSION_HISTORY_ENTRY_PROVIDER);
        const doc = sampleDocument(newApp());
        const control = DocumentVersionControl.create(doc, { persistence: new MemoryHistoryPersistence() });
        Transaction.execute(doc, "deeper", () => {
            doc.variables.setItems([{ id: "v1", name: "h", type: "length", expression: "20" }]);
        });
        control.flush();
        expect(control.createVersion("Released", "for the shop").isOk).toBe(true);
        const commits = control.log().map((entry) => entry.id);

        const bytes = (await writeProjectFile(doc, { now: NOW })).value;
        const files = await entriesOf(bytes);
        expect([...files.keys()].filter((name) => name.startsWith("history/")).sort()).toEqual([
            "history/objects.json",
            "history/refs.json",
        ]);

        const opened = await openProjectFile(newApp(), bytes);
        expect(opened.isOk).toBe(true);
        const reopened = DocumentVersionControl.of(opened.value);
        expect(reopened?.versions().map((version) => [version.name, version.description])).toEqual([
            ["Released", "for the shop"],
        ]);
        expect(reopened?.log().map((entry) => entry.id)).toEqual(commits);
    });

    test("without the provider, history/ entries (known or not) survive open and save untouched", async () => {
        registerProjectEntryProvider(historyProvider([]));
        const written = await entriesOf(
            (await writeProjectFile(sampleDocument(newApp()), { now: NOW })).value,
        );
        unregisterProjectEntryProvider("history/");
        const withUnknown = await rezip(written, (copy) =>
            copy.set("history/future.idx", new Uint8Array([9])),
        );

        const opened = await openProjectFile(newApp(), withUnknown);
        expect(opened.isOk).toBe(true);
        const resaved = await entriesOf((await writeProjectFile(opened.value, { now: NOW })).value);
        expect(resaved.get("history/objects.pack")).toEqual(new Uint8Array([7, 7, 7]));
        expect(resaved.get("history/future.idx")).toEqual(new Uint8Array([9]));
        expect(text(resaved.get("history/refs.json"))).toBe(JSON.stringify({ main: "Duct job" }));
        const manifest = JSON.parse(text(resaved.get("manifest.json"))) as ProjectManifest;
        expect(manifest.extensions.map((entry) => [entry.prefix, entry.name, entry.files])).toEqual([
            ["history/", "version-history", ["future.idx", "objects.pack", "refs.json"]],
        ]);
    });

    test("entries a provider does not rewrite are carried over; a failed read keeps the folder verbatim", async () => {
        const zip = new JSZip();
        const files = await entriesOf((await writeProjectFile(sampleDocument(newApp()), { now: NOW })).value);
        for (const [entry, bytes] of files) zip.file(entry, bytes);
        zip.file("history/legacy.bin", new Uint8Array([5]));
        const archive = await zip.generateAsync({ type: "uint8array" });

        registerProjectEntryProvider(historyProvider([]));
        const opened = await openProjectFile(newApp(), archive);
        const resaved = await entriesOf((await writeProjectFile(opened.value, { now: NOW })).value);
        expect(resaved.get("history/legacy.bin")).toEqual(new Uint8Array([5]));
        expect(resaved.get("history/objects.pack")).toEqual(new Uint8Array([7, 7, 7]));

        registerProjectEntryProvider(historyProvider([], true));
        const failed = await openProjectFile(newApp(), archive);
        expect(failed.isOk).toBe(true);
        const kept = await entriesOf((await writeProjectFile(failed.value, { now: NOW })).value);
        expect([...kept.keys()].filter((entry) => entry.startsWith("history/"))).toEqual([
            "history/legacy.bin",
        ]);
    });

    test("a provider registered after the file was opened reads its folder before its first write", async () => {
        registerProjectEntryProvider(historyProvider([]));
        const written = await entriesOf(
            (await writeProjectFile(sampleDocument(newApp()), { now: NOW })).value,
        );
        unregisterProjectEntryProvider("history/");
        const opened = await openProjectFile(newApp(), await zipProjectFiles(written, NOW));

        const order: string[] = [];
        registerProjectEntryProvider({
            prefix: "history/",
            read: async (_document, entries) => {
                order.push(`read ${Object.keys(entries).sort().join(",")}`);
            },
            write: async () => {
                order.push("write");
                return {};
            },
        });
        await writeProjectFile(opened.value, { now: NOW });
        await writeProjectFile(opened.value, { now: NOW });
        expect(order).toEqual(["read objects.pack,refs.json", "write", "write"]);
    });

    test("reserved or malformed folders are refused at registration", () => {
        const provider = historyProvider([]);
        expect(() => registerProjectEntryProvider({ ...provider, prefix: "featurestudios/" })).toThrow(
            /reserved/,
        );
        expect(() => registerProjectEntryProvider({ ...provider, prefix: "history" })).toThrow(/Invalid/);
        expect(() => registerProjectEntryProvider({ ...provider, prefix: "../x/" })).toThrow(/Invalid/);
    });
});
