// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { IHistoryRecord, NodeRecord } from "../foundation/history";
import { Id } from "../foundation/id";
import { Observable } from "../foundation/observer";
import { PubSub } from "../foundation/pubsub";
import { Transaction } from "../foundation/transaction";
import { I18n } from "../i18n";
import { DocumentElements } from "../ui/documentElements";
import { type FeatureItem, type IFeatureListNode, isFeatureListNode } from "./featureList";
import { FolderNode } from "./folderNode";
import { GeometryNode } from "./geometryNode";
import { setHistoryHiddenNodes } from "./historyPreview";
import { MeshNode } from "./meshNode";
import { type INode, type INodeLinkedList, NodeUtils } from "./node";
import { isDependentNode } from "./nodeDependencies";
import { isNodeSceneless } from "./nodeSceneless";
import { OriginNode } from "./originNode";

/**
 * The Part Studio timeline: ONE ordered list of everything that builds the model — sketches,
 * reference geometry and every feature of every feature-list node (body), interleaved in the
 * order they have to be applied — and ONE rollback position over it. The feature tree's
 * history bars and the horizontal timeline under the viewport are views of this model, so
 * moving one marker moves them all.
 *
 * - **Order.** Document order, except that an entry always follows what it reads (a feature
 *   its sketch and boolean tools, a sketch the body state it was drawn on — `anchors`), so a
 *   sketch defined later in the tree but consumed earlier moves up to its consumer. A body's
 *   features stay in their list order.
 * - **Rollback.** Entries before `position` are applied, the rest are the future. A position
 *   is applied with the two existing runtime mechanisms: the body holding the marker replays
 *   its features up to it (`setRollbackIndex`), a body or node entirely in the future is
 *   hidden (`setHistoryHidden`). Both are view state: never serialized, never transacted, so
 *   rolling is not an undo step and saving stores the full model.
 * - **Edits while rolled back.** The marker keeps its place by the entry right after it. An
 *   entry created while rolled back is placed at the marker (Onshape inserts there too) for
 *   the session — the document order itself is not edited.
 * - **Not steps.** Sceneless nodes — variables, Variable and Feature Studios, document files —
 *   hold values or code, not geometry: they never appear on the timeline.
 * - **Groups.** Steps can be grouped (Fusion's timeline groups): a group names a contiguous
 *   span of step keys and collapses to one chip. Groups are stored in the document's
 *   `userData` (saved with it) and grouping is an undo step; expanding is not.
 * - **Reordering.** `move(keys, to)` drags steps to another place in the application order:
 *   features move inside their body's list, nodes among their siblings, in one undo step —
 *   refused when a step would come before something it reads.
 */

interface TimelineEntryBase {
    /** Stable across rebuilds: the node id, plus `/featureId` for a feature. */
    readonly key: string;
    readonly node: INode;
}

/** A node applied as one step: a sketch, a reference plane, an imported or primitive solid… */
export interface NodeTimelineEntry extends TimelineEntryBase {
    readonly kind: "node";
}

/** One feature of a feature-list node (a parametric body). */
export interface FeatureTimelineEntry extends TimelineEntryBase {
    readonly kind: "feature";
    readonly node: INode & IFeatureListNode;
    readonly feature: FeatureItem;
    /** Index in the node's own feature list. */
    readonly featureIndex: number;
}

export type PartStudioTimelineEntry = NodeTimelineEntry | FeatureTimelineEntry;

/**
 * The parts a step builds or feeds — what the timeline's coloured bars show. `owner` is the
 * part the step belongs to: a body for its feature, a solid or mesh node for itself, and for a
 * sketch or plane the first part (in timeline order) consuming it. `users` are the other parts
 * relying on the step: a sketch read by a second body, a body used as a boolean tool or drawn
 * on by another body's sketch (its features up to the sketch's anchor).
 */
export interface TimelineLanes {
    readonly owner: INode | undefined;
    readonly users: readonly INode[];
}

/** A group of steps on the timeline (Fusion's timeline groups), stored with the document. */
export interface TimelineGroup {
    readonly id: string;
    readonly name: string;
    /** The keys of its steps: a contiguous span when created; steps that vanish leave it. */
    readonly keys: readonly string[];
    readonly collapsed: boolean;
}

/** Where a document keeps its timeline groups (`IDocument.userData`). */
export const TIMELINE_GROUPS_KEY = "partStudioTimelineGroups";

