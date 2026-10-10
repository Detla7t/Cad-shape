// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { bytesToBase64 } from "@chili3d/core";
import {
    escapeXml,
    IMAGE_MIME_BY_EXTENSION,
    imageMimeOf,
    lengthToPx,
    type OdfFile,
    pxToCm,
    readOdfPackage,
    writeOdfPackage,
} from "@chili3d/office-io";
import type { BlockData, ParagraphData, RunData, TableData } from "./blocks";
import { sanitizeHtml } from "./sanitize";

/**
 * OpenDocument text (.odt, ISO/IEC 26300): read from `content.xml` (+ automatic and
 * named styles, embedded pictures) into sanitized HTML for the rich-text editor, and
 * written back from the editor's blocks as a minimal, valid ODT package (the shared ODF
 * package of `@chili3d/office-io`). Like DOCX, saving keeps the editor's subset only.
 */

// ------------------------------------------------------------------ Reading

interface TextStyle {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    align?: string;
    heading?: number;
}

const attr = (element: Element, name: string) => element.getAttribute(name);

function readStyles(documents: readonly Document[]): {
    styles: Map<string, TextStyle>;
    orderedLists: Set<string>;
} {
    const styles = new Map<string, TextStyle>();
    const parents = new Map<string, string>();
    const orderedLists = new Set<string>();
    for (const document of documents) {
        for (const style of Array.from(document.getElementsByTagName("style:style"))) {
            const name = attr(style, "style:name");
            if (name === null) continue;
            const result: TextStyle = {};
            const text = style.getElementsByTagName("style:text-properties")[0];
            if (text !== undefined) {
                const weight = attr(text, "fo:font-weight");
                if (weight === "bold" || Number(weight) >= 600) result.bold = true;
                if (attr(text, "fo:font-style") === "italic") result.italic = true;
                const underline = attr(text, "style:text-underline-style");
                if (underline !== null && underline !== "none") result.underline = true;
                const strike = attr(text, "style:text-line-through-style");
                if (strike !== null && strike !== "none") result.strike = true;
            }
            const paragraph = style.getElementsByTagName("style:paragraph-properties")[0];
            const align = paragraph === undefined ? null : attr(paragraph, "fo:text-align");
            if (align !== null) result.align = align === "end" ? "right" : align === "start" ? "left" : align;
            const heading = /^Heading_20_(\d)$/.exec(name)?.[1];
            if (heading !== undefined) result.heading = Number(heading);
            styles.set(name, result);
            const parent = attr(style, "style:parent-style-name");
            if (parent !== null) parents.set(name, parent);
        }
        for (const list of Array.from(document.getElementsByTagName("text:list-style"))) {
            const name = attr(list, "style:name");
            if (name !== null && list.getElementsByTagName("text:list-level-style-number").length > 0) {
                orderedLists.add(name);
            }
        }
    }
    // Inherit from parent styles (an automatic style based on "Heading 2" is a heading).
    const resolved = new Map<string, TextStyle>();
    const resolve = (name: string, depth = 0): TextStyle => {
        const cached = resolved.get(name);
        if (cached !== undefined) return cached;
        const own = styles.get(name) ?? {};
        const parent = parents.get(name);
        const result = parent !== undefined && depth < 10 ? { ...resolve(parent, depth + 1), ...own } : own;
        resolved.set(name, result);
        return result;
    };
    for (const name of styles.keys()) resolve(name);
    return { styles: resolved, orderedLists };
}

