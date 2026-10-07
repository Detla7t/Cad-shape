// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Recognizes what a file is — by its content (magic bytes, container entries, text
 * signatures) and by its name — so one Import command can route any file, a STEP file
 * named `.txt` still opens as STEP, and proprietary CAD formats are named instead of
 * reported as "unsupported". Pure and synchronous; it reads at most the first 64 KiB and
 * the zip central directory.
 */

export type FileFormatCategory =
    /** A Chili3D document: `.chili3d` project or legacy `.cd`. */
    | "project"
    | "plugin"
    /** B-rep exchange formats the kernel reads: STEP, IGES, BREP. */
    | "cad"
    | "mesh"
    /** 2D CAD drawings: DXF, DWG. */
    | "drawing"
    | "document"
    | "spreadsheet"
    | "image"
    /** Source code Chili3D runs: FeatureScript. */
    | "source"
    /** NC programs: G-code for mills, cutting tables, wire EDM and 3D printers. */
    | "nc"
    /** A closed CAD format no open-source reader exists for (Parasolid, SolidWorks, ...). */
    | "proprietary"
    | "unknown";

export interface FileFormat {
    /** Stable key: "step", "dxf", "docx", "xlsx", "parasolid", ... */
    readonly id: string;
    readonly category: FileFormatCategory;
    /** Human-readable name, e.g. "STEP (ISO 10303-21)". */
    readonly name: string;
    /** Lowercase, with the dot; the first one is the canonical extension. */
    readonly extensions: readonly string[];
    readonly mime: string;
    /** Whose format it is, for proprietary formats ("Siemens", "Dassault Systèmes", ...). */
    readonly vendor?: string;
}

export interface DetectedFileFormat extends FileFormat {
    /** "content" when the bytes identified it, "extension" when only the name did. */
    readonly by: "content" | "extension" | "none";
    /** The name's extension names a different format than the content (a DWG saved as `.dxf`). */
    readonly mismatch: boolean;
    /** Format version found in the content, e.g. the DWG release code "AC1018". */
    readonly version?: string;
}

const f = (
    id: string,
    category: FileFormatCategory,
    name: string,
    extensions: string[],
    mime: string,
    vendor?: string,
): FileFormat => ({ id, category, name, extensions, mime, ...(vendor === undefined ? {} : { vendor }) });