/** Where a node (and everything under it) stands relative to the marker. */
export type TimelineNodeState = "applied" | "partial" | "future";

/** Property changes that never move the timeline (geometry and display only). */
const IGNORED_PROPERTIES = new Set([
    "shape",
    "transform",
    "visible",
    "parentVisible",
    "color",
    "opacity",
    "materialId",
    "evaluationError",
]);

const timelines = new WeakMap<IDocument, PartStudioTimeline>();

export class PartStudioTimeline extends Observable {
    /** The one timeline of a document, created on first use. */
    static of(document: IDocument): PartStudioTimeline {
        let timeline = timelines.get(document);
        if (timeline === undefined) {
            timeline = new PartStudioTimeline(document);
            timelines.set(document, timeline);
        }
        return timeline;
    }

    private _entries: readonly PartStudioTimelineEntry[] = [];
    private _position = 0;
    /** The key of the first future entry; undefined at the end. */
    private anchorKey: string | undefined;
    private signature = "";
    /** Entries created while rolled back, placed before the anchor they were created at. */
    private readonly hints = new Map<string, string>();
    private readonly watched = new Set<INode>();
    private dirty = false;
    private queued = false;
    private applying = false;
    private reasserting = false;
    private _groups: readonly TimelineGroup[] = [];

    private constructor(readonly document: IDocument) {
        super();
        document.modelManager.addNodeObserver(this.handleNodesChanged);
        this._groups = readGroups(document);
        this.refresh();
    }

    /** The timeline's groups, in creation order. */
    get groups(): readonly TimelineGroup[] {
        return this._groups;
    }

    /** The group a step belongs to, if any. */
    groupOf(key: string): TimelineGroup | undefined {
        return this._groups.find((group) => group.keys.includes(key));
    }

    /**
     * Groups the contiguous span of steps from the first to the last of `keys` (Fusion groups a
     * selection with its gaps); steps already grouped leave their group, which goes when empty.
     * An undo step. Returns the group, or undefined when none of the keys is a step.
     */
    group(keys: readonly string[], name?: string): TimelineGroup | undefined {
        this.flush();
        const indexes = keys
            .map((key) => this._entries.findIndex((entry) => entry.key === key))
            .filter((index) => index >= 0);
        if (indexes.length === 0) return undefined;
        const span = this._entries
            .slice(Math.min(...indexes), Math.max(...indexes) + 1)
            .map((entry) => entry.key);
        const others = this._groups
            .map((group) => ({ ...group, keys: group.keys.filter((key) => !span.includes(key)) }))
            .filter((group) => group.keys.length > 0);
        const group: TimelineGroup = {
            id: Id.generate(),
            name: name?.trim() || I18n.translate("timeline.groupName{0}", this._groups.length + 1),
            keys: span,
            collapsed: true,
        };
        this.writeGroups([...others, group], "timeline: group steps");
        return group;
    }

    /** Dissolves a group (an undo step); its steps stay where they are. */
    ungroup(id: string): void {
        if (!this._groups.some((group) => group.id === id)) return;
        this.writeGroups(
            this._groups.filter((group) => group.id !== id),
            "timeline: ungroup steps",
        );
    }

    /** Renames a group (an undo step); an empty name keeps the old one. */
    renameGroup(id: string, name: string): void {
        const trimmed = name.trim();
        const group = this._groups.find((group) => group.id === id);
        if (group === undefined || trimmed === "" || trimmed === group.name) return;
        this.writeGroups(
            this._groups.map((group) => (group.id === id ? { ...group, name: trimmed } : group)),
            "timeline: rename group",
        );
    }

    /** Collapses or expands a group: saved with the document, not an undo step. */
    setGroupCollapsed(id: string, collapsed: boolean): void {
        const group = this._groups.find((group) => group.id === id);
        if (group === undefined || group.collapsed === collapsed) return;
        this.writeGroups(this._groups.map((group) => (group.id === id ? { ...group, collapsed } : group)));
    }

    /**
     * The order with `keys` moved before the step at `to` (counted in the order without
     * them), or undefined when a moved step would then precede something it reads.
     */
    reordered(keys: readonly string[], to: number): PartStudioTimelineEntry[] | undefined {
        const wanted = new Set(keys);
        const moving = this._entries.filter((entry) => wanted.has(entry.key));
        if (moving.length === 0) return undefined;
        const rest = this._entries.filter((entry) => !wanted.has(entry.key));
        const at = Math.max(0, Math.min(rest.length, Math.round(to)));
        const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
        return orderRespectsDependencies(next) && orderIsRealizable(next) ? next : undefined;
    }

