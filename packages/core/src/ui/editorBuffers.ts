// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { IDisposable } from "../foundation/disposable";
import { Logger } from "../foundation/logger";
import { PubSub } from "../foundation/pubsub";
import type { Result } from "../foundation/result";
import { I18n } from "../i18n";
import type { INode } from "../model/node";
import { DocumentElements } from "./documentElements";

/**
 * EDITOR BUFFERS — the one contract every in-app text or document editor follows for the
 * edits it holds but has not written into its node yet (a Feature Studio's source, a document
 * element's text, sheet or rich text, an NC program, a database's live copy):
 *
 * - the editor edits a DRAFT; `commit()` writes it into the node as ONE undo step and
 *   `revert()` drops it, showing the node's content again;
 * - while mounted, the editor registers its buffer (`EditorBuffers.register`) and reports every
 *   edit through the registration's `changed()`;
 * - the app reads the registry: element tabs mark dirty elements, closing a document asks
 *   Save / Discard / Cancel (`ask` + `commitAll`), deleting an element says its draft goes,
 *   and leaving the page warns;
 * - the recovery autosave stores each dirty buffer's `snapshot()` with the document
 *   (`snapshots`), and reopening the document offers them back (`offerRecovery`). A restored
 *   draft is a draft again — it is never committed on its own.
 */

/** A caret or selection in a text draft, as character offsets. */
export interface EditorSelection {
    readonly anchor: number;
    readonly head: number;
}

/** A draft as data: the editor's own encoding (text, JSON, base64) and, for text, the selection. */
export interface EditorDraftData {
    readonly data: string;
    readonly selection?: EditorSelection;
}

/** A draft stored for recovery, with what finds its editor again. */
export interface EditorDraft extends EditorDraftData {
    /** The edited node's id. */
    readonly nodeId: string;
    /** Which editor wrote it (see `IEditorBuffer.editor`); only that editor reads it back. */
    readonly editor: string;
    /** The node's name when written, to list the draft. */
    readonly name: string;
    /** When the snapshot was taken (ms since the epoch). */
    readonly savedAt: number;
}

/** The uncommitted draft of one editor. */
export interface IEditorBuffer {
    readonly document: IDocument;
    /** The node whose content the draft edits. */
    readonly node: INode;
    /** The editor's id (`text`, `spreadsheet`, `featureStudio`, …): the format of its snapshots. */
    readonly editor: string;
    /** The draft differs from the node. */
    isDirty(): boolean;
    /** Writes the draft into the node: one undo step. An error leaves the draft dirty. */
    commit(): Promise<Result<void>>;
    /** Drops the draft and shows the node's content again. */
    revert(): void;
    /** The draft as data, for recovery; undefined when there is nothing to keep. */
    snapshot?(): EditorDraftData | undefined;
    /** Puts a recovered draft back as the (dirty, uncommitted) draft. */
    restore?(draft: EditorDraftData): void | Promise<void>;
}

/** What `register` returns: report edits through it, dispose it when the editor goes. */
export interface EditorBufferRegistration extends IDisposable {
    /** The draft may have changed (an edit, a commit, a revert). */
    changed(): void;
}

export type UnsavedDecision = "save" | "discard" | "cancel";
export type RecoveryDecision = "restore" | "discard";

/** How the user is asked; the UI installs dialogs (`setPrompt`), the default uses `confirm`. */
export interface IEditorBufferPrompt {
    unsaved(buffers: readonly IEditorBuffer[]): Promise<UnsavedDecision>;
    recovered(document: IDocument, drafts: readonly EditorDraft[]): Promise<RecoveryDecision>;
}

/** The property of the stored document record that carries its drafts (outside `serialize()`). */
export const EDITOR_DRAFTS_KEY = "editorDrafts";

/** The names a prompt lists: one per node, in order. */
export function draftNames(items: readonly ({ node: INode } | EditorDraft)[]): string {
    const names = items.map((item) => ("node" in item ? item.node.name : item.name));
    return [...new Set(names)].join(", ");
}

/** Without a UI: never loses a draft without an OK — Cancel keeps everything open. */
const confirmPrompt: IEditorBufferPrompt = {
    unsaved: async (buffers) =>
        window.confirm(I18n.translate("editorBuffers.discard.confirm{0}", draftNames(buffers)))
            ? "discard"
            : "cancel",
    recovered: async (_document, drafts) =>
        window.confirm(I18n.translate("editorBuffers.recovered{0}", draftNames(drafts)))
            ? "restore"
            : "discard",
};

