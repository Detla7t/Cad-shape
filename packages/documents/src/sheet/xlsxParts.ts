// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type JSZip from "jszip";
import { DEFAULT_INDEXED_COLORS, DEFAULT_THEME_COLORS } from "./cellStyle";
import {
    type HyperlinkData,
    parseAddress,
    parseRange,
    type SheetData,
    type SheetImage,
    type TableColumnData,
    type TableData,
    type WorkbookData,
} from "./model";
import {
    addRelationships,
    attr,
    boolAttr,
    child,
    children,
    descendants,
    escapeXml,
    insertBefore,
    parseRelationships,
    parseXml,
    REL,
    relativeTarget,
    relsPath,
    resolvePart,
    type XmlElement,
} from "./ooxml";
import { addFormulaPrefixes, stripFormulaPrefixes } from "./xlsxFormula";

/**
 * The parts of an .xlsx package ExcelJS reads incompletely or not at all — Excel tables
 * with their calculated columns and totals, hyperlink locations and tooltips, pictures in
 * drawings (incl. SVG with its PNG fallback, grouped pictures and picture links), the
 * theme palette, defined names that are formulas, hidden gridlines — read straight from
 * the zip; and, on write, the same parts added to the package ExcelJS produced.
 */

/** DrawingML measures in English Metric Units: 914400 per inch, 9525 per CSS pixel. */
const EMU_PER_PX = 9525;
const px = (emu: string | number | undefined) => Math.round(Number(emu ?? 0) / EMU_PER_PX);
const emu = (pixels: number | undefined) => Math.round((pixels ?? 0) * EMU_PER_PX);

