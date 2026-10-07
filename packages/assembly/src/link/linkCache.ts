// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Constants, type IShape, type IShapeConverter, type IStorage, Logger } from "@chili3d/core";
import type { LinkCacheEntry } from "./linkTypes";

/** The IndexedDB table link caches live in (created by `useIndexedDB`). */
export const LINK_CACHE_TABLE = Constants.LinkCacheTable;

/**
 * Resolved link geometry, keyed by (source document, commit, node) — immutable for a key, since
 * a commit never changes. Three layers:
 *
 * - memory: entries and their decoded shapes, shared by every consumer in the session;
 * - storage (IndexedDB `linkCache`): survives reloads and outlives the source document, so a
 *   link whose source was deleted still shows its last geometry;
 * - the consuming document's `.chili3d` file (`links/`, see `linksEntryProvider.ts`): carries
 *   the entries a document uses, so the file opens on another machine without its sources.
 */
export class LinkCache {
    private readonly entries = new Map<string, LinkCacheEntry>();
    private readonly shapes = new Map<string, IShape[]>();

    constructor(
        private readonly storage: IStorage | undefined,
        private readonly converter: () => IShapeConverter,
    ) {}

    /** The entry if it is in memory. */
    peek(key: string): LinkCacheEntry | undefined {
        return this.entries.get(key);
    }

    /** The entry from memory, else from storage. */
    async get(key: string): Promise<LinkCacheEntry | undefined> {
        const known = this.entries.get(key);
        if (known !== undefined) return known;
        if (this.storage === undefined) return undefined;
        try {
            const stored = (await this.storage.get(Constants.DBName, LINK_CACHE_TABLE, key)) as
                | LinkCacheEntry
                | undefined;
            if (stored?.key === key && Array.isArray(stored.parts)) {
                this.entries.set(key, stored);
                return stored;
            }
        } catch (error) {
            Logger.warn(`link cache: ${key} could not be read`, error);
        }
        return undefined;
    }

    /** Keeps an entry in memory and writes it through to storage. */
    async put(entry: LinkCacheEntry): Promise<void> {
        this.remember(entry);
        if (this.storage === undefined) return;
        try {
            await this.storage.put(Constants.DBName, LINK_CACHE_TABLE, entry.key, entry);
        } catch (error) {
            Logger.warn(`link cache: ${entry.key} could not be stored`, error);
        }
    }

    /** Keeps an entry in memory only (e.g. while a file's caches are read). */
    remember(entry: LinkCacheEntry): void {
        const previous = this.entries.get(entry.key);
        if (previous !== undefined && previous !== entry) this.releaseShapes(entry.key);
        this.entries.set(entry.key, entry);
    }

    /**
     * The entry's solids, decoded once and shared. Callers must not dispose them; take a
     * `transformed(...)` copy to own one.
     */
    shapesOf(key: string): IShape[] | undefined {
        const known = this.shapes.get(key);
        if (known !== undefined) return known;
        const entry = this.entries.get(key);
        if (entry === undefined) return undefined;
        const decoded: IShape[] = [];
        for (const part of entry.parts) {
            const shape = this.converter().convertFromBrep(part.brep);
            if (!shape.isOk) {
                Logger.warn(`link cache: ${entry.nodeName} could not be decoded: ${shape.error}`);
                for (const x of decoded) x.dispose();
                return undefined;
            }
            decoded.push(shape.value);
        }
        this.shapes.set(key, decoded);
        return decoded;
    }

    keys(): string[] {
        return [...this.entries.keys()];
    }

    /** Forgets the in-memory layer (storage is kept). */
    clearMemory(): void {
        for (const key of [...this.shapes.keys()]) this.releaseShapes(key);
        this.entries.clear();
    }

    private releaseShapes(key: string): void {
        const shapes = this.shapes.get(key);
        this.shapes.delete(key);
        for (const shape of shapes ?? []) shape.dispose();
    }
}
