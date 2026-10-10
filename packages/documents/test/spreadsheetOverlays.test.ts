// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { TestDocument } from "@chili3d/core/test-utils";
import type { CellRange, HyperlinkData, SheetImage, WorkbookData } from "@chili3d/sheet/model";
import { writeXlsx } from "@chili3d/sheet/xlsx";
import { DocumentFileNode } from "../src/documentFileNode";
import {
    createImageLayer,
    externalTarget,
    followHyperlink,
    imageRect,
    linkLocation,
} from "../src/ui/viewers/sheetOverlays";
import { createSpreadsheetViewer } from "../src/ui/viewers/spreadsheetViewer";

const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";
/** 100 px columns after a 40 px header, 20 px rows under a 20 px header. */
const grid = { left: (col: number) => 40 + col * 100, top: (row: number) => 20 + row * 20 };

describe("sheet pictures", () => {
    test("a two-cell anchor spans its cells; a one-cell anchor has its own size", () => {
        const twoCell: SheetImage = {
            data: PNG,
            mime: "image/png",
            from: { row: 1, col: 1, colOffset: 10, rowOffset: 5 },
            to: { row: 3, col: 2, colOffset: 50 },
        };
        expect(imageRect(twoCell, grid)).toEqual({ left: 150, top: 45, width: 140, height: 35 });
        const oneCell: SheetImage = {
            data: PNG,
            mime: "image/png",
            from: { row: 0, col: 0 },
            size: { width: 30, height: 12 },
        };
        expect(imageRect(oneCell, grid)).toEqual({ left: 40, top: 20, width: 30, height: 12 });
    });

    test("the layer shows displayable pictures (EMF only through a fallback) and follows picture links", () => {
        const onLink = rs.fn((_link: HyperlinkData) => {});
        const layer = createImageLayer(onLink);
        const sheet = {
            name: "S",
            cells: {},
            images: [
                {
                    data: btoa("<svg/>"),
                    mime: "image/svg+xml",
                    from: { row: 0, col: 0 },
                    size: { width: 10, height: 10 },
                    hyperlink: { target: "https://example.com/" },
                },
                {
                    data: "AAAA",
                    mime: "image/x-emf",
                    from: { row: 0, col: 1 },
                    size: { width: 5, height: 5 },
                },
                {
                    data: "AAAA",
                    mime: "image/x-emf",
                    fallback: { data: PNG, mime: "image/png" },
                    from: { row: 2, col: 1 },
                    size: { width: 5, height: 5 },
                },
            ],
        };
        layer.render(sheet, grid);
        const images = layer.element.querySelectorAll("img");
        expect(images).toHaveLength(2);
        expect(images[0].src).toBe(`data:image/svg+xml;base64,${btoa("<svg/>")}`);
        expect(images[0].style.left).toBe("40px");
        expect(images[1].src).toBe(`data:image/png;base64,${PNG}`);
        expect(images[1].style.top).toBe("60px");
        images[0].click();
        expect(onLink).toHaveBeenCalledWith({ target: "https://example.com/" });
        // Unchanged layout keeps the elements; a moved anchor rebuilds them.
        layer.render(sheet, grid);
        expect(layer.element.querySelector("img")).toBe(images[0]);
        layer.render(sheet, { ...grid, left: (col: number) => 60 + col * 100 });
        expect(layer.element.querySelector("img")).not.toBe(images[0]);
        expect(layer.element.querySelector("img")?.style.left).toBe("60px");
    });
});

