// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Document } from "@chili3d/app";
import {
    Constants,
    DocumentVersionControl,
    type IDocument,
    Logger,
    PubSub,
    StorageHistoryPersistence,
} from "@chili3d/core";
import { createMockApplication } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { IndexedDBStorage } from "../src/indexedDBStorage";

let storage: IndexedDBStorage;
const documents: IDocument[] = [];

beforeEach(async () => {
    rs.stubGlobal("indexedDB", new IDBFactory());
    rs.spyOn(Logger, "error").mockImplementation(() => {});
    rs.spyOn(Logger, "warn").mockImplementation(() => {});
    storage = new IndexedDBStorage();
    await storage.createDBIfNeeded(Constants.DBName, [
        Constants.DocumentTable,
        Constants.HistoryTable,
        Constants.RecentTable,
    ]);
});

afterEach(() => {
    for (const document of documents.splice(0)) document.dispose();
    rs.unstubAllGlobals();
    rs.restoreAllMocks();
});

async function newDocument() {
    const app = Object.assign(createMockApplication(), { storage });
    const document = new Document(app, "Initial", "save-test");
    documents.push(document);
    await Document.startVersioning(document);
    return document;
}

async function reopen(document: IDocument) {
    const loaded = await Document.open(document.application, document.id);
    expect(loaded).toBeInstanceOf(Document);
    if (loaded === undefined) throw new Error("Document was not restored");
    documents.push(loaded);
    return loaded;
}

test("an aborted save preserves the document, recent entry and history; retry saves every commit", async () => {
    const document = await newDocument();
    await document.save();
    const control = DocumentVersionControl.of(document);
    expect(control).toBeDefined();
    const before = await new StorageHistoryPersistence(storage).load(document.id);
    const recent = await storage.get(Constants.DBName, Constants.RecentTable, document.id);
    document.name = "Changed";
    const original = IDBObjectStore.prototype.put;
    const put = rs.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
    ) {
        const request = original.call(this, value, key);
        if (this.name === Constants.RecentTable)
            request.addEventListener("success", () => request.transaction?.abort());
        return request;
    });
    const saved = rs.fn((_document: IDocument) => {});
    PubSub.default.sub("documentSaved", saved);
    try {
        await expect(document.save()).rejects.toMatchObject({ name: "AbortError" });
        expect(saved).not.toHaveBeenCalled();
        expect((await storage.get(Constants.DBName, Constants.DocumentTable, document.id)).name).toBe(
            "Initial",
        );
        expect(await storage.get(Constants.DBName, Constants.RecentTable, document.id)).toEqual(recent);
        expect(await new StorageHistoryPersistence(storage).load(document.id)).toEqual(before);
        put.mockRestore();
        await document.save();
        expect(saved).toHaveBeenCalledTimes(1);
        const loaded = await reopen(document);
        expect(loaded.name).toBe("Changed");
        expect(DocumentVersionControl.of(loaded)?.head).toBe(control?.head);
        expect(
            DocumentVersionControl.of(loaded)
                ?.log()
                .map((commit) => commit.id),
        ).toEqual(control?.log().map((commit) => commit.id));
    } finally {
        PubSub.default.remove("documentSaved", saved);
    }
});

test("overlapping save requests serialize and retain a coherent document/history pair", async () => {
    const document = await newDocument();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const original = storage.writeBatch.bind(storage);
    let calls = 0;
    rs.spyOn(storage, "writeBatch").mockImplementation(async (database, operations) => {
        if (++calls === 1) {
            entered.resolve();
            await resume.promise;
        }
        return original(database, operations);
    });
    const first = document.save();
    await entered.promise;
    document.name = "Second";
    const second = document.save();
    expect(calls).toBe(1);
    resume.resolve();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    const loaded = await reopen(document);
    expect(loaded.name).toBe("Second");
    expect(DocumentVersionControl.of(loaded)?.head).toBe(DocumentVersionControl.of(document)?.head);
});

test("a pending save owns its data snapshot while the live document is edited", async () => {
    const document = await newDocument();
    document.userData = { notes: { text: "saved" } };
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const original = storage.writeBatch.bind(storage);
    rs.spyOn(storage, "writeBatch").mockImplementation(async (database, operations) => {
        entered.resolve();
        await resume.promise;
        return original(database, operations);
    });
    const saving = document.save();
    await entered.promise;
    (document.userData["notes"] as { text: string }).text = "still editing";
    resume.resolve();
    await saving;
    expect((await storage.get(Constants.DBName, Constants.DocumentTable, document.id)).userData).toEqual({
        notes: { text: "saved" },
    });
});

