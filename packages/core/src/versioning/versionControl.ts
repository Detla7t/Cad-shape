// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import {
    ArrayRecord,
    type HistoryAction,
    type IHistoryRecord,
    NodeLinkedListHistoryRecord,
    PropertyHistoryRecord,
} from "../foundation/history";
import { Logger } from "../foundation/logger";
import { Result } from "../foundation/result";
import { Transaction } from "../foundation/transaction";
import { Material, Texture } from "../material";
import { type INode, Node, NodeUtils } from "../model/node";
import { Serializer } from "../serialize";
import { applySnapshot, collectFeatureErrors, type FeatureErrorReport } from "./apply";
import { type CommitChange, treeChanges } from "./changes";
import { type DocumentDiff, diffTrees, summarizeDiff } from "./diff";
import { toJsonValue } from "./hash";
import {
    archiveToEntries,
    entriesToArchive,
    HISTORY_FORMAT_VERSION,
    type HistoryArchive,
    type IHistoryPersistence,
} from "./historyStorage";
import { type ConflictResolution, type MergeConflict, mergeTrees } from "./merge";
import { MemoryObjectStore, type StoredRecord } from "./objectStore";
import type { CommitKind, CommitObj, ObjectHash, TreeObj } from "./objects";
import { storePart } from "./parts";
import {
    type BranchInfo,
    type CommitEntry,
    DEFAULT_BRANCH,
    Repository,
    type VersionInfo,
} from "./repository";
import {
    type NodeContent,
    nodeContent,
    nodeObject,
    readTree,
    seqItems,
    storeConfiguration,
    storeShards,
} from "./snapshot";

/**
 * Version control for one live document — Onshape's model:
 *
 * - Every completed undoable change becomes a MICROVERSION on the current branch, automatically:
 *   the history (`History.onChanged`) reports each committed transaction, undo and redo, the
 *   records name the objects they touched, and only those nodes are re-serialized and
 *   re-normalized (everything else reuses its cached object hash).
 * - Undo and redo are changes like any other — they append microversions; history is never
 *   rewritten.
 * - Restoring an old commit patches the live document to it as one undoable transaction, and
 *   that too appends a microversion. Switching branches patches the document to the branch head
 *   (pending changes are committed first, so nothing is lost).
 * - Merging another branch or version three-way merges the snapshots, applies the result as
 *   one transaction and records a merge commit with both parents.
 */

export interface VersionControlOptions {
    /** Where the history is persisted; omitted keeps it in memory only. */
    readonly persistence?: IHistoryPersistence;
    readonly author?: string;
}

export interface ChangePreview {
    readonly head: ObjectHash;
    readonly source: ObjectHash;
    readonly selected: readonly string[];
    readonly direction: "apply" | "revert";
    readonly baseTree: ObjectHash;
    readonly incomingTree: ObjectHash;
    readonly conflicts: readonly MergeConflict[];
    readonly mergedTree: ObjectHash;
}

export interface RebasePreview {
    readonly head: ObjectHash;
    readonly source: ObjectHash;
    readonly onto: ObjectHash;
    readonly omitted: readonly string[];
    readonly steps: readonly { original: ObjectHash; tree: ObjectHash }[];
    readonly conflicts: readonly MergeConflict[];
}

/** A pending merge, as previewed: the conflicts to settle and what the other side brings in. */
export interface MergePreview {
    readonly ours: ObjectHash;
    readonly theirs: ObjectHash;
    readonly baseTree: ObjectHash | undefined;
    /** True when the other side is already part of the current branch — nothing to merge. */
    readonly upToDate: boolean;
    readonly conflicts: readonly MergeConflict[];
    /** What the other side changed since the merge base. */
    readonly incoming: DocumentDiff;
    /** The merged snapshot with every conflict settled as "ours". */
    readonly mergedTree: ObjectHash;
}

export interface ApplyOutcome {
    /** The commit recording the result; undefined when the document did not change. */
    readonly commit: ObjectHash | undefined;
    /** Features that fail to rebuild in the result — surfaced, never hidden. */
    readonly errors: readonly FeatureErrorReport[];
}

interface IndexedNode {
    readonly node: INode;
    readonly content: NodeContent;
    readonly children: readonly string[] | undefined;
    readonly hash: ObjectHash;
}

interface PendingCommit {
    readonly kind: CommitKind;
    readonly message: string;
    readonly parents?: readonly ObjectHash[];
}

type ChangeListener = () => void;

const MESSAGE_ACTIONS = 3;
/** How long a capture deferred by an open transaction waits before checking again. */
const RETRY_MS = 500;

