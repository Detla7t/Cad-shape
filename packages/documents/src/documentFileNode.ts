// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    base64ToBytes,
    bytesToBase64,
    fileExtension,
    type IDocument,
    Id,
    type INodeIcon,
    type INodeSceneless,
    Node,
    registerProjectSourceElement,
    serializable,
    serialize,
} from "@chili3d/core";
import { documentViewKind, formatOf, isTextFormat, mimeTypeOf } from "./documentFormats";

/**
 * A file kept inside the document — a Markdown note, a Word report, a spreadsheet of
 * dimensions, a PDF datasheet, a DXF drawing — shown as its own element (tab).
 *
 * The file's bytes are one serialized property, so every place a document is copied
 * carries them without a side channel: undo/redo, the version history, copy & paste,
 * IndexedDB persistence (which stores the serialized document) and `.chili3d` files.
 * Text formats are stored as text (`encoding: "text"`, line deltas in the version
 * history); everything else as base64 (`encoding: "base64"`, 4/3 of the size in
 * IndexedDB and memory). In a `.chili3d` project the property becomes a real file under
 * `files/` — raw bytes, not base64 — and `document.json` keeps a `{ "$file", "$encoding" }`
 * reference (see `docs/project-format.md`).
 *
 * Editors keep a draft and write it back with one recorded change (`setBytes` /
 * `setText`), so an edit session is one undo step and one version-history entry.
 */

export interface DocumentFileNodeOptions {
    document: IDocument;
    /** The tab name; defaults to the file name without its extension. */
    name?: string;
    /** The original file name, extension included ("Report.docx"). */
    fileName: string;
    /** A `FileFormat` id ("docx", "xlsx", ...); detected from the name when absent. */
    format?: string;
    bytes?: Uint8Array;
    text?: string;
    id?: string;
}

export type DocumentEncoding = "text" | "base64";

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 text of `bytes` without a byte-order mark, or undefined (then they are stored as base64). */
function plainUtf8(bytes: Uint8Array): string | undefined {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return undefined;
    try {
        return textDecoder.decode(bytes);
    } catch {
        return undefined;
    }
}

function baseName(fileName: string): string {
    const extension = fileExtension(fileName);
    return extension === "" ? fileName : fileName.slice(0, -extension.length);
}

@serializable()
export class DocumentFileNode extends Node implements INodeIcon, INodeSceneless {
    readonly sceneless = true as const;

    get icon(): string {
        return documentIcon(this.format);
    }

    constructor(options: DocumentFileNodeOptions) {
        super(options.document, options.name ?? baseName(options.fileName), options.id ?? Id.generate());
        const format = options.format ?? formatOf("", options.fileName)?.id ?? "unknown";
        this.setPrivateValue("fileName", options.fileName);
        this.setPrivateValue("format", format);
        const content = DocumentFileNode.encode(format, options.bytes, options.text);
        // Deserialization passes the stored `encoding`/`content` and sets them right after.
        this.setPrivateValue("encoding", content.encoding);
        this.setPrivateValue("content", content.content);
    }

    /** How `bytes` (or `text`) of a `format` file are stored. */
    static encode(
        format: string,
        bytes: Uint8Array | undefined,
        text: string | undefined,
    ): { encoding: DocumentEncoding; content: string } {
        if (text !== undefined) {
            return isTextFormat(format)
                ? { encoding: "text", content: text }
                : { encoding: "base64", content: bytesToBase64(new TextEncoder().encode(text)) };
        }
        const data = bytes ?? new Uint8Array();
        const decoded = isTextFormat(format) ? plainUtf8(data) : undefined;
        return decoded !== undefined
            ? { encoding: "text", content: decoded }
            : { encoding: "base64", content: bytesToBase64(data) };
    }

    /** The original file name, extension included. */
    @serialize()
    get fileName(): string {
        return this.getPrivateValue("fileName");
    }
    set fileName(value: string) {
        this.setProperty("fileName", value);
    }

