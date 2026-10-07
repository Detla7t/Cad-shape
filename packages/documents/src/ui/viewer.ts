// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { I18nKeys, IDisposable, IDocument } from "@chili3d/core";
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
 * adds the header, the Save button and the export menu.
 */
export interface IDocumentViewer extends IDisposable {
    readonly element: HTMLElement;
    /** Unsaved edits exist. */
    isDirty?(): boolean;
    /** Writes the draft into the node — one undo step. */
    save?(): Promise<void>;
    /** The node's file changed elsewhere (undo, a restored version): show it again. */
    reload?(): void;
    /** Downloads the viewer offers besides the original file. */
    exports?(): DocumentExport[];
    activated?(): void;
}

export interface ViewerContext {
    readonly node: DocumentFileNode;
    readonly document: IDocument;
    /** Tells the shell the dirty state changed. */
    changed(): void;
}

export type ViewerFactory = (context: ViewerContext) => IDocumentViewer;