export class DocumentVersionControl {
    private static readonly registry = new WeakMap<IDocument, DocumentVersionControl>();

    /** The version control attached to `document`, if any. */
    static of(document: IDocument): DocumentVersionControl | undefined {
        return DocumentVersionControl.registry.get(document);
    }

    /**
     * Starts versioning a document that has no saved history (a new document): synchronous,
     * the initial commit is made right away. Saves still go through `options.persistence`.
     */
    static create(document: IDocument, options: VersionControlOptions = {}): DocumentVersionControl {
        const existing = DocumentVersionControl.registry.get(document);
        if (existing !== undefined) return existing;
        const control = new DocumentVersionControl(document, options);
        DocumentVersionControl.registry.set(document, control);
        control.start(undefined, "");
        return control;
    }

    /**
     * Starts versioning a document: loads its persisted history (if any), records the current
     * state — the initial commit of a new history, or a microversion when the document differs
     * from the history's head (it was edited elsewhere) — and starts capturing changes.
     */
    static async attach(
        document: IDocument,
        options: VersionControlOptions = {},
    ): Promise<DocumentVersionControl> {
        const existing = DocumentVersionControl.registry.get(document);
        if (existing !== undefined) return existing;
        const control = new DocumentVersionControl(document, options);
        DocumentVersionControl.registry.set(document, control);
        let archive: HistoryArchive | undefined;
        try {
            archive = await options.persistence?.load(document.id);
        } catch (error) {
            Logger.warn(`version history of ${document.name} could not be read; starting a new one`, error);
        }
        if (control.disposed) return control;
        control.start(archive, "Synchronized with the saved document");
        return control;
    }

    readonly store = new MemoryObjectStore();
    readonly repository: Repository;
    private readonly nodes = new Map<string, IndexedNode>();
    private readonly listeners = new Set<ChangeListener>();
    private meta?: ObjectHash;
    private variables?: ObjectHash;
    /** Undefined while the document has no configuration inputs (see `TreeObj.configuration`). */
    private configuration?: ObjectHash;
    private materials?: ObjectHash;
    private components?: ObjectHash;
    private dirtyAll = true;
    private readonly dirtyNodes = new Set<INode>();
    private dirtyVariables = true;
    private dirtyMaterials = true;
    private dirtyComponents = true;
    private actions: string[] = [];
    private pending?: PendingCommit;
    private scheduled = false;
    private retry?: ReturnType<typeof setTimeout>;
    private started = false;
    private disposed = false;

    private constructor(
        readonly document: IDocument,
        private readonly options: VersionControlOptions,
    ) {
        this.repository = new Repository(this.store);
    }

    // ------------------------------------------------------------------ Lifecycle

    private start(archive: HistoryArchive | undefined, syncMessage: string): void {
        if (archive !== undefined) this.importArchive(archive);
        const tree = this.capture();
        if (!this.repository.initialized) {
            const commit = this.repository.commit({
                tree,
                parents: [],
                kind: "micro",
                message: "Document created",
                summary: [],
                branch: DEFAULT_BRANCH,
                author: this.options.author,
            });
            this.repository.initialize(commit);
        } else if (this.headCommit().tree !== tree) {
            this.commitTree(tree, { kind: "micro", message: syncMessage });
        }
        if (!this.started) {
            this.document.history.onChanged(this.handleHistory);
            this.started = true;
        }
        this.emit();
    }

    private importArchive(archive: HistoryArchive): void {
        for (const [hash, record] of archive.records) this.store.importRecord(hash, record);
        const refs = archive.refs;
        const valid = refs.branches.filter((b) => this.repository.hasCommit(b.head));
        if (valid.length === 0) return;
        this.repository.loadRefs({
            current: refs.current,
            branches: valid,
            versions: refs.versions.filter((v) => this.repository.hasCommit(v.commit)),
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.document.history.removeChanged(this.handleHistory);
        if (this.retry !== undefined) clearTimeout(this.retry);
        for (const entry of this.nodes.values()) entry.node.removePropertyChanged(this.handleNodeProperty);
        this.nodes.clear();
        this.listeners.clear();
        DocumentVersionControl.registry.delete(this.document);
    }

    /** Notified after every commit, ref change and checkout. Returns the unsubscribe function. */
    onChanged(listener: ChangeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                Logger.error("version control: a listener threw", error);
            }
        }
    }

    // ------------------------------------------------------------------ Queries

    get currentBranch(): string {
        return this.repository.current;
    }

    get head(): ObjectHash {
        return this.repository.head;
    }

    headCommit(): CommitObj {
        return this.repository.getCommit(this.repository.head);
    }

    branches(): BranchInfo[] {
        return this.repository.branches();
    }