/** OOXML string escapes (`_x000A_` for a line feed) in names and attribute text. */
const unescapeOoxml = (text: string) =>
    text.replace(/_x([\da-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
const escapeOoxml = (text: string) =>
    escapeXml(
        Array.from(text, (ch) => {
            const code = ch.charCodeAt(0);
            return code < 0x20 && code !== 0x09
                ? `_x${code.toString(16).toUpperCase().padStart(4, "0")}_`
                : ch;
        }).join(""),
    );

const MIME_BY_EXTENSION: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    webp: "image/webp",
    tif: "image/tiff",
    tiff: "image/tiff",
    emf: "image/x-emf",
    wmf: "image/x-wmf",
};
const EXTENSION_BY_MIME: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/webp": "webp",
    "image/tiff": "tiff",
    "image/x-emf": "emf",
    "image/x-wmf": "wmf",
};
const extensionOf = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

// ------------------------------------------------------------------ Reading

export interface DefinedNamePart {
    name: string;
    /** The formula text, without "=". */
    value: string;
    localSheetId?: number;
    hidden?: boolean;
}

export interface SheetParts {
    tables: TableData[];
    hyperlinks: Record<string, HyperlinkData>;
    images: SheetImage[];
    gridLines: boolean;
}

export interface WorkbookParts {
    /** RRGGBB in SpreadsheetML theme index order (lt1, dk1, lt2, dk2, accent1–6, hlink, folHlink). */
    theme: readonly string[];
    /** RRGGBB of the legacy indexed palette (the workbook's own when it defines one). */
    indexed: readonly string[];
    names: DefinedNamePart[];
    /** In workbook (tab) order. */
    sheets: SheetParts[];
}

async function text(zip: JSZip, path: string): Promise<string | undefined> {
    return zip.file(path)?.async("string");
}

/** The worksheet part paths in tab order, from the workbook part and its relationships. */
async function worksheetPaths(zip: JSZip): Promise<{ workbookPath: string; paths: string[] }> {
    const root = parseRelationships(await text(zip, "_rels/.rels"));
    const officeDocument = [...root.values()].find((rel) => rel.type.endsWith("/officeDocument"));
    const workbookPath = officeDocument ? resolvePart("", officeDocument.target) : "xl/workbook.xml";
    const rels = parseRelationships(await text(zip, relsPath(workbookPath)));
    const book = parseXml((await text(zip, workbookPath)) ?? "");
    const paths = children(child(book, "sheets"), "sheet").map((sheet) => {
        const rel = rels.get(attr(sheet, "r:id") ?? attr(sheet, "id") ?? "");
        return rel ? resolvePart(workbookPath, rel.target) : "";
    });
    return { workbookPath, paths };
}

function readTheme(xml: string | undefined): readonly string[] {
    const scheme = descendants(parseXml(xml ?? ""), "clrScheme")[0];
    if (!scheme) return DEFAULT_THEME_COLORS;
    const order = [
        "lt1",
        "dk1",
        "lt2",
        "dk2",
        "accent1",
        "accent2",
        "accent3",
        "accent4",
        "accent5",
        "accent6",
    ];
    const colorOf = (name: string, fallback: string) => {
        const slot = child(scheme, name);
        const srgb = child(slot, "srgbClr");
        const sys = child(slot, "sysClr");
        const value = attr(srgb, "val") ?? attr(sys, "lastClr");
        return value && /^[\da-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
    };
    return [...order, "hlink", "folHlink"].map((name, i) => colorOf(name, DEFAULT_THEME_COLORS[i]));
}

function readIndexedPalette(stylesXml: string | undefined): readonly string[] {
    const block = /<(?:\w+:)?indexedColors>[\s\S]*?<\/(?:\w+:)?indexedColors>/.exec(stylesXml ?? "")?.[0];
    if (!block) return DEFAULT_INDEXED_COLORS;
    const custom = children(parseXml(block), "rgbColor").map((c) => (attr(c, "rgb") ?? "000000").slice(-6));
    return [...custom, ...DEFAULT_INDEXED_COLORS.slice(custom.length)];
}

function readTable(xml: string | undefined): TableData | undefined {
    const table = parseXml(xml ?? "");
    const ref = attr(table, "ref");
    const name = attr(table, "displayName") ?? attr(table, "name");
    if (!table || !ref || !name) return undefined;
    const columns = children(child(table, "tableColumns"), "tableColumn").map((column): TableColumnData => {
        const formula = child(column, "calculatedColumnFormula")?.text;
        const totalsFunction = attr(column, "totalsRowFunction");
        const totalsLabel = attr(column, "totalsRowLabel");
        return {
            name: unescapeOoxml(attr(column, "name") ?? ""),
            ...(formula ? { formula: stripFormulaPrefixes(formula.replace(/^=/, "")) } : {}),
            ...(totalsFunction ? { totalsFunction } : {}),
            ...(totalsLabel ? { totalsLabel } : {}),
        };
    });
    const info = child(table, "tableStyleInfo");
    const headerRow = (attr(table, "headerRowCount") ?? "1") !== "0";
    const totalsRow = (attr(table, "totalsRowCount") ?? "0") !== "0";
    return {
        name,
        ref,
        ...(headerRow ? {} : { headerRow: false }),
        ...(totalsRow ? { totalsRow: true } : {}),
        columns,
        ...(info
            ? {
                  style: {
                      ...(attr(info, "name") ? { name: attr(info, "name") } : {}),
                      showRowStripes: boolAttr(info, "showRowStripes", false),
                      showColumnStripes: boolAttr(info, "showColumnStripes", false),
                      showFirstColumn: boolAttr(info, "showFirstColumn", false),
                      showLastColumn: boolAttr(info, "showLastColumn", false),
                  },
              }
            : {}),
    };
}

/** `<hyperlink>` elements of a worksheet part, by cell (a range link applies to its top-left cell). */
function readHyperlinks(
    sheetXml: string,
    rels: Map<string, { target: string }>,
): Record<string, HyperlinkData> {
    const start = sheetXml.search(/<(?:\w+:)?hyperlinks[\s>]/);
    if (start < 0) return {};
    const end = sheetXml.indexOf("hyperlinks>", start + 12);
    const block = parseXml(sheetXml.slice(start, end < 0 ? undefined : end + 11));
    const links: Record<string, HyperlinkData> = {};
    for (const link of children(block, "hyperlink")) {
        const ref = attr(link, "ref");
        const range = ref ? parseRange(ref) : undefined;
        if (!range) continue;
        const target = rels.get(attr(link, "r:id") ?? "")?.target;
        const location = attr(link, "location");
        const tooltip = attr(link, "tooltip");
        if (!target && !location) continue;
        const data: HyperlinkData = {
            ...(target ? { target } : {}),
            ...(location ? { location } : {}),
            ...(tooltip ? { tooltip } : {}),
        };
        const cells = (range.end.row - range.start.row + 1) * (range.end.col - range.start.col + 1);
        for (let r = range.start.row; r <= range.end.row && cells <= 1000; r++)
            for (let c = range.start.col; c <= range.end.col; c++) links[cellKey(r, c)] = { ...data };
        if (cells > 1000) links[cellKey(range.start.row, range.start.col)] = data;
    }
    return links;
}

const cellKey = (row: number, col: number) => {
    let name = "";
    for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
        name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    return `${name}${row + 1}`;
};

type Marker = NonNullable<SheetImage["from"]>;

function marker(element: XmlElement | undefined): Marker {
    const value = (name: string) => Number(child(element, name)?.text ?? 0) || 0;
    const colOffset = px(value("colOff"));
    const rowOffset = px(value("rowOff"));
    return {
        row: value("row"),
        col: value("col"),
        ...(rowOffset ? { rowOffset } : {}),
        ...(colOffset ? { colOffset } : {}),
    };
}

/** A group's child-to-sheet mapping: child EMU → pixels from the group's top-left. */
interface GroupTransform {
    offX: number;
    offY: number;
    chOffX: number;
    chOffY: number;
    scaleX: number;
    scaleY: number;
}

function xfrmOf(element: XmlElement | undefined) {
    const xfrm = descendants(element, "xfrm")[0];
    const num = (e: XmlElement | undefined, name: string) => Number(attr(e, name) ?? 0) || 0;
    return {
        x: num(child(xfrm, "off"), "x"),
        y: num(child(xfrm, "off"), "y"),
        cx: num(child(xfrm, "ext"), "cx"),
        cy: num(child(xfrm, "ext"), "cy"),
        chX: num(child(xfrm, "chOff"), "x"),
        chY: num(child(xfrm, "chOff"), "y"),
        chCx: num(child(xfrm, "chExt"), "cx"),
        chCy: num(child(xfrm, "chExt"), "cy"),
    };
}

async function readDrawing(zip: JSZip, path: string): Promise<SheetImage[]> {
    const drawing = parseXml((await text(zip, path)) ?? "");
    if (!drawing) return [];
    const rels = parseRelationships(await text(zip, relsPath(path)));
    const media = new Map<string, Promise<string | undefined>>();
    const load = (id: string | undefined) => {
        const rel = id ? rels.get(id) : undefined;
        if (!rel || rel.external) return undefined;
        const part = resolvePart(path, rel.target);
        if (!media.has(part)) media.set(part, zip.file(part)?.async("base64") ?? Promise.resolve(undefined));
        return { part, data: media.get(part) as Promise<string | undefined> };
    };
    const images: SheetImage[] = [];
    for (const anchor of drawing.children) {
        if (!["twoCellAnchor", "oneCellAnchor", "absoluteAnchor"].includes(anchor.name)) continue;
        const ext = child(anchor, "ext");
        const pos = child(anchor, "pos");
        const from: Marker =
            anchor.name === "absoluteAnchor"
                ? { row: 0, col: 0, rowOffset: px(attr(pos, "y")), colOffset: px(attr(pos, "x")) }
                : marker(child(anchor, "from"));
        const to = anchor.name === "twoCellAnchor" ? marker(child(anchor, "to")) : undefined;
        const anchorSize =
            anchor.name === "twoCellAnchor"
                ? undefined
                : { width: px(attr(ext, "cx")), height: px(attr(ext, "cy")) };
        const visit = async (element: XmlElement, group: GroupTransform | undefined): Promise<void> => {
            for (const item of element.children) {
                if (item.name === "AlternateContent") {
                    // Markup compatibility: the fallback is what a consumer without the extension shows.
                    const branch = child(item, "Fallback") ?? child(item, "Choice");
                    if (branch) await visit(branch, group);
                    continue;
                }
                if (item.name === "grpSp") {
                    const g = xfrmOf(child(item, "grpSpPr"));
                    const scaleX = g.chCx ? g.cx / g.chCx : 1;
                    const scaleY = g.chCy ? g.cy / g.chCy : 1;
                    // Compose: this group's frame inside the parent group (or the anchor).
                    const outer = group ?? {
                        offX: 0,
                        offY: 0,
                        chOffX: g.x,
                        chOffY: g.y,
                        scaleX: 1,
                        scaleY: 1,
                    };
                    await visit(item, {
                        offX: outer.offX + (g.x - outer.chOffX) * outer.scaleX,
                        offY: outer.offY + (g.y - outer.chOffY) * outer.scaleY,
                        chOffX: g.chX,
                        chOffY: g.chY,
                        scaleX: outer.scaleX * scaleX,
                        scaleY: outer.scaleY * scaleY,
                    });
                    continue;
                }
                if (item.name !== "pic") continue;
                if (boolAttr(descendants(item, "cNvPr")[0], "hidden", false)) continue;
                const blip = descendants(child(item, "blipFill"), "blip")[0];
                const raster = load(attr(blip, "r:embed") ?? attr(blip, "embed"));
                const svg = load(attr(descendants(blip, "svgBlip")[0], "r:embed"));
                const primary = svg ?? raster;
                if (!primary) continue;
                const data = await primary.data;
                if (!data) continue;
                const fallbackData = svg && raster ? await raster.data : undefined;
                const nv = descendants(item, "cNvPr")[0];
                const click = child(nv, "hlinkClick");
                const linkRel = rels.get(attr(click, "r:id") ?? "");
                const location = attr(click, "location");
                const tooltip = attr(click, "tooltip");
                const image: SheetImage = {
                    data,
                    mime: MIME_BY_EXTENSION[extensionOf(primary.part)] ?? "application/octet-stream",
                    from,
                    ...(attr(nv, "name") ? { name: attr(nv, "name") } : {}),
                    ...(attr(nv, "descr") ? { description: attr(nv, "descr") } : {}),
                    ...(linkRel?.target || location
                        ? {
                              hyperlink: {
                                  ...(linkRel?.target ? { target: linkRel.target } : {}),
                                  ...(location ? { location } : {}),
                                  ...(tooltip ? { tooltip } : {}),
                              },
                          }
                        : {}),
                    ...(svg && raster && fallbackData
                        ? {
                              fallback: {
                                  data: fallbackData,
                                  mime: MIME_BY_EXTENSION[extensionOf(raster.part)] ?? "image/png",
                              },
                          }
                        : {}),
                };
                if (group) {
                    // A picture inside a group: placed from the anchor's top-left by its own frame.
                    const own = xfrmOf(child(item, "spPr"));
                    image.from = {
                        row: from.row,
                        col: from.col,
                        rowOffset:
                            (from.rowOffset ?? 0) + px(group.offY + (own.y - group.chOffY) * group.scaleY),
                        colOffset:
                            (from.colOffset ?? 0) + px(group.offX + (own.x - group.chOffX) * group.scaleX),
                    };
                    image.size = { width: px(own.cx * group.scaleX), height: px(own.cy * group.scaleY) };
                } else if (to) image.to = to;
                else if (anchorSize) image.size = anchorSize;
                images.push(image);
            }
        };
        await visit(anchor, undefined);
    }
    return images;
}

async function readSheetParts(zip: JSZip, path: string): Promise<SheetParts> {
    const empty: SheetParts = { tables: [], hyperlinks: {}, images: [], gridLines: true };
    const xml = path ? await text(zip, path) : undefined;
    if (xml === undefined) return empty;
    const rels = parseRelationships(await text(zip, relsPath(path)));
    const tables: TableData[] = [];
    const images: SheetImage[] = [];
    for (const rel of rels.values()) {
        if (rel.external) continue;
        if (rel.type === REL.table) {
            const table = readTable(await text(zip, resolvePart(path, rel.target)));
            if (table) tables.push(table);
        } else if (rel.type === REL.drawing) {
            images.push(...(await readDrawing(zip, resolvePart(path, rel.target))));
        }
    }
    const view = /<(?:\w+:)?sheetView\s[^>]*>/.exec(xml)?.[0] ?? "";
    const gridLines = !/\bshowGridLines\s*=\s*["'](?:0|false)["']/.test(view);
    return { tables, hyperlinks: readHyperlinks(xml, rels), images, gridLines };
}

export async function readWorkbookParts(zip: JSZip): Promise<WorkbookParts> {
    const { workbookPath, paths } = await worksheetPaths(zip);
    const rels = parseRelationships(await text(zip, relsPath(workbookPath)));
    const themeRel = [...rels.values()].find((rel) => rel.type === REL.theme);
    const stylesRel = [...rels.values()].find((rel) => rel.type.endsWith("/styles"));
    const book = parseXml((await text(zip, workbookPath)) ?? "");
    const names = children(child(book, "definedNames"), "definedName").map((element): DefinedNamePart => {
        const local = attr(element, "localSheetId");
        return {
            name: attr(element, "name") ?? "",
            value: element.text.trim().replace(/^=/, ""),
            ...(local === undefined ? {} : { localSheetId: Number(local) }),
            ...(boolAttr(element, "hidden", false) ? { hidden: true } : {}),
        };
    });
    return {
        theme: readTheme(themeRel ? await text(zip, resolvePart(workbookPath, themeRel.target)) : undefined),
        indexed: readIndexedPalette(
            stylesRel ? await text(zip, resolvePart(workbookPath, stylesRel.target)) : undefined,
        ),
        names,
        sheets: await Promise.all(paths.map((path) => readSheetParts(zip, path))),
    };
}

/** A defined name's value split into plain references, or undefined when it is a formula. */
export function nameReferences(value: string): string[] | undefined {
    const parts = value.split(",").map((part) => part.trim());
    const reference = /^(?:'(?:[^']|'')+'|[^!'"(),[\]]+)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/;
    return parts.every((part) => reference.test(part)) ? parts : undefined;
}

// ------------------------------------------------------------------ Writing

const CONTENT_TYPE = {
    table: "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml",
    drawing: "application/vnd.openxmlformats-officedocument.drawing+xml",
    metadata: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml",
};

const SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIP_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Excel's dynamic-array cell metadata: formulas tagged `cm="1"` spill instead of being legacy CSE arrays. */
const DYNAMIC_ARRAY_METADATA = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<metadata xmlns="${SPREADSHEET_NS}" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray"><metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes><futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata><cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>`;

const AFTER_HYPERLINKS = [
    "printOptions",
    "pageMargins",
    "pageSetup",
    "headerFooter",
    "rowBreaks",
    "colBreaks",
    "customProperties",
    "cellWatches",
    "ignoredErrors",
    "smartTags",
    "drawing",
    "legacyDrawing",
    "legacyDrawingHF",
    "drawingHF",
    "picture",
    "oleObjects",
    "controls",
    "webPublishItems",
    "tableParts",
    "extLst",
] as const;
const AFTER_DRAWING = AFTER_HYPERLINKS.slice(AFTER_HYPERLINKS.indexOf("legacyDrawing"));
const AFTER_TABLE_PARTS = ["extLst"] as const;

function withRelationshipNamespace(xml: string): string {
    if (/<worksheet\b[^>]*\bxmlns:r=/.test(xml)) return xml;
    return xml.replace(/<worksheet\b/, `<worksheet xmlns:r="${RELATIONSHIP_NS}"`);
}

class ContentTypes {
    private readonly overrides: string[] = [];
    private readonly defaults = new Map<string, string>();
    override(part: string, type: string): void {
        this.overrides.push(`<Override PartName="/${part}" ContentType="${type}"/>`);
    }
    extension(extension: string, type: string): void {
        this.defaults.set(extension, type);
    }
    apply(xml: string): string {
        const defaults = [...this.defaults]
            .filter(([extension]) => !new RegExp(`Extension="${extension}"`, "i").test(xml))
            .map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}"/>`);
        return xml.replace("</Types>", `${defaults.join("")}${this.overrides.join("")}</Types>`);
    }
}

/** The header text of each table column (the header cell wins over a stale model name), unique. */
function tableColumnNames(
    sheet: SheetData,
    table: TableData,
    range: NonNullable<ReturnType<typeof parseRange>>,
) {
    const used = new Set<string>();
    const width = range.end.col - range.start.col + 1;
    return Array.from({ length: width }, (_, i) => {
        const header =
            table.headerRow === false
                ? undefined
                : sheet.cells[cellKey(range.start.row, range.start.col + i)];
        let name =
            (header?.v !== undefined && header.f === undefined ? String(header.v) : undefined) ??
            table.columns[i]?.name ??
            `Column${i + 1}`;
        if (name === "") name = table.columns[i]?.name || `Column${i + 1}`;
        let unique = name;
        for (let n = 2; used.has(unique.toLowerCase()); n++) unique = `${name}${n}`;
        used.add(unique.toLowerCase());
        return unique;
    });
}

function tableXml(sheet: SheetData, table: TableData, id: number): string | undefined {
    const range = parseRange(table.ref);
    if (!range) return undefined;
    const names = tableColumnNames(sheet, table, range);
    const header = table.headerRow !== false;
    const totals = table.totalsRow === true;
    const filterEnd = totals ? range.end.row - 1 : range.end.row;
    const columns = names.map((name, i) => {
        const column = table.columns[i];
        const totalsCell = totals ? sheet.cells[cellKey(range.end.row, range.start.col + i)] : undefined;
        const fn = column?.totalsFunction;
        const attrs = [
            `id="${i + 1}"`,
            `name="${escapeOoxml(name)}"`,
            fn && fn !== "none" ? `totalsRowFunction="${escapeXml(fn)}"` : "",
            column?.totalsLabel ? `totalsRowLabel="${escapeXml(column.totalsLabel)}"` : "",
        ].filter(Boolean);
        const body = [
            column?.formula
                ? `<calculatedColumnFormula>${escapeXml(addFormulaPrefixes(column.formula))}</calculatedColumnFormula>`
                : "",
            fn === "custom" && totalsCell?.f
                ? `<totalsRowFormula>${escapeXml(addFormulaPrefixes(totalsCell.f))}</totalsRowFormula>`
                : "",
        ].join("");
        return body
            ? `<tableColumn ${attrs.join(" ")}>${body}</tableColumn>`
            : `<tableColumn ${attrs.join(" ")}/>`;
    });
    const style = table.style;
    const flag = (value: boolean | undefined) => (value ? "1" : "0");
    const styleInfo = style
        ? `<tableStyleInfo${style.name ? ` name="${escapeXml(style.name)}"` : ""} showFirstColumn="${flag(style.showFirstColumn)}" showLastColumn="${flag(style.showLastColumn)}" showRowStripes="${flag(style.showRowStripes)}" showColumnStripes="${flag(style.showColumnStripes)}"/>`
        : "";
    const ref = `${cellKey(range.start.row, range.start.col)}:${cellKey(range.end.row, range.end.col)}`;
    const filter =
        header && filterEnd > range.start.row
            ? `<autoFilter ref="${cellKey(range.start.row, range.start.col)}:${cellKey(filterEnd, range.end.col)}"/>`
            : "";
    const safeName = table.name.replace(/[^\w.\\]/g, "_").replace(/^([^A-Za-z_\\])/, "_$1");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="${SPREADSHEET_NS}" id="${id}" name="${escapeXml(safeName)}" displayName="${escapeXml(safeName)}" ref="${ref}"${header ? "" : ' headerRowCount="0"'}${totals ? ' totalsRowCount="1"' : ' totalsRowShown="0"'}>${filter}<tableColumns count="${columns.length}">${columns.join("")}</tableColumns>${styleInfo}</table>`;
}

function markerXml(tag: "from" | "to", at: Marker): string {
    return `<xdr:${tag}><xdr:col>${at.col}</xdr:col><xdr:colOff>${emu(at.colOffset)}</xdr:colOff><xdr:row>${at.row}</xdr:row><xdr:rowOff>${emu(at.rowOffset)}</xdr:rowOff></xdr:${tag}>`;
}

/**
 * Writes the pictures of one sheet: the drawing part, its relationships (media, links) and
 * the media files. Returns the drawing XML.
 */
function drawingXml(
    images: SheetImage[],
    addMedia: (data: string, mime: string) => string,
    addLink: (target: string) => string,
): string {
    const anchors = images.map((image, index) => {
        const id = index + 2;
        const svg = image.mime === "image/svg+xml";
        const raster = svg ? (image.fallback ?? image) : image;
        const rasterId = addMedia(raster.data, raster.mime);
        const svgId = svg ? addMedia(image.data, image.mime) : undefined;
        const link = image.hyperlink;
        const linkId = link?.target ? addLink(link.target) : undefined;
        const click =
            linkId || link?.location
                ? `<a:hlinkClick xmlns:r="${RELATIONSHIP_NS}"${linkId ? ` r:id="${linkId}"` : ' r:id=""'}${link?.location ? ` location="${escapeXml(link.location)}"` : ""}${link?.tooltip ? ` tooltip="${escapeXml(link.tooltip)}"` : ""}/>`
                : "";
        const blipExt = svgId
            ? `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${svgId}"/></a:ext></a:extLst>`
            : "";
        const width = image.size?.width ?? 0;
        const height = image.size?.height ?? 0;
        const pic = `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="${escapeXml(image.name ?? `Picture ${index + 1}`)}"${image.description ? ` descr="${escapeXml(image.description)}"` : ""}>${click}</xdr:cNvPr><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${rasterId}">${blipExt}</a:blip><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/>`;
        if (image.to) {
            return `<xdr:twoCellAnchor editAs="oneCell">${markerXml("from", image.from)}${markerXml("to", image.to)}${pic}</xdr:twoCellAnchor>`;
        }
        return `<xdr:oneCellAnchor>${markerXml("from", image.from)}<xdr:ext cx="${emu(width)}" cy="${emu(height)}"/>${pic}</xdr:oneCellAnchor>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${RELATIONSHIP_NS}">${anchors.join("")}</xdr:wsDr>`;
}

function hyperlinksXml(links: Record<string, HyperlinkData>, addLink: (target: string) => string): string {
    const items = Object.entries(links)
        .filter(([address, link]) => parseAddress(address) && (link.target || link.location))
        .map(([address, link]) => {
            const id = link.target ? addLink(link.target) : undefined;
            return `<hyperlink ref="${address}"${id ? ` r:id="${id}"` : ""}${link.location ? ` location="${escapeXml(link.location)}"` : ""}${link.tooltip ? ` tooltip="${escapeXml(link.tooltip)}"` : ""}/>`;
        });
    return items.length ? `<hyperlinks>${items.join("")}</hyperlinks>` : "";
}

/** Formula names ExcelJS cannot write (anything but plain references) as `<definedName>` XML. */
function definedNamesXml(names: { name: string; value: string }[]): string {
    return names
        .map(
            (n) =>
                `<definedName name="${escapeXml(n.name)}">${escapeXml(addFormulaPrefixes(n.value))}</definedName>`,
        )
        .join("");
}

/**
 * Adds tables, hyperlinks, pictures, dynamic-array metadata and formula names to the
 * package ExcelJS wrote for `workbook` (sheets in the same order).
 */
export async function finishXlsxPackage(
    bytes: Uint8Array,
    workbook: WorkbookData,
    formulaNames: { name: string; value: string }[],
): Promise<Uint8Array> {
    const { default: JSZipModule } = await import("jszip");
    const zip = await JSZipModule.loadAsync(bytes);
    const { workbookPath, paths } = await worksheetPaths(zip);
    const types = new ContentTypes();
    let tableId = 1;
    let drawingId = 1;
    let mediaId = 1;
    let dynamicArrays = false;
    for (const [index, sheet] of workbook.sheets.entries()) {
        const path = paths[index];
        let xml = path ? await text(zip, path) : undefined;
        if (!path || xml === undefined) continue;
        const sheetRelsPath = relsPath(path);
        let sheetRels = await text(zip, sheetRelsPath);
        const addSheetRel = (type: string, target: string, external = false) => {
            const added = addRelationships(sheetRels, [{ type, target, external }]);
            sheetRels = added.xml;
            return added.ids[0];
        };
        let touched = false;
        // Dynamic arrays: every array formula is tagged as one (Excel 365 spills it).
        if (/<f\s[^>]*t="array"/.test(xml)) {
            xml = xml.replace(/<c ((?:(?!cm=)[^>])*)><f ([^>]*)t="array"/g, '<c $1 cm="1"><f $2t="array"');
            dynamicArrays = true;
            touched = true;
        }
        const links = hyperlinksXml(sheet.hyperlinks ?? {}, (target) =>
            addSheetRel(REL.hyperlink, target, true),
        );
        if (links) {
            xml = insertBefore(xml, links, AFTER_HYPERLINKS, "worksheet");
            touched = true;
        }
        const images = (sheet.images ?? []).filter((image) => image.data && EXTENSION_BY_MIME[image.mime]);
        if (images.length > 0) {
            const drawingPath = `xl/drawings/drawing${drawingId++}.xml`;
            let drawingRels: string | undefined;
            const addDrawingRel = (type: string, target: string, external = false) => {
                const added = addRelationships(drawingRels, [{ type, target, external }]);
                drawingRels = added.xml;
                return added.ids[0];
            };
            const mediaParts = new Map<string, string>();
            const drawing = drawingXml(
                images,
                (data, mime) => {
                    const key = `${mime}:${data}`;
                    let part = mediaParts.get(key);
                    if (!part) {
                        const extension = EXTENSION_BY_MIME[mime] ?? "png";
                        part = `xl/media/chili${mediaId++}.${extension}`;
                        zip.file(part, data, { base64: true });
                        types.extension(extension, mime);
                        mediaParts.set(key, part);
                    }
                    return addDrawingRel(REL.image, relativeTarget(drawingPath, part));
                },
                (target) => addDrawingRel(REL.hyperlink, target, true),
            );
            zip.file(drawingPath, drawing);
            if (drawingRels) zip.file(relsPath(drawingPath), drawingRels);
            types.override(drawingPath, CONTENT_TYPE.drawing);
            const id = addSheetRel(REL.drawing, relativeTarget(path, drawingPath));
            xml = insertBefore(xml, `<drawing r:id="${id}"/>`, AFTER_DRAWING, "worksheet");
            touched = true;
        }
        const tableParts: string[] = [];
        for (const table of sheet.tables ?? []) {
            const id = tableId++;
            const content = tableXml(sheet, table, id);
            if (!content) continue;
            const tablePath = `xl/tables/table${id}.xml`;
            zip.file(tablePath, content);
            types.override(tablePath, CONTENT_TYPE.table);
            tableParts.push(`<tablePart r:id="${addSheetRel(REL.table, relativeTarget(path, tablePath))}"/>`);
        }
        if (tableParts.length > 0) {
            xml = insertBefore(
                xml,
                `<tableParts count="${tableParts.length}">${tableParts.join("")}</tableParts>`,
                AFTER_TABLE_PARTS,
                "worksheet",
            );
            touched = true;
        }
        if (touched) {
            zip.file(path, withRelationshipNamespace(xml));
            if (sheetRels) zip.file(sheetRelsPath, sheetRels);
        }
    }
    let bookXml = (await text(zip, workbookPath)) ?? "";
    const extraNames = definedNamesXml(formulaNames);
    if (extraNames) {
        bookXml = /<definedNames\s*\/>/.test(bookXml)
            ? bookXml.replace(/<definedNames\s*\/>/, `<definedNames>${extraNames}</definedNames>`)
            : bookXml.includes("</definedNames>")
              ? bookXml.replace("</definedNames>", `${extraNames}</definedNames>`)
              : insertBefore(
                    bookXml,
                    `<definedNames>${extraNames}</definedNames>`,
                    [
                        "calcPr",
                        "oleSize",
                        "customWorkbookViews",
                        "pivotCaches",
                        "smartTagPr",
                        "smartTagTypes",
                        "webPublishing",
                        "fileRecoveryPr",
                        "webPublishObjects",
                        "extLst",
                    ],
                    "workbook",
                );
        zip.file(workbookPath, bookXml);
    }
    if (dynamicArrays) {
        const metadataPath = `${workbookPath.slice(0, workbookPath.lastIndexOf("/") + 1)}metadata.xml`;
        zip.file(metadataPath, DYNAMIC_ARRAY_METADATA);
        types.override(metadataPath, CONTENT_TYPE.metadata);
        const bookRelsPath = relsPath(workbookPath);
        const added = addRelationships(await text(zip, bookRelsPath), [
            { type: REL.sheetMetadata, target: relativeTarget(workbookPath, metadataPath) },
        ]);
        zip.file(bookRelsPath, added.xml);
    }
    const contentTypes = (await text(zip, "[Content_Types].xml")) ?? "";
    zip.file("[Content_Types].xml", types.apply(contentTypes));
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
