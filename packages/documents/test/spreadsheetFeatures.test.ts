// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { TestDocument } from "@chili3d/core/test-utils";
import { WorkbookEvaluator } from "@chili3d/sheet/formula";
import { dropdownValues } from "@chili3d/sheet/operations";
import { readWorkbook } from "@chili3d/sheet/workbookIo";
import { DocumentFileNode } from "../src/documentFileNode";
import { createSpreadsheetViewer } from "../src/ui/viewers/spreadsheetViewer";

describe("spreadsheet menu interactions", () => {
    async function setup() {
        const doc = new TestDocument();
        const node = new DocumentFileNode({
            document: doc,
            fileName: "Budget.csv",
            format: "csv",
            text: "Category,Amount\nFood,10\nRent,50\nFood,20",
        });
        const viewer = createSpreadsheetViewer({ node, document: doc, changed: () => {} });
        document.body.append(viewer.element);
        await Promise.resolve();
        const click = (label: string, root: ParentNode = viewer.element) => {
            const button = root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
            expect(button).not.toBeNull();
            button!.click();
        };
        const menu = (label: string) => click(label, document.querySelector('[role="menu"]')!);
        const select = (range: string) => {
            const name = viewer.element.querySelector<HTMLInputElement>('[aria-label="Cell or range"]')!;
            name.value = range;
            name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        };
        const field = (label: string, value: string) => {
            const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
            expect(input).not.toBeNull();
            input!.value = value;
        };
        const apply = () => {
            const form = document.querySelector('form[role="dialog"]');
            expect(form).not.toBeNull();
            form!.dispatchEvent(new Event("submit", { cancelable: true }));
        };
        const cell = (r: number, c: number) =>
            viewer.element.querySelector<HTMLTableCellElement>(`td[data-row="${r}"][data-col="${c}"]`);
        const exportBook = async () => {
            const exported = await viewer.exports!()
                .find((e) => e.extension === ".xlsx")!
                .produce();
            const back = await readWorkbook(exported as Uint8Array, "xlsx");
            expect(back.isOk).toBe(true);
            return back.value;
        };
        const dispose = () => {
            viewer.dispose();
            viewer.element.remove();
        };
        return { viewer, click, menu, select, field, apply, cell, exportBook, dispose };
    }
    test("named range dialog, formula evaluation, undo and redo", async () => {
        const ui = await setup();
        try {
            ui.select("B2:B4");
            ui.click("Named ranges");
            ui.menu("Manage named ranges");
            ui.field("Name", "Expenses");
            ui.apply();
            expect(document.querySelector('[role="dialog"]')).toBeNull();
            ui.select("C1");
            ui.field("Formula bar", "=SUM(Expenses)");
            ui.viewer.element
                .querySelector('[aria-label="Formula bar"]')!
                .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            expect(ui.cell(0, 2)?.textContent).toBe("80");
            ui.click("Undo");
            expect(ui.cell(0, 2)?.textContent).toBe("");
            ui.click("Redo");
            expect(ui.cell(0, 2)?.textContent).toBe("80");
            const back = await ui.exportBook();
            expect(new WorkbookEvaluator(back).value(0, "C1")).toBe(80);
            expect(back.names?.[0].name).toBe("Expenses");
        } finally {
            ui.dispose();
        }
    });
    test("dropdown editing rejects invalid values and persists selected values", async () => {
        const ui = await setup();
        try {
            ui.select("A2:A4");
            ui.click("Insert");
            ui.menu("Dropdown");
            ui.field("Items (one per line)", "Food\nRent\nFuel");
            ui.apply();
            ui.click("Dropdown A2");
            ui.menu("Fuel");
            expect(ui.cell(1, 0)?.textContent).toBe("Fuel▾");
            ui.select("A2");
            ui.field("Formula bar", "Invalid");
            ui.viewer.element
                .querySelector('[aria-label="Formula bar"]')!
                .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            expect(ui.cell(1, 0)?.textContent).toBe("Fuel▾");
            expect(ui.viewer.element.textContent).toContain("choose a value from the dropdown");
            const back = await ui.exportBook();
            expect(back.sheets[0].cells["A2"].v).toBe("Fuel");
            expect(dropdownValues(back, 0, 3, 0)).toEqual(["Food", "Rent", "Fuel"]);
        } finally {
            ui.dispose();
        }
    });
    test("the function menu puts the aggregate below the source range without replacing data", async () => {
        const ui = await setup();
        try {
            ui.select("B2:B4");
            ui.click("Functions");
            ui.menu("SUM");
            const bar = ui.viewer.element.querySelector<HTMLInputElement>('[aria-label="Formula bar"]')!;
            expect(bar.value).toBe("=SUM(B2:B4)");
            expect(
                ui.viewer.element.querySelector<HTMLInputElement>('[aria-label="Cell or range"]')!.value,
            ).toBe("B5");
            bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            expect(ui.cell(4, 1)?.textContent).toBe("80");
            expect(ui.cell(3, 1)?.textContent).toBe("20");
        } finally {
            ui.dispose();
        }
    });
    test("copy and paste preserve styling and translate relative formulas as one undo step", async () => {
        const ui = await setup();
        try {
            ui.select("C2");
            ui.field("Formula bar", "=B2*2+$B$2");
            expect(ui.viewer.isDirty!()).toBe(true);
            ui.viewer.element
                .querySelector('[aria-label="Formula bar"]')!
                .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            ui.select("C2");
            ui.click("Bold");
            const scroller = ui.cell(1, 2)!.closest("table")!.parentElement!;
            const data = new DataTransfer();
            scroller.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, cancelable: true }));
            ui.select("C3");
            scroller.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, cancelable: true }));
            expect(ui.cell(2, 2)?.textContent).toBe("110");
            expect(ui.cell(2, 2)?.style.fontWeight).toBe("700");
            ui.click("Undo");
            expect(ui.cell(2, 2)?.textContent).toBe("");
            ui.click("Redo");
            const back = await ui.exportBook();
            expect(back.sheets[0].cells["C3"]).toMatchObject({
                f: "B3*2+$B$2",
                v: 110,
                s: { font: { bold: true } },
            });
        } finally {
            ui.dispose();
        }
    });

    test("banding, filtering, freeze, sheet rename, duplication and deletion use working menus", async () => {
        const ui = await setup();
        try {
            ui.select("A1:B4");
            ui.click("Format");
            ui.menu("Alternating colors");
            ui.apply();
            expect(ui.cell(0, 0)?.style.backgroundColor).toBe("#ca91a6");
            ui.click("Data");
            ui.menu("Create filter");
            ui.click("Filter A");
            const rent = [...document.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')].find(
                (l) => l.textContent === "Rent",
            );
            expect(rent).not.toBeUndefined();
            rent!.querySelector<HTMLInputElement>("input")!.checked = false;
            ui.apply();
            expect(ui.cell(2, 0)).toBeNull();
            expect(ui.cell(1, 0)).not.toBeNull();
            ui.click("View");
            ui.menu("Freeze first row");
            expect(ui.cell(0, 0)?.style.position).toBe("sticky");
            ui.click("All sheets");
            const current = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
            expect(current).not.toBeNull();
            // Dismiss the sheet menu through a real Escape key event.
            document
                .querySelector('[role="menu"]')!
                .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            const tab = ui.viewer.element.querySelector('[role="tab"]')!;
            const oldName = tab.textContent!;
            ui.click(`Sheet options: ${oldName}`);
            ui.menu("Rename");
            ui.field("Sheet name", "Transactions");
            ui.apply();
            expect(ui.viewer.element.querySelector('[role="tab"]')?.textContent).toBe("Transactions");
            ui.click("Sheet options: Transactions");
            ui.menu("Duplicate");
            expect(ui.viewer.element.querySelectorAll('[role="tab"]')).toHaveLength(2);
            ui.click("Sheet options: Transactions copy 1");
            ui.menu("Delete sheet");
            ui.apply();
            expect(ui.viewer.element.querySelectorAll('[role="tab"]')).toHaveLength(1);
            const back = await ui.exportBook();
            expect(back.sheets[0]).toMatchObject({
                name: "Transactions",
                autoFilter: "A1:B4",
                hiddenRows: [2],
                frozen: { rows: 1, cols: 0 },
            });
        } finally {
            ui.dispose();
        }
    });
});