/** An ODT file as sanitized HTML. */
export async function odtToHtml(bytes: Uint8Array): Promise<string> {
    const { content, styleDocuments, paths, read } = await readOdfPackage(bytes);
    const { styles, orderedLists } = readStyles(styleDocuments);
    const pictures = new Map<string, string>();
    for (const path of paths) {
        const mime = imageMimeOf(path);
        const data = mime === undefined ? undefined : await read(path);
        if (data !== undefined) pictures.set(path, `data:${mime};base64,${bytesToBase64(data)}`);
    }

    const styleOf = (element: Element) => styles.get(attr(element, "text:style-name") ?? "") ?? {};

    const inline = (node: Node): string => {
        if (node.nodeType === 3) return escapeXml(node.textContent ?? "");
        if (node.nodeType !== 1) return "";
        const element = node as Element;
        const children = () => Array.from(element.childNodes).map(inline).join("");
        if (element.tagName.startsWith("text:")) {
            switch (element.tagName.slice(5)) {
                case "s":
                    return "&nbsp;".repeat(Math.max(1, Number(attr(element, "text:c") ?? 1)));
                case "tab":
                    return "&emsp;";
                case "line-break":
                    return "<br>";
                case "a": {
                    const href = attr(element, "xlink:href") ?? "";
                    return `<a href="${escapeXml(href)}">${children()}</a>`;
                }
                case "span": {
                    const style = styleOf(element);
                    let html = children();
                    if (style.bold) html = `<strong>${html}</strong>`;
                    if (style.italic) html = `<em>${html}</em>`;
                    if (style.underline) html = `<u>${html}</u>`;
                    if (style.strike) html = `<s>${html}</s>`;
                    return html;
                }
                case "note":
                case "bookmark":
                case "bookmark-start":
                case "bookmark-end":
                case "soft-page-break":
                    return "";
                default:
                    return children();
            }
        }
        if (element.tagName === "draw:frame") {
            const image = element.getElementsByTagName("draw:image")[0];
            const src = image === undefined ? undefined : pictures.get(attr(image, "xlink:href") ?? "");
            if (src === undefined) return "";
            const width = lengthToPx(attr(element, "svg:width"));
            const height = lengthToPx(attr(element, "svg:height"));
            const size = `${width === undefined ? "" : ` width="${width}"`}${height === undefined ? "" : ` height="${height}"`}`;
            return `<img src="${src}"${size}>`;
        }
        return children();
    };

    const paragraph = (element: Element): string => {
        const style = styleOf(element);
        const align =
            style.align !== undefined && style.align !== "left" ? ` style="text-align: ${style.align}"` : "";
        const body = Array.from(element.childNodes).map(inline).join("") || "<br>";
        const level =
            element.tagName === "text:h" ? Number(attr(element, "text:outline-level") ?? 1) : style.heading;
        if (level !== undefined && level >= 1) {
            const n = Math.min(6, level);
            return `<h${n}${align}>${body}</h${n}>`;
        }
        return `<p${align}>${body}</p>`;
    };

    const block = (element: Element, listStyle?: string): string => {
        if (element.tagName === "text:p" || element.tagName === "text:h") {
            return paragraph(element);
        }
        if (element.tagName === "text:list") {
            const style = attr(element, "text:style-name") ?? listStyle;
            const tag = style !== undefined && orderedLists.has(style) ? "ol" : "ul";
            const items = Array.from(element.children)
                .filter((child) => child.tagName === "text:list-item" || child.tagName === "text:list-header")
                .map(
                    (item) =>
                        `<li>${Array.from(item.children)
                            .map((child) => block(child, style))
                            .join("")}</li>`,
                );
            return `<${tag}>${items.join("")}</${tag}>`;
        }
        if (element.tagName === "table:table") {
            const rows: string[] = [];
            const collect = (parent: Element) => {
                for (const child of Array.from(parent.children)) {
                    if (child.tagName === "table:table-row") {
                        const cells = Array.from(child.children)
                            .filter((cell) => cell.tagName === "table:table-cell")
                            .map((cell) => {
                                const span = Number(attr(cell, "table:number-columns-spanned") ?? 1);
                                const colspan = span > 1 ? ` colspan="${span}"` : "";
                                return `<td${colspan}>${Array.from(cell.children)
                                    .map((c) => block(c))
                                    .join("")}</td>`;
                            });
                        rows.push(`<tr>${cells.join("")}</tr>`);
                    } else if (
                        child.tagName === "table:table-header-rows" ||
                        child.tagName === "table:table-rows"
                    ) {
                        collect(child);
                    }
                }
            };
            collect(element);
            return `<table>${rows.join("")}</table>`;
        }
        if (element.tagName === "text:section") {
            return Array.from(element.children)
                .map((child) => block(child))
                .join("");
        }
        return "";
    };

    const body = content.getElementsByTagName("office:text")[0];
    const html =
        body === undefined
            ? ""
            : Array.from(body.children)
                  .map((child) => block(child))
                  .join("");
    return sanitizeHtml(html);
}

// ------------------------------------------------------------------ Writing

interface WriteState {
    readonly textStyles: Map<string, string>;
    readonly paragraphStyles: Map<string, string>;
    readonly pictures: OdfFile[];
    tables: number;
}

function textStyleName(state: WriteState, run: RunData): string | undefined {
    const key = [run.bold && "b", run.italic && "i", run.underline && "u", run.strike && "s", run.code && "c"]
        .filter(Boolean)
        .join("");
    if (key === "") return undefined;
    let name = state.textStyles.get(key);
    if (name === undefined) {
        name = `T${state.textStyles.size + 1}`;
        state.textStyles.set(key, name);
    }
    return name;
}

