// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Constants } from "../constants";
import type { IStorage } from "../foundation/storage";
import { MemoryObjectStore, type StoredRecord } from "./objectStore";
import type { ObjectHash } from "./objects";
import type { RefsData } from "./repository";

/**
 * Where a document's history lives between sessions. The engine works on an in-memory object
 * store (reads must be synchronous); a persistence loads it whole when the document opens and
 * writes behind: each save appends the records created since the previous save.
 */
export interface HistoryArchive {
    readonly refs: RefsData;
    readonly records: readonly (readonly [ObjectHash, StoredRecord])[];
}

export interface IHistoryPersistence {
    load(documentId: string): Promise<HistoryArchive | undefined>;
    /**
     * Persists the refs and the records added since the previous save. `all` yields every
     * record still reachable — a persistence that compacts rewrites from it.
     */
    save(
        documentId: string,
        refs: RefsData,
        added: readonly (readonly [ObjectHash, StoredRecord])[],
        all: () => (readonly [ObjectHash, StoredRecord])[],
    ): Promise<void>;
    remove(documentId: string): Promise<void>;
}

export const HISTORY_FORMAT = "chili3d-history";
export const HISTORY_FORMAT_VERSION = 1;

/** Appended packs before a save rewrites everything reachable into one. */
const MAX_PACKS = 24;

interface HistoryManifest {
    readonly format: typeof HISTORY_FORMAT;
    readonly version: number;
    readonly refs: RefsData;
    readonly packs: number;
    readonly savedAt: number;
}

const packKey = (documentId: string, index: number) => `${documentId}#pack${index}`;

/**
 * IndexedDB persistence through the app's `IStorage`: under the document id a manifest (refs and
 * the pack count), under `<id>#pack<n>` the records each save appended. Every save writes its
 * pack before the manifest that lists it, so an interrupted save never leaves the manifest
 * pointing at a missing pack.
 */
export class StorageHistoryPersistence implements IHistoryPersistence {
    constructor(
        private readonly storage: IStorage,
        private readonly database = Constants.DBName,
        private readonly table = Constants.HistoryTable,
    ) {}

    async load(documentId: string): Promise<HistoryArchive | undefined> {
        const manifest = (await this.storage.get(this.database, this.table, documentId)) as
            | HistoryManifest
            | undefined;
        if (manifest?.format !== HISTORY_FORMAT || typeof manifest.packs !== "number") return undefined;
        const records: (readonly [ObjectHash, StoredRecord])[] = [];
        for (let i = 0; i < manifest.packs; i++) {
            const pack = await this.storage.get(this.database, this.table, packKey(documentId, i));
            if (Array.isArray(pack)) records.push(...(pack as [ObjectHash, StoredRecord][]));
        }
        return { refs: manifest.refs, records };
    }

    async save(
        documentId: string,
        refs: RefsData,
        added: readonly (readonly [ObjectHash, StoredRecord])[],
        all: () => (readonly [ObjectHash, StoredRecord])[],
    ): Promise<void> {
        const manifest = (await this.storage.get(this.database, this.table, documentId)) as
            | HistoryManifest
            | undefined;
        const previous = manifest?.format === HISTORY_FORMAT ? manifest.packs : 0;
        let packs = previous;
        if (previous === 0 || previous >= MAX_PACKS) {
            // First save, or compaction: one pack with everything reachable.
            await this.storage.put(this.database, this.table, packKey(documentId, 0), all());
            packs = 1;
        } else if (added.length > 0) {
            await this.storage.put(this.database, this.table, packKey(documentId, packs), [...added]);
            packs++;
        }
        const next: HistoryManifest = {
            format: HISTORY_FORMAT,
            version: HISTORY_FORMAT_VERSION,
            refs,
            packs,
            savedAt: Date.now(),
        };
        await this.storage.put(this.database, this.table, documentId, next);
        for (let i = packs; i < previous; i++) {
            await this.storage.delete(this.database, this.table, packKey(documentId, i));
        }
    }

    async remove(documentId: string): Promise<void> {
        const manifest = (await this.storage.get(this.database, this.table, documentId)) as
            | HistoryManifest
            | undefined;
        const packs = manifest?.format === HISTORY_FORMAT ? manifest.packs : 0;
        for (let i = 0; i < packs; i++)
            await this.storage.delete(this.database, this.table, packKey(documentId, i));
        await this.storage.delete(this.database, this.table, documentId);
    }
}

/** An in-memory persistence — for tests and documents that should not outlive the session. */
export class MemoryHistoryPersistence implements IHistoryPersistence {
    private readonly archives = new Map<string, { refs: RefsData; records: Map<ObjectHash, StoredRecord> }>();
    saves = 0;

    async load(documentId: string): Promise<HistoryArchive | undefined> {
        const archive = this.archives.get(documentId);
        if (archive === undefined) return undefined;
        return { refs: structuredClone(archive.refs), records: [...archive.records] };
    }

    async save(
        documentId: string,
        refs: RefsData,
        added: readonly (readonly [ObjectHash, StoredRecord])[],
    ): Promise<void> {
        const archive = this.archives.get(documentId) ?? { refs, records: new Map() };
        archive.refs = structuredClone(refs);
        for (const [hash, record] of added) archive.records.set(hash, structuredClone(record));
        this.archives.set(documentId, archive);
        this.saves++;
    }

    async remove(documentId: string): Promise<void> {
        this.archives.delete(documentId);
    }
}

// ------------------------------------------------------------------ File entries

const REFS_ENTRY = "refs.json";
const OBJECTS_ENTRY = "objects.json";

/**
 * The history as files — what a `.chili3d` project keeps under `history/`: `refs.json`
 * (branches, versions, the current branch) and `objects.json` (every reachable record).
 */
export function archiveToEntries(documentId: string, archive: HistoryArchive): Record<string, string> {
    return {
        [REFS_ENTRY]: JSON.stringify({
            format: HISTORY_FORMAT,
            version: HISTORY_FORMAT_VERSION,
            documentId,
            refs: archive.refs,
        }),
        [OBJECTS_ENTRY]: JSON.stringify(archive.records),
    };
}

/** Reads entries written by `archiveToEntries`; undefined when they are absent or not a history. */
export function entriesToArchive(
    entries: Readonly<Record<string, Uint8Array | string>>,
): HistoryArchive | undefined {
    const text = (entry: Uint8Array | string | undefined) =>
        entry === undefined ? undefined : typeof entry === "string" ? entry : new TextDecoder().decode(entry);
    const refsText = text(entries[REFS_ENTRY]);
    const objectsText = text(entries[OBJECTS_ENTRY]);
    if (refsText === undefined || objectsText === undefined) return undefined;
    const refs = JSON.parse(refsText) as { format?: string; refs?: RefsData };
    if (refs.format !== HISTORY_FORMAT || refs.refs === undefined) return undefined;
    const records = JSON.parse(objectsText) as [ObjectHash, StoredRecord][];
    if (!Array.isArray(records)) return undefined;
    return { refs: refs.refs, records };
}

/** A fresh store holding an archive's records. */
export function storeFromArchive(archive: HistoryArchive): MemoryObjectStore {
    const store = new MemoryObjectStore();
    for (const [hash, record] of archive.records) store.importRecord(hash, record);
    return store;
}
