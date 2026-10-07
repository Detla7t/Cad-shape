// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Constants,
    type IApplication,
    type IDisposable,
    type IDocument,
    type INode,
    type IShape,
    type IShapeConverter,
    type IStorage,
    Logger,
    type NodeRecord,
    NodeUtils,
    PubSub,
    Result,
    ShapeNode,
    ShapeTypes,
} from "@chili3d/core";
import { evaluateAssembly, isAssemblyLike } from "../model/evaluate";
import { DetachedDocument, isDetachedDocument } from "./detachedDocument";
import { LinkCache } from "./linkCache";
import type { ILinkConsumer, ILinkService } from "./linkRegistry";
import {
    type CachedPartData,
    type LinkCacheEntry,
    type LinkState,
    type LinkVersionSpec,
    linkCacheKey,
    linkKeyOf,
    type PartLinkData,
} from "./linkTypes";
import { SourceHistory, type SourceNodeInfo } from "./sourceHistory";

/**
 * Resolves cross-document links: reads a source document's SAVED history from storage,
 * picks the commit a link's version spec names, rebuilds the linked part (or assembly) in a
 * detached copy of the source at that commit and caches its geometry. It also keeps links
 * current: when a source document is saved, links following one of its branches update
 * themselves (a recorded change of the consuming document) and pinned links re-check whether
 * a newer version exists.
 */

export interface SourceDocumentInfo {
    readonly id: string;
    readonly name: string;
    readonly date?: number;
    readonly image?: string;
}

export interface PartLinkServiceOptions {
    readonly storage: IStorage;
    /** The application detached source documents are created for. */
    readonly application: IApplication;
    readonly converter?: () => IShapeConverter;
    /** Listen to `documentSaved` and update links of the saved document (default true). */
    readonly followSaves?: boolean;
}

/** Bookkeeping per consumer: its runtime states and its serial work queue. */
interface ConsumerRecord {
    readonly states: Map<string, LinkState>;
    queue: Promise<void>;
}

const MAX_SOURCES = 8;

export class PartLinkService implements ILinkService {
    readonly cache: LinkCache;
    readonly storage: IStorage;
    readonly application: IApplication;
    private readonly consumers = new Map<ILinkConsumer, ConsumerRecord>();
    private readonly watched = new Map<IDocument, number>();
    private readonly sources = new Map<string, Promise<SourceHistory | undefined>>();
    private readonly building = new Map<string, Promise<Result<LinkCacheEntry>>>();
    private readonly listeners = new Set<() => void>();
    private disposed = false;

    constructor(private readonly options: PartLinkServiceOptions) {
        this.storage = options.storage;
        this.application = options.application;
        this.cache = new LinkCache(options.storage, options.converter ?? (() => shapeConverter));
        if (options.followSaves !== false) PubSub.default.sub("documentSaved", this.handleDocumentSaved);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        PubSub.default.remove("documentSaved", this.handleDocumentSaved);
        for (const document of this.watched.keys())
            document.modelManager.removeNodeObserver(this.handleNodes);
        this.watched.clear();
        this.consumers.clear();
        this.listeners.clear();
        this.cache.clearMemory();
    }

