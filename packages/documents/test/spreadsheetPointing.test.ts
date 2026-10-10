// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { TestDocument } from "@chili3d/core/test-utils";
import { DocumentFileNode } from "../src/documentFileNode";
import { createSpreadsheetViewer } from "../src/ui/viewers/spreadsheetViewer";

/** A sheet with 10 in A1 and 20 in A2, mounted and loaded. */
async function mount() {
    const doc = new TestDocument();
    const node = new DocumentFileNode({
        document: doc,
        fileName: "Totals.csv",
        format: "csv",
        text: "10\n20",
    });
    const viewer = createSpreadsheetViewer({ node, document: doc, changed: () => {} });
    document.body.append(viewer.element);
    await Promise.resolve();
    const root = viewer.element;
    const scroller = root.querySelector<HTMLElement>('[tabindex="0"]')!;
    const cellName = root.querySelector<HTMLInputElement>('[aria-label="Cell or range"]')!;
    const bar = root.querySelector<HTMLInputElement>('[aria-label="Formula bar"]')!;
    const td = (row: number, col: number) =>
        root.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${col}"]`)!;
    const select = (address: string) => {
        cellName.value = address;
        cellName.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    };
    const key = (target: HTMLElement, init: KeyboardEventInit) =>
        target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    const mouse = (type: string, target: HTMLElement, init: MouseEventInit = {}) =>
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
    /** Starts an in-cell formula with "=" and returns the editor. */
    const startFormula = (address: string) => {
        select(address);
        key(scroller, { key: "=" });
        const editor = root.querySelector<HTMLInputElement>(`input[aria-label="Edit ${address}"]`)!;
        expect(editor).not.toBeNull();
        expect(editor.value).toBe("=");
        return editor;
    };
    const type = (input: HTMLInputElement, text: string) => {
        input.value = text;
        input.setSelectionRange(text.length, text.length);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const editorOf = (address: string) =>
        root.querySelector<HTMLInputElement>(`input[aria-label="Edit ${address}"]`);
    const references = () =>
        [...root.querySelectorAll<HTMLElement>('[class*="referenceLayer"] div')].map((box) => [
            box.dataset["ref"],
            box.style.left,
            box.style.top,
            box.dataset["hot"] ?? null,
        ]);
    return {
        viewer,
        root,
        scroller,
        cellName,
        bar,
        td,
        select,
        key,
        mouse,
        startFormula,
        type,
        editorOf,
        references,
    };
}

describe("point mode", () => {
    test("a click puts the cell into the formula, replaces it until something is typed, and a drag makes a range", async () => {
        const { viewer, td, mouse, startFormula, type, editorOf, references, key } = await mount();
        try {
            const editor = startFormula("B1");
            mouse("mousedown", td(0, 0));
            expect(editor.value).toBe("=A1");
            expect(editorOf("B1")).toBe(editor);
            expect(references()).toEqual([["A1", "48px", "22px", "true"]]);
            // the same reference again, then another cell: the hot one is replaced
            mouse("mousedown", td(0, 0));
            mouse("mousedown", td(1, 0));
            expect(editor.value).toBe("=A2");
            // typing ends the replacement; after an operator the next click adds
            type(editor, "=A2+");
            // the second row starts a border lower than one row height
            expect(references()).toEqual([["A2", "48px", "45px", null]]);
            mouse("mousedown", td(0, 0));
            expect(editor.value).toBe("=A2+A1");
            expect(references().map((r) => r[0])).toEqual(["A2", "A1"]);
            key(editor, { key: "Enter" });
            expect(editorOf("B1")).toBeNull();
            expect(td(0, 1).textContent).toBe("30");

            // a drag over A1:A2 inside SUM(; Enter closes the parenthesis
            const second = startFormula("B2");
            type(second, "=SUM(");
            mouse("mousedown", td(0, 0));
            mouse("mouseover", td(1, 0));
            expect(second.value).toBe("=SUM(A1:A2");
            window.dispatchEvent(new MouseEvent("mouseup"));
            mouse("mouseover", td(0, 1));
            expect(second.value).toBe("=SUM(A1:A2");
            // Shift+click stretches the hot reference from its anchor
            mouse("mousedown", td(1, 1), { shiftKey: true });
            expect(second.value).toBe("=SUM(A1:B2");
            mouse("mousedown", td(1, 0));
            expect(second.value).toBe("=SUM(A2");
            mouse("mousedown", td(0, 0), { shiftKey: true });
            expect(second.value).toBe("=SUM(A1:A2");
            key(second, { key: "Enter" });
            expect(td(1, 1).textContent).toBe("30");
            expect(references()).toEqual([]);
        } finally {
            viewer.dispose();
            viewer.element.remove();
        }
    });

    test("arrow keys walk the pointed cell, Shift stretches it, F4 cycles the anchors", async () => {
        const { viewer, td, startFormula, type, key, select, bar } = await mount();
        try {
            const editor = startFormula("B3");
            type(editor, "=SUM(");
            key(editor, { key: "ArrowUp" });
            expect(editor.value).toBe("=SUM(B2");
            key(editor, { key: "ArrowLeft" });
            expect(editor.value).toBe("=SUM(A2");
            key(editor, { key: "ArrowUp", shiftKey: true });
            expect(editor.value).toBe("=SUM(A1:A2");
            key(editor, { key: "F4" });
            expect(editor.value).toBe("=SUM($A$1:$A$2");
            key(editor, { key: "F4" });
            expect(editor.value).toBe("=SUM(A$1:A$2");
            key(editor, { key: "Enter" });
            expect(td(2, 1).textContent).toBe("30");
            select("B3");
            expect(bar.value).toBe("=SUM(A$1:A$2)");
            // outside point mode the arrows are the caret's
            const plain = startFormula("C1");
            type(plain, "=A1*2");
            const moved = key(plain, { key: "ArrowLeft" });
            expect(moved).toBe(true);
            expect(plain.value).toBe("=A1*2");
        } finally {
            viewer.dispose();
            viewer.element.remove();
        }
    });

    test("the formula bar points too, and a click outside point mode ends the edit as before", async () => {
        const { viewer, td, mouse, bar, cellName, select, type, key, startFormula, editorOf } = await mount();
        try {
            select("C1");
            bar.focus();
            type(bar, "=");
            mouse("mousedown", td(0, 0));
            expect(bar.value).toBe("=A1");
            expect(cellName.value).toBe("C1");
            expect(editorOf("C1")).toBeNull();
            key(bar, { key: "Enter" });
            expect(td(0, 2).textContent).toBe("10");
            expect(cellName.value).toBe("C2");

            const editor = startFormula("C2");
            type(editor, "=A1");
            mouse("mousedown", td(1, 0));
            expect(editorOf("C2")).toBeNull();
            expect(td(1, 2).textContent).toBe("10");
            expect(cellName.value).toBe("A2");
        } finally {
            viewer.dispose();
            viewer.element.remove();
        }
    });

    test("pointing crosses sheets: the formula moves to the bar, names the other sheet, and comes home on Enter", async () => {
        const { viewer, root, td, mouse, bar, cellName, select, type, key, startFormula, editorOf } =
            await mount();
        try {
            root.querySelector<HTMLButtonElement>('[aria-label="Add sheet"]')!.click();
            const tab = (name: string) =>
                root.querySelector<HTMLButtonElement>(`[role="tab"][aria-label="${name}"]`)!;
            expect(tab("Sheet2").getAttribute("aria-selected")).toBe("true");
            // the first sheet carries the file's name
            tab("Totals").click();
            select("D1");
            const editor = startFormula("D1");
            mouse("mousedown", tab("Sheet2"));
            tab("Sheet2").click();
            expect(editorOf("D1")).toBeNull();
            expect(bar.value).toBe("=");
            expect(tab("Sheet2").getAttribute("aria-selected")).toBe("true");
            mouse("mousedown", td(0, 0));
            expect(bar.value).toBe("=Sheet2!A1");
            type(bar, "=Sheet2!A1+1");
            key(bar, { key: "Enter" });
            expect(tab("Totals").getAttribute("aria-selected")).toBe("true");
            expect(td(0, 3).textContent).toBe("1");
            expect(cellName.value).toBe("D2");
            select("D1");
            expect(bar.value).toBe("=Sheet2!A1+1");
            expect(editor.isConnected).toBe(false);
        } finally {
            viewer.dispose();
            viewer.element.remove();
        }
    });
});
