// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EditorBuffers, type IEditorBuffer, type INode } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { EditorView } from "@codemirror/view";
import { DocumentFileNode } from "../src/documentFileNode";
import { createDocumentView } from "../src/ui/shell";
import { createRichTextViewer } from "../src/ui/viewers/richTextViewer";
import { createSpreadsheetViewer } from "../src/ui/viewers/spreadsheetViewer";

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeout = 3000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeout) throw new Error("timed out");
        await tick(5);
    }
}

/** The editor buffer the shell registered for `node`, once its viewer has loaded. */
async function bufferOf(node: INode): Promise<IEditorBuffer> {
    await until(() => EditorBuffers.buffersOf(undefined, node).length === 1);
    return EditorBuffers.buffersOf(undefined, node)[0];
}

describe("a text document as an editor buffer (through the shell)", () => {
    async function open(text = "first\nsecond") {
        const doc = new TestDocument();
        const node = new DocumentFileNode({ document: doc, fileName: "notes.txt", format: "text", text });
        doc.modelManager.addNode(node);
        const view = createDocumentView(node, doc);
        document.body.append(view.element);
        const buffer = await bufferOf(node);
        const host = view.element.querySelector<HTMLElement>(".cm-editor");
        expect(host).not.toBeNull();
        const editor = EditorView.findFromDOM(host!)!;
        // The shell focuses the editor; under Happy-DOM a focused CodeMirror re-enters its own
        // update on the next dispatch (selectionchange), so the test types into a blurred one.
        await tick(10);
        editor.contentDOM.blur();
        await tick(10);
        const type = (at: number, insert: string) => editor.dispatch({ changes: { from: at, insert } });
        const close = () => {
            view.dispose();
            view.element.remove();
        };
        return { doc, node, view, buffer, editor, type, close };
    }

    test("an edit makes it dirty; commit writes it as one undo step", async () => {
        const { doc, node, buffer, type, close } = await open();
        try {
            expect(buffer.editor).toBe("document.text");
            expect(buffer.isDirty()).toBe(false);
            type(0, "new ");
            expect(EditorBuffers.isDirty(node)).toBe(true);
            const before = doc.history.undoCount();
            expect((await buffer.commit()).isOk).toBe(true);
            expect(node.text).toBe("new first\nsecond");
            expect(buffer.isDirty()).toBe(false);
            expect(doc.history.undoCount()).toBe(before + 1);
            await doc.history.undo();
            expect(node.text).toBe("first\nsecond");
        } finally {
            close();
        }
        expect(EditorBuffers.buffersOf(undefined, node)).toEqual([]);
    });

    test("revert drops the draft; a snapshot restores it with its selection", async () => {
        const { node, buffer, editor, type, close } = await open();
        try {
            type(5, "!");
            editor.dispatch({ selection: { anchor: 1, head: 4 } });
            const snapshot = buffer.snapshot?.();
            expect(snapshot).toEqual({ data: "first!\nsecond", selection: { anchor: 1, head: 4 } });

            buffer.revert();
            expect(editor.state.doc.toString()).toBe("first\nsecond");
            expect(buffer.isDirty()).toBe(false);

            await buffer.restore?.(snapshot!);
            expect(editor.state.doc.toString()).toBe("first!\nsecond");
            expect(editor.state.selection.main.from).toBe(1);
            expect(editor.state.selection.main.to).toBe(4);
            expect(buffer.isDirty()).toBe(true);
            expect(node.text).toBe("first\nsecond");
        } finally {
            close();
        }
    });
});

describe("a spreadsheet's editor buffer", () => {
    test("edit, snapshot, revert, restore and save as one undo step", async () => {
        const doc = new TestDocument();
        const node = new DocumentFileNode({
            document: doc,
            fileName: "Budget.csv",
            format: "csv",
            text: "10\n20",
        });
        let changes = 0;
        const viewer = createSpreadsheetViewer({ node, document: doc, changed: () => changes++ });
        document.body.append(viewer.element);
        await until(() => viewer.element.querySelector('td[data-row="0"][data-col="0"]') !== null);
        const cell = () =>
            viewer.element.querySelector<HTMLElement>('td[data-row="0"][data-col="0"]')!.textContent;
        try {
            const cellName = viewer.element.querySelector<HTMLInputElement>('[aria-label="Cell or range"]')!;
            const bar = viewer.element.querySelector<HTMLInputElement>('[aria-label="Formula bar"]')!;
            cellName.value = "A1";
            cellName.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            bar.value = "99";
            bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
            expect(cell()).toBe("99");
            expect(viewer.isDirty?.()).toBe(true);
            expect(changes).toBeGreaterThan(0);

            const snapshot = viewer.snapshot?.();
            expect(snapshot).toBeDefined();
            expect(JSON.parse(snapshot!.data).workbook.sheets[0].cells.A1).toMatchObject({ v: 99 });

            viewer.reload?.();
            await until(() => cell() === "10");
            expect(viewer.isDirty?.()).toBe(false);
            expect(viewer.snapshot?.()).toBeUndefined();

            await viewer.restore?.(snapshot!);
            expect(cell()).toBe("99");
            expect(viewer.isDirty?.()).toBe(true);
            expect(node.text).toBe("10\n20");

            const before = doc.history.undoCount();
            await viewer.save?.();
            expect(node.text.replace(/\r\n/g, "\n").trim()).toBe("99\n20");
            expect(viewer.isDirty?.()).toBe(false);
            expect(doc.history.undoCount()).toBe(before + 1);
        } finally {
            viewer.dispose();
            viewer.element.remove();
        }
    });
});

describe("a rich-text document's editor buffer", () => {
    test("snapshot, revert and a sanitized restore", async () => {
        const doc = new TestDocument();
        const node = new DocumentFileNode({
            document: doc,
            fileName: "Letter.docx",
            format: "docx",
            bytes: new Uint8Array(),
        });
        const viewer = createRichTextViewer({ node, document: doc, changed: () => {} });
        document.body.append(viewer.element);
        const page = viewer.element.querySelector<HTMLElement>("[contenteditable]")!;
        await until(() => page.contentEditable === "true");
        try {
            page.innerHTML = "<p>Dear reader</p>";
            page.dispatchEvent(new Event("input"));
            expect(viewer.isDirty?.()).toBe(true);
            expect(viewer.snapshot?.()).toEqual({ data: "<p>Dear reader</p>" });

            viewer.reload?.();
            await until(() => viewer.isDirty?.() === false && page.contentEditable === "true");
            expect(page.textContent).toBe("");

            await viewer.restore?.({ data: '<p>Dear reader</p><script>alert("x")</script>' });
            expect(page.innerHTML).toBe("<p>Dear reader</p>");
            expect(viewer.isDirty?.()).toBe(true);
        } finally {
            viewer.dispose();
            viewer.element.remove();
        }
    });
});
