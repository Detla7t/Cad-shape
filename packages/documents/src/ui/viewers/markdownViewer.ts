// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Transaction } from "@chili3d/core";
import { div } from "@chili3d/element";
import { htmlPage, markdownToHtmlPage, renderMarkdown } from "../../text/markdown";
import { sanitizeHtml } from "../../text/sanitize";
import { labelButton } from "../controls";
import style from "../documents.module.css";
import type { DocumentExport, IDocumentViewer, ViewerContext } from "../viewer";
import { createCodeEditor } from "./codeEditor";

/**
 * Markdown (and HTML) documents: the source in CodeMirror beside a live, sanitized
 * preview; the toolbar switches between source, split and preview. Export as the source
 * or as a standalone HTML page.
 */
export function createMarkdownViewer({ node, document, changed }: ViewerContext): IDocumentViewer {
    const isHtml = node.format === "html";
    const render = (source: string) => (isHtml ? sanitizeHtml(source) : renderMarkdown(source));
    const source = div({ className: style.source });
    const preview = div({ className: style.preview });
    let saved = node.text;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const editor = createCodeEditor(source, saved, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            preview.innerHTML = render(editor.text());
        }, 150);
        changed();
    });
    preview.innerHTML = render(saved);

    const mode = (show: "source" | "split" | "preview") => {
        source.style.display = show === "preview" ? "none" : "";
        preview.style.display = show === "source" ? "none" : "";
        source.style.borderRight = show === "split" ? "" : "none";
    };

    const element = div(
        { className: style.body },
        div(
            { className: style.toolbar },
            labelButton("documents.view.source", () => mode("source")),
            labelButton("documents.view.split", () => mode("split")),
            labelButton("documents.view.preview", () => mode("preview")),
        ),
        div({ className: style.split }, source, preview),
    );

    const exports = (): DocumentExport[] => [
        {
            label: "documents.export.html",
            extension: ".html",
            produce: async () =>
                isHtml
                    ? htmlPage(node.name, sanitizeHtml(editor.text()))
                    : markdownToHtmlPage(node.name, editor.text()),
        },
    ];

    return {
        element,
        isDirty: () => editor.text() !== saved,
        save: async () => {
            const text = editor.text();
            Transaction.execute(document, "edit document", () => node.setText(text));
            saved = text;
            changed();
        },
        reload: () => {
            saved = node.text;
            editor.setText(saved);
            preview.innerHTML = render(saved);
            changed();
        },
        exports,
        activated: () => editor.focus(),
        dispose: () => {
            clearTimeout(timer);
            editor.dispose();
        },
    };
}