/** Every format Chili3D knows by name. */
export const FILE_FORMATS: readonly FileFormat[] = [
    f("chili3d", "project", "Chili3D project", [".chili3d"], "application/vnd.chili3d.project+zip"),
    f("cd", "project", "Chili3D document (legacy)", [".cd"], "application/json"),
    f("chiliplugin", "plugin", "Chili3D plugin", [".chiliplugin"], "application/zip"),
    f("featurescript", "source", "FeatureScript", [".fs"], "text/plain"),
    f("step", "cad", "STEP (ISO 10303-21)", [".step", ".stp", ".p21"], "model/step"),
    f("iges", "cad", "IGES", [".iges", ".igs"], "model/iges"),
    f("brep", "cad", "OCCT BREP", [".brep", ".brp"], "application/octet-stream"),
    f("stl", "mesh", "STL", [".stl"], "model/stl"),
    f("obj", "mesh", "Wavefront OBJ", [".obj"], "model/obj"),
    f("gltf", "mesh", "glTF", [".gltf"], "model/gltf+json"),
    f("glb", "mesh", "glTF binary", [".glb"], "model/gltf-binary"),
    f("3mf", "mesh", "3D Manufacturing Format", [".3mf"], "model/3mf"),
    f("ply", "mesh", "PLY", [".ply"], "application/octet-stream"),
    f("dxf", "drawing", "AutoCAD DXF", [".dxf"], "image/vnd.dxf"),
    f("dwg", "drawing", "AutoCAD DWG", [".dwg"], "image/vnd.dwg"),
    f("markdown", "document", "Markdown", [".md", ".markdown", ".mdown"], "text/markdown"),
    f("text", "document", "Plain text", [".txt", ".text", ".log", ".ini", ".cfg"], "text/plain"),
    f(
        "nc",
        "nc",
        "NC program (G-code)",
        [
            ".nc",
            ".ngc",
            ".tap",
            ".cnc",
            ".gcode",
            ".gco",
            ".gc",
            ".g",
            ".iso",
            ".eia",
            ".mpf",
            ".spf",
            ".min",
            ".ptp",
            ".h",
            ".ncc",
            ".nc1",
            ".fan",
        ],
        "text/x-gcode",
    ),
    f("json", "document", "JSON", [".json"], "application/json"),
    f("xml", "document", "XML", [".xml"], "application/xml"),
    f("html", "document", "HTML", [".html", ".htm"], "text/html"),
    f(
        "docx",
        "document",
        "Word document",
        [".docx"],
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    f("odt", "document", "OpenDocument text", [".odt"], "application/vnd.oasis.opendocument.text"),
    f("pdf", "document", "PDF", [".pdf"], "application/pdf"),
    f("doc", "document", "Word 97–2003 document", [".doc"], "application/msword"),
    f(
        "pptx",
        "document",
        "PowerPoint presentation",
        [".pptx"],
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
    f(
        "odp",
        "document",
        "OpenDocument presentation",
        [".odp"],
        "application/vnd.oasis.opendocument.presentation",
    ),
    f("csv", "spreadsheet", "CSV", [".csv"], "text/csv"),
    f("tsv", "spreadsheet", "Tab-separated values", [".tsv", ".tab"], "text/tab-separated-values"),
    f(
        "xlsx",
        "spreadsheet",
        "Excel workbook",
        [".xlsx", ".xlsm"],
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    f("xls", "spreadsheet", "Excel 97–2003 workbook", [".xls"], "application/vnd.ms-excel"),
    f(
        "ods",
        "spreadsheet",
        "OpenDocument spreadsheet",
        [".ods"],
        "application/vnd.oasis.opendocument.spreadsheet",
    ),
    f("png", "image", "PNG image", [".png"], "image/png"),
    f("jpeg", "image", "JPEG image", [".jpg", ".jpeg", ".jfif"], "image/jpeg"),
    f("gif", "image", "GIF image", [".gif"], "image/gif"),
    f("webp", "image", "WebP image", [".webp"], "image/webp"),
    f("bmp", "image", "BMP image", [".bmp"], "image/bmp"),
    f("svg", "image", "SVG image", [".svg"], "image/svg+xml"),
    f("parasolid", "proprietary", "Parasolid", [".x_t", ".xmt_txt", ".x_b", ".xmt_bin"], "", "Siemens"),
    f("solidworks", "proprietary", "SolidWorks", [".sldprt", ".sldasm", ".slddrw"], "", "Dassault Systèmes"),
    f(
        "catia",
        "proprietary",
        "CATIA V5",
        [".catpart", ".catproduct", ".catdrawing"],
        "",
        "Dassault Systèmes",
    ),
    f("inventor", "proprietary", "Autodesk Inventor", [".ipt", ".iam", ".idw"], "", "Autodesk"),
    f("fusion", "proprietary", "Autodesk Fusion", [".f3d", ".f3z"], "", "Autodesk"),
    f("creo", "proprietary", "Creo / NX part", [".prt", ".asm", ".neu"], "", "PTC / Siemens"),
    f("solidedge", "proprietary", "Solid Edge", [".par", ".psm", ".pwd"], "", "Siemens"),
    f("jt", "proprietary", "JT", [".jt"], "", "Siemens"),
    f("acis", "proprietary", "ACIS", [".sat", ".sab", ".asat", ".asab"], "", "Spatial"),
    f("rhino", "proprietary", "Rhino 3DM", [".3dm"], "", "Robert McNeel & Associates"),
    f("sketchup", "proprietary", "SketchUp", [".skp"], "", "Trimble"),
];

const UNKNOWN: FileFormat = f("unknown", "unknown", "Unknown", [], "application/octet-stream");

const byId = new Map(FILE_FORMATS.map((format) => [format.id, format]));

export function fileFormatById(id: string): FileFormat | undefined {
    return byId.get(id);
}

/** The lowercase extension of `name` including the dot ("" when it has none). */
export function fileExtension(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? name;
    const dot = base.lastIndexOf(".");
    return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** The format the name's extension stands for. */
export function fileFormatByName(name: string): FileFormat | undefined {
    const extension = fileExtension(name);
    if (extension === "") return undefined;
    return FILE_FORMATS.find((format) => format.extensions.includes(extension));
}

// ------------------------------------------------------------------ Content sniffing

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
    bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (bytes: Uint8Array, start: number, end: number) => {
    let text = "";
    for (let i = start; i < Math.min(end, bytes.length); i++) text += String.fromCharCode(bytes[i]);
    return text;
};

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const SNIFF_LIMIT = 64 * 1024;

interface ZipEntry {
    readonly name: string;
    /** 0 = stored, 8 = deflated. */
    readonly method: number;
    readonly compressedSize: number;
    /** Offset of the entry's local header. */
    readonly offset: number;
}

/**
 * The entries of a zip archive, from its central directory (or, for a truncated archive,
 * by walking the local headers). Nothing is decompressed.
 */
function zipEntries(bytes: Uint8Array): ZipEntry[] {
    if (!startsWith(bytes, ZIP)) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    const entries: ZipEntry[] = [];
    // End of central directory: 22 bytes + up to 64 KiB comment, at the end.
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
        if (view.getUint32(at, true) !== 0x06054b50) continue;
        const count = view.getUint16(at + 10, true);
        let offset = view.getUint32(at + 16, true);
        for (let i = 0; i < count && offset + 46 <= bytes.length; i++) {
            if (view.getUint32(offset, true) !== 0x02014b50) break;
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            entries.push({
                name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
                method: view.getUint16(offset + 10, true),
                compressedSize: view.getUint32(offset + 20, true),
                offset: view.getUint32(offset + 42, true),
            });
            offset += 46 + nameLength + extraLength + commentLength;
        }
        if (entries.length > 0) return entries;
        break;
    }
    let offset = 0;
    while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
        const compressedSize = view.getUint32(offset + 18, true);
        const nameLength = view.getUint16(offset + 26, true);
        const extraLength = view.getUint16(offset + 28, true);
        entries.push({
            name: decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)),
            method: view.getUint16(offset + 8, true),
            compressedSize,
            offset,
        });
        if (compressedSize === 0) break; // sizes in a data descriptor: cannot skip ahead
        offset += 30 + nameLength + extraLength + compressedSize;
    }
    return entries;
}

