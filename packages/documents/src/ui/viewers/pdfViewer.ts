// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Localize } from "@chili3d/core";
import { canvas, div, input, span } from "@chili3d/element";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { type LoadedPdf, loadPdf } from "../../viewers/pdfText";
import { toolButton } from "../controls";
import style from "../documents.module.css";
import type { IDocumentViewer, ViewerContext } from "../viewer";

/** PDF documents with pdf.js: page navigation (buttons, page number, PageUp/PageDown), zoom and fit-to-width. */
export function createPdfViewer({ node }: ViewerContext): IDocumentViewer {
    const page = canvas({ className: style.pdfPage });
    const scroller = div({ className: style.canvasScroller, tabIndex: 0 }, page);
    const pageInput = input({ className: style.pageInput, value: "1" });
    const pageCount = span({ textContent: "/ –" });
    const zoomLabel = span({ textContent: "100%" });
    let pdf: PDFDocumentProxy | undefined;
    let current = 1;
    let zoom = 1;
    let fitWidth = true;
    let task: RenderTask | undefined;
    let disposed = false;

    const render = async () => {
        if (pdf === undefined) return;
        task?.cancel();
        const pdfPage = await pdf.getPage(current);
        const base = pdfPage.getViewport({ scale: 1 });
        if (fitWidth) zoom = Math.max(0.1, (scroller.clientWidth - 48) / base.width);
        const ratio = window.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({ scale: zoom * ratio });
        page.width = Math.floor(viewport.width);
        page.height = Math.floor(viewport.height);
        page.style.width = `${Math.floor(viewport.width / ratio)}px`;
        page.style.height = `${Math.floor(viewport.height / ratio)}px`;
        const context = page.getContext("2d");
        if (context === null) return;
        task = pdfPage.render({ canvas: page, canvasContext: context, viewport });
        try {
            await task.promise;
        } catch {
            // cancelled by a newer render
        }
        pageInput.value = String(current);
        zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    };

    const go = (n: number) => {
        if (pdf === undefined) return;
        current = Math.min(pdf.numPages, Math.max(1, n));
        scroller.scrollTop = 0;
        void render();
    };
    const setZoom = (next: number) => {
        fitWidth = false;
        zoom = Math.min(8, Math.max(0.1, next));
        void render();
    };

    pageInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") go(Number(pageInput.value) || 1);
    });
    scroller.addEventListener("keydown", (e) => {
        if (e.key === "PageDown") go(current + 1);
        else if (e.key === "PageUp") go(current - 1);
    });

    let loaded: LoadedPdf | undefined;
    const load = async () => {
        await loaded?.destroy();
        loaded = undefined;
        pdf = undefined;
        try {
            loaded = await loadPdf(node.bytes);
            if (disposed) {
                await loaded.destroy();
                return;
            }
            pdf = loaded.pdf;
            pageCount.textContent = `/ ${pdf.numPages}`;
            current = Math.min(current, pdf.numPages);
            await render();
        } catch (error) {
            scroller.replaceChildren(div({ className: style.error, textContent: String(error) }));
        }
    };
    void load();

    const observer =
        typeof ResizeObserver === "undefined"
            ? undefined
            : new ResizeObserver(() => fitWidth && void render());
    observer?.observe(scroller);

    return {
        element: div(
            { className: style.body },
            div(
                { className: style.toolbar },
                toolButton("documents.pdf.previous", "‹", () => go(current - 1)),
                pageInput,
                pageCount,
                toolButton("documents.pdf.next", "›", () => go(current + 1)),
                div({ className: style.separator }),
                toolButton("documents.zoomOut", "−", () => setZoom(zoom / 1.25)),
                zoomLabel,
                toolButton("documents.zoomIn", "+", () => setZoom(zoom * 1.25)),
                toolButton("documents.fitWidth", "↔", () => {
                    fitWidth = true;
                    void render();
                }),
                span({ className: style.info, textContent: new Localize("documents.pdf.hint") }),
            ),
            scroller,
        ),
        reload: () => void load(),
        activated: () => void render(),
        dispose: () => {
            disposed = true;
            observer?.disconnect();
            task?.cancel();
            void loaded?.destroy();
        },
    };
}
