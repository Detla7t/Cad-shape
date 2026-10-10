// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type BranchInfo,
    type CommitEntry,
    type CommitObj,
    Constants,
    type DocumentSnapshot,
    type IStorage,
    LEGACY_DOCUMENT_VERSION,
    MemoryObjectStore,
    Repository,
    Result,
    readTree,
    type Serialized,
    StorageHistoryPersistence,
    snapshotToSerialized,
    type VersionInfo,
} from "@chili3d/core";
import { type LinkUpdate, type LinkVersionSpec, sameVersionSpec } from "./linkTypes";

/** A node of a source snapshot that can be linked: a part (shape node) or an assembly. */
export interface SourceNodeInfo {
    readonly id: string;
    readonly name: string;
    readonly className: string;
    readonly kind: "part" | "assembly";
}

export interface ResolvedCommit {
    readonly commit: string;
    readonly label: string;
}

/** Node classes that hold geometry but are not parts (sketch profiles, annotations). */
const NOT_PARTS = new Set(["SketchNode", "RefSegmentAnnotation", "FolderNode", "GroupNode", "AssemblyNode"]);
/** Serialized classes that are assemblies. */
export const ASSEMBLY_CLASS = "AssemblyNode";

/** Whether a serialized node class is a part: any shape node except the non-parts above. */
function isPartClass(cls: string, props: Readonly<Record<string, unknown>>): boolean {
    if (NOT_PARTS.has(cls)) return false;
    // Shape nodes serialize a material and a transform; studios, tables and folders do not.
    return "materialId" in props && "transform" in props;
}

/**
 * The saved version history of a source document, read headlessly from storage: its commit
 * graph, branches and versions (the same `Repository` the live document's version control
 * uses), and the snapshots its commits point at. A link resolves its version spec here and
 * rebuilds the referenced part from the snapshot — it never touches the source document if
 * it happens to be open (only what was SAVED is linkable, as in Onshape).
 */
export class SourceHistory {
    private constructor(
        readonly documentId: string,
        readonly store: MemoryObjectStore,
        readonly repository: Repository,
        readonly savedAt: number | undefined,
    ) {}

    /** Loads a document's persisted history; undefined when it has none (deleted, never saved). */
    static async load(storage: IStorage, documentId: string): Promise<SourceHistory | undefined> {
        const archive = await new StorageHistoryPersistence(storage).load(documentId);
        if (archive === undefined) return undefined;
        const store = new MemoryObjectStore();
        for (const [hash, record] of archive.records) store.importRecord(hash, record);
        const repository = new Repository(store);
        const branches = archive.refs.branches.filter((b) => repository.hasCommit(b.head));
        if (branches.length === 0) return undefined;
        repository.loadRefs({
            current: archive.refs.current,
            branches,
            versions: archive.refs.versions.filter((v) => repository.hasCommit(v.commit)),
        });
        const manifest = (await storage.get(Constants.DBName, Constants.HistoryTable, documentId)) as
            | { savedAt?: number }
            | undefined;
        return new SourceHistory(documentId, store, repository, manifest?.savedAt);
    }

    /** The name the document had at its current branch's head. */
    get name(): string {
        return this.snapshot(this.repository.head).meta.name;
    }

    branches(): BranchInfo[] {
        return this.repository.branches();
    }

    versions(): VersionInfo[] {
        return this.repository.versions();
    }

    /** Commits newest first; `limit` keeps the most recent. */
    log(limit?: number): CommitEntry[] {
        const log = this.repository.log();
        return limit === undefined ? log : log.slice(0, limit);
    }

    commit(id: string): CommitObj | undefined {
        return this.repository.hasCommit(id) ? this.repository.getCommit(id) : undefined;
    }

    /** A short human name for a commit: its version, a branch it heads, or its message. */
    label(commit: string): string {
        const version = this.repository.versionsAt(commit)[0];
        if (version !== undefined) return version.name;
        const branch = this.repository.branches().find((b) => b.head === commit);
        if (branch !== undefined) return branch.name;
        const object = this.commit(commit);
        return object === undefined ? commit.slice(0, 7) : `${object.message} (${commit.slice(0, 7)})`;
    }