/** The entry names of a zip archive (see `zipEntries`). */
export function zipEntryNames(bytes: Uint8Array): string[] {
    return zipEntries(bytes).map((entry) => entry.name);
}

/** An OpenDocument's `mimetype` entry (stored uncompressed, usually first), if readable. */
function odfMimetype(bytes: Uint8Array, entries: readonly ZipEntry[]): string | undefined {
    const entry = entries.find((candidate) => candidate.name === "mimetype");
    if (entry === undefined || entry.method !== 0 || entry.compressedSize > 200) return undefined;
    if (entry.offset + 30 > bytes.length) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start =
        entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
    return ascii(bytes, start, start + entry.compressedSize).trim();
}

function sniffZip(bytes: Uint8Array): string {
    const entries = zipEntries(bytes);
    const mimetype = odfMimetype(bytes, entries);
    if (mimetype === "application/vnd.oasis.opendocument.text") return "odt";
    if (mimetype === "application/vnd.oasis.opendocument.spreadsheet") return "ods";
    if (mimetype === "application/vnd.oasis.opendocument.presentation") return "odp";
    const names = entries.map((entry) => entry.name);
    const has = (name: string) => names.some((entry) => entry.toLowerCase() === name.toLowerCase());
    const hasPrefix = (prefix: string) => names.some((entry) => entry.startsWith(prefix));
    if (has("manifest.json") && has("document.json")) return "chili3d";
    if (has("3D/3dmodel.model")) return "3mf";
    if (has("[Content_Types].xml")) {
        if (hasPrefix("word/")) return "docx";
        if (hasPrefix("xl/")) return "xlsx";
        if (hasPrefix("ppt/")) return "pptx";
    }
    if (names.some((name) => name.startsWith("Fusion[Active]/") || name.endsWith(".f2d"))) return "fusion";
    // An OpenDocument whose mimetype entry is compressed: the extension tells which.
    if (has("content.xml") && has("META-INF/manifest.xml")) return "odf";
    return "zip";
}

/** UTF-16LE occurrences of `word` (OLE directory entries are UTF-16 names). */
function hasUtf16(bytes: Uint8Array, word: string): boolean {
    const limit = Math.min(bytes.length, 512 * 1024);
    outer: for (let i = 0; i + word.length * 2 <= limit; i++) {
        for (let k = 0; k < word.length; k++) {
            if (bytes[i + 2 * k] !== word.charCodeAt(k) || bytes[i + 2 * k + 1] !== 0) continue outer;
        }
        return true;
    }
    return false;
}

function sniffOle(bytes: Uint8Array): string {
    if (hasUtf16(bytes, "Workbook") || hasUtf16(bytes, "Book")) return "xls";
    if (hasUtf16(bytes, "WordDocument")) return "doc";
    return "ole";
}

