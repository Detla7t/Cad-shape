// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { canonicalJson, contentHash } from "./hash";
import type { ObjectHash, TextObj, VcsObject } from "./objects";
import { applyDelta, type DeltaOp, encodeDelta } from "./textDiff";

/**
 * How an object is kept physically: whole, or — for text — as a line delta against another
 * text object. The object's hash is always that of its full content, so a delta is invisible to
 * everything above the store.
 */
export type StoredRecord =
    | { readonly o: VcsObject }
    | { readonly d: { readonly base: ObjectHash; readonly ops: readonly DeltaOp[]; readonly depth: number } };

/**
 * Content-addressed object storage. Reads are synchronous — diff, merge and capture run inside
 * the edit that triggers them — so persistent implementations keep the working set in memory and
 * write behind (see `historyStorage.ts`).
 */
export interface IObjectStore {
    has(hash: ObjectHash): boolean;
    get(hash: ObjectHash): VcsObject | undefined;
    /**
     * Stores `object` and returns its hash; an object already present is not stored again.
     * `deltaBase` names the previous version of the same text — the store may keep the new
     * text as a line delta against it.
     */
    put(object: VcsObject, deltaBase?: ObjectHash): ObjectHash;
    /** The physical record of an object (for persistence). */
    record(hash: ObjectHash): StoredRecord | undefined;
    /** Adds a record read back from persistence; an existing one is kept. */
    importRecord(hash: ObjectHash, record: StoredRecord): void;
    hashes(): IterableIterator<ObjectHash>;
    readonly size: number;
}

/** Longest chain of deltas a text is rebuilt through before the store keeps it whole again. */
export const MAX_DELTA_CHAIN = 16;
/** A delta is kept only when it is at most this fraction of the full text's size. */
const DELTA_RATIO = 0.6;
/** Texts shorter than this are always stored whole — a delta would not pay for itself. */
const MIN_DELTA_TEXT = 256;
const TEXT_CACHE_SIZE = 64;

export interface ObjectStoreStats {
    readonly objects: number;
    readonly deltas: number;
    /** Canonical JSON size of all records — what persisting the store writes. */
    readonly bytes: number;
}

export class MemoryObjectStore implements IObjectStore {
    private readonly records = new Map<ObjectHash, StoredRecord>();
    private readonly sizes = new Map<ObjectHash, number>();
    /** Recently rebuilt delta texts, oldest first. */
    private readonly texts = new Map<ObjectHash, string>();
    /** Hashes written since the last `takeUnsaved` — what a persistent store must flush. */
    private readonly unsaved = new Set<ObjectHash>();

    get size(): number {
        return this.records.size;
    }

    has(hash: ObjectHash): boolean {
        return this.records.has(hash);
    }

    hashes(): IterableIterator<ObjectHash> {
        return this.records.keys();
    }

    record(hash: ObjectHash): StoredRecord | undefined {
        return this.records.get(hash);
    }

    get(hash: ObjectHash): VcsObject | undefined {
        const record = this.records.get(hash);
        if (record === undefined) return undefined;
        if ("o" in record) return record.o;
        return { t: "text", s: this.text(hash, record.d) };
    }

    put(object: VcsObject, deltaBase?: ObjectHash): ObjectHash {
        const json = canonicalJson(object);
        const hash = contentHash(json);
        if (this.records.has(hash)) return hash;
        let record: StoredRecord = { o: object };
        let size = json.length;
        if (object.t === "text" && deltaBase !== undefined && deltaBase !== hash) {
            const delta = this.tryDelta(object, deltaBase, json.length);
            if (delta !== undefined) {
                record = delta.record;
                size = delta.size;
            }
        }
        this.records.set(hash, record);
        this.sizes.set(hash, size);
        this.unsaved.add(hash);
        return hash;
    }

    importRecord(hash: ObjectHash, record: StoredRecord): void {
        if (this.records.has(hash)) return;
        this.records.set(hash, record);
        this.sizes.set(hash, canonicalJson(record).length);
    }

    /** Hashes written since the previous call; the set is cleared. */
    takeUnsaved(): ObjectHash[] {
        const hashes = [...this.unsaved];
        this.unsaved.clear();
        return hashes;
    }

    /** Puts hashes back after a failed flush, so the next one retries them. */
    restoreUnsaved(hashes: Iterable<ObjectHash>): void {
        for (const hash of hashes) this.unsaved.add(hash);
    }

    /** The stored size of one object (a delta record's size for a delta text). */
    recordSize(hash: ObjectHash): number {
        return this.sizes.get(hash) ?? 0;
    }

    stats(): ObjectStoreStats {
        let deltas = 0;
        let bytes = 0;
        for (const [hash, record] of this.records) {
            if ("d" in record) deltas++;
            bytes += this.sizes.get(hash) ?? 0;
        }
        return { objects: this.records.size, deltas, bytes };
    }

    private tryDelta(
        object: TextObj,
        base: ObjectHash,
        fullSize: number,
    ): { record: StoredRecord; size: number } | undefined {
        if (object.s.length < MIN_DELTA_TEXT) return undefined;
        const baseRecord = this.records.get(base);
        if (baseRecord === undefined) return undefined;
        const baseObject = this.get(base);
        if (baseObject?.t !== "text") return undefined;
        const depth = "d" in baseRecord ? baseRecord.d.depth + 1 : 1;
        if (depth > MAX_DELTA_CHAIN) return undefined;
        const ops = encodeDelta(baseObject.s, object.s);
        const record: StoredRecord = { d: { base, ops, depth } };
        const size = canonicalJson(record).length;
        if (size > fullSize * DELTA_RATIO) return undefined;
        return { record, size };
    }

    private text(hash: ObjectHash, delta: Extract<StoredRecord, { d: unknown }>["d"]): string {
        const cached = this.texts.get(hash);
        if (cached !== undefined) {
            // Refresh recency.
            this.texts.delete(hash);
            this.texts.set(hash, cached);
            return cached;
        }
        const base = this.get(delta.base);
        if (base?.t !== "text") throw new Error(`version store: delta base ${delta.base} is missing`);
        const text = applyDelta(base.s, delta.ops);
        this.texts.set(hash, text);
        if (this.texts.size > TEXT_CACHE_SIZE) {
            const oldest = this.texts.keys().next().value;
            if (oldest !== undefined) this.texts.delete(oldest);
        }
        return text;
    }
}