    versions(): VersionInfo[] {
        return this.repository.versions();
    }

    log(): CommitEntry[] {
        return this.repository.log();
    }

    commit(id: ObjectHash): CommitObj {
        return this.repository.getCommit(id);
    }

    /** A short human name for a commit: its version name, a branch it heads, or its message. */
    label(id: ObjectHash): string {
        const version = this.repository.versionsAt(id)[0];
        if (version !== undefined) return version.name;
        const branch = this.repository.branches().find((b) => b.head === id);
        if (branch !== undefined) return branch.name;
        return `${this.repository.getCommit(id).message} (${id.slice(0, 7)})`;
    }

    /** Semantic diff between two commits; `to` defaults to the current head (after a flush). */
    diff(from: ObjectHash, to?: ObjectHash): DocumentDiff {
        this.flush();
        const target = to ?? this.head;
        return diffTrees(
            this.store,
            this.repository.getCommit(from).tree,
            this.repository.getCommit(target).tree,
        );
    }

    // ------------------------------------------------------------------ Capture

    private readonly handleHistory = (action: HistoryAction, record: IHistoryRecord) => {
        if (this.disposed) return;
        this.collectDirty(record);
        const name = describeRecord(record);
        this.actions.push(action === "add" ? name : `${action} ${name}`);
        this.schedule();
    };

    /**
     * Captures at the end of the current tick, so the edits of one tick share a microversion.
     * While a transaction is still open (an async command mid-way) or history is switched off
     * (a programmatic rewrite in progress) the state is not settled: the capture waits — the
     * transaction's commit schedules it again, and a slow retry covers one that is rolled back.
     */
    private schedule(): void {
        if (this.scheduled) return;
        this.scheduled = true;
        const run = () => {
            this.scheduled = false;
            if (this.disposed) return;
            if (Transaction.isActive(this.document) || this.document.history.disabled) {
                if (this.retry === undefined) {
                    this.retry = setTimeout(() => {
                        this.retry = undefined;
                        this.schedule();
                    }, RETRY_MS);
                }
                return;
            }
            this.flush();
        };
        queueMicrotask(run);
    }

    /**
     * Derived state a node persists with history switched off — a sketch re-solved after a
     * variable edit, refs re-anchored after a rebuild — never reaches the history, but it is
     * part of the document. Watching every indexed node's properties marks such a node dirty,
     * so the next microversion carries it.
     */
    private readonly handleNodeProperty = (_property: string | number | symbol, source: unknown) => {
        if (source instanceof Node) this.dirtyNodes.add(source);
    };

    /** Which parts of the document a record may have changed. */
    private collectDirty(record: IHistoryRecord): void {
        if (record instanceof ArrayRecord) {
            for (const inner of record.records) this.collectDirty(inner);
        } else if (record instanceof PropertyHistoryRecord) {
            const target = record.object as unknown;
            if (target === this.document.variables) this.dirtyVariables = true;
            else if (target instanceof Material || target instanceof Texture) this.dirtyMaterials = true;
            else if (target instanceof Node) this.dirtyNodes.add(target);
            else this.dirtyAll = true;
        } else if (record instanceof NodeLinkedListHistoryRecord) {
            // Structure is re-read on every capture; the nodes themselves may come back changed.
            for (const item of record.records) this.dirtyNodes.add(item.node);
        } else if (record.name === "MaterialChanged") {
            this.dirtyMaterials = true;
        } else if (record.name === "ComponentChanged") {
            this.dirtyComponents = true;
        } else {
            this.dirtyAll = true;
        }
    }

    /**
     * Records the live document as a new microversion if it changed since the head. Called
     * automatically after each change; call it to capture synchronously. Returns the new commit.
     */
    flush(): ObjectHash | undefined {
        this.scheduled = false;
        if (!this.started || this.disposed) return undefined;
        const pending = this.pending;
        this.pending = undefined;
        const actions = this.actions;
        this.actions = [];
        const tree = this.capture();
        if (tree === this.headCommit().tree && pending?.kind !== "merge") return undefined;
        return this.commitTree(tree, pending ?? { kind: "micro", message: messageOf(actions) });
    }

    private commitTree(tree: ObjectHash, pending: PendingCommit): ObjectHash {
        const head = this.repository.head;
        const summary = summarizeDiff(diffTrees(this.store, this.repository.getCommit(head).tree, tree));
        const commit = this.repository.commit({
            tree,
            parents: pending.parents ?? [head],
            kind: pending.kind,
            message: pending.message,
            summary,
            branch: this.repository.current,
            author: this.options.author,
        });
        this.repository.setHead(this.repository.current, commit);
        this.emit();
        return commit;
    }