    /** Whether `move(keys, to)` would be accepted. */
    canMove(keys: readonly string[], to: number): boolean {
        return this.reordered(keys, to) !== undefined;
    }

    /**
     * Moves steps (one, or a group's, kept in their order) to another position in the
     * application order: the document changes underneath — features inside their body's
     * list, nodes among their siblings — as one undo step. Returns false, changing nothing,
     * when a step would come before something it reads.
     */
    move(keys: readonly string[], to: number): boolean {
        this.flush();
        const next = this.reordered(keys, to);
        if (next === undefined) return false;
        if (next.every((entry, i) => entry === this._entries[i])) return true;
        Transaction.execute(this.document, "timeline: reorder", () => applyOrder(this.document, next));
        this.refresh();
        return true;
    }

    private writeGroups(groups: readonly TimelineGroup[], record?: string): void {
        const old = this._groups;
        const apply = (next: readonly TimelineGroup[]) => {
            this._groups = next;
            this.document.userData ??= {};
            const data = this.document.userData;
            if (next.length === 0) delete data[TIMELINE_GROUPS_KEY];
            else data[TIMELINE_GROUPS_KEY] = next.map((group) => ({ ...group, keys: [...group.keys] }));
            this.emitPropertyChanged("groups", old);
        };
        apply(groups);
        if (record === undefined) return;
        const step: IHistoryRecord = {
            name: record,
            undo: () => apply(old),
            redo: () => apply(groups),
            dispose: () => {},
        };
        this.document.history.add(step);
    }

    /** Drops the keys of steps that no longer exist from the groups (and empty groups). */
    private pruneGroups(entries: readonly PartStudioTimelineEntry[]): void {
        const keys = new Set(entries.map((entry) => entry.key));
        const pruned = this._groups
            .map((group) => ({ ...group, keys: group.keys.filter((key) => keys.has(key)) }))
            .filter((group) => group.keys.length > 0);
        const same =
            pruned.length === this._groups.length &&
            pruned.every((group, i) => group.keys.length === this._groups[i].keys.length);
        if (!same) this.writeGroups(pruned);
    }

    /** Every step, in application order. */
    get entries(): readonly PartStudioTimelineEntry[] {
        return this._entries;
    }

    /** How many entries are applied: the marker sits before `entries[position]`. */
    get position(): number {
        return this._position;
    }

    get length(): number {
        return this._entries.length;
    }

    get isRolledBack(): boolean {
        return this._position < this._entries.length;
    }

    isFuture(index: number): boolean {
        return index >= this._position;
    }

    /**
     * Moves the marker and applies it. A position the kernel cannot rebuild restores the
     * previous one, reports it, and returns false.
     */
    rollTo(position: number): boolean {
        this.flush();
        const target = Math.max(0, Math.min(this._entries.length, Math.round(position)));
        const previous = this._position;
        if (!this.apply(target)) {
            this.apply(previous);
            PubSub.default.pub("displayError", I18n.translate("timeline.rollbackFailed"));
            this.flush();
            return false;
        }
        this.setPosition(target);
        this.flush();
        return true;
    }

    step(delta: number): boolean {
        return this.rollTo(this._position + delta);
    }

    start(): boolean {
        return this.rollTo(0);
    }

    end(): boolean {
        return this.rollTo(this._entries.length);
    }

    /** The entry index of a node, or of one of its features; -1 when it has none. */
    indexOf(node: INode, featureId?: string): number {
        return this._entries.findIndex(
            (entry) =>
                entry.node === node &&
                (featureId === undefined ? true : entry.kind === "feature" && entry.feature.id === featureId),
        );
    }

    /** Applied, future or split by the marker — over `node` and everything under it. */
    nodeState(node: INode): TimelineNodeState {
        let applied = false;
        let future = false;
        this._entries.forEach((entry, index) => {
            if (!isWithin(entry.node, node)) return;
            if (index < this._position) applied = true;
            else future = true;
        });
        if (applied && future) return "partial";
        return future ? "future" : "applied";
    }

    /** How many of a feature-list node's features are applied (all of them at the end). */
    appliedFeatureCount(node: INode): number {
        const indexes = this.featureIndexes(node);
        if (indexes.length === 0) return isFeatureListNode(node) ? node.featureItems().length : 0;
        return indexes.filter((index) => index < this._position).length;
    }

