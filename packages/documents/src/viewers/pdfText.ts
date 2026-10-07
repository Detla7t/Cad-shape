// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * PDF documents through Mozilla's pdf.js (Apache-2.0): parsing runs in pdf.js' own worker
 * (bundled as a separate chunk); XFA forms are not rendered. Loaded on first use.
 */

let workerReady = false;

/** A loaded PDF; `destroy` releases it (and its worker-side data). */
export interface LoadedPdf {
    readonly pdf: PDFDocumentProxy;
    destroy(): Promise<void>;
}

export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
    const pdfjs = await import("pdfjs-dist");
    if (!workerReady && typeof Worker !== "undefined") {
        const { createPdfWorker } = await import("./pdfWorkerHost");
        pdfjs.GlobalWorkerOptions.workerPort = createPdfWorker();
        workerReady = true;
    }
    const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: false });
    return { pdf: await task.promise, destroy: () => task.destroy() };
}

/** The text of every page, pages separated by blank lines. */
export async function pdfText(bytes: Uint8Array): Promise<Result<string>> {
    try {
        const loaded = await loadPdf(bytes);
        const pdf = loaded.pdf;
        const pages: string[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n);
            const content = await page.getTextContent();
            pages.push(
                content.items
                    .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
                    .join("")
                    .trim(),
            );
        }
        await loaded.destroy();
        return Result.ok(pages.join("\n\n"));
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}
