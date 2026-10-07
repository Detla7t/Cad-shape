// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FILE_FORMATS, type FileFormat, fileFormatById, fileFormatByName } from "@chili3d/core";

/**
 * Which file formats become document elements, and which viewer/editor shows each:
 *
 * - `markdown` — CodeMirror source with a live, sanitized preview (Markdown and HTML);
 * - `richText` — formatted text editing (DOCX, ODT), saved back to the same format;
 * - `spreadsheet` — a grid with sheets, formulas and number formats (CSV, TSV, XLSX, XLS, ODS);
 * - `pdf`, `image` — viewers;
 * - `text` — CodeMirror source (plain text, JSON, XML, G-code, ...);
 * - `drawing` — a 2D CAD drawing (DXF, DWG) with layers, convertible to a sketch;
 * - `file` — anything else: kept in the project, downloadable, not shown.
 */
export type DocumentViewKind =
    | "markdown"
    | "richText"
    | "spreadsheet"
    | "pdf"
    | "image"
    | "text"
    | "drawing"
    | "file";

const VIEW_KINDS: Record<string, DocumentViewKind> = {
    markdown: "markdown",
    html: "markdown",
    docx: "richText",
    odt: "richText",
    csv: "spreadsheet",
    tsv: "spreadsheet",
    xlsx: "spreadsheet",
    xls: "spreadsheet",
    ods: "spreadsheet",
    pdf: "pdf",
    png: "image",
    jpeg: "image",
    gif: "image",
    webp: "image",
    bmp: "image",
    svg: "image",
    text: "text",
    json: "text",
    xml: "text",
    featurescript: "text",
    dxf: "drawing",
    dwg: "drawing",
};

/** Formats stored as text in the document (diffable in the version history); the rest as base64. */
const TEXT_FORMATS = new Set([
    "markdown",
    "html",
    "text",
    "json",
    "xml",
    "csv",
    "tsv",
    "svg",
    "featurescript",
    "dxf",
]);

export function documentViewKind(formatId: string): DocumentViewKind {
    return VIEW_KINDS[formatId] ?? "file";
}

export function isTextFormat(formatId: string): boolean {
    return TEXT_FORMATS.has(formatId);
}

/** Formats imported as document elements (everything with a viewer, plus office files without one). */
export const DOCUMENT_FORMAT_IDS: readonly string[] = [
    ...Object.keys(VIEW_KINDS).filter((id) => id !== "dxf" && id !== "dwg" && id !== "featurescript"),
    "doc",
    "pptx",
    "odp",
];

/** The extensions of the document formats, for the Import dialog. */
export function documentExtensions(): string[] {
    return FILE_FORMATS.filter((format) => DOCUMENT_FORMAT_IDS.includes(format.id)).flatMap((format) => [
        ...format.extensions,
    ]);
}

/** The format of a document node's file: by its id, else its name. */
export function formatOf(formatId: string, fileName: string): FileFormat | undefined {
    return fileFormatById(formatId) ?? fileFormatByName(fileName);
}

/** The MIME type to download or display a file of `formatId` with. */
export function mimeTypeOf(formatId: string): string {
    return fileFormatById(formatId)?.mime || "application/octet-stream";
}