    /**
     * A feature list's own rollback bar: the marker before its feature `featureIndex`, or right
     * after its last feature for `featureIndex >= count` (unchanged when already past it).
     */
    rollToFeature(node: INode, featureIndex: number): boolean {
        const indexes = this.featureIndexes(node);
        if (indexes.length === 0) return true;
        if (featureIndex < indexes.length) return this.rollTo(indexes[Math.max(0, featureIndex)]);
        const after = indexes[indexes.length - 1] + 1;
        return this._position >= after ? true : this.rollTo(after);
    }

    /**
     * The marker right after the entry of `node` (or of its feature `featureId`): the model as
     * it stood with that step just applied — what opening a step shows (Onshape's Edit rolls
     * back to the feature; Fusion's double-click too). False when the node has no entry.
     */
    rollAfter(node: INode, featureId?: string): boolean {
        const index = this.indexOf(node, featureId);
        if (index < 0) return false;
        return this._position === index + 1 ? true : this.rollTo(index + 1);
    }

    /** The marker before the first entry of any of `nodes` (or their contents); the end when none has one. */
    rollBefore(nodes: readonly INode[]): boolean {
        const index = this._entries.findIndex((entry) => nodes.some((node) => isWithin(entry.node, node)));
        return this.rollTo(index < 0 ? this._entries.length : index);
    }

    /** Re-reads the document now (changes are otherwise picked up in a microtask). */
    refresh(): void {
        this.dirty = false;
        const previous = this._entries;
        const wasRolledBack = this._position < previous.length;
        let next = partStudioTimelineEntries(this.document, this.hints);
        if (wasRolledBack && this.anchorKey !== undefined && previous.length > 0) {
            const known = new Set(previous.map((entry) => entry.key));
            const created = next.filter((entry) => !known.has(entry.key) && !this.hints.has(entry.key));
            if (created.length > 0) {
                for (const entry of created) this.hints.set(entry.key, this.anchorKey);
                next = partStudioTimelineEntries(this.document, this.hints);
            }
        }
        const keys = new Set(next.map((entry) => entry.key));
        for (const key of [...this.hints.keys()]) if (!keys.has(key)) this.hints.delete(key);

        const position = wasRolledBack ? this.remapPosition(previous, next) : next.length;
        this.watch(next);
        const signature = entriesSignature(next);
        if (signature !== this.signature) {
            this.signature = signature;
            this.setEntries(next);
        } else {
            this._entries = next;
        }
        this.pruneGroups(next);
        this.setPosition(position);
        if (wasRolledBack) this.reassert();
    }

    protected override disposeInternal(): void {
        this.document.modelManager.removeNodeObserver(this.handleNodesChanged);
        for (const node of this.watched) node.removePropertyChanged(this.handleNodeChanged);
        this.watched.clear();
        timelines.delete(this.document);
        super.disposeInternal();
    }

    private featureIndexes(node: INode): number[] {
        const indexes: number[] = [];
        this._entries.forEach((entry, index) => {
            if (entry.kind === "feature" && entry.node === node) indexes.push(index);
        });
        return indexes;
    }

    /** The marker stays before the entry it was before; that entry gone, before the next survivor. */
    private remapPosition(
        previous: readonly PartStudioTimelineEntry[],
        next: readonly PartStudioTimelineEntry[],
    ) {
        const index = new Map(next.map((entry, i) => [entry.key, i]));
        for (let i = this._position; i < previous.length; i++) {
            const at = index.get(previous[i].key);
            if (at !== undefined) return at;
        }
        return next.length;
    }

    /**
     * A session that rolled a body back on its own (a sketch being edited) restores it to its
     * full list when it ends. While the marker is rolled back that body must follow the
     * marker again, so its rollback is re-applied — only for a body found fully restored
     * (`rollbackIndex` undefined) that the marker cuts short; an open feature dialog sets a
     * numeric rollback and is left alone.
     */
    private reassert(): void {
        if (this.applying || this.reasserting) return;
        const counts = this.featureCounts(this._position);
        let stale = false;
        for (const [node, { applied, total }] of counts) {
            if (applied > 0 && applied < total && node.rollbackIndex === undefined) stale = true;
        }
        if (!stale) return;
        queueMicrotask(() => {
            if (!this.isRolledBack || this._isDisposed) return;
            this.reasserting = true;
            try {
                if (!this.apply(this._position)) {
                    this.apply(this._entries.length);
                    this.setPosition(this._entries.length);
                }
            } finally {
                this.reasserting = false;
            }
            this.flush();
        });
    }