test("a missing history pack remains recoverable and blocks overwriting the saved project", async () => {
    const document = await newDocument();
    await document.save();
    const packId = `${document.id}#pack0`;
    const pack = await storage.get(Constants.DBName, Constants.HistoryTable, packId);
    expect(pack.length).toBeGreaterThan(0);
    await storage.delete(Constants.DBName, Constants.HistoryTable, packId);
    const loaded = await reopen(document);
    expect(DocumentVersionControl.of(loaded)).toBeUndefined();
    loaded.name = "Would overwrite";
    await expect(loaded.save()).rejects.toThrow("history could not be loaded");
    expect((await storage.get(Constants.DBName, Constants.DocumentTable, loaded.id)).name).toBe("Initial");
    await storage.put(Constants.DBName, Constants.HistoryTable, packId, pack);
    await Document.startVersioning(loaded);
    await loaded.save();
    expect((await storage.get(Constants.DBName, Constants.DocumentTable, loaded.id)).name).toBe(
        "Would overwrite",
    );
});

test("a backend returning false does not emit a successful-save notification", async () => {
    const document = await newDocument();
    rs.spyOn(storage, "writeBatch").mockResolvedValue(false);
    const saved = rs.fn((_document: IDocument) => {});
    PubSub.default.sub("documentSaved", saved);
    try {
        await expect(document.save()).rejects.toThrow("Storage transaction failed");
        expect(saved).not.toHaveBeenCalled();
    } finally {
        PubSub.default.remove("documentSaved", saved);
    }
});

test.each([
    false,
    true,
])("queued history persistence preserves all records when an earlier save fails: %s", async (failFirst) => {
    const document = await newDocument();
    await document.save();
    const control = DocumentVersionControl.of(document);
    if (control === undefined) throw new Error("Version control was not attached");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const original = storage.writeBatch.bind(storage);
    let calls = 0;
    rs.spyOn(storage, "writeBatch").mockImplementation(async (database, operations) => {
        if (++calls === 1) {
            entered.resolve();
            await resume.promise;
            if (failFirst) throw new Error("first save aborted");
        }
        return original(database, operations);
    });
    document.name = "First revision";
    const first = control.persist().then(
        () => undefined,
        (error: unknown) => error,
    );
    await entered.promise;
    document.name = "Second revision";
    const second = control.persist();
    expect(calls).toBe(1);
    resume.resolve();
    expect((await first) instanceof Error).toBe(failFirst);
    await second;
    const archive = await new StorageHistoryPersistence(storage).load(document.id);
    if (archive === undefined) throw new Error("Saved history was not found");
    const hashes = new Set(archive.records.map(([hash]) => hash));
    expect(control.reachableRecords().length).toBeGreaterThan(0);
    for (const [hash] of control.reachableRecords()) expect(hashes.has(hash)).toBe(true);
    expect(archive.refs.branches.find((branch) => branch.name === control.currentBranch)?.head).toBe(
        control.head,
    );
});

test("aborted history compaction preserves the earlier packs and can be retried", async () => {
    const document = await newDocument();
    for (let index = 0; index < 24; index++) {
        document.name = `Revision ${index}`;
        await document.save();
    }
    const before = await new StorageHistoryPersistence(storage).load(document.id);
    expect((await storage.get(Constants.DBName, Constants.HistoryTable, document.id)).packs).toBe(24);
    document.name = "Compacted revision";
    const original = IDBObjectStore.prototype.put;
    const put = rs.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
    ) {
        const request = original.call(this, value, key);
        if (this.name === Constants.RecentTable)
            request.addEventListener("success", () => request.transaction?.abort());
        return request;
    });
    await expect(document.save()).rejects.toMatchObject({ name: "AbortError" });
    expect(await new StorageHistoryPersistence(storage).load(document.id)).toEqual(before);
    put.mockRestore();
    await document.save();
    expect((await storage.get(Constants.DBName, Constants.HistoryTable, document.id)).packs).toBe(1);
    expect(
        await storage.get(Constants.DBName, Constants.HistoryTable, `${document.id}#pack23`),
    ).toBeUndefined();
    const loaded = await reopen(document);
    expect(loaded.name).toBe("Compacted revision");
    expect(DocumentVersionControl.of(loaded)?.log()).toHaveLength(26);
});
