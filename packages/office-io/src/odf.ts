// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { escapeXml } from "./xml";

/**
 * The OpenDocument package (ISO/IEC 26300) shared by the spreadsheet (.ods) and text (.odt)
 * formats: a zip whose `mimetype` entry comes first and uncompressed, a manifest, and the
 * `content.xml` / `styles.xml` / `meta.xml` documents. The format modules supply only their
 * body and styles. JSZip loads on first use.
 *
 * Reading parses the documents with `DOMParser`; elements and attributes are then addressed
 * by qualified name ("table:table-cell"): producers use the standard prefixes, and qualified
 * names work in every DOM, including ones without namespace support.
 */

export type OdfKind = "text" | "spreadsheet";

/** The prefixes every document of a written package declares. */
const NAMESPACES = {
    office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
    text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
    fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
    xlink: "http://www.w3.org/1999/xlink",
    svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
    number: "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0",
    of: "urn:oasis:names:tc:opendocument:xmlns:of:1.2",
    meta: "urn:oasis:names:tc:opendocument:xmlns:meta:1.0",
    dc: "http://purl.org/dc/elements/1.1/",
} as const;

const MANIFEST_NS = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";

const DECLARATIONS = Object.entries(NAMESPACES)
    .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
    .join(" ");

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

export const odfMimeType = (kind: OdfKind) => `application/vnd.oasis.opendocument.${kind}`;

// ------------------------------------------------------------------ Reading

export interface OdfPackage {
    /** `content.xml`. */
    readonly content: Document;
    /** The documents holding styles: `content.xml` (automatic styles), then `styles.xml` when present. */
    readonly styleDocuments: readonly Document[];
    /** Every file entry of the package (folders excluded). */
    readonly paths: readonly string[];
    /** The bytes of an entry; undefined when there is none. */
    read(path: string): Promise<Uint8Array | undefined>;
}

/** An ODF package's documents; rejects when the bytes are not a zip. */
export async function readOdfPackage(bytes: Uint8Array): Promise<OdfPackage> {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(bytes);
    const text = async (path: string) => (await zip.file(path)?.async("string")) ?? "";
    const parser = new DOMParser();
    const content = parser.parseFromString(await text("content.xml"), "application/xml");
    const stylesXml = await text("styles.xml");
    return {
        content,
        styleDocuments: [
            content,
            ...(stylesXml === "" ? [] : [parser.parseFromString(stylesXml, "application/xml")]),
        ],
        paths: Object.values(zip.files)
            .filter((file) => !file.dir)
            .map((file) => file.name),
        read: async (path) => zip.file(path)?.async("uint8array"),
    };
}

// ------------------------------------------------------------------ Writing

export interface OdfFile {
    /** Path inside the package ("Pictures/image1.png"). */
    readonly path: string;
    readonly bytes: Uint8Array;
    /** Media type for the manifest. */
    readonly mime: string;
}

export interface OdfPackageOptions {
    readonly kind: OdfKind;
    /** The children of `office:automatic-styles` in `content.xml`. */
    readonly automaticStyles: string;
    /** The children of `office:text` / `office:spreadsheet`. */
    readonly body: string;
    /** The children of `office:styles` in `styles.xml`. */
    readonly styles: string;
    /** The document title (`dc:title` in `meta.xml`). */
    readonly title?: string;
    /** Further entries (pictures): stored uncompressed and listed in the manifest. */
    readonly files?: readonly OdfFile[];
}

/** The four XML documents of a package, by entry path (`mimetype` and pictures excluded). */
export function odfDocuments(options: OdfPackageOptions): Record<string, string> {
    const { kind } = options;
    const root = (name: string, inner: string) =>
        `${XML_DECLARATION}<office:${name} ${DECLARATIONS} office:version="1.3">${inner}</office:${name}>`;
    const title = options.title === undefined ? "" : `<dc:title>${escapeXml(options.title)}</dc:title>`;
    const entry = (path: string, mime: string) =>
        `<manifest:file-entry manifest:full-path="${escapeXml(path)}" manifest:media-type="${mime}"/>`;
    return {
        "META-INF/manifest.xml": `${XML_DECLARATION}<manifest:manifest xmlns:manifest="${MANIFEST_NS}" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${odfMimeType(kind)}"/>${entry("content.xml", "text/xml")}${entry("styles.xml", "text/xml")}${entry("meta.xml", "text/xml")}${(options.files ?? []).map((file) => entry(file.path, file.mime)).join("")}</manifest:manifest>`,
        "content.xml": root(
            "document-content",
            `<office:automatic-styles>${options.automaticStyles}</office:automatic-styles><office:body><office:${kind}>${options.body}</office:${kind}></office:body>`,
        ),
        "styles.xml": root("document-styles", `<office:styles>${options.styles}</office:styles>`),
        "meta.xml": root(
            "document-meta",
            `<office:meta><meta:generator>Chili3D</meta:generator>${title}</office:meta>`,
        ),
    };
}

/** A complete ODF package. */
export async function writeOdfPackage(options: OdfPackageOptions): Promise<Uint8Array> {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    const mimeType = odfMimeType(options.kind);
    // The mimetype must be the first entry, uncompressed.
    zip.file("mimetype", mimeType, { compression: "STORE" });
    for (const [path, xml] of Object.entries(odfDocuments(options))) zip.file(path, xml);
    for (const file of options.files ?? []) zip.file(file.path, file.bytes, { compression: "STORE" });
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType });
}