    private featureCounts(position: number) {
        const counts = new Map<INode & IFeatureListNode, { applied: number; total: number; last: number }>();
        this._entries.forEach((entry, index) => {
            if (entry.kind !== "feature") return;
            const count = counts.get(entry.node) ?? { applied: 0, total: 0, last: index };
            count.total++;
            count.last = index;
            if (index < position) count.applied++;
            counts.set(entry.node, count);
        });
        return counts;
    }

    /** Shows `position`: replays bodies, hides what lies entirely in the future. */
    private apply(position: number): boolean {
        this.applying = true;
        let ok = true;
        try {
            const hidden: [INode, boolean][] = [];
            this._entries.forEach((entry, index) => {
                if (entry.kind === "node") hidden.push([entry.node, index >= position]);
            });
            // Sources before the bodies consuming them: by the timeline index of their last feature.
            const counts = [...this.featureCounts(position)].sort((a, b) => a[1].last - b[1].last);
            for (const [node, { applied, total }] of counts) {
                hidden.push([node, applied === 0]);
                // A body with nothing applied is hidden whole; replaying an empty list builds nothing.
                const target = applied === 0 || applied >= total ? undefined : applied;
                if (node.rollbackIndex === target || node.setRollbackIndex === undefined) continue;
                if (!node.setRollbackIndex(target)) ok = false;
            }
            setHistoryHiddenNodes(this.document, hidden);
        } finally {
            this.applying = false;
        }
        return ok;
    }

    private setPosition(position: number): void {
        this.anchorKey = this._entries[position]?.key;
        if (position === this._position) return;
        const old = this._position;
        this._position = position;
        this.emitPropertyChanged("position", old);
    }

    private setEntries(entries: readonly PartStudioTimelineEntry[]): void {
        const old = this._entries;
        this._entries = entries;
        this.emitPropertyChanged("entries", old);
    }

    private flush(): void {
        if (this.dirty) this.refresh();
    }

    private markDirty(): void {
        this.dirty = true;
        if (this.applying || this.queued) return;
        this.queued = true;
        queueMicrotask(() => {
            this.queued = false;
            if (this.dirty && !this._isDisposed) this.refresh();
        });
    }

    private watch(entries: readonly PartStudioTimelineEntry[]): void {
        const nodes = new Set<INode>(entries.map((entry) => entry.node));
        for (const node of this.watched) {
            if (nodes.has(node)) continue;
            node.removePropertyChanged(this.handleNodeChanged);
            this.watched.delete(node);
        }
        for (const node of nodes) {
            if (this.watched.has(node)) continue;
            node.onPropertyChanged(this.handleNodeChanged);
            this.watched.add(node);
        }
    }

    private readonly handleNodesChanged = (_records: NodeRecord[]) => this.markDirty();

    private readonly handleNodeChanged = (property: string | number | symbol) => {
        if (!IGNORED_PROPERTIES.has(String(property))) this.markDirty();
    };
}

function isWithin(node: INode | undefined, container: INode): boolean {
    for (let current = node; current !== undefined; current = current.parent) {
        if (current === container) return true;
    }
    return false;
}

/** The datum folder of a new document: the origin and the three default planes. */
function isDatumFolder(node: INodeLinkedList): boolean {
    for (let child = node.firstChild; child !== undefined; child = child.nextSibling) {
        if (child instanceof OriginNode) return true;
    }
    return false;
}

/** The document's timeline entries in document order: folders flattened, bodies expanded. */
function documentEntries(document: IDocument): PartStudioTimelineEntry[] {
    const entries: PartStudioTimelineEntry[] = [];
    const walk = (list: INodeLinkedList) => {
        for (let child = list.firstChild; child !== undefined; child = child.nextSibling) visit(child);
    };
    const visit = (node: INode) => {
        // Variables, studios and document files hold values or code, not geometry: not steps.
        if (node instanceof OriginNode || DocumentElements.hiddenInTree(node) || isNodeSceneless(node))
            return;
        const isList = NodeUtils.isLinkedListNode(node);
        if (isFeatureListNode(node)) {
            const items = node.featureItems();
            if (items.length === 0) entries.push({ kind: "node", key: node.id, node });
            items.forEach((feature, featureIndex) => {
                entries.push({
                    kind: "feature",
                    key: `${node.id}/${feature.id}`,
                    node,
                    feature,
                    featureIndex,
                });
            });
            // Consumed boolean tools live under the body; their own steps come before the boolean.
            if (isList) walk(node);
            return;
        }
        if (isList) {
            if (!(node instanceof FolderNode && isDatumFolder(node))) walk(node);
            return;
        }
        entries.push({ kind: "node", key: node.id, node });
    };
    const root = document.modelManager?.rootNode;
    if (root !== undefined) walk(root);
    return entries;
}