    /** The commit a version spec names now. */
    resolve(spec: LinkVersionSpec): Result<ResolvedCommit> {
        switch (spec.kind) {
            case "branch": {
                const branch = this.repository.branch(spec.name);
                if (branch === undefined) return Result.err(`The source has no branch "${spec.name}"`);
                return Result.ok({ commit: branch.head, label: spec.name });
            }
            case "version": {
                const version = this.repository.version(spec.name);
                if (version === undefined) return Result.err(`The source has no version "${spec.name}"`);
                return Result.ok({ commit: version.commit, label: version.name });
            }
            case "commit":
                if (!this.repository.hasCommit(spec.id)) {
                    return Result.err(`The source has no commit ${spec.id.slice(0, 7)}`);
                }
                return Result.ok({ commit: spec.id, label: this.label(spec.id) });
        }
    }

    /**
     * The newer target a pinned link could update to, or undefined when it is current. A
     * version link offers the newest version created after it; a commit link the head of the
     * branch its commit was made on. Branch links follow by themselves and never offer one.
     */
    latest(spec: LinkVersionSpec, current: string | undefined): LinkUpdate | undefined {
        if (spec.kind === "branch") return undefined;
        if (spec.kind === "version") {
            // Versions are listed oldest first (creation order, ties in the order they were made).
            const versions = this.versions();
            const newest = versions.at(-1);
            const pinned = versions.findIndex((v) => v.name === spec.name);
            if (newest === undefined || pinned === versions.length - 1) return undefined;
            if (sameVersionSpec(spec, { kind: "version", name: newest.name })) return undefined;
            return {
                version: { kind: "version", name: newest.name },
                commit: newest.commit,
                label: newest.name,
            };
        }
        const commit = this.commit(spec.id);
        const branch =
            (commit && this.repository.branch(commit.branch)) ??
            this.repository.branch(this.repository.current);
        if (branch === undefined || branch.head === (current ?? spec.id)) return undefined;
        if (this.repository.isAncestor(branch.head, current ?? spec.id)) return undefined;
        return {
            version: { kind: "commit", id: branch.head },
            commit: branch.head,
            label: this.label(branch.head),
        };
    }

    snapshot(commit: string): DocumentSnapshot {
        return readTree(this.store, this.repository.getCommit(commit).tree);
    }

    /**
     * The document as it was at `commit`, in the form `Document.serialize` writes. Commits do not
     * record a document schema; every one so far is schema 1 (the legacy version marker).
     */
    serializedAt(commit: string): Serialized {
        return snapshotToSerialized(this.snapshot(commit), this.documentId, LEGACY_DOCUMENT_VERSION);
    }

    /** The linkable nodes of the snapshot at `commit`, in tree order. */
    nodesAt(commit: string): SourceNodeInfo[] {
        const snapshot = this.snapshot(commit);
        const order: string[] = [];
        const visit = (id: string, seen: Set<string>) => {
            const node = snapshot.nodes.get(id);
            if (node === undefined || seen.has(id)) return;
            seen.add(id);
            order.push(id);
            // A parametric body's children are its consumed tools: not parts of their own.
            if (isPartClass(node.cls, node.props)) return;
            for (const child of node.children ?? []) visit(child, seen);
        };
        visit(snapshot.rootId, new Set());
        const nodes: SourceNodeInfo[] = [];
        for (const id of order) {
            const node = snapshot.nodes.get(id)!;
            const name = typeof node.props["name"] === "string" ? (node.props["name"] as string) : id;
            if (node.cls === ASSEMBLY_CLASS) {
                nodes.push({ id, name, className: node.cls, kind: "assembly" });
            } else if (isPartClass(node.cls, node.props)) {
                nodes.push({ id, name, className: node.cls, kind: "part" });
            }
        }
        return nodes;
    }
}
