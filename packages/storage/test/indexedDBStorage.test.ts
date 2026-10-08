// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger } from "@chili3d/core";
import { rs } from "@rstest/core";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { IndexedDBStorage } from "../src/indexedDBStorage";

const DB = "storage-test";
let storage: IndexedDBStorage;
let factory: IDBFactory;

beforeEach(() => {
    factory = new IDBFactory();
    rs.stubGlobal("indexedDB", factory);
    rs.spyOn(Logger, "error").mockImplementation(() => {});
    storage = new IndexedDBStorage();
});

afterEach(() => {
    rs.unstubAllGlobals();
    rs.restoreAllMocks();
});

function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = factory.open(DB);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

test("creates missing stores and upgrades only when necessary", async () => {
    await storage.createDBIfNeeded(DB, ["documents"]);
    const first = await open();
    expect(first.objectStoreNames.contains("documents")).toBe(true);
    const version = first.version;
    first.close();
    await storage.createDBIfNeeded(DB, ["documents"]);
    const same = await open();
    expect(same.version).toBe(version);
    same.close();
    await storage.createDBIfNeeded(DB, ["documents", "history"]);
    const upgraded = await open();
    expect(upgraded.version).toBe(version + 1);
    expect(upgraded.objectStoreNames.contains("history")).toBe(true);
    upgraded.close();
});

test("round trips, replaces and deletes committed data", async () => {
    await storage.createDBIfNeeded(DB, ["documents"]);
    expect(await storage.put(DB, "documents", "doc", { version: 1 })).toBe(true);
    expect(await storage.get(DB, "documents", "doc")).toEqual({ version: 1 });
    expect(await storage.put(DB, "documents", "doc", { version: 2 })).toBe(true);
    expect(await storage.get(DB, "documents", "doc")).toEqual({ version: 2 });
    expect(await storage.delete(DB, "documents", "doc")).toBe(true);
    expect(await storage.get(DB, "documents", "doc")).toBeUndefined();
    expect(await storage.delete(DB, "documents", "absent")).toBe(true);
});

test("pages in IndexedDB key order and stops at the page boundary", async () => {
    await storage.createDBIfNeeded(DB, ["documents"]);
    for (let i = 24; i >= 0; i--) await storage.put(DB, "documents", String(i).padStart(2, "0"), i);
    expect(await storage.page(DB, "documents", 0)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(await storage.page(DB, "documents", 1)).toEqual([20, 21, 22, 23, 24]);
    expect(await storage.page(DB, "documents", 2)).toEqual([]);
});

test.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0xffffffff,
])("rejects invalid page %s before opening a cursor", async (page) => {
    await expect(storage.page(DB, "documents", page)).rejects.toThrow("Page must");
});

test("a successful put request followed by an abort is a failed write", async () => {
    await storage.createDBIfNeeded(DB, ["documents"]);
    await storage.put(DB, "documents", "doc", { version: 1 });
    const original = IDBObjectStore.prototype.put;
    let requestSucceeded = false;
    const spy = rs.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
    ) {
        const request = original.call(this, value, key);
        request.addEventListener("success", () => {
            requestSucceeded = true;
            request.transaction?.abort();
        });
        return request;
    });
    await expect(storage.put(DB, "documents", "doc", { version: 2 })).rejects.toMatchObject({
        name: "AbortError",
    });
    expect(requestSucceeded).toBe(true);
    spy.mockRestore();
    expect(await storage.get(DB, "documents", "doc")).toEqual({ version: 1 });
});

test("a delete request followed by an abort preserves the original record", async () => {
    await storage.createDBIfNeeded(DB, ["documents"]);
    await storage.put(DB, "documents", "doc", "preserve");
    const original = IDBObjectStore.prototype.delete;
    const spy = rs.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
        this: IDBObjectStore,
        key: IDBValidKey | IDBKeyRange,
    ) {
        const request = original.call(this, key);
        request.addEventListener("success", () => request.transaction?.abort());
        return request;
    });
    await expect(storage.delete(DB, "documents", "doc")).rejects.toMatchObject({ name: "AbortError" });
    spy.mockRestore();
    expect(await storage.get(DB, "documents", "doc")).toBe("preserve");
});

test("batches commit records across tables together", async () => {
    await storage.createDBIfNeeded(DB, ["documents", "history"]);
    expect(
        await storage.writeBatch(DB, [
            { type: "put", table: "documents", id: "doc", value: "model" },
            { type: "put", table: "history", id: "doc", value: "history" },
        ]),
    ).toBe(true);
    expect(await storage.get(DB, "documents", "doc")).toBe("model");
    expect(await storage.get(DB, "history", "doc")).toBe("history");
});

test("a clone failure aborts every earlier write in the batch", async () => {
    await storage.createDBIfNeeded(DB, ["documents", "history"]);
    await storage.put(DB, "documents", "doc", "original");
    await expect(
        storage.writeBatch(DB, [
            { type: "put", table: "documents", id: "doc", value: "changed" },
            { type: "put", table: "history", id: "doc", value: () => {} },
        ]),
    ).rejects.toMatchObject({ name: "DataCloneError" });
    expect(await storage.get(DB, "documents", "doc")).toBe("original");
    expect(await storage.get(DB, "history", "doc")).toBeUndefined();
});

test("a blocked schema upgrade rejects instead of leaving the save waiting forever", async () => {
    await storage.createDBIfNeeded(DB, ["documents"]);
    const otherTab = await open();
    const upgrade = storage.createDBIfNeeded(DB, ["documents", "history"]);
    await expect(upgrade).rejects.toThrow("blocked by another open tab");
    otherTab.close();
    // The pending upgrade can now finish; its abandoned connection must be closed.
    const reloaded = await open();
    reloaded.close();
});

test("database open exceptions reach the caller", async () => {
    rs.spyOn(factory, "open").mockImplementation(() => {
        throw new Error("storage unavailable");
    });
    await expect(storage.get(DB, "documents", "doc")).rejects.toThrow("storage unavailable");
});