/** Text of the first bytes when they look like text (no NUL, valid UTF-8 up to a cut character). */
function sniffText(bytes: Uint8Array): string | undefined {
    const head = bytes.subarray(0, Math.min(bytes.length, SNIFF_LIMIT));
    let control = 0;
    for (const byte of head) {
        if (byte === 0) return undefined;
        // Control characters other than tab, line feeds, form feed and escape.
        if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x1b)
            control++;
    }
    if (control > head.length / 100) return undefined;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    // A multi-byte character cut by the sniff limit is not an error: drop up to 3 bytes.
    const cuts = head.length < bytes.length ? 3 : 0;
    for (let cut = 0; cut <= cuts; cut++) {
        try {
            return decoder.decode(head.subarray(0, head.length - cut));
        } catch {
            // try a shorter cut
        }
    }
    // Not UTF-8, yet free of binary bytes: text in a legacy code page.
    return new TextDecoder("latin1").decode(head);
}

function isIgesLine(line: string): boolean {
    return line.length >= 80 && line[72] === "S" && /^ *\d+$/.test(line.slice(73, 80));
}

function sniffTextFormat(text: string): string | undefined {
    const body = text.replace(/^﻿/, "");
    const trimmed = body.trimStart();
    if (trimmed.startsWith("ISO-10303-21;")) return "step";
    if (/^(999\r?\n[^\n]*\r?\n\s*)?0\s*\r?\n\s*SECTION\s*\r?\n/.test(trimmed)) return "dxf";
    if (body.includes("DBRep_DrawableShape") || /^CASCADE Topology V/m.test(body)) return "brep";
    if (trimmed.startsWith("**ABCDEFGHIJKLMNOPQRSTUVWXYZ") || /^\*\*PART1;/m.test(body)) return "parasolid";
    if (/^FeatureScript \d+;/.test(trimmed)) return "featurescript";
    if (isIgesLine(body.split(/\r?\n/, 1)[0] ?? "")) return "iges";
    if (/^solid\b/.test(trimmed) && /facet\s+normal/.test(body)) return "stl";
    if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(trimmed))
        return "svg";
    if (/^(<!doctype html|<html[\s>])/i.test(trimmed)) return "html";
    if (trimmed.startsWith("{")) {
        if (/"__cla\$\$__"\s*:\s*"Document"/.test(body)) return "cd";
        if (/"asset"\s*:\s*\{/.test(body) && /"version"\s*:\s*"2/.test(body)) return "gltf";
        return "json";
    }
    if (trimmed.startsWith("[")) return "json";
    if (trimmed.startsWith("<?xml") || /^<[A-Za-z][\w:.-]*[\s>/]/.test(trimmed)) return "xml";
    if (/^\s*v\s+-?[\d.]/m.test(body) && /^\s*f\s+\d/m.test(body)) return "obj";
    if (looksLikeNcProgram(body)) return "nc";
    return undefined;
}

/**
 * Whether text looks like an NC program: most non-blank lines are blocks of address words
 * (`G1 X10`, `N10 M3`, `O1000`, `%`, `#1 = 2`, `o100 call`) and some are G or M codes — or a
 * Heidenhain `BEGIN PGM`. For files whose name does not say (an extensionless file, a `.001`).
 */
export function looksLikeNcProgram(text: string): boolean {
    const sample = text.length > SNIFF_LIMIT ? text.slice(0, SNIFF_LIMIT) : text;
    if (/^\s*\d*\s*BEGIN\s+PGM\b/im.test(sample)) return true;
    let blocks = 0;
    let codes = 0;
    let other = 0;
    const lines = sample.split(/\r?\n/);
    // The last line may be cut by the sample limit.
    if (text.length > sample.length) lines.pop();
    for (const raw of lines) {
        const line = raw
            .replace(/\([^)]*\)/g, " ")
            .replace(/;.*$/, "")
            .trim();
        if (line === "") continue;
        if (line.startsWith("%")) {
            blocks++;
            continue;
        }
        if (NC_BLOCK.test(line)) {
            blocks++;
            if (/(^|[^A-Z])[GM]\s*\d/i.test(line)) codes++;
        } else if (/^(o\d+|o<[^>]+>)\s+\w+/i.test(line) || /^#\d+\s*=/.test(line)) {
            blocks++;
        } else {
            other++;
        }
    }
    return blocks >= 3 && codes >= 2 && blocks >= (blocks + other) * 0.8;
}