    /**
     * Normalizes the live document into the store and returns the tree hash. Only nodes the
     * history reported as touched (or not seen before) are re-serialized; the walk itself only
     * reads child order.
     */
    private capture(): ObjectHash {
        const root = this.document.modelManager.rootNode;
        const seen = new Map<string, ObjectHash>();
        const visit = (node: INode) => {
            if (seen.has(node.id)) return;
            const entry = this.indexNode(node);
            seen.set(node.id, entry.hash);
            if (NodeUtils.isLinkedListNode(node)) {
                let child = node.firstChild;
                while (child !== undefined) {
                    visit(child);
                    child = child.nextSibling;
                }
            }
        };
        visit(root);
        for (const [id, entry] of [...this.nodes]) {
            if (seen.has(id)) continue;
            entry.node.removePropertyChanged(this.handleNodeProperty);
            this.nodes.delete(id);
        }

        const metaValue = toJsonValue({
            name: this.document.name,
            userData: this.document.userData ?? {},
            acts: this.document.acts.map((x) => Serializer.serializeObject(x)),
        });
        this.meta = storePart(this.store, { kind: "json", value: metaValue });
        if (this.dirtyAll || this.dirtyVariables || this.variables === undefined) {
            this.variables = storePart(this.store, {
                kind: "seq",
                role: "variable",
                items: seqItems(this.document.variables.items, (x) => x.id),
            });
            // The configuration inputs live on the same object, so they are dirty together.
            this.configuration = storeConfiguration(
                this.store,
                seqItems(this.document.variables.configurationInputs ?? [], (x) => x.id),
            );
        }
        if (this.dirtyAll || this.dirtyMaterials || this.materials === undefined) {
            this.materials = storePart(this.store, {
                kind: "seq",
                role: "material",
                items: seqItems(
                    this.document.modelManager.materials.map((x) => Serializer.serializeObject(x)),
                    (x) => x["id"],
                ),
            });
        }
        if (this.dirtyAll || this.dirtyComponents || this.components === undefined) {
            this.components = storePart(this.store, {
                kind: "seq",
                role: "component",
                items: seqItems(
                    this.document.modelManager.components.map((x) => Serializer.serializeObject(x)),
                    (x) => x["id"],
                ),
            });
        }
        this.dirtyAll = false;
        this.dirtyNodes.clear();
        this.dirtyVariables = this.dirtyMaterials = this.dirtyComponents = false;
        const tree: TreeObj = {
            t: "tree",
            root: root.id,
            meta: this.meta,
            shards: storeShards(this.store, seen),
            variables: this.variables,
            materials: this.materials,
            components: this.components,
            ...(this.configuration === undefined ? {} : { configuration: this.configuration }),
        };
        return this.store.put(tree);
    }

    private indexNode(node: INode): IndexedNode {
        const entry = this.nodes.get(node.id);
        const children = NodeUtils.isLinkedListNode(node) ? childIds(node) : undefined;
        let content = entry?.content;
        if (entry === undefined || entry.node !== node || this.dirtyAll || this.dirtyNodes.has(node)) {
            content = nodeContent(this.store, Serializer.serializeObject(node), entry?.content);
        }
        if (entry !== undefined && content === entry.content && sameIds(children, entry.children))
            return entry;
        if (entry?.node !== node) {
            entry?.node.removePropertyChanged(this.handleNodeProperty);
            node.onPropertyChanged(this.handleNodeProperty);
        }
        const hash = this.store.put(nodeObject(content!, children));
        const next: IndexedNode = { node, content: content!, children, hash };
        this.nodes.set(node.id, next);
        return next;
    }

    /** Re-normalizes the whole document on the next capture. */
    private invalidate(): void {
        this.dirtyAll = true;
    }

    // ------------------------------------------------------------------ Versions and branches

    /** An explicit named checkpoint; automatic operation commits remain available beneath it. */
    createCommit(message: string): Result<ObjectHash> {
        if (!message.trim()) return Result.err("A commit needs a message");
        this.flush();
        return Result.ok(
            this.commitTree(this.headCommit().tree, { kind: "checkpoint", message: message.trim() }),
        );
    }

    /** Operations recorded since the previous named commit, version, merge or branch boundary. */
    operations(commit: ObjectHash): CommitEntry[] {
        const entry = this.repository.getCommit(commit);
        if (entry.kind !== "checkpoint" && entry.kind !== "version") return [];
        const boundaries = new Set([
            ...this.branches().map((b) => b.head),
            ...this.versions().map((v) => v.commit),
        ]);
        const operations: CommitEntry[] = [];
        let cursor = entry.parents[0];
        while (cursor && !boundaries.has(cursor)) {
            const operation = this.repository.getCommit(cursor);
            if (
                operation.kind !== "micro" ||
                operation.parents.length !== 1 ||
                operation.branch !== entry.branch
            )
                break;
            operations.push({ ...operation, id: cursor });
            cursor = operation.parents[0];
        }
        return operations;
    }

