// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, Localize, readFilesAsync, Transaction } from "@chili3d/core";
import { div, option, select } from "@chili3d/element";
import { blocksToText, htmlToBlocks } from "@chili3d/richtext/blocks";
import { blocksToDocx, docxToHtml } from "@chili3d/richtext/docx";
import { blocksToOdt, odtToHtml } from "@chili3d/richtext/odt";
import { sanitizeHtml } from "@chili3d/richtext/sanitize";
import { htmlPage } from "../../text/markdown";
import { toolButton } from "../controls";
import style from "../documents.module.css";
import type { DocumentExport, IDocumentViewer, ViewerContext } from "../viewer";

/**
 * Word (DOCX) and OpenDocument (ODT) files as formatted text: the file is converted to
 * HTML (mammoth / `odt.ts`), edited in place (headings, emphasis, lists, alignment,
 * links, tables, images) and saved back to its own format from the edited content —
 * which keeps only what the editor shows, as the notice says.
 */

function exec(command: string, value?: string): void {
    // execCommand is deprecated but remains the only cross-browser rich-text editing API.
    window.document.execCommand(command, false, value);
}

function insertTable(): void {
    const rows = Number(window.prompt(I18n.translate("documents.richText.tableRows"), "3"));
    const cols = Number(window.prompt(I18n.translate("documents.richText.tableColumns"), "3"));
    if (!(rows > 0 && cols > 0 && rows <= 100 && cols <= 30)) return;
    const row = `<tr>${"<td><br></td>".repeat(cols)}</tr>`;
    exec("insertHTML", `<table>${row.repeat(rows)}</table><p><br></p>`);
}

async function insertImage(page: HTMLElement): Promise<void> {
    const files = await readFilesAsync("image/png,image/jpeg,image/gif,image/bmp", false);
    if (!files.isOk || files.value.length === 0) return;
    const file = files.value[0];
    const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
    page.focus();
    exec("insertImage", url);
}

function insertLink(): void {
    const url = window.prompt(I18n.translate("documents.richText.linkUrl"), "https://");
    if (url !== null && /^(https?:|mailto:)/i.test(url.trim())) exec("createLink", url.trim());
}

export function createRichTextViewer({ node, document, changed }: ViewerContext): IDocumentViewer {
    const isOdt = node.format === "odt";
    const page = div({ className: style.page, contentEditable: "false", spellcheck: true });
    const notice = div({ className: style.notice, textContent: new Localize("documents.richText.lossy") });
    let savedHtml = "";
    let edited = false;

    const load = async () => {
        page.contentEditable = "false";
        page.replaceChildren(
            div({ className: style.message, textContent: new Localize("documents.loading") }),
        );
        try {
            const html =
                node.bytes.length === 0
                    ? ""
                    : isOdt
                      ? await odtToHtml(node.bytes)
                      : (await docxToHtml(node.bytes)).html;
            page.innerHTML = html === "" ? "<p><br></p>" : html;
        } catch (error) {
            page.replaceChildren(div({ className: style.error, textContent: String(error) }));
            return;
        }
        page.contentEditable = "true";
        savedHtml = page.innerHTML;
        edited = false;
        changed();
    };
    let loading = load();

    page.addEventListener("input", () => {
        edited = true;
        changed();
    });
    page.addEventListener("paste", (e: ClipboardEvent) => {
        // Pasted HTML from other pages is untrusted too.
        const html = e.clipboardData?.getData("text/html");
        if (!html) return;
        e.preventDefault();
        exec("insertHTML", sanitizeHtml(html));
    });

    const blockStyle = select(
        {
            className: style.select,
            onchange: () => {
                page.focus();
                exec("formatBlock", blockStyle.value);
                blockStyle.value = "";
            },
        },
        option({ value: "", textContent: I18n.translate("documents.richText.style") }),
        ...(
            [
                ["P", "documents.richText.paragraph"],
                ["H1", "documents.richText.heading1"],
                ["H2", "documents.richText.heading2"],
                ["H3", "documents.richText.heading3"],
                ["BLOCKQUOTE", "documents.richText.quote"],
                ["PRE", "documents.richText.code"],
            ] as [string, I18nKeys][]
        ).map(([value, label]) => option({ value, textContent: I18n.translate(label) })),
    );

    const toolbar = div(
        { className: style.toolbar },
        blockStyle,
        div({ className: style.separator }),
        toolButton("documents.richText.bold", "B", () => exec("bold")),
        toolButton("documents.richText.italic", "I", () => exec("italic")),
        toolButton("documents.richText.underline", "U", () => exec("underline")),
        toolButton("documents.richText.strike", "S", () => exec("strikeThrough")),
        div({ className: style.separator }),
        toolButton("documents.richText.bullets", "•", () => exec("insertUnorderedList")),
        toolButton("documents.richText.numbers", "1.", () => exec("insertOrderedList")),
        toolButton("documents.richText.outdent", "⇤", () => exec("outdent")),
        toolButton("documents.richText.indent", "⇥", () => exec("indent")),
        div({ className: style.separator }),
        toolButton("documents.richText.alignLeft", "⯇", () => exec("justifyLeft")),
        toolButton("documents.richText.alignCenter", "≡", () => exec("justifyCenter")),
        toolButton("documents.richText.alignRight", "⯈", () => exec("justifyRight")),
        div({ className: style.separator }),
        toolButton("documents.richText.link", "↗", insertLink),
        toolButton("documents.richText.table", "▦", insertTable),
        toolButton("documents.richText.image", "▣", () => void insertImage(page)),
        toolButton("documents.richText.rule", "―", () => exec("insertHorizontalRule")),
        div({ className: style.separator }),
        toolButton("documents.richText.undo", "↶", () => exec("undo")),
        toolButton("documents.richText.redo", "↷", () => exec("redo")),
    );

    const write = async (format: "docx" | "odt") => {
        const blocks = htmlToBlocks(page);
        return format === "odt" ? blocksToOdt(blocks, node.name) : blocksToDocx(blocks, node.name);
    };

    const exports = (): DocumentExport[] => [
        { label: "documents.export.docx", extension: ".docx", produce: () => write("docx") },
        { label: "documents.export.odt", extension: ".odt", produce: () => write("odt") },
        {
            label: "documents.export.html",
            extension: ".html",
            produce: async () => htmlPage(node.name, sanitizeHtml(page.innerHTML)),
        },
        {
            label: "documents.export.text",
            extension: ".txt",
            produce: async () => blocksToText(htmlToBlocks(page)),
        },
    ];

    const isDirty = () => edited && page.innerHTML !== savedHtml;
    return {
        element: div({ className: style.body }, notice, toolbar, div({ className: style.richText }, page)),
        isDirty,
        save: async () => {
            const bytes = await write(isOdt ? "odt" : "docx");
            Transaction.execute(document, "edit document", () => node.setBytes(bytes));
            savedHtml = page.innerHTML;
            edited = false;
            changed();
        },
        reload: () => {
            loading = load();
        },
        snapshot: () => (isDirty() ? { data: page.innerHTML } : undefined),
        restore: async (draft) => {
            await loading;
            // A file that failed to load stays as it is; the draft is sanitized like a paste.
            if (page.contentEditable !== "true") return;
            page.innerHTML = sanitizeHtml(draft.data);
            edited = true;
            changed();
        },
        exports,
        activated: () => page.focus(),
        dispose: () => page.replaceChildren(),
    };
}
