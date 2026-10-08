// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";
import { loadPdf } from "../src/viewers/pdfText";

const { getDocument, destroy } = rs.hoisted(() => {
    const destroy = rs.fn(async () => {});
    return {
        destroy,
        getDocument: rs.fn((_options: DocumentInitParameters) => ({
            promise: Promise.resolve({ numPages: 1 }),
            destroy,
        })),
    };
});
rs.mock("pdfjs-dist", () => ({ getDocument, GlobalWorkerOptions: {} }));

test("PDF workers receive local font, character-map and decoder URLs under the app's base path", async () => {
    const base = document.createElement("base");
    base.href = "http://localhost:8080/cad/";
    document.head.appendChild(base);
    rs.stubGlobal("Worker", undefined);
    try {
        const bytes = new Uint8Array([37, 80, 68, 70]);
        const loaded = await loadPdf(bytes);
        expect(loaded.pdf.numPages).toBe(1);
        expect(getDocument).toHaveBeenCalledTimes(1);
        const options = getDocument.mock.calls[0][0];
        expect(options).toMatchObject({
            cMapUrl: "http://localhost:8080/cad/vendor/pdfjs/cmaps/",
            cMapPacked: true,
            standardFontDataUrl: "http://localhost:8080/cad/vendor/pdfjs/standard_fonts/",
            wasmUrl: "http://localhost:8080/cad/vendor/pdfjs/wasm/",
            iccUrl: "http://localhost:8080/cad/vendor/pdfjs/iccs/",
            useSystemFonts: false,
        });
        expect(options.data).toEqual(bytes);
        expect(options.data).not.toBe(bytes);
        await loaded.destroy();
        expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
        base.remove();
        rs.unstubAllGlobals();
    }
});