    /** Individual fields, sketch entities, constraints and operations changed by a commit. */
    changes(commit: ObjectHash): readonly CommitChange[] {
        const entry = this.repository.getCommit(commit);
        const parent = entry.parents[0];
        return parent
            ? treeChanges(this.store, this.repository.getCommit(parent).tree, entry.tree).changes
            : [];
    }

    previewChanges(
        source: ObjectHash,
        selected: readonly string[],
        direction: "apply" | "revert",
    ): Result<ChangePreview> {
        this.flush();
        const entry = this.repository.getCommit(source);
        if (!entry.parents[0] || selected.length === 0)
            return Result.err("Select at least one change in a commit");
        const parentTree = this.repository.getCommit(entry.parents[0]).tree;
        const partial = treeChanges(this.store, parentTree, entry.tree).select(selected);
        if (!partial.isOk) return Result.err(partial.error);
        const baseTree = direction === "apply" ? parentTree : partial.value;
        const incomingTree = direction === "apply" ? partial.value : parentTree;
        const result = mergeTrees(this.store, baseTree, this.headCommit().tree, incomingTree);
        return Result.ok({
            head: this.head,
            source,
            selected: [...selected],
            direction,
            baseTree,
            incomingTree,
            conflicts: result.conflicts,
            mergedTree: result.tree,
        });
    }

    /** Partial apply/revert is a new undoable commit, never a rewrite of its source commit. */
    applyChanges(
        preview: ChangePreview,
        resolutions: ReadonlyMap<string, ConflictResolution> = new Map(),
    ): Result<ApplyOutcome> {
        this.flush();
        if (this.head !== preview.head)
            return Result.err("The branch changed since these changes were previewed");
        const result = mergeTrees(
            this.store,
            preview.baseTree,
            this.headCommit().tree,
            preview.incomingTree,
            resolutions,
        );
        if (result.conflicts.some((c) => !resolutions.has(c.id)))
            return Result.err("Review each conflict before applying changes");
        const message = `${preview.direction === "apply" ? "Applied" : "Reverted"} ${preview.selected.length} changes from ${this.label(preview.source)}`;
        this.pending = { kind: "micro", message };
        try {
            applySnapshot(this.document, readTree(this.store, result.tree), {
                undoable: true,
                name: message,
            });
            this.document.visual.update();
            return Result.ok({ commit: this.flush(), errors: collectFeatureErrors(this.document) });
        } finally {
            this.pending = undefined;
        }
    }

    /**
     * Replays the first-parent history from source through head onto a chosen point, omitting
     * selected changes from source. Merge commits replay their net first-parent patch. The
     * preview is read-only; the result is created on a new branch so the original stays intact.
     */
    previewRebase(
        source: ObjectHash,
        omitted: readonly string[],
        onto: ObjectHash,
        resolutions: ReadonlyMap<string, ConflictResolution> = new Map(),
    ): Result<RebasePreview> {
        this.flush();
        if (!this.repository.hasCommit(onto)) return Result.err("The rebase target is not a commit");
        const chain: ObjectHash[] = [];
        let cursor: ObjectHash | undefined = this.head;
        while (cursor) {
            chain.unshift(cursor);
            if (cursor === source) break;
            cursor = this.repository.getCommit(cursor).parents[0];
        }
        if (!cursor) return Result.err("Choose a commit on this branch's first-parent history");
        const entry = this.repository.getCommit(source);
        if (!entry.parents[0]) return Result.err("The initial document cannot be rebased as a change");
        const delta = treeChanges(this.store, this.repository.getCommit(entry.parents[0]).tree, entry.tree);
        if (omitted.some((id) => !delta.changes.some((c) => c.id === id)))
            return Result.err("A selected change is not in this commit");
        const filtered = delta.select(delta.changes.filter((c) => !omitted.includes(c.id)).map((c) => c.id));
        if (!filtered.isOk) return Result.err(filtered.error);
        let tree = this.repository.getCommit(onto).tree;
        const conflicts: MergeConflict[] = [];
        const steps: { original: ObjectHash; tree: ObjectHash }[] = [];
        for (const original of chain) {
            const commit = this.repository.getCommit(original);
            const prefix = `${original}:`;
            const choices = new Map(
                [...resolutions]
                    .filter(([key]) => key.startsWith(prefix))
                    .map(([key, value]) => [key.slice(prefix.length), value]),
            );
            const result = mergeTrees(
                this.store,
                this.repository.getCommit(commit.parents[0]).tree,
                tree,
                original === source ? filtered.value : commit.tree,
                choices,
            );
            conflicts.push(
                ...result.conflicts.map((c) => ({
                    ...c,
                    id: prefix + c.id,
                    location: `${commit.message} › ${c.location}`,
                    textId: c.textId ? prefix + c.textId : undefined,
                })),
            );
            tree = result.tree;
            steps.push({ original, tree });
        }
        return Result.ok({ head: this.head, source, onto, omitted: [...omitted], steps, conflicts });
    }