function spaces(text: string): string {
    return escapeXml(text)
        .replace(/\t/g, "<text:tab/>")
        .replace(/ {2,}/g, (run) => ` <text:s text:c="${run.length - 1}"/>`)
        .replace(/^ /, '<text:s text:c="1"/>');
}

function runsXml(state: WriteState, runs: readonly RunData[]): string {
    return runs
        .map((run) => {
            if (run.break) return "<text:line-break/>";
            if (run.image !== undefined) {
                const index = state.pictures.length + 1;
                const extension = run.image.type === "jpg" ? "jpg" : run.image.type;
                const path = `Pictures/image${index}.${extension}`;
                state.pictures.push({
                    path,
                    bytes: run.image.bytes,
                    mime: IMAGE_MIME_BY_EXTENSION[extension],
                });
                return (
                    `<draw:frame draw:name="image${index}" text:anchor-type="as-char" svg:width="${pxToCm(run.image.width)}" svg:height="${pxToCm(run.image.height)}">` +
                    `<draw:image xlink:href="${path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`
                );
            }
            const style = textStyleName(state, run);
            const text =
                style === undefined
                    ? spaces(run.text)
                    : `<text:span text:style-name="${style}">${spaces(run.text)}</text:span>`;
            return run.link === undefined
                ? text
                : `<text:a xlink:type="simple" xlink:href="${escapeXml(run.link)}">${text}</text:a>`;
        })
        .join("");
}

const BASE_STYLES: Record<ParagraphData["style"], string> = {
    p: "Standard",
    h1: "Heading_20_1",
    h2: "Heading_20_2",
    h3: "Heading_20_3",
    h4: "Heading_20_4",
    h5: "Heading_20_5",
    h6: "Heading_20_6",
    pre: "Preformatted_20_Text",
    quote: "Quotations",
};

function paragraphXml(state: WriteState, block: ParagraphData): string {
    let style = BASE_STYLES[block.style];
    if (block.align !== undefined && block.align !== "left") {
        const key = `${style}|${block.align}`;
        let name = state.paragraphStyles.get(key);
        if (name === undefined) {
            name = `P${state.paragraphStyles.size + 1}`;
            state.paragraphStyles.set(key, name);
        }
        style = name;
    }
    const heading = /^h([1-6])$/.exec(block.style);
    const body = runsXml(state, block.runs);
    return heading
        ? `<text:h text:style-name="${style}" text:outline-level="${heading[1]}">${body}</text:h>`
        : `<text:p text:style-name="${style}">${body}</text:p>`;
}

function tableXml(state: WriteState, table: TableData): string {
    const columns = Math.max(
        1,
        ...table.rows.map((row) => row.reduce((n, cell) => n + (cell.colSpan ?? 1), 0)),
    );
    state.tables++;
    const rows = table.rows.map((row) => {
        const cells = row.map((cell) => {
            const span = cell.colSpan ?? 1;
            const paragraphs = cell.paragraphs.map((p) =>
                paragraphXml(
                    state,
                    cell.header ? { ...p, runs: p.runs.map((r) => ({ ...r, bold: true })) } : p,
                ),
            );
            const spanned = span > 1 ? ` table:number-columns-spanned="${span}"` : "";
            const covered = "<table:covered-table-cell/>".repeat(span - 1);
            return `<table:table-cell table:style-name="TableCell" office:value-type="string"${spanned}>${paragraphs.join("")}</table:table-cell>${covered}`;
        });
        const missing = columns - row.reduce((n, cell) => n + (cell.colSpan ?? 1), 0);
        return `<table:table-row>${cells.join("")}${'<table:table-cell office:value-type="string"><text:p/></table:table-cell>'.repeat(Math.max(0, missing))}</table:table-row>`;
    });
    return `<table:table table:name="Table${state.tables}" table:style-name="Table"><table:table-column table:number-columns-repeated="${columns}"/>${rows.join("")}</table:table>`;
}

