// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { EditorDraftData, I18nKeys, IDisposable, IDocument } from "@chili3d/core";
import type { DocumentFileNode } from "../documentFileNode";

/** One way to download a document: its own format or a conversion. */
export interface DocumentExport {
    readonly label: I18nKeys;
    /** File extension with the dot. */
    readonly extension: string;
    produce(): Promise<Uint8Array | string>;
}

/**
 * The viewer/editor of one document element, mounted in the shell (`shell.ts`), which
 * adds the header, the Save button and the export menu — and turns an editing viewer into
 * the element's `IEditorBuffer` (dirty mark on the tab, Save / Discard / Cancel on close,
 * recovery of the draft), so every document editor behaves the same.
 */
export interface IDocumentViewer extends IDisposable {
    readonly element: HTMLElement;
    /** Unsaved edits exist. */
    isDirty?(): boolean;
    /** Writes the draft into the node — one undo step. Throws when the file cannot be written. */
    save?(): Promise<void>;
    /** Shows the node's file again, dropping the draft (undo elsewhere, a restored version, Discard). */
    reload?(): void;
    /** The draft as data for recovery (text, JSON, HTML…); undefined when clean. */
    snapshot?(): EditorDraftData | undefined;
    /** Puts a recovered draft back as the unsaved draft (after the file has loaded). */
    restore?(draft: EditorDraftData): void | Promise<void>;
    /** Downloads the viewer offers besides the original file. */
    exports?(): DocumentExport[];
    activated?(): void;
    /** Another element's tab took over (the view stays mounted). */
    deactivated?(): void;
}

export interface ViewerContext {
    readonly node: DocumentFileNode;
    readonly document: IDocument;
    /** Tells the shell the dirty state changed. */
    changed(): void;
}

export type ViewerFactory = (context: ViewerContext) => IDocumentViewer;