    rebase(
        preview: RebasePreview,
        branchName: string,
        resolutions: ReadonlyMap<string, ConflictResolution> = new Map(),
    ): Result<ApplyOutcome> {
        this.flush();
        if (this.head !== preview.head)
            return Result.err("The branch changed since the rebase was previewed");
        const checked = this.previewRebase(preview.source, preview.omitted, preview.onto, resolutions);
        if (!checked.isOk) return Result.err(checked.error);
        if (checked.value.conflicts.some((c) => !resolutions.has(c.id)))
            return Result.err("Review each conflict before rebasing");
        const branch = this.repository.createBranch(branchName, preview.onto);
        if (!branch.isOk) return Result.err(branch.error);
        let head = preview.onto;
        for (const step of checked.value.steps) {
            const previous = this.repository.getCommit(head);
            if (previous.tree === step.tree) continue;
            head = this.repository.commit({
                tree: step.tree,
                parents: [head],
                kind: "micro",
                message: `Rebased: ${this.repository.getCommit(step.original).message}`,
                summary: summarizeDiff(diffTrees(this.store, previous.tree, step.tree)),
                branch: branch.value.name,
                author: this.options.author,
            });
        }
        this.repository.setHead(branch.value.name, head);
        const switched = this.switchBranch(branch.value.name);
        if (!switched.isOk) return Result.err(switched.error);
        return Result.ok({ commit: head, errors: collectFeatureErrors(this.document) });
    }

    /**
     * Names a commit (default: the current state). Naming the head adds a version commit the
     * branch continues from, as Onshape does; naming an older commit tags it.
     */
    createVersion(name: string, description = "", commit?: ObjectHash): Result<VersionInfo> {
        this.flush();
        const head = this.head;
        let target = commit ?? head;
        if (this.repository.version(name.trim()) !== undefined) {
            return Result.err(`A version named "${name.trim()}" already exists`);
        }
        if (target === head) {
            const headCommit = this.headCommit();
            target = this.repository.commit({
                tree: headCommit.tree,
                parents: [head],
                kind: "version",
                message: name.trim(),
                summary: [],
                branch: this.repository.current,
                author: this.options.author,
            });
            const version = this.repository.createVersion(name, target, description);
            if (!version.isOk) return version;
            this.repository.setHead(this.repository.current, target);
            this.emit();
            return version;
        }
        const version = this.repository.createVersion(name, target, description);
        if (version.isOk) this.emit();
        return version;
    }

    /** Creates a branch at `from` (default: the current state) and, by default, switches to it. */
    createBranch(name: string, from?: ObjectHash, switchTo = true): Result<BranchInfo> {
        this.flush();
        const branch = this.repository.createBranch(name, from ?? this.head);
        if (!branch.isOk) return branch;
        if (switchTo) this.switchBranch(branch.value.name);
        else this.emit();
        return branch;
    }

    /**
     * Makes `name` the current branch and brings the document to its head. Pending changes are
     * committed to the branch being left first; the undo stack is cleared (its steps belong to
     * the other branch's state).
     */
    switchBranch(name: string): Result<ObjectHash> {
        const branch = this.repository.branch(name);
        if (branch === undefined) return Result.err(`No branch named "${name}"`);
        this.flush();
        if (name === this.repository.current) return Result.ok(branch.head);
        this.repository.setCurrent(name);
        applySnapshot(this.document, readTree(this.store, this.repository.getCommit(branch.head).tree), {
            undoable: false,
        });
        this.document.history.reset();
        this.document.visual.update();
        this.invalidate();
        const tree = this.capture();
        if (tree !== this.headCommit().tree) {
            Logger.info(`version control: ${name} re-normalized differently from its head after checkout`);
        }
        this.actions = [];
        this.emit();
        return Result.ok(branch.head);
    }

