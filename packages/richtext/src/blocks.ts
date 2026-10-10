// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { base64ToBytes } from "@chili3d/core";

/**
 * The editable subset of a word-processing document — what the rich-text editor's HTML
 * is reduced to before it is written as DOCX or ODT: headings and paragraphs (with
 * alignment), runs (bold, italic, underline, strikethrough, code, links, line breaks),
 * images, bulleted and numbered lists (nested), tables and rules. Anything else (styles,
 * headers and footers, comments, tracked changes, fields, footnotes) is not kept.
 */

export interface ImageData {
    readonly bytes: Uint8Array;
    readonly type: "png" | "jpg" | "gif" | "bmp";
    /** Display size in CSS pixels. */
    readonly width: number;
    readonly height: number;
}

export interface RunData {
    readonly text: string;
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly underline?: boolean;
    readonly strike?: boolean;
    readonly code?: boolean;
    readonly link?: string;
    /** A line break instead of text. */
    readonly break?: boolean;
    readonly image?: ImageData;
}

export type ParagraphStyle = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "pre" | "quote";
export type Alignment = "left" | "center" | "right" | "justify";

export interface ParagraphData {
    readonly kind: "paragraph";
    readonly style: ParagraphStyle;
    readonly runs: readonly RunData[];
    readonly align?: Alignment;
    /** A list item: its list type and nesting level (0 = top). */
    readonly list?: { readonly ordered: boolean; readonly level: number };
}

export interface TableCellData {
    readonly paragraphs: readonly ParagraphData[];
    readonly header?: boolean;
    readonly colSpan?: number;
}

export interface TableData {
    readonly kind: "table";
    readonly rows: readonly (readonly TableCellData[])[];
}

export type BlockData = ParagraphData | TableData | { readonly kind: "rule" };

interface RunStyle {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    code?: boolean;
    link?: string;
}

const BLOCK_TAGS = new Set([
    "P",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "PRE",
    "BLOCKQUOTE",
    "UL",
    "OL",
    "LI",
    "TABLE",
    "HR",
    "SECTION",
    "ARTICLE",
    "HEADER",
    "FOOTER",
    "FIGURE",
]);

function alignmentOf(element: Element): Alignment | undefined {
    const style = element.getAttribute("style") ?? "";
    const align =
        /text-align\s*:\s*(left|right|center|justify)/i.exec(style)?.[1] ?? element.getAttribute("align");
    return align === "left" || align === "right" || align === "center" || align === "justify"
        ? align
        : undefined;
}

/** A `data:image/...;base64,` URL as image data; undefined for anything else. */
export function imageFromDataUrl(src: string, width: number, height: number): ImageData | undefined {
    const match = /^data:image\/(png|jpe?g|gif|bmp);base64,(.*)$/is.exec(src);
    if (!match) return undefined;
    const bytes = base64ToBytes(match[2]);
    if (bytes === undefined) return undefined;
    const type = match[1].toLowerCase().startsWith("jp")
        ? "jpg"
        : (match[1].toLowerCase() as ImageData["type"]);
    return { bytes, type, width, height };
}

