// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument, ProjectEntryProvider } from "@chili3d/core";
import type { ILinkService } from "./linkRegistry";
import { type CachedPartData, type LinkCacheEntry, linkKeyOf } from "./linkTypes";

export const LINKS_FOLDER = "links/";
export const LINKS_FORMAT = "chili3d-links";
export const LINKS_FORMAT_VERSION = 1;
const INDEX_ENTRY = "index.json";

/** `index.json`: every cached link the document uses, with its solids' BREP files beside it. */
interface LinksIndex {
    readonly format: typeof LINKS_FORMAT;
    readonly version: number;
    readonly entries: readonly (Omit<LinkCacheEntry, "parts"> & {
        readonly parts: readonly (Omit<CachedPartData, "brep"> & { readonly path: string })[];
    })[];
}

const utf8 = (data: Uint8Array | string) =>
    typeof data === "string" ? data : new TextDecoder().decode(data);

/**
 * The `.chili3d` project folder `links/`: the cached geometry of every link the document holds
 * (linked parts and an assembly's linked instances), so the file opens — and shows its linked
 * parts — on a machine that has none of the source documents. The links keep pointing at their
 * sources; a source that is (or later becomes) available takes over again.
 */
export function createLinksEntryProvider(service: () => ILinkService | undefined): ProjectEntryProvider {
    return {
        prefix: LINKS_FOLDER,
        name: "link-cache",
        version: LINKS_FORMAT_VERSION,
        exclusive: true,
        async write(document: IDocument): Promise<Record<string, Uint8Array | string>> {
            const links = service();
            if (links === undefined) return {};
            const keys = new Set<string>();
            for (const consumer of links.consumersOf(document)) {
                if (!consumer.attached) continue;
                for (const slot of consumer.linkSlots()) {
                    const key = linkKeyOf(slot.link);
                    if (key !== undefined) keys.add(key);
                }
            }
            const files: Record<string, string> = {};
            const entries: LinksIndex["entries"][number][] = [];
            let n = 0;
            for (const key of [...keys].sort()) {
                const entry = await links.cache.get(key);
                if (entry === undefined) continue;
                n++;
                entries.push({
                    ...entry,
                    parts: entry.parts.map(({ brep, ...part }, i) => {
                        const path = `${n}-${i + 1}.brep`;
                        files[path] = brep;
                        return { ...part, path };
                    }),
                });
            }
            if (entries.length === 0) return {};
            const index: LinksIndex = { format: LINKS_FORMAT, version: LINKS_FORMAT_VERSION, entries };
            files[INDEX_ENTRY] = JSON.stringify(index, null, 2);
            return files;
        },
        async read(document: IDocument, entries: Record<string, Uint8Array>): Promise<void> {
            const links = service();
            const indexData = entries[INDEX_ENTRY];
            if (links === undefined || indexData === undefined) return;
            const index = JSON.parse(utf8(indexData)) as LinksIndex;
            if (index.format !== LINKS_FORMAT || !Array.isArray(index.entries)) {
                throw new Error("links/index.json is not a link cache");
            }
            for (const stored of index.entries) {
                const parts: CachedPartData[] = [];
                for (const { path, ...part } of stored.parts) {
                    const brep = entries[path];
                    if (brep === undefined) throw new Error(`links/${path} is missing`);
                    parts.push({ ...part, brep: utf8(brep) });
                }
                await links.cache.put({ ...stored, parts });
            }
            // Show what arrived; the sources (when reachable) are consulted as usual.
            await Promise.all(links.consumersOf(document).map((consumer) => links.refresh(consumer)));
        },
    };
}
