// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    DocumentVersionControl,
    exportHistory,
    FolderNode,
    type INode,
    type IStorage,
    importHistory,
    PhongMaterial,
    Serializer,
    StorageHistoryPersistence,
    Transaction,
    VERSION_HISTORY_ENTRY_PROVIDER,
} from "../../src";
import { TestDocument } from "../../test-utils";

/** IStorage over plain maps — the IndexedDB adapter's contract without a browser. */
class MapStorage implements IStorage {
    readonly tables = new Map<string, Map<string, unknown>>();
    puts = 0;
    async createDBIfNeeded(): Promise<void> {}
    private table(database: string, table: string) {
        const key = `${database}/${table}`;
        let map = this.tables.get(key);
        if (map === undefined) {
            map = new Map();
            this.tables.set(key, map);
        }
        return map;
    }
    async get(database: string, table: string, id: string) {
        return structuredClone(this.table(database, table).get(id));
    }
    async put(database: string, table: string, id: string, value: unknown) {
        this.puts++;
        this.table(database, table).set(id, structuredClone(value));
        return true;
    }
    async delete(database: string, table: string, id: string) {
        return this.table(database, table).delete(id);
    }
    async page() {
        return [];
    }
}

/** A document as `Document.load` would rebuild it: the same id and root node id every time. */
function newDocument(id = "doc-1") {
    const document = new TestDocument();
    document.id = id;
    document.name = "Doc";
    document.modelManager.rootNode = new FolderNode({ document, name: "Doc", id: `${id}-root` });
    return document;
}

function folder(document: TestDocument, name: string, id?: string) {
    return new FolderNode({ document, name, id });
}

function add(document: TestDocument, ...nodes: INode[]) {
    Transaction.execute(document, "add nodes", () => document.modelManager.rootNode.add(...nodes));
}

function names(document: TestDocument) {
    return document.modelManager.findNodes().map((x) => x.name);
}