describe("sheet hyperlinks", () => {
    const book: WorkbookData = {
        sheets: [
            { name: "Data", cells: {} },
            { name: "My sheet", cells: {} },
        ],
        names: [{ name: "Target", ranges: ["'My sheet'!$C$4"] }],
    };

    test.each([
        ["https://example.com/a", "https://example.com/a"],
        ["mailto:me@example.com", "mailto:me@example.com"],
        ["WWW.UI.COM", "https://WWW.UI.COM"],
        ["javascript:alert(1)", undefined],
        ["file:///etc/passwd", undefined],
    ])("external target %s", (target, expected) => {
        expect(externalTarget({ target })).toBe(expected);
    });

    test("in-workbook locations resolve sheet references and names", () => {
        const at = (sheet: number, row: number, col: number) => ({
            sheet,
            range: { start: { row, col }, end: { row, col } },
        });
        expect(linkLocation(book, "'My sheet'!B2", 0)).toEqual(at(1, 1, 1));
        expect(linkLocation(book, "#Data!A1", 1)).toEqual(at(0, 0, 0));
        expect(linkLocation(book, "Target", 0)).toEqual(at(1, 3, 2));
        expect(linkLocation(book, "Nowhere!A1", 0)).toBeUndefined();
    });

    test("following opens external links without opener access and navigates to locations", () => {
        const open = rs.spyOn(window, "open").mockImplementation(() => null);
        try {
            const navigate = rs.fn((_sheet: number, _range: CellRange) => {});
            expect(followHyperlink({ target: "https://example.com/" }, book, 0, navigate)).toBe(true);
            expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
            expect(followHyperlink({ location: "'My sheet'!B2" }, book, 0, navigate)).toBe(true);
            expect(navigate).toHaveBeenCalledWith(1, { start: { row: 1, col: 1 }, end: { row: 1, col: 1 } });
            expect(followHyperlink({ target: "javascript:void(0)" }, book, 0, navigate)).toBe(false);
            expect(open).toHaveBeenCalledTimes(1);
        } finally {
            open.mockRestore();
        }
    });
});

describe("spreadsheet viewer with an imported workbook", () => {
    async function open(workbook: WorkbookData) {
        const doc = new TestDocument();
        const bytes = await writeXlsx(workbook);
        const node = new DocumentFileNode({ document: doc, fileName: "book.xlsx", format: "xlsx", bytes });
        const viewer = createSpreadsheetViewer({ node, document: doc, changed: () => {} });
        document.body.append(viewer.element);
        const cell = (r: number, c: number) =>
            viewer.element.querySelector<HTMLTableCellElement>(`td[data-row="${r}"][data-col="${c}"]`);
        for (let i = 0; i < 200 && !cell(0, 0)?.textContent; i++) await new Promise((r) => setTimeout(r, 10));
        return { viewer, cell };
    }

    test("pictures, hidden gridlines and links render; Ctrl+click follows a link", async () => {
        const { viewer, cell } = await open({
            sheets: [
                {
                    name: "Report",
                    gridLines: false,
                    cells: { A1: { v: "Docs" }, B1: { v: "Details" } },
                    hyperlinks: {
                        A1: { target: "https://example.com/docs" },
                        B1: { location: "Details!C3" },
                    },
                    images: [
                        {
                            data: PNG,
                            mime: "image/png",
                            from: { row: 2, col: 1 },
                            size: { width: 20, height: 10 },
                        },
                    ],
                },
                { name: "Details", cells: { C3: { v: "here" } } },
            ],
        });
        const opened = rs.spyOn(window, "open").mockImplementation(() => null);
        try {
            expect(cell(0, 0)?.textContent).toBe("Docs");
            expect(cell(0, 0)?.className).toContain("hyperlink");
            expect(viewer.element.querySelector("table")?.className).toContain("noGridLines");
            const img = viewer.element.querySelector<HTMLImageElement>("img");
            expect(img).not.toBeNull();
            expect(img!.style.width).toBe("20px");
            cell(0, 0)!.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: true }),
            );
            expect(opened).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");
            // A plain click selects the cell instead of following the link.
            cell(0, 0)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
            expect(opened).toHaveBeenCalledTimes(1);
            cell(0, 1)!.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, button: 0, metaKey: true }),
            );
            const name = viewer.element.querySelector<HTMLInputElement>('[aria-label="Cell or range"]');
            expect(name?.value).toBe("C3");
            expect(cell(2, 2)?.textContent).toBe("here");
        } finally {
            opened.mockRestore();
            viewer.dispose();
            viewer.element.remove();
        }
    });
});
