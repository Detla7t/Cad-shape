// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { escapeXml } from "@chili3d/office-io";
import { sanitizeHtml } from "@chili3d/richtext/sanitize";
import { Marked } from "marked";

/**
 * Markdown (GitHub flavored, via `marked`) to sanitized HTML for the preview, and to a
 * standalone HTML page for export. A private `Marked` instance: the AI panel configures
 * the shared one.
 */

const markdown = new Marked({ gfm: true, breaks: false, async: false });

export function renderMarkdown(source: string): string {
    return sanitizeHtml(markdown.parse(source, { async: false }) as string);
}

const PAGE_STYLE = `body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:52em;margin:2em auto;padding:0 1em;color:#1f2328}
table{border-collapse:collapse}th,td{border:1px solid #d0d7de;padding:.3em .7em}
pre,code{font-family:ui-monospace,Consolas,monospace;background:#f6f8fa}pre{padding:1em;overflow:auto}
img{max-width:100%}blockquote{margin:0;padding:0 1em;color:#59636e;border-left:.25em solid #d0d7de}`;

/** A complete HTML page of sanitized `body` HTML. */
export function htmlPage(title: string, body: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** Markdown as a standalone HTML page. */
export function markdownToHtmlPage(title: string, source: string): string {
    return htmlPage(title, renderMarkdown(source));
}

/** The plain text of an HTML fragment (block elements become lines). */
export function htmlToText(html: string): string {
    const container = document.createElement("div");
    container.innerHTML = sanitizeHtml(
        html.replace(/<(br|\/p|\/h\d|\/li|\/tr|\/div)>/gi, (tag) => `${tag}\n`),
    );
    return (container.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
