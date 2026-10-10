// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Result } from "../foundation/result";
import { Transaction } from "../foundation/transaction";
import type { INode } from "../model/node";
import type { EditorDraftData, EditorSelection, IEditorBuffer } from "./editorBuffers";

export interface TextEditorBufferOptions {
    readonly document: IDocument;
    readonly node: INode;
    /** The editor's id, the format of its snapshots (see `IEditorBuffer.editor`). */
    readonly editor: string;
    /** The undo step's name. */
    readonly transaction: string;
    /** The node's committed text, as the editor holds it. */
    read(): string;
    /** Writes `text` into the node (inside the commit's transaction). */
    write(text: string): void;
    /** The draft in the editor. */
    text(): string;
    /** Replaces the draft without it counting as the user's edit (a revert, a restore, a reload). */
    show(text: string, selection?: EditorSelection): void;
    /** The editor's selection, kept with a snapshot. */
    selection?(): EditorSelection | undefined;
    /** Called after a commit, revert, restore or followed node change, to redraw the host's chrome. */
    changed?(): void;
}

/**
 * The editor buffer of a plain-text editor (a text document, Markdown, an NC program): the draft
 * is the editor's text, compared with a baseline — the node's text the draft was last in sync
 * with. `commit` writes the draft as one undo step; `nodeChanged` follows undo, redo or another
 * writer unless the draft holds edits of the user's own, which are kept.
 */
export class TextEditorBuffer implements IEditorBuffer {
    readonly document: IDocument;
    readonly node: INode;
    readonly editor: string;
    private baseline: string;

    constructor(private readonly options: TextEditorBufferOptions) {
        this.document = options.document;
        this.node = options.node;
        this.editor = options.editor;
        this.baseline = options.read();
    }

    /** The node's text the draft was last in sync with. */
    get saved(): string {
        return this.baseline;
    }

    isDirty(): boolean {
        return this.options.text() !== this.baseline;
    }

    async commit(): Promise<Result<void>> {
        if (!this.isDirty()) return Result.ok(undefined);
        const text = this.options.text();
        Transaction.execute(this.document, this.options.transaction, () => this.options.write(text));
        this.baseline = text;
        this.options.changed?.();
        return Result.ok(undefined);
    }

    revert(): void {
        this.baseline = this.options.read();
        this.options.show(this.baseline);
        this.options.changed?.();
    }

    snapshot(): EditorDraftData | undefined {
        if (!this.isDirty()) return undefined;
        const selection = this.options.selection?.();
        return { data: this.options.text(), ...(selection === undefined ? {} : { selection }) };
    }

    restore(draft: EditorDraftData): void {
        this.options.show(draft.data, draft.selection);
        this.options.changed?.();
    }

    /**
     * The node's text changed elsewhere (undo, redo, a restored version): a clean draft shows
     * it, a dirty one keeps the user's edits. Returns whether the editor now shows the node.
     */
    nodeChanged(): boolean {
        const text = this.options.read();
        if (text === this.baseline) return false;
        const follow = !this.isDirty();
        this.baseline = text;
        if (follow) this.options.show(text);
        this.options.changed?.();
        return follow;
    }
}