/** Reads the drafts of a stored document record (anything malformed is dropped). */
export function storedEditorDrafts(record: unknown): EditorDraft[] {
    const value = (record as Record<string, unknown> | undefined)?.[EDITOR_DRAFTS_KEY];
    if (!Array.isArray(value)) return [];
    return value.filter(
        (draft): draft is EditorDraft =>
            typeof draft === "object" &&
            draft !== null &&
            typeof draft.nodeId === "string" &&
            typeof draft.editor === "string" &&
            typeof draft.data === "string",
    );
}

interface Recovered {
    drafts: EditorDraft[];
    /** The user chose Restore: each draft goes back as its editor registers. */
    accepted: boolean;
}

export class EditorBufferRegistry {
    private readonly buffers = new Set<IEditorBuffer>();
    private readonly listeners = new Set<(document: IDocument) => void>();
    /** Drafts read back from storage and not yet restored or discarded, by document id. */
    private readonly recovered = new Map<string, Recovered>();
    private prompt: IEditorBufferPrompt = confirmPrompt;

    /** Installs the dialogs that ask the user; `undefined` restores the `confirm` fallback. */
    setPrompt(prompt: IEditorBufferPrompt | undefined): void {
        this.prompt = prompt ?? confirmPrompt;
    }

    /**
     * Adds a mounted editor's buffer. A recovered draft the user chose to restore for the same
     * node and editor is put back right away.
     */
    register(buffer: IEditorBuffer): EditorBufferRegistration {
        this.buffers.add(buffer);
        this.notify(buffer.document);
        void this.restoreInto(buffer);
        return {
            changed: () => {
                if (this.buffers.has(buffer)) this.notify(buffer.document);
            },
            dispose: () => {
                if (this.buffers.delete(buffer)) this.notify(buffer.document);
            },
        };
    }

    /** The registered buffers, of `document` (and `node`) when given. */
    buffersOf(document?: IDocument, node?: INode): IEditorBuffer[] {
        return [...this.buffers].filter(
            (buffer) =>
                (document === undefined || buffer.document === document) &&
                (node === undefined || buffer.node === node),
        );
    }

    /** The buffers holding uncommitted edits. */
    dirtyBuffers(document?: IDocument, node?: INode): IEditorBuffer[] {
        return this.buffersOf(document, node).filter((buffer) => isDirty(buffer));
    }

    /** Whether an editor of `node` holds uncommitted edits. */
    isDirty(node: INode): boolean {
        for (const buffer of this.buffers) if (buffer.node === node && isDirty(buffer)) return true;
        return false;
    }

