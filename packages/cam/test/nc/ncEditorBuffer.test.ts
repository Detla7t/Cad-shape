// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EditorBuffers } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { NcProgramNode } from "../../src/nc/ncProgramNode";
import { NcProgramView } from "../../src/nc/ui/ncProgramView";

const PROGRAM = "G21\nG0 X0 Y0\nG1 X10 F100\n";

async function open() {
    const doc = new TestDocument();
    const node = new NcProgramNode({ document: doc, name: "Part", source: PROGRAM });
    doc.modelManager.addNode(node);
    const view = new NcProgramView(node, doc, { parseDelay: 0 });
    await view.ready;
    return { doc, node, view };
}

describe("the NC program's editor buffer", () => {
    test("is registered while the view is mounted, and its draft commits as one undo step", async () => {
        const { doc, node, view } = await open();
        try {
            expect(EditorBuffers.buffersOf(doc, node)).toEqual([view.buffer]);
            expect(view.buffer.editor).toBe("ncProgram");
            view.setDraft(`${PROGRAM}G1 Y10\n`);
            expect(EditorBuffers.isDirty(node)).toBe(true);

            const before = doc.history.undoCount();
            expect((await view.buffer.commit()).isOk).toBe(true);
            expect(node.source).toBe(`${PROGRAM}G1 Y10\n`);
            expect(view.dirty).toBe(false);
            expect(doc.history.undoCount()).toBe(before + 1);

            // Undo shows the node's program again in a clean editor.
            await doc.history.undo();
            expect(node.source).toBe(PROGRAM);
            expect(view.text).toBe(PROGRAM);
            expect(view.dirty).toBe(false);
        } finally {
            view.dispose();
        }
        expect(EditorBuffers.buffersOf(doc, node)).toEqual([]);
    });

    test("an undo elsewhere keeps the user's own unsaved edits", async () => {
        const { doc, node, view } = await open();
        try {
            view.setDraft("G21\n");
            await view.buffer.commit();
            view.setDraft("G20\n");
            await doc.history.undo();
            expect(node.source).toBe(PROGRAM);
            expect(view.text).toBe("G20\n");
            expect(view.dirty).toBe(true);
        } finally {
            view.dispose();
        }
    });

    test("revert drops the draft; a snapshot restores it with its selection", async () => {
        const { node, view } = await open();
        try {
            view.setDraft("G21\nM30\n");
            const snapshot = view.buffer.snapshot();
            expect(snapshot?.data).toBe("G21\nM30\n");
            expect(snapshot?.selection).toBeDefined();

            view.revert();
            expect(view.text).toBe(PROGRAM);
            expect(view.dirty).toBe(false);
            expect(view.buffer.snapshot()).toBeUndefined();

            view.buffer.restore({ data: "G21\nM30\n", selection: { anchor: 4, head: 7 } });
            expect(view.text).toBe("G21\nM30\n");
            expect(view.dirty).toBe(true);
            expect(view.buffer.snapshot()?.selection).toEqual({ anchor: 4, head: 7 });
            expect(node.source).toBe(PROGRAM);
        } finally {
            view.dispose();
        }
    });
});
