// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Cross-document links against real geometry and a real saved history: a source document
 * with a box, saved to an in-memory IndexedDB stand-in; a consumer document linking it pinned
 * to a version and following its branch. Editing and saving the source moves only the
 * following link; a new version flags the pinned one; changing version swaps the shape; a
 * deleted source leaves the cached geometry; and a `.chili3d` round trip carries the cache to
 * a machine without the source.
 */

import {
    BoxNode,
    buildProjectFiles,
    readProjectFile,
    restoreProjectState,
    zipProjectFiles,
} from "@chili3d/app";
import {
    Constants,
    type IFace,
    Matrix4,
    Plane,
    PubSub,
    readTree,
    registerProjectEntryProvider,
    StorageHistoryPersistence,
    snapshotToSerialized,
    Transaction,
    unregisterProjectEntryProvider,
    VERSION_HISTORY_ENTRY_PROVIDER,
} from "@chili3d/core";
import { importSourceProject } from "../src/link/importSource";
import { LinkedPartNode } from "../src/link/linkedPartNode";
import { linkService, setLinkService } from "../src/link/linkRegistry";
import { createLinksEntryProvider, LINKS_FOLDER } from "../src/link/linksEntryProvider";
import type { PartLinkService } from "../src/link/partLinkService";
import { AssemblyNode } from "../src/model/assemblyNode";
import { connectorFromSubShape, subShapesOf } from "../src/model/connectors";
import { evaluateAssembly } from "../src/model/evaluate";
import { insertInstance } from "../src/model/insert";
import { solveAssembly } from "../src/model/solve";
import "../src/versioning";

const round = (x: number) => Math.round(x * 1e6) / 1e6;

import {
    createApp,
    initKernel,
    installService,
    MemoryStorage,
    newDocument,
    type SavableDocument,
    save,
    settle,
    versioned,
} from "./helpers";

beforeAll(initKernel);

const SOURCE = "source-doc";

function volumeOf(node: LinkedPartNode): number {
    expect(node.shape.isOk).toBe(true);
    return node.shape.unchecked()!.volume();
}