    /**
     * Brings the document back to `commit` as one undoable step; the result is a new
     * microversion on the current branch — history only ever grows.
     */
    restore(commit: ObjectHash): ApplyOutcome {
        this.flush();
        const target = readTree(this.store, this.repository.getCommit(commit).tree);
        this.pending = { kind: "micro", message: `Restored to ${this.label(commit)}` };
        applySnapshot(this.document, target, { undoable: true, name: "restore version" });
        this.document.visual.update();
        const created = this.flush();
        this.pending = undefined;
        return { commit: created, errors: collectFeatureErrors(this.document) };
    }

    // ------------------------------------------------------------------ Merge

    /** The merge base's tree — a virtual one merged from all best bases after criss-cross merges. */
    mergeBaseTree(a: ObjectHash, b: ObjectHash): ObjectHash | undefined {
        const bases = this.repository.mergeBases(a, b);
        if (bases.length === 0) return undefined;
        let tree = this.repository.getCommit(bases[0]).tree;
        for (const other of bases.slice(1)) {
            const base = this.mergeBaseTree(bases[0], other);
            tree = mergeTrees(this.store, base, tree, this.repository.getCommit(other).tree).tree;
        }
        return tree;
    }

    /** What merging `source` (a branch head or version commit) into the current branch would do. */
    previewMerge(source: ObjectHash): MergePreview {
        this.flush();
        const ours = this.head;
        const oursTree = this.repository.getCommit(ours).tree;
        const theirsTree = this.repository.getCommit(source).tree;
        if (this.repository.isAncestor(source, ours)) {
            return {
                ours,
                theirs: source,
                baseTree: theirsTree,
                upToDate: true,
                conflicts: [],
                incoming: diffTrees(this.store, theirsTree, theirsTree),
                mergedTree: oursTree,
            };
        }
        const baseTree = this.mergeBaseTree(ours, source);
        const result = mergeTrees(this.store, baseTree, oursTree, theirsTree);
        return {
            ours,
            theirs: source,
            baseTree,
            upToDate: false,
            conflicts: result.conflicts,
            incoming: diffTrees(this.store, baseTree, theirsTree),
            mergedTree: result.tree,
        };
    }

    /**
     * Merges as previewed, settling conflicts by `resolutions` (unlisted ones keep "ours"),
     * applies the result to the document as one undoable step and records a merge commit.
     */
    merge(
        preview: MergePreview,
        resolutions: ReadonlyMap<string, ConflictResolution> = new Map(),
    ): Result<ApplyOutcome> {
        this.flush();
        if (preview.upToDate) return Result.ok({ commit: undefined, errors: [] });
        if (this.head !== preview.ours) return Result.err("The branch changed since the merge was previewed");
        const result = mergeTrees(
            this.store,
            preview.baseTree,
            this.repository.getCommit(preview.ours).tree,
            this.repository.getCommit(preview.theirs).tree,
            resolutions,
        );
        this.pending = {
            kind: "merge",
            message: `Merged ${this.label(preview.theirs)} into ${this.repository.current}`,
            parents: [preview.ours, preview.theirs],
        };
        applySnapshot(this.document, readTree(this.store, result.tree), { undoable: true, name: "merge" });
        this.document.visual.update();
        const created = this.flush();
        this.pending = undefined;
        return Result.ok({ commit: created, errors: collectFeatureErrors(this.document) });
    }

    // ------------------------------------------------------------------ Persistence

    /** Every object reachable from a branch or version (what a save or export must keep). */
    reachableRecords(): (readonly [ObjectHash, StoredRecord])[] {
        const seen = new Set<ObjectHash>();
        const stack: ObjectHash[] = [
            ...this.repository.branches().map((b) => b.head),
            ...this.repository.versions().map((v) => v.commit),
        ];
        while (stack.length > 0) {
            const hash = stack.pop()!;
            if (seen.has(hash)) continue;
            const record = this.store.record(hash);
            if (record === undefined) continue;
            seen.add(hash);
            if ("d" in record) {
                stack.push(record.d.base);
                continue;
            }
            const object = record.o;
            switch (object.t) {
                case "commit":
                    stack.push(object.tree, ...object.parents);
                    break;
                case "tree":
                    stack.push(
                        object.meta,
                        object.variables,
                        object.materials,
                        object.components,
                        ...(object.configuration === undefined ? [] : [object.configuration]),
                        ...object.shards,
                    );
                    break;
                case "shard":
                    stack.push(...Object.values(object.n));
                    break;
                case "node":
                    stack.push(...Object.values(object.parts));
                    break;
                case "seq":
                    stack.push(...object.items.map(([, item]) => item));
                    break;
                case "rec":
                    stack.push(...Object.values(object.f));
                    break;
                default:
                    break;
            }
        }
        return [...seen].map((hash) => [hash, this.store.record(hash)!] as const);
    }