/**
 * The entries in application order: a stable topological sort — of the entries whose
 * dependencies are met, the one earliest in document order goes next. `hints` place an
 * entry right before another (by key). A dependency cycle drops a sketch's unanchored "whole
 * body" dependency first, then falls back to document order.
 */
export function partStudioTimelineEntries(
    document: IDocument,
    hints: ReadonlyMap<string, string> = new Map(),
): PartStudioTimelineEntry[] {
    const entries = documentEntries(document);
    const byNode = new Map<string, number[]>();
    entries.forEach((entry, index) => {
        const list = byNode.get(entry.node.id) ?? [];
        list.push(index);
        byNode.set(entry.node.id, list);
    });
    const strong = entries.map(() => new Set<number>());
    const weak = entries.map(() => new Set<number>());
    entries.forEach((entry, index) => {
        if (entry.kind === "feature") {
            if (entry.featureIndex > 0) strong[index].add(index - 1);
            const ids = entry.feature.nodeIds ?? entry.feature.references?.map((ref) => ref.node.id) ?? [];
            for (const id of ids) {
                if (id === entry.node.id) continue;
                const last = byNode.get(id)?.at(-1);
                if (last !== undefined && last !== index) strong[index].add(last);
            }
            return;
        }
        if (!isDependentNode(entry.node)) return;
        const dependencies = entry.node.dependencies();
        for (const id of dependencies.nodeIds) {
            const list = byNode.get(id);
            if (list === undefined || id === entry.node.id) continue;
            const anchor = dependencies.anchors?.[id];
            if (anchor === undefined) {
                // A whole body read without an anchor: after it, unless that closes a cycle.
                const last = list[list.length - 1];
                (entries[last].kind === "feature" ? weak : strong)[index].add(last);
            } else if (anchor > 0) {
                strong[index].add(list[Math.min(anchor, list.length) - 1]);
            }
        }
    });

    // A hinted entry sorts just before its anchor (itself possibly hinted), in hint order.
    const indexOfKey = new Map(entries.map((entry, index) => [entry.key, index]));
    const sequence = new Map([...hints.keys()].map((key, i) => [key, i]));
    const priorityOf = (index: number, depth: number): number => {
        const key = entries[index].key;
        const at = indexOfKey.get(hints.get(key) ?? "");
        if (at === undefined || depth > entries.length) return index;
        return priorityOf(at, depth + 1) - 1e-3 + (sequence.get(key) ?? 0) * 1e-7;
    };
    const priority = entries.map((_, index) => priorityOf(index, 0));

    const done = entries.map(() => false);
    const met = (deps: Set<number>) => [...deps].every((dep) => done[dep]);
    const order: PartStudioTimelineEntry[] = [];
    while (order.length < entries.length) {
        let pick = -1;
        for (let i = 0; i < entries.length; i++) {
            if (done[i] || !met(strong[i]) || !met(weak[i])) continue;
            if (pick < 0 || priority[i] < priority[pick]) pick = i;
        }
        if (pick < 0) {
            // A cycle: release the earliest entry holding an unanchored body dependency, else the earliest.
            let release = -1;
            for (let i = 0; i < entries.length; i++) {
                if (done[i] || weak[i].size === 0) continue;
                if (release < 0 || priority[i] < priority[release]) release = i;
            }
            if (release >= 0) {
                weak[release].clear();
                continue;
            }
            for (let i = 0; i < entries.length; i++) {
                if (!done[i] && (pick < 0 || priority[i] < priority[pick])) pick = i;
            }
        }
        done[pick] = true;
        order.push(entries[pick]);
    }
    return order;
}

