// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { TestDocument } from "@chili3d/core/test-utils";
import { readWorkbook } from "@chili3d/sheet/workbookIo";
import { DocumentFileNode } from "../src/documentFileNode";
import { createFormulaAssist } from "../src/ui/viewers/formulaAssist";
import { createSpreadsheetViewer } from "../src/ui/viewers/spreadsheetViewer";

describe("formula suggestions", () => {
    test("Tab accepts, arrows select, Escape dismisses, and no suggestion commits a cell", () => {
        const assist = createFormulaAssist();
        const input = document.createElement("input");
        document.body.append(input);
        assist.bind(input);
        try {
            input.value = "=sum";
            input.setSelectionRange(4, 4);
            input.focus();
            input.dispatchEvent(new Event("input"));
            const list = document.querySelector('[role="listbox"]');
            expect(list).not.toBeNull();
            expect(list!.textContent).toContain("SUMIFS");
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
            const selected = document.querySelector('[role="option"][aria-selected="true"]');
            expect(selected).not.toBeNull();
            expect(selected!.textContent).toBe("SUMIF");
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
            expect(input.value).toBe("=SUMIF(");
            expect(input.selectionStart).toBe(7);
            expect(document.querySelector('[role="listbox"]')).toBeNull();
            expect(document.body.textContent).toContain("range, criteria, [sum_range]");
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
            expect(input.getAttribute("aria-expanded")).toBe("false");
        } finally {
            assist.dispose();
            input.remove();
        }
    });
});

describe("spreadsheet editor", () => {
    test("format a range, edit its contents, and export the styled formula workbook", async () => {
        const doc = new TestDocument();
        const node = new DocumentFileNode({
            document: doc,
            fileName: "Budget.csv",
            format: "csv",
            text: "10\n20",
        });
        let changed = 0;
        const viewer = createSpreadsheetViewer({ node, document: doc, changed: () => changed++ });
        document.body.append(viewer.element);
        await Promise.resolve();
        try {
            const cellName = viewer.element.querySelector<HTMLInputElement>('[aria-label="Cell or range"]')!;
            const bar = viewer.element.querySelector<HTMLInputElement>('[aria-label="Formula bar"]')!;
            const bold = viewer.element.querySelector<HTMLButtonElement>('[aria-label="Bold"]')!;
            expect(bold).not.toBeNull();
            cellName.value = "A1:B2";
            cellName.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            bold.click();
            expect(bold.getAttribute("aria-pressed")).toBe("true");
            cellName.value = "B1";
            cellName.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            bar.value = "=sum";
            bar.focus();
            bar.setSelectionRange(4, 4);
            bar.dispatchEvent(new Event("input"));
            bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
            expect(bar.value).toBe("=SUM(");
            bar.value = "=SUM(A1:A2)";
            bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
            const cell = viewer.element.querySelector<HTMLElement>('td[data-row="0"][data-col="1"]');
            expect(cell).not.toBeNull();
            expect(cell!.textContent).toBe("30");
            expect(cell!.style.fontWeight).toBe("700");
            const xlsx = viewer.exports!().find((e) => e.extension === ".xlsx")!;
            const bytes = await xlsx.produce();
            expect(bytes).toBeInstanceOf(Uint8Array);
            const back = await readWorkbook(bytes as Uint8Array, "xlsx");
            expect(back.value.sheets[0].cells["B1"]).toMatchObject({
                f: "SUM(A1:A2)",
                v: 30,
                s: { font: { bold: true } },
            });
            expect(back.value.sheets[0].cells["B2"].s?.font?.bold).toBe(true);
            expect(changed).toBeGreaterThan(1);
            // Save must bubble to the document shell while the formula bar has focus.
            let saves = 0;
            viewer.element.addEventListener("keydown", (event) => {
                if (event.ctrlKey && event.key === "s") saves++;
            });
            bar.focus();
            bar.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
            expect(saves).toBe(1);
            // Export flushes a pending formula-bar edit even before Enter.
            bar.value = "=SUM(A1:A2)*2";
            const editedBytes = await xlsx.produce();
            const edited = await readWorkbook(editedBytes as Uint8Array, "xlsx");
            expect(edited.value.sheets[0].cells["B2"]).toMatchObject({ f: "SUM(A1:A2)*2", v: 60 });
        } finally {
            viewer.dispose();
            viewer.element.remove();
        }
    });
});