describe("cross-document links (kernel)", () => {
    let storage: MemoryStorage;
    let service: PartLinkService;
    let source: SavableDocument;
    let box: BoxNode;
    let sourceVc: ReturnType<typeof versioned>;

    beforeEach(async () => {
        storage = new MemoryStorage();
        const app = createApp(storage);
        service = installService(storage, app, true);
        source = newDocument(app, SOURCE, "Bracket library");
        sourceVc = versioned(source, storage);
        box = new BoxNode({ document: source, plane: Plane.XY, dx: 10, dy: 10, dz: 10 });
        Transaction.execute(source, "box", () => {
            box.name = "Block";
            source.modelManager.addNode(box);
        });
        await settle();
        expect(sourceVc.createVersion("V1").isOk).toBe(true);
        await save(source, storage, sourceVc);
    });

    afterEach(() => {
        service.dispose();
        setLinkService(undefined);
    });

    async function consumer(id = "consumer-doc") {
        const doc = newDocument(source.application, id, "Machine");
        const vc = versioned(doc, storage);
        const insert = async (version: Parameters<PartLinkService["resolveNew"]>[2]) => {
            const resolved = await service.resolveNew(SOURCE, box.id, version);
            expect(resolved.isOk).toBe(true);
            const node = new LinkedPartNode({ document: doc, link: resolved.unchecked()!.link });
            Transaction.execute(doc, "insert linked part", () => doc.modelManager.addNode(node));
            await service.settled();
            return node;
        };
        return { doc, vc, insert };
    }

    async function editSourceDepth(dz: number) {
        Transaction.execute(source, "depth", () => {
            box.dz = dz;
        });
        await settle();
        await save(source, storage, sourceVc);
        PubSub.default.pub("documentSaved", source);
        await service.settled();
    }

    test("a pinned version stays, a branch link follows each save of the source", async () => {
        const { vc, insert } = await consumer();
        const pinned = await insert({ kind: "version", name: "V1" });
        const following = await insert({ kind: "branch", name: "Main" });
        expect(volumeOf(pinned)).toBeCloseTo(1000, 6);
        expect(volumeOf(following)).toBeCloseTo(1000, 6);
        expect(pinned.linkState.status).toBe("ok");
        expect(pinned.link!.versionLabel).toBe("V1");

        await editSourceDepth(20);
        expect(volumeOf(following)).toBeCloseTo(2000, 6);
        expect(volumeOf(pinned)).toBeCloseTo(1000, 6);
        // A microversion of the source is no new version: the pinned link has nothing to offer.
        expect(pinned.linkState.status).toBe("ok");
        // The follow-up is a recorded change of the consuming document.
        await settle();
        expect(vc.headCommit().message).toBe("Update linked part");
        expect(vc.headCommit().summary.join("\n")).toContain("source commit");

        expect(sourceVc.createVersion("V2").isOk).toBe(true);
        await save(source, storage, sourceVc);
        PubSub.default.pub("documentSaved", source);
        await service.settled();
        expect(pinned.linkState.status).toBe("updateAvailable");
        expect(pinned.linkState.update?.label).toBe("V2");
        expect(pinned.warningCount).toBe(1);

        expect(await service.updateToLatest(pinned, "link")).toBe(true);
        expect(pinned.link!.version).toEqual({ kind: "version", name: "V2" });
        expect(volumeOf(pinned)).toBeCloseTo(2000, 6);
        expect(pinned.linkState.status).toBe("ok");
    });

    test("changing the version swaps the shape, and undo swaps it back", async () => {
        await editSourceDepth(30);
        const { doc, insert } = await consumer();
        const following = await insert({ kind: "branch", name: "Main" });
        expect(volumeOf(following)).toBeCloseTo(3000, 6);

        expect(await service.changeVersion(following, "link", { kind: "version", name: "V1" })).toBe(true);
        expect(volumeOf(following)).toBeCloseTo(1000, 6);
        expect(following.link!.version).toEqual({ kind: "version", name: "V1" });

        doc.history.undo();
        await service.settled();
        expect(following.link!.version).toEqual({ kind: "branch", name: "Main" });
        expect(volumeOf(following)).toBeCloseTo(3000, 6);

        // A commit pin offers the branch head once the branch moves on.
        const commit = sourceVc.head;
        expect(await service.changeVersion(following, "link", { kind: "commit", id: commit })).toBe(true);
        await editSourceDepth(40);
        expect(following.linkState.status).toBe("updateAvailable");
        expect(volumeOf(following)).toBeCloseTo(3000, 6);
    });

    test("a deleted source shows a broken link with the cached geometry", async () => {
        const { doc, insert } = await consumer();
        await insert({ kind: "version", name: "V1" });
        const saved = doc.serialize();

        // The source disappears from this browser.
        await new StorageHistoryPersistence(storage).remove(SOURCE);
        await storage.delete(Constants.DBName, Constants.DocumentTable, SOURCE);
        service.dispose();
        service = installService(storage, createApp(storage));

        const reopened = newDocument(source.application, "consumer-doc", "Machine");
        reopened.history.disabled = true;
        await reopened.modelManager.deserialize(saved["models"]);
        reopened.history.disabled = false;
        await service.settled();
        const node = reopened.modelManager.findNode((x) => x instanceof LinkedPartNode) as LinkedPartNode;
        expect(node.linkState.status).toBe("broken");
        expect(node.linkState.fromCache).toBe(true);
        expect(node.warningCount).toBe(1);
        expect(volumeOf(node)).toBeCloseTo(1000, 6);

        // Without the cache table too, nothing can be shown — but the link is kept.
        storage.clearTable(Constants.LinkCacheTable);
        service.dispose();
        service = installService(storage, createApp(storage));
        const bare = newDocument(source.application, "consumer-doc", "Machine");
        await bare.modelManager.deserialize(saved["models"]);
        await service.settled();
        const orphan = bare.modelManager.findNode((x) => x instanceof LinkedPartNode) as LinkedPartNode;
        expect(orphan.linkState.status).toBe("broken");
        expect(orphan.shape.isOk).toBe(false);
        expect(orphan.link!.documentId).toBe(SOURCE);
    });

    test("the link cache travels in the .chili3d file and opens without the source", async () => {
        const { doc, insert } = await consumer();
        const node = await insert({ kind: "version", name: "V1" });
        node.transform = node.transform.multiply(Matrix4.fromTranslation(50, 0, 0));
        registerProjectEntryProvider(createLinksEntryProvider(() => linkService()));
        try {
            const files = await buildProjectFiles(doc, { thumbnail: new Uint8Array() });
            expect(files.isOk).toBe(true);
            const paths = [...files.unchecked()!.keys()];
            expect(paths).toContain(`${LINKS_FOLDER}index.json`);
            expect(paths.some((p) => p.startsWith(LINKS_FOLDER) && p.endsWith(".brep"))).toBe(true);
            const bytes = await zipProjectFiles(files.unchecked()!);

            // Another machine: no source, no cache.
            const elsewhere = new MemoryStorage();
            service.dispose();
            service = installService(elsewhere, createApp(elsewhere));
            const project = await readProjectFile(bytes);
            expect(project.isOk).toBe(true);
            const opened = newDocument(createApp(elsewhere), "consumer-doc", "Machine");
            opened.history.disabled = true;
            await opened.modelManager.deserialize(project.unchecked()!.document["models"]);
            opened.history.disabled = false;
            await restoreProjectState(opened, project.unchecked()!);
            await service.settled();
            const linked = opened.modelManager.findNode((x) => x instanceof LinkedPartNode) as LinkedPartNode;
            expect(volumeOf(linked)).toBeCloseTo(1000, 6);
            expect(linked.transform.translationPart().x).toBeCloseTo(50, 9);
            expect(linked.linkState.status).toBe("broken");
            expect(linked.linkState.fromCache).toBe(true);
            // The cache was also stored in this browser's link cache.
            expect([...elsewhere.data.keys()].some((k) => k.startsWith(`${Constants.LinkCacheTable}/`))).toBe(
                true,
            );
        } finally {
            unregisterProjectEntryProvider(LINKS_FOLDER);
        }
    });

    test("an assembly can be linked: its placed parts come along, counted in the BOM by source", async () => {
        const assembly = new AssemblyNode({ document: source, name: "Pair" });
        Transaction.execute(source, "assembly", () => source.modelManager.addNode(assembly));
        insertInstance(assembly, { kind: "part", nodeId: box.id }, "Block");
        insertInstance(assembly, { kind: "part", nodeId: box.id }, "Block");
        await settle();
        expect(assembly.instances.map((x) => x.name)).toEqual(["Block <1>", "Block <2>"]);
        await save(source, storage, sourceVc);
        PubSub.default.pub("documentSaved", source);
        await service.settled();

        const { doc } = await consumer();
        const resolved = await service.resolveNew(SOURCE, assembly.id, { kind: "branch", name: "Main" });
        expect(resolved.isOk).toBe(true);
        expect(resolved.unchecked()!.entry.kind).toBe("assembly");
        expect(resolved.unchecked()!.entry.parts).toHaveLength(2);
        const node = new LinkedPartNode({ document: doc, link: resolved.unchecked()!.link });
        Transaction.execute(doc, "insert", () => doc.modelManager.addNode(node));
        await service.settled();
        expect(volumeOf(node)).toBeCloseTo(2000, 6);
        const keys = new Set(resolved.unchecked()!.entry.parts.map((p) => p.bomKey));
        expect(keys.size).toBe(1);
    });

    test("a linked instance follows its source: link, mate connectors and placement in one step", async () => {
        const { doc } = await consumer();
        const plate = new BoxNode({ document: doc, plane: Plane.XY, dx: 40, dy: 40, dz: 10 });
        const assembly = new AssemblyNode({ document: doc, name: "Assembly 1" });
        Transaction.execute(doc, "setup", () => doc.modelManager.addNode(plate, assembly));
        const resolved = await service.resolveNew(SOURCE, box.id, { kind: "branch", name: "Main" });
        const base = insertInstance(assembly, { kind: "part", nodeId: plate.id }, "Plate");
        const block = insertInstance(assembly, { kind: "link", link: resolved.unchecked()!.link }, "Block", {
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 70, 0, 0, 1],
        });
        await service.settled();
        const parts = () => evaluateAssembly(doc, assembly).parts;
        const topFace = (instanceId: string) => {
            const part = parts().find((p) => p.instanceId === instanceId)!;
            const faces = subShapesOf(part.shape, "face");
            const index = faces.findIndex((face) => {
                const [point, normal] = (face as IFace).normal(0, 0);
                return (
                    normal.normalize()!.z > 1 - 1e-9 &&
                    Math.abs(point.z - part.shape.boundingBox().max.z) < 1e-6
                );
            });
            expect(index).toBeGreaterThanOrEqual(0);
            return connectorFromSubShape(part, faces[index], index)!;
        };
        // The block stands upside down on the plate: its top face against the plate's.
        Transaction.execute(doc, "mate", () => {
            assembly.addMate({
                id: "m",
                name: "m",
                type: "fastened",
                a: topFace(base.id),
                b: topFace(block.id),
            });
            solveAssembly(assembly);
        });
        const extent = () => {
            const part = parts().find((p) => p.instanceId === block.id)!;
            const bounds = part.shape.transformed(part.placement).boundingBox();
            return [round(bounds.min.z), round(bounds.max.z)];
        };
        expect(extent()).toEqual([10, 20]);

        await editSourceDepth(25);
        const link = () =>
            (assembly.instance(block.id)!.source as { link: { resolvedCommit?: string } }).link;
        expect(link().resolvedCommit).toBe(sourceVc.head);
        // The connector moved with the grown face, and the block still stands on the plate.
        expect(assembly.mates[0].b.origin[2]).toBeCloseTo(25, 6);
        expect(extent()).toEqual([10, 35]);

        // One undo takes back the update, the re-anchored connector and the placement.
        doc.history.undo();
        await service.settled();
        expect(link().resolvedCommit).not.toBe(sourceVc.head);
        expect(assembly.mates[0].b.origin[2]).toBeCloseTo(10, 6);
        expect(extent()).toEqual([10, 20]);
    });

    test("a .chili3d file imported as a source links at any of its versions", async () => {
        await editSourceDepth(20);
        registerProjectEntryProvider(VERSION_HISTORY_ENTRY_PROVIDER);
        let bytes: Uint8Array;
        try {
            const files = await buildProjectFiles(source, { thumbnail: new Uint8Array() });
            bytes = await zipProjectFiles(files.unchecked()!);
        } finally {
            unregisterProjectEntryProvider(VERSION_HISTORY_ENTRY_PROVIDER.prefix);
        }

        // A browser that never saw the library.
        const elsewhere = new MemoryStorage();
        service.dispose();
        const app = createApp(elsewhere);
        service = installService(elsewhere, app);
        const imported = await importSourceProject(app, elsewhere, bytes);
        expect(imported.isOk).toBe(true);
        expect(imported.unchecked()).toEqual({ id: SOURCE, name: "Bracket library" });
        expect((await service.listSourceDocuments()).map((x) => x.name)).toEqual(["Bracket library"]);

        const v1 = await service.resolveNew(SOURCE, box.id, { kind: "version", name: "V1" });
        const head = await service.resolveNew(SOURCE, box.id, { kind: "branch", name: "Main" });
        expect(v1.isOk && head.isOk).toBe(true);
        const volume = (entry: { parts: readonly { brep: string }[] }) =>
            shapeConverter.convertFromBrep(entry.parts[0].brep).unchecked()!.volume();
        expect(volume(v1.unchecked()!.entry)).toBeCloseTo(1000, 6);
        expect(volume(head.unchecked()!.entry)).toBeCloseTo(2000, 6);
        // The imported history is the source's own: same commits.
        expect(head.unchecked()!.link.resolvedCommit).toBe(sourceVc.head);
    });

    test("lists saved documents and the linkable nodes of a commit", async () => {
        const archive = await new StorageHistoryPersistence(storage).load(SOURCE);
        expect(archive).toBeDefined();
        const serialized = snapshotToSerialized(
            readTree(sourceVc.store, sourceVc.headCommit().tree),
            SOURCE,
            "x",
        );
        expect(serialized["name"]).toBe("Bracket library");
        const listed = await service.listSourceDocuments();
        expect(listed.map((x) => x.id)).toEqual([SOURCE]);
        const nodes = await service.listSourceNodes(SOURCE, sourceVc.head);
        expect(nodes.unchecked()!.map((x) => [x.name, x.kind])).toEqual([["Block", "part"]]);
    });
});