function bodyXml(state: WriteState, blocks: readonly BlockData[]): string {
    let out = "";
    const open: boolean[] = []; // per open list level: is a list-item open
    const ordered: boolean[] = []; // per open list level: numbered or bulleted
    const closeLists = (level: number) => {
        while (open.length - 1 > level) {
            if (open[open.length - 1]) out += "</text:list-item>";
            out += "</text:list>";
            open.pop();
            ordered.pop();
        }
    };
    for (const block of blocks) {
        if (block.kind !== "paragraph" || block.list === undefined) {
            closeLists(-1);
            if (block.kind === "paragraph") out += paragraphXml(state, block);
            else if (block.kind === "rule") out += '<text:p text:style-name="Rule"/>';
            else out += tableXml(state, block);
            continue;
        }
        const level = block.list.level;
        closeLists(level);
        // A list of the other kind at this level is a new list.
        if (open.length - 1 === level && ordered[level] !== block.list.ordered) closeLists(level - 1);
        while (open.length - 1 < level) {
            if (open.length > 0 && !open[open.length - 1]) {
                out += "<text:list-item>";
                open[open.length - 1] = true;
            }
            out += `<text:list text:style-name="${block.list.ordered ? "LNumber" : "LBullet"}">`;
            open.push(false);
            ordered.push(block.list.ordered);
        }
        if (open[level]) out += "</text:list-item>";
        out += `<text:list-item>${paragraphXml(state, { ...block, list: undefined })}`;
        open[level] = true;
    }
    closeLists(-1);
    return out;
}

function listStyle(name: string, ordered: boolean): string {
    const levels = Array.from({ length: 10 }, (_, i) => {
        const indent = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="${(0.635 * (i + 2)).toFixed(3)}cm"/></style:list-level-properties>`;
        return ordered
            ? `<text:list-level-style-number text:level="${i + 1}" style:num-suffix="." style:num-format="1">${indent}</text:list-level-style-number>`
            : `<text:list-level-style-bullet text:level="${i + 1}" text:bullet-char="•">${indent}</text:list-level-style-bullet>`;
    });
    return `<text:list-style style:name="${name}">${levels.join("")}</text:list-style>`;
}

/** The blocks as an .odt file. */
export async function blocksToOdt(blocks: readonly BlockData[], title?: string): Promise<Uint8Array> {
    const state: WriteState = { textStyles: new Map(), paragraphStyles: new Map(), pictures: [], tables: 0 };
    const body = bodyXml(state, blocks);
    const textProperty: Record<string, string> = {
        b: 'fo:font-weight="bold"',
        i: 'fo:font-style="italic"',
        u: 'style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"',
        s: 'style:text-line-through-style="solid"',
        c: 'style:font-name="Liberation Mono" fo:font-family="monospace"',
    };
    const automatic = [
        ...[...state.textStyles].map(
            ([key, name]) =>
                `<style:style style:name="${name}" style:family="text"><style:text-properties ${[...key].map((k) => textProperty[k]).join(" ")}/></style:style>`,
        ),
        ...[...state.paragraphStyles].map(([key, name]) => {
            const [parent, align] = key.split("|");
            const value = align === "right" ? "end" : align;
            return `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${parent}"><style:paragraph-properties fo:text-align="${value}"/></style:style>`;
        }),
        '<style:style style:name="Rule" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:border-bottom="0.5pt solid #000000" fo:padding="0.05cm"/></style:style>',
        '<style:style style:name="Table" style:family="table"><style:table-properties style:width="17cm" table:align="margins"/></style:style>',
        '<style:style style:name="TableCell" style:family="table-cell"><style:table-cell-properties fo:padding="0.1cm" fo:border="0.5pt solid #000000"/></style:style>',
        listStyle("LBullet", false),
        listStyle("LNumber", true),
    ].join("");
    const heading = (level: number, size: string) =>
        `<style:style style:name="Heading_20_${level}" style:display-name="Heading ${level}" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:default-outline-level="${level}"><style:paragraph-properties fo:margin-top="0.42cm" fo:margin-bottom="0.21cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="${size}" fo:font-weight="bold"/></style:style>`;
    const styles = `<style:style style:name="Standard" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.25cm"/><style:text-properties style:font-name="Liberation Sans" fo:font-family="'Liberation Sans', Arial, sans-serif" fo:font-size="11pt"/></style:style>${heading(1, "20pt")}${heading(2, "16pt")}${heading(3, "14pt")}${heading(4, "12pt")}${heading(5, "11pt")}${heading(6, "10pt")}<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="1cm" fo:margin-right="1cm"/><style:text-properties fo:font-style="italic"/></style:style><style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties style:font-name="Liberation Mono" fo:font-family="monospace" fo:font-size="10pt"/></style:style>`;
    return writeOdfPackage({
        kind: "text",
        automaticStyles: automatic,
        body,
        styles,
        ...(title === undefined ? {} : { title }),
        files: state.pictures,
    });
}
