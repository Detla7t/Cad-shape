// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Constants, DocumentLibrary, type IStorage, type RecentDocumentDTO } from "../src";
import { createMockApplication } from "../test-utils";

function libraryStorage() {
    const records = new Map<string, unknown>();
    const storage: IStorage = createMockApplication({
        storage: {
            get: async (_db, table, id) => structuredClone(records.get(`${table}/${id}`)),
            put: async (_db, table, id, value) => {
                records.set(`${table}/${id}`, structuredClone(value));
                return true;
            },
            page: async (_db, table, page) =>
                [...records]
                    .filter(([key]) => key.startsWith(`${table}/`))
                    .slice(page * 20, (page + 1) * 20)
                    .map(([, value]) => structuredClone(value)),
        },
    }).storage;
    return { records, storage, library: new DocumentLibrary(storage) };
}

test("loads every document page and leaves existing unorganized documents intact", async () => {
    const { storage, library } = libraryStorage();
    for (let index = 0; index < 43; index++) {
        const document: RecentDocumentDTO = {
            id: `doc-${index}`,
            name: `Part ${index}`,
            date: index,
            image: "",
        };
        await storage.put(Constants.DBName, Constants.RecentTable, document.id, document);
    }
    const folder = await library.createFolder(" Ductwork ");
    const label = await library.createLabel("Ready");
    await library.update("doc-42", { folderId: folder.id, labels: [label.id], lastOpened: 300 });
    const snapshot = await new DocumentLibrary(storage).list();
    expect(snapshot.documents).toHaveLength(43);
    expect(snapshot.documents[0].metadata.labels).toEqual([]);
    expect(snapshot.documents[42].metadata).toMatchObject({
        folderId: folder.id,
        labels: [label.id],
        lastOpened: 300,
    });
    expect(snapshot.folders[0].name).toBe("Ductwork");
});

test("concurrent opens, labeling and trash preserve each other's metadata; restore never deletes model/history", async () => {
    const { storage, records, library } = libraryStorage();
    records.set(`${Constants.DocumentTable}/part`, { features: ["sketch", "extrude"] });
    records.set(`${Constants.HistoryTable}/part`, { commits: ["initial", "sized"] });
    await Promise.all([
        library.update("part", { labels: ["ready"], folderId: "folder" }),
        new DocumentLibrary(storage).update("part", { lastOpened: 25 }),
        library.update("part", { trashedAt: 40 }),
    ]);
    expect(await storage.get(Constants.DBName, Constants.LibraryTable, "document:part")).toMatchObject({
        labels: ["ready"],
        folderId: "folder",
        lastOpened: 25,
        trashedAt: 40,
    });
    await storage.put(Constants.DBName, Constants.RecentTable, "part", {
        id: "part",
        name: "Renamed",
        date: 50,
        image: "",
    });
    expect((await library.list()).documents[0].metadata.trashedAt).toBe(40);
    await library.update("part", { trashedAt: undefined });
    const restored = (await new DocumentLibrary(storage).list()).documents[0];
    expect(restored.metadata.trashedAt).toBeUndefined();
    expect(restored.metadata.labels).toEqual(["ready"]);
    expect(restored.name).toBe("Renamed");
    expect(records.get(`${Constants.DocumentTable}/part`)).toEqual({ features: ["sketch", "extrude"] });
    expect(records.get(`${Constants.HistoryTable}/part`)).toEqual({ commits: ["initial", "sized"] });
});

test("rejects duplicate organization names and storage failures without corrupting the queue", async () => {
    const { library, storage } = libraryStorage();
    await library.createFolder("Parts");
    await expect(library.createFolder(" parts ")).rejects.toThrow("already exists");
    await expect(library.createLabel("  ")).rejects.toThrow("Enter a name");
    await library.createLabel("Parts");
    const put = storage.put;
    storage.put = async () => false;
    await expect(library.update("part", { trashedAt: 1 })).rejects.toThrow("Could not save");
    storage.put = put;
    await library.update("part", { labels: ["ready"] });
    expect(await storage.get(Constants.DBName, Constants.LibraryTable, "document:part")).toMatchObject({
        labels: ["ready"],
    });
    expect((await library.list()).folders).toHaveLength(1);
});
