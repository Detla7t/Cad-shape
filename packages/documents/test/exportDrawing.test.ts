// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DialogButton,
    type DownloadedFile,
    type I18nKeys,
    PubSub,
    setDownloadDelivery,
} from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import type { Drawing } from "@chili3d/drawing";
import { rs } from "@rstest/core";
import { exportDrawingFile, PNG_DPI, showExportDrawingDialog } from "../src/ui/exportDialog";

const drawing: Drawing = {
    units: "mm",
    layers: [{ name: "0", aci: 7, color: "#000000" }],
    entities: [{ kind: "line", layer: "0", a: [0, 0], b: [40, 0] }],
};
const files: DownloadedFile[] = [];
beforeEach(() => {
    files.length = 0;
    setDownloadDelivery((file) => {
        files.push(file);
        return true;
    });
});
afterEach(() => setDownloadDelivery(undefined));

test("a drawing exports as a vector PDF, and as a PNG through the rasteriser", async () => {
    await exportDrawingFile(drawing, {
        fileName: "Plate.pdf",
        format: ".pdf",
        units: "inch",
        properties: {},
    });
    expect(files.at(-1)?.name).toBe("Plate.pdf");
    const pdf = await files.at(-1)!.blob.text();
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("/Title (Plate)");
    // converted to inches: 40 mm is 1.575 in; plus 0.197 in of margin each side at 72 pt/in
    expect(pdf).toContain("/MediaBox [0 0 141.732 ");

    const rasterize = rs.fn(
        async (_drawing: Drawing, _dpi?: number) => new Blob(["png"], { type: "image/png" }),
    );
    await exportDrawingFile(
        drawing,
        { fileName: "Plate.png", format: ".png", units: "mm", properties: {} },
        rasterize,
    );
    expect(rasterize).toHaveBeenCalledTimes(1);
    expect(rasterize.mock.calls[0][1]).toBe(PNG_DPI);
    expect(rasterize.mock.calls[0][0].units).toBe("mm");
    expect(files.at(-1)?.name).toBe("Plate.png");
});

test("the dialog offers DXF, DWG, SVG, PDF and PNG and renames the file with the format", () => {
    const doc = new TestDocument();
    let shown: { title: I18nKeys; content: HTMLElement; buttons?: DialogButton[] | (() => void) } | undefined;
    const onDialog = (title: I18nKeys, content: HTMLElement, buttons?: DialogButton[] | (() => void)) => {
        shown = { title, content, buttons };
    };
    PubSub.default.sub("showDialog", onDialog);
    try {
        showExportDrawingDialog({ document: doc, name: "Plate", drawing: () => drawing });
        const content = shown!.content;
        const format = content.querySelector<HTMLSelectElement>(
            'select[aria-label="documents.exportDialog.format"]',
        );
        const version = content.querySelector<HTMLSelectElement>(
            'select[aria-label="documents.exportDialog.version"]',
        );
        const name = content.querySelector<HTMLInputElement>(
            'input[aria-label="documents.exportDialog.fileName"]',
        );
        expect([...format!.options].map((o) => o.textContent)).toEqual(["DXF", "DWG", "SVG", "PDF", "PNG"]);
        expect(name!.value).toBe("Plate.dxf");
        format!.value = ".pdf";
        format!.dispatchEvent(new Event("change"));
        expect(name!.value).toBe("Plate.pdf");
        expect(version!.value).toBe("PDF 1.4");
        format!.value = ".png";
        format!.dispatchEvent(new Event("change"));
        expect(name!.value).toBe("Plate.png");
        expect(version!.value).toBe(`${PNG_DPI} dpi`);
    } finally {
        PubSub.default.remove("showDialog", onDialog);
    }
});