function imageSize(element: HTMLImageElement): { width: number; height: number } {
    const width = Number(element.getAttribute("width")) || element.naturalWidth || 320;
    const height =
        Number(element.getAttribute("height")) || element.naturalHeight || Math.round(width * 0.75);
    const scale = width > 600 ? 600 / width : 1;
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

class BlockCollector {
    readonly blocks: BlockData[] = [];
    private runs: RunData[] = [];
    private style: ParagraphStyle = "p";
    private align: Alignment | undefined;
    private list: ParagraphData["list"];

    private flush(): void {
        const runs = trimRuns(this.runs);
        if (runs.length > 0) {
            this.blocks.push({
                kind: "paragraph",
                style: this.style,
                runs,
                ...(this.align === undefined ? {} : { align: this.align }),
                ...(this.list === undefined ? {} : { list: this.list }),
            });
        }
        this.runs = [];
    }

    private paragraph(
        style: ParagraphStyle,
        align: Alignment | undefined,
        list: ParagraphData["list"],
        body: () => void,
    ): void {
        this.flush();
        const saved = [this.style, this.align, this.list] as const;
        this.style = style;
        this.align = align;
        this.list = list;
        body();
        this.flush();
        [this.style, this.align, this.list] = saved;
    }

    walk(node: Node, style: RunStyle, listLevel: number): void {
        if (node.nodeType === 3) {
            // Preformatted text keeps its spaces and line breaks; elsewhere whitespace collapses.
            const raw = node.textContent ?? "";
            const text = this.style === "pre" ? raw.replace(/\r/g, "") : raw.replace(/\s+/g, " ");
            if (text !== "") this.runs.push({ text, ...style });
            return;
        }
        if (node.nodeType !== 1) return;
        const element = node as HTMLElement;
        const tag = element.tagName.toUpperCase();
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "HEAD") return;
        if (tag === "BR") {
            this.runs.push({ text: "", break: true });
            return;
        }
        if (tag === "IMG") {
            const size = imageSize(element as HTMLImageElement);
            const image = imageFromDataUrl(element.getAttribute("src") ?? "", size.width, size.height);
            if (image !== undefined) this.runs.push({ text: "", image });
            return;
        }
        if (tag === "HR") {
            this.flush();
            this.blocks.push({ kind: "rule" });
            return;
        }
        if (tag === "TABLE") {
            this.flush();
            this.blocks.push(tableOf(element));
            return;
        }
        if (tag === "UL" || tag === "OL") {
            this.flush();
            for (const child of Array.from(element.children)) {
                if (child.tagName.toUpperCase() !== "LI") {
                    this.walk(child, style, listLevel + 1);
                    continue;
                }
                this.listItem(child as HTMLElement, tag === "OL", listLevel + 1, style);
            }
            return;
        }
        const heading = /^H([1-6])$/.exec(tag);
        if (heading) {
            this.paragraph(`h${heading[1]}` as ParagraphStyle, alignmentOf(element), undefined, () =>
                this.children(element, style, listLevel),
            );
            return;
        }
        if (tag === "PRE") {
            this.paragraph("pre", undefined, undefined, () =>
                this.children(element, { ...style, code: true }, listLevel),
            );
            return;
        }
        if (tag === "BLOCKQUOTE") {
            this.paragraph("quote", alignmentOf(element), undefined, () =>
                this.children(element, style, listLevel),
            );
            return;
        }
        if (BLOCK_TAGS.has(tag)) {
            this.paragraph(
                this.style === "quote" ? "quote" : "p",
                alignmentOf(element) ?? this.align,
                this.list,
                () => this.children(element, style, listLevel),
            );
            return;
        }
        const css = element.getAttribute("style") ?? "";
        const next: RunStyle = { ...style };
        if (tag === "B" || tag === "STRONG" || /font-weight\s*:\s*(bold|[6-9]00)/i.test(css))
            next.bold = true;
        if (tag === "I" || tag === "EM" || /font-style\s*:\s*italic/i.test(css)) next.italic = true;
        if (tag === "U" || tag === "INS" || /text-decoration[^;]*underline/i.test(css)) next.underline = true;
        if (tag === "S" || tag === "STRIKE" || tag === "DEL" || /text-decoration[^;]*line-through/i.test(css))
            next.strike = true;
        if (tag === "CODE" || tag === "KBD" || tag === "SAMP") next.code = true;
        if (tag === "A" && /^(https?:|mailto:)/i.test(element.getAttribute("href") ?? "")) {
            next.link = element.getAttribute("href") ?? undefined;
        }
        this.children(element, next, listLevel);
    }

    private listItem(item: HTMLElement, ordered: boolean, level: number, style: RunStyle): void {
        this.flush();
        const saved = [this.style, this.align, this.list] as const;
        this.style = "p";
        this.align = undefined;
        this.list = { ordered, level: level - 1 };
        for (const child of Array.from(item.childNodes)) {
            const tag = child.nodeType === 1 ? (child as Element).tagName.toUpperCase() : "";
            if (tag === "UL" || tag === "OL") {
                this.flush();
                this.walk(child, style, level);
                this.list = { ordered, level: level - 1 };
            } else {
                this.walk(child, style, level);
            }
        }
        this.flush();
        [this.style, this.align, this.list] = saved;
    }

    private children(element: Element, style: RunStyle, listLevel: number): void {
        for (const child of Array.from(element.childNodes)) this.walk(child, style, listLevel);
    }

    finish(): BlockData[] {
        this.flush();
        return this.blocks;
    }
}

