// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    type I18nKeys,
    type IDisposable,
    type IDocument,
    type INode,
    registerElementKind,
    registerElementView,
} from "@chili3d/core";
import { DocumentFileNode, documentIcon } from "../documentFileNode";
import { type DocumentViewKind, documentViewKind } from "../documentFormats";
import { createDocumentView } from "./shell";

/**
 * Documents as document elements (tabs along the bottom): one element kind per viewer, so
 * each tab shows its file type's icon and the "+" menu offers the documents one can start
 * empty (Markdown, Word, spreadsheet, text).
 */

interface DocumentKind {
    readonly kind: string;
    readonly view: DocumentViewKind;
    readonly display: I18nKeys;
    readonly newCommand?: CommandKeys;
    /** A representative format, for the icon. */
    readonly format: string;
}

export const DOCUMENT_KINDS: readonly DocumentKind[] = [
    {
        kind: "markdownDocument",
        view: "markdown",
        display: "documents.kind.markdown",
        newCommand: "documents.newMarkdown",
        format: "markdown",
    },
    {
        kind: "richTextDocument",
        view: "richText",
        display: "documents.kind.richText",
        newCommand: "documents.newRichText",
        format: "docx",
    },
    {
        kind: "spreadsheetDocument",
        view: "spreadsheet",
        display: "documents.kind.spreadsheet",
        newCommand: "documents.newSpreadsheet",
        format: "xlsx",
    },
    {
        kind: "textDocument",
        view: "text",
        display: "documents.kind.text",
        newCommand: "documents.newText",
        format: "text",
    },
    { kind: "pdfDocument", view: "pdf", display: "documents.kind.pdf", format: "pdf" },
    { kind: "imageDocument", view: "image", display: "documents.kind.image", format: "png" },
    { kind: "drawingDocument", view: "drawing", display: "documents.kind.drawing", format: "dxf" },
    { kind: "fileDocument", view: "file", display: "documents.kind.file", format: "unknown" },
];

const isKind = (view: DocumentViewKind) => (node: INode) =>
    node instanceof DocumentFileNode && documentViewKind(node.format) === view;

/** Registers the element kinds and their views; the handle removes them. */
export function registerDocumentElements(): IDisposable {
    const handles: IDisposable[] = [];
    for (const kind of DOCUMENT_KINDS) {
        handles.push(
            registerElementKind({
                kind: kind.kind,
                icon: documentIcon(kind.format),
                display: kind.display,
                isElement: isKind(kind.view),
                ...(kind.newCommand === undefined ? {} : { newCommand: kind.newCommand }),
            }),
            registerElementView(kind.kind, (node: INode, document: IDocument) =>
                createDocumentView(node as DocumentFileNode, document),
            ),
        );
    }
    return {
        dispose: () => {
            for (const handle of handles) handle.dispose();
        },
    };
}
