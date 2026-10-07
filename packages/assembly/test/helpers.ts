// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    Constants,
    DocumentVersionControl,
    FolderNode,
    type IApplication,
    type IStorage,
    type IVisual,
    Material,
    type Serialized,
    StorageHistoryPersistence,
} from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, OccShapeConverter, ShapeFactory } from "@chili3d/wasm";
import { setLinkService } from "../src/link/linkRegistry";
import { PartLinkService } from "../src/link/partLinkService";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
);

export async function initKernel(): Promise<void> {
    await initWasm({ wasmBinary: WASM_BINARY });
    const factory = new ShapeFactory();
    const converter = new OccShapeConverter();
    for (const [name, value] of [
        ["shapeFactory", factory],
        ["shapeConverter", converter],
    ] as const) {
        Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    }
}

/** An `IStorage` over a Map — what IndexedDB holds, per table and key. */
export class MemoryStorage implements IStorage {
    readonly data = new Map<string, unknown>();

    async createDBIfNeeded(): Promise<void> {}

    async get(_database: string, table: string, id: string): Promise<unknown> {
        return structuredClone(this.data.get(`${table}/${id}`));
    }

    async put(_database: string, table: string, id: string, value: unknown): Promise<boolean> {
        this.data.set(`${table}/${id}`, structuredClone(value));
        return true;
    }

    async delete(_database: string, table: string, id: string): Promise<boolean> {
        return this.data.delete(`${table}/${id}`);
    }

    async page(_database: string, table: string, page: number): Promise<unknown[]> {
        const items = [...this.data.entries()]
            .filter(([key]) => key.startsWith(`${table}/`))
            .map(([, v]) => v);
        return structuredClone(items.slice(page * 20, page * 20 + 20));
    }

    /** Drops every key of a table. */
    clearTable(table: string): void {
        for (const key of [...this.data.keys()]) if (key.startsWith(`${table}/`)) this.data.delete(key);
    }
}

/** A test document that serializes like the app's `Document` (what saves and project files write). */
export class SavableDocument extends TestDocument {
    override serialize(): Serialized {
        return {
            __cla$$__: "Document",
            version: __DOCUMENT_VERSION__,
            id: this.id,
            name: this.name,
            models: this.modelManager.serialize(),
            variables: this.variables.items,
            acts: [],
            userData: this.userData ?? {},
        };
    }
}

export function createApp(storage: IStorage): IApplication {
    return createMockApplication({
        storage,
        shapeProvider: { factory: globalThis.shapeFactory, converter: globalThis.shapeConverter },
    });
}

export function newDocument(app: IApplication, id: string, name = id): SavableDocument {
    const doc = new SavableDocument({ application: app });
    doc.id = id;
    doc.name = name;
    doc.visual = createMockVisualWithDocument(doc) as unknown as IVisual;
    doc.modelManager.rootNode = new FolderNode({ document: doc, name, id: `${id}-root` });
    doc.modelManager.materials.push(new Material({ document: doc, name: "Gray", color: 0xcccccc }));
    return doc;
}

/** Versions a document with its history kept in `storage`, as the app does. */
export function versioned(doc: SavableDocument, storage: IStorage): DocumentVersionControl {
    return DocumentVersionControl.create(doc, { persistence: new StorageHistoryPersistence(storage) });
}

/** What `Document.save` does: the document, its history, the recent list — then `documentSaved`. */
export async function save(
    doc: SavableDocument,
    storage: IStorage,
    control: DocumentVersionControl,
): Promise<void> {
    await storage.put(Constants.DBName, Constants.DocumentTable, doc.id, doc.serialize());
    await control.persist();
    await storage.put(Constants.DBName, Constants.RecentTable, doc.id, {
        id: doc.id,
        name: doc.name,
        date: Date.now(),
    });
}

export function installService(storage: IStorage, app: IApplication, followSaves = false): PartLinkService {
    const service = new PartLinkService({
        storage,
        application: app,
        converter: () => globalThis.shapeConverter,
        followSaves,
    });
    setLinkService(service);
    return service;
}

export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