    /** Called with the document whenever one of its buffers registers, changes or goes. */
    onChanged(listener: (document: IDocument) => void): IDisposable {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    /** Asks the user what to do with dirty buffers; nothing to ask is "discard" (nothing lost). */
    async ask(buffers: readonly IEditorBuffer[]): Promise<UnsavedDecision> {
        const dirty = buffers.filter((buffer) => isDirty(buffer));
        if (dirty.length === 0) return "discard";
        return this.prompt.unsaved(dirty);
    }

    /** Commits each dirty buffer (one undo step each); false at the first failure, reported. */
    async commitAll(buffers: readonly IEditorBuffer[]): Promise<boolean> {
        for (const buffer of buffers) {
            if (!isDirty(buffer)) continue;
            let error: string | undefined;
            try {
                const result = await buffer.commit();
                if (!result.isOk) error = String(result.error);
            } catch (thrown) {
                error = thrown instanceof Error ? thrown.message : String(thrown);
            }
            if (error !== undefined) {
                Logger.warn(`editor buffers: ${buffer.node.name} could not be saved`, error);
                PubSub.default.pub("showToast", "error.default:{0}", `${buffer.node.name}: ${error}`);
                return false;
            }
        }
        return true;
    }

    /** Reverts every buffer given. */
    revertAll(buffers: readonly IEditorBuffer[]): void {
        for (const buffer of buffers) {
            try {
                buffer.revert();
            } catch (error) {
                Logger.warn(`editor buffers: ${buffer.node.name} could not be reverted`, error);
            }
        }
    }

    /**
     * Asks, then acts: Save commits, Discard reverts, Cancel keeps all. True when the caller may
     * go ahead (close, leave) — no dirty buffers, a successful save, or a discard.
     */
    async settle(buffers: readonly IEditorBuffer[]): Promise<boolean> {
        const decision = await this.ask(buffers);
        if (decision === "cancel") return false;
        const dirty = buffers.filter((buffer) => isDirty(buffer));
        if (decision === "save") return this.commitAll(dirty);
        this.revertAll(dirty);
        return true;
    }

    /**
     * The drafts to store with `document`: every dirty buffer's snapshot, plus recovered drafts
     * no editor has taken back yet (so a recovery is never lost by the next save).
     */
    snapshots(document: IDocument, now = Date.now()): EditorDraft[] {
        const drafts: EditorDraft[] = [];
        const live = new Set<string>();
        for (const buffer of this.buffersOf(document)) {
            live.add(draftKey(buffer.node.id, buffer.editor));
            if (!isDirty(buffer) || buffer.snapshot === undefined) continue;
            try {
                const data = buffer.snapshot();
                if (data === undefined) continue;
                drafts.push({
                    nodeId: buffer.node.id,
                    editor: buffer.editor,
                    name: buffer.node.name,
                    savedAt: now,
                    data: data.data,
                    ...(data.selection === undefined ? {} : { selection: data.selection }),
                });
            } catch (error) {
                Logger.warn(`editor buffers: no snapshot of ${buffer.node.name}`, error);
            }
        }
        for (const draft of this.recovered.get(document.id)?.drafts ?? []) {
            if (!live.has(draftKey(draft.nodeId, draft.editor))) drafts.push(draft);
        }
        return drafts;
    }

    /** Drafts read back with a document; `offerRecovery` asks about them. */
    setRecovered(document: IDocument, drafts: readonly EditorDraft[]): void {
        if (drafts.length === 0) this.recovered.delete(document.id);
        else this.recovered.set(document.id, { drafts: [...drafts], accepted: false });
    }

    /** The recovered drafts of `document` not restored or discarded yet. */
    recoveredOf(document: IDocument): readonly EditorDraft[] {
        return this.recovered.get(document.id)?.drafts ?? [];
    }

    /**
     * Offers the recovered drafts of `document` back. Restore opens each draft's element, whose
     * editor takes the draft as it registers; Discard forgets them (the next save drops them).
     * Drafts of nodes no longer in the document are dropped. Undefined when there was none.
     */
    async offerRecovery(document: IDocument): Promise<RecoveryDecision | undefined> {
        const entry = this.recovered.get(document.id);
        if (entry === undefined) return undefined;
        const nodes = new Map(document.modelManager.findNodes().map((node) => [node.id, node]));
        entry.drafts = entry.drafts.filter((draft) => nodes.has(draft.nodeId));
        if (entry.drafts.length === 0) {
            this.recovered.delete(document.id);
            this.notify(document);
            return undefined;
        }
        const decision = await this.prompt.recovered(document, entry.drafts);
        if (this.recovered.get(document.id) !== entry) return decision;
        if (decision === "discard") {
            this.recovered.delete(document.id);
            this.notify(document);
            return decision;
        }
        entry.accepted = true;
        for (const buffer of this.buffersOf(document)) await this.restoreInto(buffer);
        for (const draft of [...entry.drafts]) {
            const node = nodes.get(draft.nodeId);
            if (node !== undefined) DocumentElements.open(document, node);
        }
        return decision;
    }

    /** Forgets a closed document's recovered drafts. */
    forget(document: IDocument): void {
        this.recovered.delete(document.id);
    }

    private async restoreInto(buffer: IEditorBuffer): Promise<void> {
        const entry = this.recovered.get(buffer.document.id);
        if (entry === undefined || !entry.accepted || buffer.restore === undefined) return;
        const key = draftKey(buffer.node.id, buffer.editor);
        const index = entry.drafts.findIndex((draft) => draftKey(draft.nodeId, draft.editor) === key);
        if (index < 0) return;
        const [draft] = entry.drafts.splice(index, 1);
        if (entry.drafts.length === 0) this.recovered.delete(buffer.document.id);
        try {
            await buffer.restore({
                data: draft.data,
                ...(draft.selection === undefined ? {} : { selection: draft.selection }),
            });
        } catch (error) {
            Logger.warn(`editor buffers: the draft of ${buffer.node.name} could not be restored`, error);
        }
        this.notify(buffer.document);
    }

    private notify(document: IDocument): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(document);
            } catch (error) {
                Logger.warn("editor buffers: a listener failed", error);
            }
        }
    }
}

function draftKey(nodeId: string, editor: string): string {
    return `${nodeId}\u0000${editor}`;
}

/** A buffer whose `isDirty` throws (a half-disposed view) counts as clean. */
function isDirty(buffer: IEditorBuffer): boolean {
    try {
        return buffer.isDirty();
    } catch {
        return false;
    }
}

/** The application-wide editor-buffer registry. */
export const EditorBuffers = new EditorBufferRegistry();