/** Runs without leading/trailing blank text (whitespace between tags is not content). */
function trimRuns(runs: RunData[]): RunData[] {
    const out = runs.map((run) => ({ ...run }));
    while (out.length > 0 && !out[0].break && out[0].image === undefined && out[0].text.trim() === "")
        out.shift();
    while (out.length > 0) {
        const last = out[out.length - 1];
        if (last.image !== undefined || last.break || last.text.trim() !== "") break;
        out.pop();
    }
    if (out.length > 0 && out[0].image === undefined && !out[0].break)
        out[0] = { ...out[0], text: out[0].text.replace(/^\s+/, "") };
    const end = out.length - 1;
    if (end >= 0 && out[end].image === undefined && !out[end].break)
        out[end] = { ...out[end], text: out[end].text.replace(/\s+$/, "") };
    // Merge neighbours with the same formatting.
    const merged: RunData[] = [];
    for (const run of out) {
        const previous = merged[merged.length - 1];
        if (
            previous !== undefined &&
            run.image === undefined &&
            previous.image === undefined &&
            !run.break &&
            !previous.break &&
            previous.bold === run.bold &&
            previous.italic === run.italic &&
            previous.underline === run.underline &&
            previous.strike === run.strike &&
            previous.code === run.code &&
            previous.link === run.link
        ) {
            merged[merged.length - 1] = { ...previous, text: previous.text + run.text };
        } else merged.push(run);
    }
    return merged;
}

function tableOf(table: HTMLElement): TableData {
    const rows: TableCellData[][] = [];
    for (const row of Array.from(table.querySelectorAll("tr"))) {
        if (row.closest("table") !== table) continue;
        const cells: TableCellData[] = [];
        for (const cell of Array.from(row.children)) {
            const tag = cell.tagName.toUpperCase();
            if (tag !== "TD" && tag !== "TH") continue;
            const collector = new BlockCollector();
            collector.walk(cell, {}, 0);
            const paragraphs = collector
                .finish()
                .filter((block): block is ParagraphData => block.kind === "paragraph");
            const colSpan = Number(cell.getAttribute("colspan")) || 1;
            cells.push({
                paragraphs:
                    paragraphs.length > 0 ? paragraphs : [{ kind: "paragraph", style: "p", runs: [] }],
                ...(tag === "TH" ? { header: true } : {}),
                ...(colSpan > 1 ? { colSpan } : {}),
            });
        }
        if (cells.length > 0) rows.push(cells);
    }
    return { kind: "table", rows };
}

/** The blocks of an HTML fragment or element (the rich-text editor's content). */
export function htmlToBlocks(input: string | HTMLElement): BlockData[] {
    let root: HTMLElement;
    if (typeof input === "string") {
        root = document.createElement("div");
        root.innerHTML = input;
    } else root = input;
    const collector = new BlockCollector();
    for (const child of Array.from(root.childNodes)) collector.walk(child, {}, 0);
    return collector.finish();
}

/** The plain text of blocks: paragraphs as lines, table cells tab-separated. */
export function blocksToText(blocks: readonly BlockData[]): string {
    const runText = (runs: readonly RunData[]) => runs.map((run) => (run.break ? "\n" : run.text)).join("");
    return blocks
        .map((block) => {
            if (block.kind === "rule") return "";
            if (block.kind === "table") {
                return block.rows
                    .map((row) =>
                        row.map((cell) => cell.paragraphs.map((p) => runText(p.runs)).join(" ")).join("\t"),
                    )
                    .join("\n");
            }
            return runText(block.runs);
        })
        .join("\n");
}