/** What the views show of the entries — they re-render only when this changes. */
function entriesSignature(entries: readonly PartStudioTimelineEntry[]): string {
    return entries
        .map((entry) =>
            entry.kind === "node"
                ? `${entry.key}|${entry.node.name}`
                : [
                      entry.key,
                      entry.node.name,
                      entry.feature.name ?? "",
                      entry.feature.display,
                      entry.feature.icon ?? "",
                      entry.feature.error ?? "",
                      entry.feature.warning ?? "",
                      entry.feature.suppressed === true,
                  ].join("|"),
        )
        .join("\n");
}

/** A node the timeline colours as a part: a body, a solid or a mesh — not a sketch or a plane. */
export function isTimelinePart(node: INode): boolean {
    if (isFeatureListNode(node)) return true;
    if (node instanceof GeometryNode) return !isDependentNode(node);
    return node instanceof MeshNode;
}

/**
 * The parts behind every step (see `TimelineLanes`): a feature belongs to its body; a solid
 * node to itself; a sketch to the first part consuming it. A part relying on another part's
 * step — through a feature reading the node (a tool body, a shared sketch) or through its
 * sketch drawn on that body (its features up to the sketch's anchor) — is a user of the step.
 */
export function timelineLanes(entries: readonly PartStudioTimelineEntry[]): TimelineLanes[] {
    const indexesOf = new Map<string, number[]>();
    const order = new Map<INode, number>();
    entries.forEach((entry, index) => {
        const list = indexesOf.get(entry.node.id) ?? [];
        list.push(index);
        indexesOf.set(entry.node.id, list);
        if (isTimelinePart(entry.node) && !order.has(entry.node)) order.set(entry.node, index);
    });
    const users = entries.map(() => new Set<INode>());
    /** `part` reads the steps of node `id` (the first `upTo` of them, all without). */
    const use = (id: string, part: INode, upTo?: number) => {
        const indexes = indexesOf.get(id);
        if (indexes === undefined) return;
        const limit = upTo === undefined ? indexes.length : Math.min(upTo, indexes.length);
        for (let i = 0; i < limit; i++) {
            if (entries[indexes[i]].node !== part) users[indexes[i]].add(part);
        }
    };
    for (const entry of entries) {
        if (entry.kind !== "feature") continue;
        const ids = entry.feature.nodeIds ?? entry.feature.references?.map((ref) => ref.node.id) ?? [];
        for (const id of ids) if (id !== entry.node.id) use(id, entry.node);
    }
    // A sketch drawn on a body: the parts consuming the sketch rely on that body up to the anchor.
    entries.forEach((entry, index) => {
        if (entry.kind !== "node" || isTimelinePart(entry.node) || !isDependentNode(entry.node)) return;
        const parts = [...users[index]];
        if (parts.length === 0) return;
        const dependencies = entry.node.dependencies();
        for (const id of dependencies.nodeIds) {
            if (id === entry.node.id) continue;
            const anchor = dependencies.anchors?.[id];
            for (const part of parts) use(id, part, anchor);
        }
    });
    const byOrder = (a: INode, b: INode) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity);
    return entries.map((entry, index) => {
        const sorted = [...users[index]].sort(byOrder);
        if (entry.kind === "feature" || isTimelinePart(entry.node)) {
            return { owner: entry.node, users: sorted.filter((part) => part !== entry.node) };
        }
        return { owner: sorted[0], users: sorted.slice(1) };
    });
}

/** The groups stored with a document; anything malformed is dropped. */
function readGroups(document: IDocument): TimelineGroup[] {
    const raw = document.userData?.[TIMELINE_GROUPS_KEY];
    if (!Array.isArray(raw)) return [];
    const groups: TimelineGroup[] = [];
    for (const item of raw) {
        if (typeof item !== "object" || item === null) continue;
        const { id, name, keys, collapsed } = item as Record<string, unknown>;
        if (typeof id !== "string" || typeof name !== "string" || !Array.isArray(keys)) continue;
        const valid = keys.filter((key): key is string => typeof key === "string");
        if (valid.length === 0) continue;
        groups.push({ id, name, keys: valid, collapsed: collapsed !== false });
    }
    return groups;
}