    /** Writes the history through the configured persistence (on document save). */
    async persist(persistence = this.options.persistence): Promise<void> {
        if (persistence === undefined) return;
        this.flush();
        const unsaved = this.store.takeUnsaved();
        const added = unsaved.flatMap((hash) => {
            const record = this.store.record(hash);
            return record === undefined ? [] : [[hash, record] as const];
        });
        try {
            await persistence.save(this.document.id, this.repository.refs(), added, () =>
                this.reachableRecords(),
            );
        } catch (error) {
            this.store.restoreUnsaved(unsaved);
            throw error;
        }
    }

    /** The history as files (for the `.chili3d` project's `history/` folder). */
    exportEntries(): Record<string, string> {
        this.flush();
        return archiveToEntries(this.document.id, {
            refs: this.repository.refs(),
            records: this.reachableRecords(),
        });
    }

    /**
     * Replaces the history with one read from files. The document as loaded stays as it is:
     * if it differs from the imported head, that difference is recorded as a microversion.
     */
    importEntries(entries: Readonly<Record<string, Uint8Array | string>>): Result<void> {
        let archive: HistoryArchive | undefined;
        try {
            archive = entriesToArchive(entries);
        } catch (error) {
            return Result.err(`The version history could not be read: ${String(error)}`);
        }
        if (archive === undefined) return Result.err("No version history in the file");
        if (!archive.refs.branches.some((b) => archive.records.some(([hash]) => hash === b.head))) {
            return Result.err("The version history has no branch");
        }
        this.flush();
        this.importArchive(archive);
        this.invalidate();
        this.actions = [];
        this.start(undefined, "Synchronized with the opened file");
        return Result.ok(undefined);
    }
}

function childIds(node: INode): string[] {
    const ids: string[] = [];
    if (!NodeUtils.isLinkedListNode(node)) return ids;
    let child = node.firstChild;
    while (child !== undefined) {
        ids.push(child.id);
        child = child.nextSibling;
    }
    return ids;
}

function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
    if (a === undefined || b === undefined) return a === b;
    return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** A short name for what a history record did ("add nodes", "edit name"). */
function describeRecord(record: IHistoryRecord): string {
    if (record instanceof PropertyHistoryRecord) return `edit ${String(record.property)}`;
    if (record instanceof NodeLinkedListHistoryRecord) return "change structure";
    const name = record.name.trim();
    return name.length === 0 ? "edit" : name;
}

function messageOf(actions: readonly string[]): string {
    if (actions.length === 0) return "Edit";
    const shown = actions.slice(0, MESSAGE_ACTIONS).join(", ");
    const message =
        actions.length > MESSAGE_ACTIONS ? `${shown} (+${actions.length - MESSAGE_ACTIONS})` : shown;
    return message.charAt(0).toUpperCase() + message.slice(1);
}

/** Starts versioning `document` (see `DocumentVersionControl.attach`). */
export function attachVersionControl(
    document: IDocument,
    options?: VersionControlOptions,
): Promise<DocumentVersionControl> {
    return DocumentVersionControl.attach(document, options);
}

/** The history of `document` as files, keyed relative to the project's `history/` folder. */
export function exportHistory(document: IDocument): Record<string, Uint8Array | string> {
    return DocumentVersionControl.of(document)?.exportEntries() ?? {};
}

/** Loads a history exported by `exportHistory` into the (already versioned) `document`. */
export function importHistory(
    document: IDocument,
    entries: Readonly<Record<string, Uint8Array | string>>,
): Result<void> {
    const control = DocumentVersionControl.of(document);
    if (control === undefined) return Result.err("The document is not under version control");
    return control.importEntries(entries);
}

/**
 * The history as a project-file extension folder — shaped for a project format's entry-provider
 * hook (the `.chili3d` zip keeps it under `history/`): `write` exports every reachable object,
 * `read` imports them when the file is opened (a file without history keeps the history the
 * document already has). `exclusive`: the folder holds exactly what `write` produced.
 */
export const VERSION_HISTORY_ENTRY_PROVIDER = {
    prefix: "history/",
    name: "version-history",
    version: HISTORY_FORMAT_VERSION,
    exclusive: true,
    async write(document: IDocument): Promise<Record<string, Uint8Array | string>> {
        return exportHistory(document);
    },
    async read(document: IDocument, entries: Readonly<Record<string, Uint8Array | string>>): Promise<void> {
        if (Object.keys(entries).length === 0) return;
        const result = importHistory(document, entries);
        if (!result.isOk) throw new Error(result.error);
    },
} as const;