    /** The `FileFormat` id of the file. */
    @serialize()
    get format(): string {
        return this.getPrivateValue("format");
    }
    set format(value: string) {
        this.setProperty("format", value);
    }

    @serialize()
    get encoding(): DocumentEncoding {
        return this.getPrivateValue("encoding");
    }
    set encoding(value: DocumentEncoding) {
        this.setProperty("encoding", value);
    }

    /** The file: its text (`encoding` "text") or its bytes in base64. Prefer `bytes`/`text`. */
    @serialize()
    get content(): string {
        return this.getPrivateValue("content");
    }
    set content(value: string) {
        this.setProperty("content", value);
    }

    private _decoded?: { content: string; bytes: Uint8Array };

    /** The file's bytes (decoded once per content). */
    get bytes(): Uint8Array {
        const content = this.content;
        if (this._decoded?.content === content) return this._decoded.bytes;
        const bytes =
            this.encoding === "text"
                ? new TextEncoder().encode(content)
                : (base64ToBytes(content) ?? new Uint8Array());
        this._decoded = { content, bytes };
        return bytes;
    }

    /** The file as text (UTF-8, a byte-order mark dropped). */
    get text(): string {
        if (this.encoding === "text") return this.content;
        return new TextDecoder().decode(this.bytes);
    }

    get size(): number {
        return this.encoding === "text" ? new TextEncoder().encode(this.content).length : this.bytes.length;
    }

    get mimeType(): string {
        return mimeTypeOf(this.format);
    }

    /** Which viewer shows the file. */
    get viewKind() {
        return documentViewKind(this.format);
    }

    /** The name to save the file under: the element's name with the file's extension. */
    get exportFileName(): string {
        const extension = fileExtension(this.fileName) || (formatOf(this.format, "")?.extensions[0] ?? "");
        return `${this.name}${extension}`;
    }

    /** Replaces the file (one recorded change per property). */
    setBytes(bytes: Uint8Array): void {
        this.store(DocumentFileNode.encode(this.format, bytes, undefined));
    }

    /** Replaces the file with `text` (UTF-8). */
    setText(text: string): void {
        this.store(DocumentFileNode.encode(this.format, undefined, text));
    }

    private store(value: { encoding: DocumentEncoding; content: string }): void {
        if (value.encoding !== this.encoding) this.encoding = value.encoding;
        if (value.content !== this.content) this.content = value.content;
    }

    protected onVisibleChanged(): void {}

    protected onParentVisibleChanged(): void {}
}

export function isDocumentFileNode(node: unknown): node is DocumentFileNode {
    return node instanceof DocumentFileNode;
}

/** The folder document files are written to in a `.chili3d` project. */
export const DOCUMENT_FILES_FOLDER = "files/";

// In a `.chili3d` project each file is a real file under files/, named after the element.
registerProjectSourceElement({
    className: DocumentFileNode.name,
    kind: "document",
    field: "content",
    folder: DOCUMENT_FILES_FOLDER,
    extension: "",
    encoding: (node) => (node["encoding"] === "text" ? "text" : "base64"),
    fileName: (node) => {
        const name = typeof node["name"] === "string" ? node["name"] : "file";
        const fileName = typeof node["fileName"] === "string" ? node["fileName"] : "";
        return `${name}${fileExtension(fileName)}`;
    },
});

/** Iconfont key of a document element tab (see `documentIcons.ts`). */
export function documentIcon(format: string): string {
    switch (documentViewKind(format)) {
        case "markdown":
            return "icon-doc-markdown";
        case "richText":
            return "icon-doc-text";
        case "spreadsheet":
            return "icon-doc-sheet";
        case "pdf":
            return "icon-doc-pdf";
        case "image":
            return "icon-doc-image";
        case "drawing":
            return "icon-doc-drawing";
        case "text":
            return "icon-doc-code";
        default:
            return "icon-doc-file";
    }
}