/** Lets the microtask that captures a microversion run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("DocumentVersionControl", () => {
    let document: TestDocument;
    let vc: DocumentVersionControl;

    beforeEach(async () => {
        document = newDocument();
        vc = await DocumentVersionControl.attach(document);
    });

    afterEach(() => {
        vc.dispose();
        document.dispose();
    });

    test("starts every history with an initial commit on Main", () => {
        const log = vc.log();
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({
            message: "Document created",
            parents: [],
            branch: "Main",
            kind: "micro",
        });
        expect(DocumentVersionControl.of(document)).toBe(vc);
        expect(vc.currentBranch).toBe("Main");
    });

    describe("microversions", () => {
        test("one per completed transaction, with a semantic summary", async () => {
            add(document, folder(document, "A"));
            await settle();
            expect(vc.log()).toHaveLength(2);
            expect(vc.headCommit()).toMatchObject({
                kind: "micro",
                message: "Add nodes",
                summary: ["Added A"],
            });

            const a = document.modelManager.findNode((n) => n.name === "A")!;
            Transaction.execute(document, "rename and hide", () => {
                a.name = "B";
                a.visible = false;
            });
            await settle();
            expect(vc.log()).toHaveLength(3);
            expect(vc.headCommit().summary).toEqual(["Renamed A → B", "B › visible on → off"]);
        });

        test("edits in one tick share a microversion; an edit that changes nothing adds none", async () => {
            const a = folder(document, "A");
            add(document, a);
            a.name = "A1";
            a.name = "A2";
            await settle();
            expect(vc.log()).toHaveLength(2);
            Transaction.execute(document, "nothing", () => {});
            await settle();
            expect(vc.log()).toHaveLength(2);
        });

        test("undo and redo append microversions that return to earlier snapshots", async () => {
            const initial = vc.headCommit().tree;
            add(document, folder(document, "A"));
            await settle();
            const added = vc.headCommit().tree;

            document.history.undo();
            await settle();
            expect(vc.log()).toHaveLength(3);
            expect(vc.headCommit()).toMatchObject({
                message: "Undo add nodes",
                tree: initial,
                summary: ["Removed A"],
            });

            document.history.redo();
            await settle();
            expect(vc.log()).toHaveLength(4);
            expect(vc.headCommit()).toMatchObject({ message: "Redo add nodes", tree: added });
        });

        test("captures variables and materials", async () => {
            Transaction.execute(document, "edit variables", () =>
                document.variables.setItems([{ id: "v1", name: "w", type: "length", expression: "10" }]),
            );
            await settle();
            expect(vc.headCommit().summary).toEqual(["Variables › Added Variable w"]);
            document.modelManager.materials.push(
                new PhongMaterial({ document, name: "Steel", color: 0x888888 }),
            );
            await settle();
            expect(vc.headCommit().summary).toEqual(["Materials › Added Material Steel"]);
        });

        test("re-serializes only the nodes an edit touched", async () => {
            const nodes = Array.from({ length: 40 }, (_, i) => folder(document, `F${i}`));
            add(document, ...nodes);
            await settle();
            const spy = rs.spyOn(Serializer, "serializeObject");
            try {
                nodes[17].name = "renamed";
                await settle();
                expect(vc.headCommit().summary).toEqual(["Renamed F17 → renamed"]);
                expect(spy.mock.calls.map((call) => (call[0] as INode).name)).toEqual(["renamed"]);
            } finally {
                spy.mockRestore();
            }
        });

        test("carries state written with history off (derived data) into the next microversion", async () => {
            const a = folder(document, "A");
            const b = folder(document, "B");
            add(document, a, b);
            await settle();
            document.history.disabled = true;
            a.visible = false;
            document.history.disabled = false;
            b.name = "B2";
            await settle();
            // Structural changes (the rename) lead the summary; property details follow.
            expect(vc.headCommit().summary).toEqual(["Renamed B → B2", "A › visible on → off"]);
        });
    });

    describe("restore", () => {
        test("brings the document back as one undoable step and appends a microversion", async () => {
            const initial = vc.head;
            add(document, folder(document, "A"), folder(document, "B"));
            await settle();
            const outcome = vc.restore(initial);
            expect(names(document)).toEqual([]);
            expect(outcome.errors).toEqual([]);
            expect(outcome.commit).toBe(vc.head);
            expect(vc.headCommit()).toMatchObject({
                message: `Restored to Document created (${initial.slice(0, 7)})`,
            });
            expect(vc.headCommit().tree).toBe(vc.commit(initial).tree);
            expect(vc.log()).toHaveLength(3);

            document.history.undo();
            await settle();
            expect(names(document)).toEqual(["A", "B"]);
            expect(vc.log()).toHaveLength(4);
        });

        test("patches in place: untouched nodes keep their identity", async () => {
            const a = folder(document, "A");
            const b = folder(document, "B");
            add(document, a, b);
            await settle();
            const v1 = vc.head;
            b.name = "B2";
            add(document, folder(document, "C"));
            await settle();
            vc.restore(v1);
            expect(names(document)).toEqual(["A", "B"]);
            expect(document.modelManager.findNode((n) => n.name === "A")).toBe(a);
            expect(document.modelManager.findNode((n) => n.name === "B")).toBe(b);
        });

        test("restores structure: moves back into folders", async () => {
            const parent = folder(document, "Parent");
            const child = folder(document, "Child");
            add(document, parent, child);
            Transaction.execute(document, "nest", () => document.modelManager.rootNode.move(child, parent));
            await settle();
            const nested = vc.head;
            const root = document.modelManager.rootNode as FolderNode;
            Transaction.execute(document, "unnest", () => parent.move(child, root, parent));
            await settle();
            expect(child.parent).toBe(document.modelManager.rootNode);
            vc.restore(nested);
            expect(child.parent).toBe(parent);
        });
    });

    describe("branches", () => {
        test("switching checks out the branch head and keeps both lines of work", async () => {
            const a = folder(document, "A", "a");
            add(document, a);
            await settle();
            expect(vc.createBranch("Feature").isOk).toBe(true);
            expect(vc.currentBranch).toBe("Feature");
            a.name = "A-feature";
            await settle();

            expect(vc.switchBranch("Main").isOk).toBe(true);
            expect(names(document)).toEqual(["A"]);
            expect(document.history.undoCount()).toBe(0);
            vc.switchBranch("Feature");
            expect(names(document)).toEqual(["A-feature"]);
            expect(vc.branches().map((b) => b.name)).toEqual(["Main", "Feature"]);
        });

        test("pending edits are committed before switching", () => {
            add(document, folder(document, "A"));
            // No settle: the microversion is still pending when the switch happens.
            vc.createBranch("Feature", undefined, false);
            vc.switchBranch("Feature");
            vc.switchBranch("Main");
            expect(names(document)).toEqual(["A"]);
        });

        test("a branch from an old commit starts from that state", async () => {
            const initial = vc.head;
            add(document, folder(document, "A"));
            await settle();
            vc.createBranch("Old", initial);
            expect(names(document)).toEqual([]);
            expect(vc.currentBranch).toBe("Old");
        });
    });

    describe("versions", () => {
        test("naming the head adds a version commit the branch continues from", async () => {
            add(document, folder(document, "A"));
            await settle();
            const result = vc.createVersion("V1", "first release");
            expect(result.isOk).toBe(true);
            expect(vc.headCommit()).toMatchObject({ kind: "version", message: "V1" });
            expect(vc.versions().map((v) => [v.name, v.commit])).toEqual([["V1", vc.head]]);
            expect(vc.createVersion("V1").isOk).toBe(false);
            expect(vc.label(vc.head)).toBe("V1");
        });

        test("naming an older commit tags it", async () => {
            const initial = vc.head;
            add(document, folder(document, "A"));
            await settle();
            const head = vc.head;
            expect(vc.createVersion("Start", "", initial).isOk).toBe(true);
            expect(vc.versions()[0].commit).toBe(initial);
            expect(vc.head).toBe(head);
        });
    });

    describe("merge", () => {
        test("merges another branch's changes and records both parents", async () => {
            const a = folder(document, "A", "a");
            add(document, a);
            await settle();
            vc.createBranch("Feature");
            add(document, folder(document, "B", "b"));
            await settle();
            const feature = vc.head;
            vc.switchBranch("Main");
            document.modelManager.findNode((n) => n.id === "a")!.name = "A-main";
            await settle();
            const main = vc.head;

            const preview = vc.previewMerge(feature);
            expect(preview.upToDate).toBe(false);
            expect(preview.conflicts).toEqual([]);
            expect(preview.incoming.nodes.map((n) => `${n.status} ${n.name}`)).toEqual(["added B"]);
            const outcome = vc.merge(preview);
            expect(outcome.isOk).toBe(true);
            expect(names(document)).toEqual(["A-main", "B"]);
            expect(vc.headCommit()).toMatchObject({ kind: "merge", parents: [main, feature] });

            expect(vc.previewMerge(feature).upToDate).toBe(true);
            document.history.undo();
            await settle();
            expect(names(document)).toEqual(["A-main"]);
        });

        test("settles conflicts as chosen", async () => {
            add(document, folder(document, "A", "a"));
            await settle();
            vc.createBranch("Feature");
            document.modelManager.findNode((n) => n.id === "a")!.name = "theirs";
            await settle();
            const feature = vc.head;
            vc.switchBranch("Main");
            document.modelManager.findNode((n) => n.id === "a")!.name = "ours";
            await settle();
            const preview = vc.previewMerge(feature);
            expect(preview.conflicts).toEqual([
                expect.objectContaining({ id: "node/a/name", kind: "value", ours: "ours", theirs: "theirs" }),
            ]);
            vc.merge(preview, new Map([["node/a/name", "theirs"]]));
            expect(names(document)).toEqual(["theirs"]);
        });

        test("refuses a stale preview", async () => {
            add(document, folder(document, "A"));
            await settle();
            vc.createBranch("Feature");
            add(document, folder(document, "B"));
            await settle();
            const feature = vc.head;
            vc.switchBranch("Main");
            const preview = vc.previewMerge(feature);
            add(document, folder(document, "C"));
            await settle();
            expect(vc.merge(preview).isOk).toBe(false);
        });
    });

    describe("persistence", () => {
        test("round-trips through the IndexedDB adapter, appending one pack per save", async () => {
            const storage = new MapStorage();
            const persistence = new StorageHistoryPersistence(storage);
            const doc = newDocument("persisted");
            const control = await DocumentVersionControl.attach(doc, { persistence });
            add(doc, folder(doc, "A", "a"));
            await settle();
            control.createVersion("V1");
            await control.persist();
            control.createBranch("Feature");
            add(doc, folder(doc, "B", "b"));
            await settle();
            await control.persist();
            const table = storage.tables.get("chili3d-db/history")!;
            expect([...table.keys()].sort()).toEqual(["persisted", "persisted#pack0", "persisted#pack1"]);

            const reopened = newDocument("persisted");
            reopened.modelManager.rootNode.add(folder(reopened, "A", "a"), folder(reopened, "B", "b"));
            const loaded = await DocumentVersionControl.attach(reopened, { persistence });
            expect(loaded.log().map((c) => c.id)).toEqual(control.log().map((c) => c.id));
            expect(loaded.currentBranch).toBe("Feature");
            expect(loaded.versions().map((v) => v.name)).toEqual(["V1"]);
            // The reopened document matches the saved head: no synchronization commit.
            expect(loaded.head).toBe(control.head);
            loaded.dispose();
            control.dispose();
        });

        test("a document edited outside its history gets a synchronizing microversion", async () => {
            const persistence = new StorageHistoryPersistence(new MapStorage());
            const doc = newDocument("sync");
            const control = await DocumentVersionControl.attach(doc, { persistence });
            await control.persist();
            const reopened = newDocument("sync");
            reopened.modelManager.rootNode.add(folder(reopened, "Edited elsewhere"));
            const loaded = await DocumentVersionControl.attach(reopened, { persistence });
            expect(loaded.log()).toHaveLength(2);
            expect(loaded.headCommit()).toMatchObject({
                message: "Synchronized with the saved document",
                summary: ["Added Edited elsewhere"],
            });
            loaded.dispose();
            control.dispose();
        });

        test("round-trips through exported entries", async () => {
            add(document, folder(document, "A", "a"));
            await settle();
            vc.createVersion("V1");
            vc.createBranch("Feature");
            const entries = exportHistory(document);
            expect(Object.keys(entries).sort()).toEqual(["objects.json", "refs.json"]);

            const copy = newDocument();
            copy.modelManager.rootNode.add(folder(copy, "A", "a"));
            const control = await DocumentVersionControl.attach(copy);
            const encoded = Object.fromEntries(
                Object.entries(entries).map(([k, v]) => [k, new TextEncoder().encode(v as string)]),
            );
            expect(importHistory(copy, encoded).isOk).toBe(true);
            expect(control.log().map((c) => c.id)).toEqual(vc.log().map((c) => c.id));
            expect(control.currentBranch).toBe("Feature");
            expect(control.versions().map((v) => v.name)).toEqual(["V1"]);
            control.dispose();
            copy.dispose();
        });

        test("export keeps only reachable objects", async () => {
            add(document, folder(document, "A"));
            await settle();
            const reachable = new Set(vc.reachableRecords().map(([hash]) => hash));
            expect(reachable.has(vc.head)).toBe(true);
            expect(reachable.size).toBeLessThanOrEqual(vc.store.size);
            const objects = JSON.parse(exportHistory(document)["objects.json"] as string) as [
                string,
                unknown,
            ][];
            expect(new Set(objects.map(([hash]) => hash))).toEqual(reachable);
        });

        test("plugs into a project file's extension folder", async () => {
            add(document, folder(document, "A", "a"));
            await settle();
            const files = await VERSION_HISTORY_ENTRY_PROVIDER.write(document);
            expect(VERSION_HISTORY_ENTRY_PROVIDER.prefix).toBe("history/");

            const copy = newDocument();
            copy.modelManager.rootNode.add(folder(copy, "A", "a"));
            const control = await DocumentVersionControl.attach(copy);
            const bytes = Object.fromEntries(
                Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v as string)]),
            );
            await VERSION_HISTORY_ENTRY_PROVIDER.read(copy, bytes);
            expect(control.head).toBe(vc.head);
            // A file without history leaves the document's own history alone.
            await VERSION_HISTORY_ENTRY_PROVIDER.read(copy, {});
            expect(control.head).toBe(vc.head);
            await expect(VERSION_HISTORY_ENTRY_PROVIDER.read(copy, { "refs.json": "{}" })).rejects.toThrow();
            control.dispose();
            copy.dispose();
        });

        test("rejects entries that are not a history", () => {
            expect(importHistory(document, { "refs.json": "{}", "objects.json": "[]" }).isOk).toBe(false);
            expect(importHistory(document, {}).isOk).toBe(false);
        });
    });
});