const NC_BLOCK =
    /^\/?\s*(N\d+\s*)?((O|:)\d+|[GMTSFXYZIJKABCEUVWHDPQRL]\s*[-+]?(\d+\.?\d*|\.\d+|#\d+|\[)[^A-Z\s]*\s*)+(\*\d+)?$/i;

interface Sniffed {
    readonly id: string;
    readonly version?: string;
}

/** The format the content proves; generic containers come back as "zip", "ole" or "text". */
export function sniffFileContent(bytes: Uint8Array): Sniffed | undefined {
    if (bytes.length === 0) return undefined;
    if (startsWith(bytes, ZIP)) return { id: sniffZip(bytes) };
    if (startsWith(bytes, OLE)) return { id: sniffOle(bytes) };
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { id: "pdf" };
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { id: "png" };
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { id: "jpeg" };
    if (ascii(bytes, 0, 4) === "GIF8") return { id: "gif" };
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { id: "webp" };
    if (ascii(bytes, 0, 4) === "glTF") return { id: "glb" };
    if (ascii(bytes, 0, 22) === "AutoCAD Binary DXF\r\n\x1a\0") return { id: "dxf", version: "binary" };
    const dwg = /^AC(10\d\d|1\.\d\d|2\.\d\d)/.exec(ascii(bytes, 0, 6));
    if (dwg) return { id: "dwg", version: dwg[0] };
    if (ascii(bytes, 0, 7) === "V5_CFV2") return { id: "catia" };
    if (ascii(bytes, 0, 24) === "3D Geometry File Format ") return { id: "rhino" };
    if (startsWith(bytes, [0xff, 0xfe, 0xff, 0x0e, 0x53, 0x00, 0x6b, 0x00])) return { id: "sketchup" };
    if (ascii(bytes, 0, 5) === "#UGC:") return { id: "creo" };
    if (ascii(bytes, 0, 8) === "Version " && ascii(bytes, 0, 80).includes(" JT")) return { id: "jt" };
    if (ascii(bytes, 0, 2) === "BM" && bytes.length > 26) {
        const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true);
        if (size === bytes.length) return { id: "bmp" };
    }
    if (bytes.length >= 84) {
        const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
        if (84 + 50 * count === bytes.length) return { id: "stl", version: "binary" };
    }
    const text = sniffText(bytes);
    if (text === undefined) return undefined;
    return { id: sniffTextFormat(text) ?? "text" };
}

/** Text formats whose content has no signature: the extension tells them apart. */
const TEXT_FAMILY = [
    "markdown",
    "text",
    "csv",
    "tsv",
    "json",
    "xml",
    "html",
    "svg",
    "featurescript",
    "obj",
    "stl",
    "brep",
    "ply",
    "acis",
    "parasolid",
    "iges",
    "step",
    "dxf",
    "creo",
    "nc",
];

/**
 * What a generic or weak content result may be, so the extension refines it: a zip or an
 * OLE container, plain text, and text signatures that ordinary documents can also start
 * with (a Markdown file beginning with `[link]` or `<div>` is not JSON or XML).
 */
const REFINABLE: Record<string, readonly string[]> = {
    zip: ["chiliplugin", "docx", "xlsx", "pptx", "odt", "ods", "odp", "3mf", "fusion", "chili3d"],
    odf: ["odt", "ods", "odp"],
    ole: ["xls", "doc", "solidworks", "inventor", "solidedge", "creo"],
    text: TEXT_FAMILY,
    json: [...TEXT_FAMILY, "gltf", "cd"],
    xml: TEXT_FAMILY,
    html: TEXT_FAMILY,
    svg: TEXT_FAMILY,
    obj: TEXT_FAMILY,
    // A G-code-like text named as another text format (notes.txt, a .md) stays that format.
    nc: TEXT_FAMILY,
};

/**
 * What `bytes` (named `name`) is. A content signature wins over the extension (a DWG
 * saved as `.dxf` is a DWG, flagged `mismatch`); a generic result (a zip, an OLE
 * container, plain text) is refined by the extension when it fits.
 */
export function detectFileFormat(name: string, bytes: Uint8Array): DetectedFileFormat {
    const byName = fileFormatByName(name);
    const sniffed = sniffFileContent(bytes);
    if (sniffed !== undefined) {
        const refinable = REFINABLE[sniffed.id];
        if (refinable !== undefined && byName !== undefined && refinable.includes(byName.id)) {
            return { ...byName, by: "extension", mismatch: false };
        }
        const format = byId.get(sniffed.id);
        if (format !== undefined) {
            return {
                ...format,
                by: "content",
                mismatch: byName !== undefined && byName.id !== format.id,
                ...(sniffed.version === undefined ? {} : { version: sniffed.version }),
            };
        }
    }
    if (byName !== undefined) return { ...byName, by: "extension", mismatch: false };
    return { ...UNKNOWN, by: "none", mismatch: false };
}