/** Whether every step of `order` comes after what it reads (the strong dependencies). */
export function orderRespectsDependencies(order: readonly PartStudioTimelineEntry[]): boolean {
    const positions = new Map<string, number[]>();
    order.forEach((entry, index) => {
        const list = positions.get(entry.node.id) ?? [];
        list.push(index);
        positions.set(entry.node.id, list);
    });
    const last = (id: string) => positions.get(id)?.at(-1);
    return order.every((entry, index) => {
        if (entry.kind === "feature") {
            const ids = entry.feature.nodeIds ?? entry.feature.references?.map((ref) => ref.node.id) ?? [];
            return ids.every((id) => {
                if (id === entry.node.id) return true;
                const at = last(id);
                return at === undefined || at < index;
            });
        }
        if (!isDependentNode(entry.node)) return true;
        const dependencies = entry.node.dependencies();
        return dependencies.nodeIds.every((id) => {
            if (id === entry.node.id) return true;
            const list = positions.get(id);
            if (list === undefined) return true;
            const anchor = dependencies.anchors?.[id];
            if (anchor === undefined) return list[list.length - 1] < index;
            return anchor === 0 || list[Math.min(anchor, list.length) - 1] < index;
        });
    });
}

/**
 * Whether the document can hold `order`: a body's features stand together in the document, so
 * a step of another node between two of them must be one a later feature of that body reads
 * (the sort then interleaves it). Anything else would silently snap back.
 */
export function orderIsRealizable(order: readonly PartStudioTimelineEntry[]): boolean {
    const bodies = new Set(order.filter((entry) => entry.kind === "feature").map((entry) => entry.node));
    for (const body of bodies) {
        const indexes = order.flatMap((entry, index) => (entry.node === body ? [index] : []));
        for (let i = 1; i < indexes.length; i++) {
            for (let between = indexes[i - 1] + 1; between < indexes[i]; between++) {
                const stranger = order[between].node;
                const read = order
                    .slice(indexes[i])
                    .some(
                        (entry) =>
                            entry.kind === "feature" &&
                            entry.node === body &&
                            (
                                entry.feature.nodeIds ??
                                entry.feature.references?.map((ref) => ref.node.id) ??
                                []
                            ).includes(stranger.id),
                    );
                if (!read) return false;
            }
        }
    }
    return true;
}

/**
 * Makes the document follow `order`: each body's features take the order they have in it,
 * and in every folder the children that are steps take the order their first step has —
 * nodes that are no step (the datums) keep their places.
 */
export function applyOrder(document: IDocument, order: readonly PartStudioTimelineEntry[]): void {
    const firstIndex = new Map<INode, number>();
    const featureOrder = new Map<INode & IFeatureListNode, string[]>();
    const root = document.modelManager.rootNode;
    order.forEach((entry, index) => {
        // A folder stands where its first step stands: it moves with its contents.
        for (
            let node: INode | undefined = entry.node;
            node !== undefined && node !== root;
            node = node.parent
        )
            if (!firstIndex.has(node)) firstIndex.set(node, index);
        if (entry.kind === "feature") {
            const ids = featureOrder.get(entry.node) ?? [];
            ids.push(entry.feature.id);
            featureOrder.set(entry.node, ids);
        }
    });
    for (const [node, ids] of featureOrder) {
        const current = node.featureItems().map((item) => item.id);
        if (current.length === ids.length && current.every((id, i) => id === ids[i])) continue;
        if (node.moveFeatureTo !== undefined) {
            ids.forEach((id, i) => {
                node.moveFeatureTo?.(id, i);
            });
            continue;
        }
        // Only steps of one: walk each feature up to its place.
        ids.forEach((id, i) => {
            for (let at = node.featureItems().findIndex((item) => item.id === id); at > i; at--)
                node.moveFeature(id, -1);
        });
    }
    const parents = new Set<INodeLinkedList>();
    for (const node of firstIndex.keys()) if (node.parent !== undefined) parents.add(node.parent);
    for (const parent of parents) {
        const children: INode[] = [];
        for (let child = parent.firstChild; child !== undefined; child = child.nextSibling)
            children.push(child);
        const steps = children.filter((child) => firstIndex.has(child));
        const wanted = [...steps].sort((a, b) => firstIndex.get(a)! - firstIndex.get(b)!);
        if (wanted.every((child, i) => child === steps[i])) continue;
        // The run of steps starts where the first of them stands now: after the last fixed node before it.
        let previous: INode | undefined = steps[0]?.previousSibling;
        while (previous !== undefined && firstIndex.has(previous)) previous = previous.previousSibling;
        for (const child of wanted) {
            if (child.previousSibling !== previous || child.parent !== parent)
                parent.move(child, parent, previous);
            previous = child;
        }
    }
}
