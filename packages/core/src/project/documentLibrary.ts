// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Constants } from "../constants";
import type { RecentDocumentDTO } from "../foundation/dto";
import type { IStorage } from "../foundation/storage";

export interface LibraryDocumentMetadata {
    kind: "document";
    id: string;
    folderId?: string;
    labels: string[];
    lastOpened?: number;
    trashedAt?: number;
}
export interface LibraryFolder {
    kind: "folder";
    id: string;
    name: string;
}
export interface LibraryLabel {
    kind: "label";
    id: string;
    name: string;
    color: string;
}
export type LibraryRecord = LibraryDocumentMetadata | LibraryFolder | LibraryLabel;
export interface LibraryDocument extends RecentDocumentDTO {
    metadata: LibraryDocumentMetadata;
}
export interface DocumentLibrarySnapshot {
    documents: LibraryDocument[];
    folders: LibraryFolder[];
    labels: LibraryLabel[];
}

/** Organization lives outside the model snapshot, so a save or version restore cannot undo trash/labels. */
export class DocumentLibrary {
    private static queues = new WeakMap<IStorage, Promise<unknown>>();
    constructor(private readonly storage: IStorage) {}

    async list(): Promise<DocumentLibrarySnapshot> {
        const [documents, records] = await Promise.all([
            this.all<RecentDocumentDTO>(Constants.RecentTable),
            this.all<LibraryRecord>(Constants.LibraryTable),
        ]);
        const metadata = new Map(
            records.filter((record) => record.kind === "document").map((record) => [record.id, record]),
        );
        return {
            documents: documents.map((document) => ({
                ...document,
                metadata: metadata.get(document.id) ?? { kind: "document", id: document.id, labels: [] },
            })),
            folders: records
                .filter((record) => record.kind === "folder")
                .sort((a, b) => a.name.localeCompare(b.name)),
            labels: records
                .filter((record) => record.kind === "label")
                .sort((a, b) => a.name.localeCompare(b.name)),
        };
    }

    private async all<T extends { id: string }>(table: string): Promise<T[]> {
        const records = new Map<string, T>();
        for (let page = 0; ; page++) {
            const batch = (await this.storage.page(Constants.DBName, table, page)) as T[];
            const before = records.size;
            for (const item of batch) records.set(item.id, item);
            if (records.size === before) break;
        }
        return [...records.values()];
    }

    private queue<T>(run: () => Promise<T>): Promise<T> {
        const result = (DocumentLibrary.queues.get(this.storage) ?? Promise.resolve())
            .catch(() => {})
            .then(run);
        DocumentLibrary.queues.set(
            this.storage,
            result.catch(() => {}),
        );
        return result;
    }

    update(id: string, patch: Partial<Omit<LibraryDocumentMetadata, "id" | "kind">>): Promise<void> {
        return this.queue(async () => {
            const before = (await this.storage.get(
                Constants.DBName,
                Constants.LibraryTable,
                `document:${id}`,
            )) as LibraryDocumentMetadata | undefined;
            const next: LibraryDocumentMetadata = { kind: "document", id, labels: [], ...before, ...patch };
            if (!(await this.storage.put(Constants.DBName, Constants.LibraryTable, `document:${id}`, next)))
                throw new Error("Could not save document organization.");
        });
    }

    async createFolder(name: string): Promise<LibraryFolder> {
        return this.create({ kind: "folder", id: crypto.randomUUID(), name: name.trim() });
    }
    async createLabel(name: string, color = "#4c81c5"): Promise<LibraryLabel> {
        return this.create({ kind: "label", id: crypto.randomUUID(), name: name.trim(), color });
    }
    private create<T extends LibraryFolder | LibraryLabel>(record: T): Promise<T> {
        return this.queue(async () => {
            if (!record.name) throw new Error("Enter a name.");
            const records = await this.all<LibraryRecord>(Constants.LibraryTable);
            if (
                records.some(
                    (item) =>
                        item.kind === record.kind && item.name.toLowerCase() === record.name.toLowerCase(),
                )
            )
                throw new Error(`A ${record.kind} with that name already exists.`);
            if (
                !(await this.storage.put(
                    Constants.DBName,
                    Constants.LibraryTable,
                    `${record.kind}:${record.id}`,
                    record,
                ))
            )
                throw new Error(`Could not save the ${record.kind}.`);
            return record;
        });
    }
}