    /** Notified whenever some link's geometry or state changed (assembly views re-evaluate). */
    onChanged(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                Logger.warn("link service: a listener threw", error);
            }
        }
    }

    // ------------------------------------------------------------------ Consumers

    register(consumer: ILinkConsumer): IDisposable {
        if (!this.consumers.has(consumer)) {
            this.consumers.set(consumer, { states: new Map(), queue: Promise.resolve() });
            this.watch(consumer.document);
        }
        return {
            dispose: () => {
                if (!this.consumers.delete(consumer)) return;
                this.unwatch(consumer.document);
            },
        };
    }

    consumersOf(document: IDocument): ILinkConsumer[] {
        return [...this.consumers.keys()].filter((consumer) => consumer.document === document);
    }

    stateOf(consumer: ILinkConsumer, slotId: string): LinkState | undefined {
        return this.consumers.get(consumer)?.states.get(slotId);
    }

    /** Consumers are resolved when they join their document's tree (load, insert, redo). */
    private watch(document: IDocument): void {
        const count = this.watched.get(document) ?? 0;
        if (count === 0) document.modelManager.addNodeObserver(this.handleNodes);
        this.watched.set(document, count + 1);
    }

    private unwatch(document: IDocument): void {
        const count = (this.watched.get(document) ?? 1) - 1;
        if (count > 0) {
            this.watched.set(document, count);
            return;
        }
        this.watched.delete(document);
        document.modelManager.removeNodeObserver(this.handleNodes);
    }

    private readonly handleNodes = (records: NodeRecord[]) => {
        const added: INode[] = [];
        for (const record of records) {
            if (
                record.action === "add" ||
                record.action === "insertAfter" ||
                record.action === "insertBefore"
            ) {
                NodeUtils.nodeOrChildrenAppendToNodes(added, record.node);
            }
        }
        for (const node of added) {
            const consumer = node as unknown as ILinkConsumer;
            // A detached source copy is resolved by the build that loaded it, with its cycle guard.
            if (this.consumers.has(consumer) && !isDetachedDocument(consumer.document))
                void this.refresh(consumer);
        }
    };

    private enqueue(consumer: ILinkConsumer, task: () => Promise<void>): Promise<void> {
        const record = this.consumers.get(consumer);
        if (record === undefined) return task();
        const run = record.queue.then(task, task);
        record.queue = run.catch((error) => Logger.warn("link service: a link failed to resolve", error));
        return record.queue;
    }

    private setState(consumer: ILinkConsumer, slotId: string, state: LinkState): void {
        this.consumers.get(consumer)?.states.set(slotId, state);
        consumer.setLinkState(slotId, state);
        this.emit();
    }

    /** Resolves once no link work is queued or building (tests, and callers that must see the result). */
    async settled(): Promise<void> {
        for (let round = 0; round < 50; round++) {
            const queues = [...this.consumers.values()].map((record) => record.queue);
            const building = [...this.building.values()];
            await Promise.all([...queues, ...building]);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            const now = [...this.consumers.values()].map((record) => record.queue);
            if (
                this.building.size === 0 &&
                now.length === queues.length &&
                now.every((q, i) => q === queues[i])
            ) {
                return;
            }
        }
    }

    // ------------------------------------------------------------------ Sources

    /** The documents saved in this browser that links can point at (most recent first). */
    async listSourceDocuments(): Promise<SourceDocumentInfo[]> {
        const documents: SourceDocumentInfo[] = [];
        for (let page = 0; page < 50; page++) {
            const items = (await this.storage.page(Constants.DBName, Constants.RecentTable, page)) as
                | SourceDocumentInfo[]
                | undefined;
            if (items === undefined || items.length === 0) break;
            documents.push(
                ...items
                    .filter((x) => typeof x?.id === "string")
                    .map((x) => ({
                        id: x.id,
                        name: x.name,
                        date: x.date,
                        image: x.image,
                    })),
            );
        }
        return documents.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
    }

    /** A source document's saved history; undefined when it has none (deleted, never saved). */
    openSource(documentId: string): Promise<SourceHistory | undefined> {
        let source = this.sources.get(documentId);
        if (source === undefined) {
            source = SourceHistory.load(this.storage, documentId).catch((error) => {
                Logger.warn(`link service: the history of ${documentId} could not be read`, error);
                return undefined;
            });
            this.sources.set(documentId, source);
            while (this.sources.size > MAX_SOURCES) this.sources.delete(this.sources.keys().next().value!);
        }
        return source;
    }

    /** Forgets a source's loaded history, so the next resolution reads what was saved last. */
    invalidateSource(documentId: string): void {
        this.sources.delete(documentId);
    }

    /** The parts and assemblies of a source document at a commit. */
    async listSourceNodes(documentId: string, commit: string): Promise<Result<SourceNodeInfo[]>> {
        const source = await this.openSource(documentId);
        if (source === undefined) return Result.err("The source document has no saved history");
        if (source.commit(commit) === undefined) return Result.err(`Unknown commit ${commit.slice(0, 7)}`);
        return Result.ok(source.nodesAt(commit));
    }

    /**
     * Resolves a new link: the commit its version names and that commit's geometry. Returns the
     * link with `resolvedCommit` and the display names filled in, ready to store.
     */
    async resolveNew(
        documentId: string,
        nodeId: string,
        version: LinkVersionSpec,
    ): Promise<Result<{ link: PartLinkData; entry: LinkCacheEntry }>> {
        const source = await this.openSource(documentId);
        if (source === undefined) return Result.err("The source document has no saved history");
        const target = source.resolve(version);
        if (!target.isOk) return Result.err(target.error);
        const entry = await this.ensureEntry(source, target.value.commit, nodeId, []);
        if (!entry.isOk) return Result.err(entry.error);
        return Result.ok({
            link: {
                documentId,
                nodeId,
                version,
                resolvedCommit: target.value.commit,
                documentName: entry.value.documentName,
                nodeName: entry.value.nodeName,
                versionLabel: target.value.label,
            },
            entry: entry.value,
        });
    }

    // ------------------------------------------------------------------ Resolution

    shapesOf(link: PartLinkData): { entry: LinkCacheEntry; shapes: IShape[] } | undefined {
        const key = linkKeyOf(link);
        if (key === undefined) return undefined;
        const entry = this.cache.peek(key);
        if (entry === undefined) return undefined;
        const shapes = this.cache.shapesOf(key);
        return shapes === undefined ? undefined : { entry, shapes };
    }

    refresh(consumer: ILinkConsumer): Promise<void> {
        return this.enqueue(consumer, () => this.refreshNow(consumer, []));
    }

    loadGeometry(consumer: ILinkConsumer, slotId: string): Promise<void> {
        return this.enqueue(consumer, async () => {
            const slot = consumer.linkSlots().find((x) => x.slotId === slotId);
            if (slot === undefined) return;
            await this.showCachedOrBuild(consumer, slot.slotId, slot.link, []);
        });
    }

    private async refreshNow(consumer: ILinkConsumer, stack: readonly string[]): Promise<void> {
        if (!consumer.attached && !isDetachedDocument(consumer.document)) return;
        const follow = !isDetachedDocument(consumer.document);
        for (const { slotId, link } of consumer.linkSlots()) {
            const cached = await this.loadCached(link);
            if (cached) consumer.linkGeometryChanged(slotId);
            const source = await this.openSource(link.documentId);
            if (source === undefined) {
                this.setState(consumer, slotId, {
                    status: "broken",
                    message: cached ? "source missing — showing the cached geometry" : "source missing",
                    fromCache: cached,
                });
                continue;
            }
            const target = source.resolve(link.version);
            if (!target.isOk) {
                this.setState(consumer, slotId, {
                    status: "error",
                    message: target.error,
                    fromCache: cached,
                });
                continue;
            }
            // A branch link follows its head; any link without (or with a stale) resolution re-resolves.
            const moved = link.resolvedCommit !== target.value.commit;
            if (moved && (follow || link.resolvedCommit === undefined)) {
                const entry = await this.ensureEntry(source, target.value.commit, link.nodeId, stack);
                if (!entry.isOk) {
                    this.setState(consumer, slotId, {
                        status: "error",
                        message: entry.error,
                        fromCache: cached,
                    });
                    continue;
                }
                consumer.applyLink(
                    slotId,
                    {
                        ...link,
                        resolvedCommit: target.value.commit,
                        documentName: entry.value.documentName,
                        nodeName: entry.value.nodeName,
                        versionLabel: target.value.label,
                    },
                    "Update linked part",
                );
                consumer.linkGeometryChanged(slotId);
                this.setState(consumer, slotId, { status: "ok" });
                continue;
            }
            if (!cached) {
                const built = await this.showCachedOrBuild(consumer, slotId, link, stack);
                if (!built) continue;
            }
            const update = source.latest(link.version, link.resolvedCommit);
            this.setState(
                consumer,
                slotId,
                update === undefined ? { status: "ok" } : { status: "updateAvailable", update },
            );
        }
    }

    /** Loads the cache entry of a link's resolved commit into memory; true when it exists. */
    private async loadCached(link: PartLinkData): Promise<boolean> {
        const key = linkKeyOf(link);
        if (key === undefined) return false;
        return (await this.cache.get(key)) !== undefined;
    }

    private async showCachedOrBuild(
        consumer: ILinkConsumer,
        slotId: string,
        link: PartLinkData,
        stack: readonly string[],
    ): Promise<boolean> {
        if (await this.loadCached(link)) {
            consumer.linkGeometryChanged(slotId);
            return true;
        }
        if (link.resolvedCommit === undefined) return false;
        const source = await this.openSource(link.documentId);
        if (source === undefined) {
            this.setState(consumer, slotId, {
                status: "broken",
                message: "source missing, no cached geometry",
            });
            return false;
        }
        const entry = await this.ensureEntry(source, link.resolvedCommit, link.nodeId, stack);
        if (!entry.isOk) {
            this.setState(consumer, slotId, { status: "error", message: entry.error });
            return false;
        }
        consumer.linkGeometryChanged(slotId);
        this.emit();
        return true;
    }

    /** Moves a pinned link to the newer target its source offers; false when there is none. */
    async updateToLatest(consumer: ILinkConsumer, slotId: string): Promise<boolean> {
        let changed = false;
        await this.enqueue(consumer, async () => {
            const slot = consumer.linkSlots().find((x) => x.slotId === slotId);
            if (slot === undefined) return;
            const source = await this.openSource(slot.link.documentId);
            const update = source?.latest(slot.link.version, slot.link.resolvedCommit);
            if (update !== undefined) changed = await this.changeVersionNow(consumer, slotId, update.version);
        });
        return changed;
    }

    /** Re-points a link at another version spec (resolving and caching it first). */
    async changeVersion(consumer: ILinkConsumer, slotId: string, version: LinkVersionSpec): Promise<boolean> {
        let changed = false;
        await this.enqueue(consumer, async () => {
            changed = await this.changeVersionNow(consumer, slotId, version);
        });
        return changed;
    }

    private async changeVersionNow(
        consumer: ILinkConsumer,
        slotId: string,
        version: LinkVersionSpec,
    ): Promise<boolean> {
        const slot = consumer.linkSlots().find((x) => x.slotId === slotId);
        if (slot === undefined) return false;
        const resolved = await this.resolveNew(slot.link.documentId, slot.link.nodeId, version);
        if (!resolved.isOk) {
            this.setState(consumer, slotId, { status: "error", message: resolved.error });
            return false;
        }
        consumer.applyLink(slotId, resolved.value.link, "Change linked version");
        consumer.linkGeometryChanged(slotId);
        const source = await this.openSource(slot.link.documentId);
        const update = source?.latest(version, resolved.value.link.resolvedCommit);
        this.setState(
            consumer,
            slotId,
            update === undefined ? { status: "ok" } : { status: "updateAvailable", update },
        );
        return true;
    }

    /** A source was saved: its loaded history is stale, and links into it may have moved. */
    async sourceSaved(documentId: string): Promise<void> {
        this.invalidateSource(documentId);
        const affected = [...this.consumers.keys()].filter(
            (consumer) =>
                !isDetachedDocument(consumer.document) &&
                consumer.attached &&
                consumer.linkSlots().some((slot) => slot.link.documentId === documentId),
        );
        await Promise.all(affected.map((consumer) => this.refresh(consumer)));
    }

    private readonly handleDocumentSaved = (document: IDocument) => {
        void this.sourceSaved(document.id);
    };

    // ------------------------------------------------------------------ Building geometry

    /** The cache entry of (source, commit, node), building it from the source when missing. */
    async ensureEntry(
        source: SourceHistory,
        commit: string,
        nodeId: string,
        stack: readonly string[],
    ): Promise<Result<LinkCacheEntry>> {
        const key = linkCacheKey(source.documentId, commit, nodeId);
        const cached = await this.cache.get(key);
        if (cached !== undefined) return Result.ok(cached);
        if (stack.includes(key)) return Result.err("The link refers back to itself");
        let building = this.building.get(key);
        if (building === undefined) {
            building = this.build(source, commit, nodeId, [...stack, key]).finally(() =>
                this.building.delete(key),
            );
            this.building.set(key, building);
        }
        return building;
    }

    private async build(
        source: SourceHistory,
        commit: string,
        nodeId: string,
        stack: readonly string[],
    ): Promise<Result<LinkCacheEntry>> {
        if (source.commit(commit) === undefined)
            return Result.err(`The source has no commit ${commit.slice(0, 7)}`);
        let document: DetachedDocument | undefined;
        try {
            document = await DetachedDocument.load(this.application, source.serializedAt(commit));
            // Links inside the source resolve as the source saved them (never auto-updated).
            for (const consumer of this.consumersOf(document)) {
                await this.enqueue(consumer, () => this.refreshNow(consumer, stack));
            }
            const node = document.modelManager.findNode((x) => x.id === nodeId);
            if (node === undefined) return Result.err("The linked node does not exist in that version");
            const parts = this.cachedParts(document, node, source, commit);
            if (!parts.isOk) return Result.err(parts.error);
            const entry: LinkCacheEntry = {
                key: linkCacheKey(source.documentId, commit, nodeId),
                documentId: source.documentId,
                documentName: document.name,
                commit,
                nodeId,
                nodeName: node.name,
                kind: isAssemblyLike(node) ? "assembly" : "part",
                versionLabel: source.label(commit),
                parts: parts.value,
            };
            await this.cache.put(entry);
            return Result.ok(entry);
        } catch (error) {
            Logger.warn(`link service: ${nodeId} could not be rebuilt at ${commit.slice(0, 7)}`, error);
            return Result.err(`The linked node could not be rebuilt: ${String(error)}`);
        } finally {
            document?.dispose();
        }
    }

    private cachedParts(
        document: DetachedDocument,
        node: INode,
        source: SourceHistory,
        commit: string,
    ): Result<CachedPartData[]> {
        const converter = (this.options.converter ?? (() => shapeConverter))();
        const label = `${document.name} @ ${source.label(commit)}`;
        if (isAssemblyLike(node)) {
            const evaluation = evaluateAssembly(document, node, this);
            if (evaluation.parts.length === 0) return Result.err("The linked assembly has no parts");
            const parts: CachedPartData[] = [];
            for (const part of evaluation.parts) {
                const brep = converter.convertToBrep(part.shape);
                if (!brep.isOk) return Result.err(brep.error);
                parts.push({
                    name: part.name,
                    brep: brep.value,
                    transform: part.placement.toArray(),
                    faceIds: part.faceIds,
                    edgeIds: part.edgeIds,
                    // A part of a linked assembly is the same item as that part linked directly.
                    bomKey: part.bomKey.startsWith("local:")
                        ? `${source.documentId}@${commit}#${part.bomKey.slice("local:".length)}`
                        : part.bomKey,
                    sourceLabel: part.bomKey.startsWith("local:") ? label : part.sourceLabel,
                });
            }
            return Result.ok(parts);
        }
        if (!(node instanceof ShapeNode)) return Result.err(`${node.name} is not a part`);
        const shape = node.shape;
        if (!shape.isOk) return Result.err(`${node.name} does not rebuild: ${shape.error}`);
        const brep = converter.convertToBrep(shape.value);
        if (!brep.isOk) return Result.err(brep.error);
        const tracked = trackedIds(node, shape.value);
        return Result.ok([
            {
                name: node.name,
                brep: brep.value,
                transform: node.transform.toArray(),
                ...tracked,
                bomKey: linkCacheKey(source.documentId, commit, node.id),
                sourceLabel: label,
            },
        ]);
    }
}

/** A node's stable sub-shape ids by index, when it tracks them (parametric bodies). */
export function trackedIds(
    node: INode,
    shape: IShape,
): { faceIds?: (string | null)[]; edgeIds?: (string | null)[] } {
    const tracker = node as unknown as {
        faceIdAt?: (index: number) => string | undefined;
        edgeIdAt?: (index: number) => string | undefined;
    };
    if (typeof tracker.faceIdAt !== "function" || typeof tracker.edgeIdAt !== "function") return {};
    try {
        const faces = shape.findSubShapes(ShapeTypes.face).length;
        const edges = shape.findSubShapes(ShapeTypes.edge).length;
        return {
            faceIds: Array.from({ length: faces }, (_, i) => tracker.faceIdAt!(i) ?? null),
            edgeIds: Array.from({ length: edges }, (_, i) => tracker.edgeIdAt!(i) ?? null),
        };
    } catch {
        return {};
    }
}
