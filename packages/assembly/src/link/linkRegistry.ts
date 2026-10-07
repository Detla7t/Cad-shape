// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDisposable, IDocument, IShape } from "@chili3d/core";
import type { LinkCache } from "./linkCache";
import type { LinkCacheEntry, LinkState, LinkVersionSpec, PartLinkData } from "./linkTypes";

/**
 * The seam between the nodes that HOLD links (a linked part in a Part Studio, the linked
 * instances of an assembly) and the service that resolves them. Nodes only know these
 * interfaces and the installed service, so the service can rebuild source documents — which
 * contain such nodes themselves — without an import cycle.
 */

/** One link a consumer holds; `slotId` tells its links apart (an assembly has one per linked instance). */
export interface LinkSlot {
    readonly slotId: string;
    readonly link: PartLinkData;
}

export interface ILinkConsumer {
    readonly document: IDocument;
    /** False while the consumer is not part of its document's tree (deleted, or not yet added). */
    readonly attached: boolean;
    linkSlots(): readonly LinkSlot[];
    /** Runtime state of a slot changed (resolved, update available, broken). Never recorded. */
    setLinkState(slotId: string, state: LinkState): void;
    /**
     * Moves a slot to another resolution — an auto-update, "Update to latest", "Change version".
     * A recorded change: one undo step and one microversion of the consuming document.
     */
    applyLink(slotId: string, link: PartLinkData, message: string): void;
    /** The geometry of a slot's resolved commit is now in the cache. */
    linkGeometryChanged(slotId: string): void;
}

export interface ILinkService extends IDisposable {
    readonly cache: LinkCache;
    register(consumer: ILinkConsumer): IDisposable;
    /** Resolves every slot of a consumer: loads geometry, follows branch heads, flags updates. */
    refresh(consumer: ILinkConsumer): Promise<void>;
    /** Loads a link's cached geometry for its resolved commit, rebuilding it from the source if needed. */
    loadGeometry(consumer: ILinkConsumer, slotId: string): Promise<void>;
    /** The decoded solids of a resolved link (shared; do not dispose), when cached in memory. */
    shapesOf(link: PartLinkData): { entry: LinkCacheEntry; shapes: IShape[] } | undefined;
    stateOf(consumer: ILinkConsumer, slotId: string): LinkState | undefined;
    updateToLatest(consumer: ILinkConsumer, slotId: string): Promise<boolean>;
    changeVersion(consumer: ILinkConsumer, slotId: string, version: LinkVersionSpec): Promise<boolean>;
    consumersOf(document: IDocument): ILinkConsumer[];
}

let current: ILinkService | undefined;

/** The link service the app runs with (installed by `installAssembly`); undefined in a bare core. */
export function linkService(): ILinkService | undefined {
    return current;
}

/** Installs (or with `undefined` removes) the link service; returns the previous one. */
export function setLinkService(service: ILinkService | undefined): ILinkService | undefined {
    const previous = current;
    current = service;
    return previous;
}
