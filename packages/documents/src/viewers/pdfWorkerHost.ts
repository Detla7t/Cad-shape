// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Starts pdf.js' worker — its own bundle chunk. */
export function createPdfWorker(): Worker {
    return new Worker(new URL("./pdfWorker.ts", import.meta.url));
}
