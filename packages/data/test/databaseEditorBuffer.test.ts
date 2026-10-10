// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { base64ToBytes, EditorBuffers } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { DatabaseNode } from "../src/database/databaseNode";
import { DatabaseView } from "../src/database/databaseView";
import { openDatabase, readRows } from "../src/database/sqlite";
import { sqliteFile, useNodeSqlJs } from "./_helpers";

beforeAll(() => useNodeSqlJs());

async function rowCount(bytes: Uint8Array): Promise<number> {
    const db = await openDatabase(bytes);
    try {
        return readRows(db, "parts", 100, 0).total;
    } finally {
        db.close();
    }
}

async function open() {
    const doc = new TestDocument();
    const bytes = await sqliteFile(
        "CREATE TABLE parts (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO parts (name) VALUES ('cap'), ('reducer');",
    );
    const node = new DatabaseNode({ document: doc, name: "Parts", bytes });
    doc.modelManager.addNode(node);
    const view = new DatabaseView(node, doc);
    document.body.append(view.element);
    await view.ready;
    /** Runs `sql` in the view's SQL console, as the user would. */
    const run = (sql: string) => {
        const box = view.element.querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="data.database.sql"]',
        );
        expect(box).not.toBeNull();
        box!.value = sql;
        const button = [...view.element.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.textContent === "data.database.run",
        );
        expect(button).toBeDefined();
        button!.click();
    };
    const close = () => {
        view.dispose();
        view.element.remove();
    };
    return { doc, node, view, run, close };
}

describe("the database manager's editor buffer", () => {
    test("a change to the live copy is a draft; commit saves the file as one undo step", async () => {
        const { doc, node, view, run, close } = await open();
        try {
            expect(EditorBuffers.buffersOf(doc, node)).toEqual([view.buffer]);
            expect(view.buffer.isDirty()).toBe(false);
            run("INSERT INTO parts (name) VALUES ('flange')");
            expect(EditorBuffers.isDirty(node)).toBe(true);

            const before = doc.history.undoCount();
            expect((await view.buffer.commit()).isOk).toBe(true);
            expect(view.buffer.isDirty()).toBe(false);
            expect(await rowCount(node.bytes)).toBe(3);
            expect(doc.history.undoCount()).toBe(before + 1);
            await doc.history.undo();
            expect(await rowCount(node.bytes)).toBe(2);
        } finally {
            close();
        }
        expect(EditorBuffers.buffersOf(doc, node)).toEqual([]);
    });

    test("revert reopens the saved file; a snapshot brings the edited database back as a draft", async () => {
        const { node, view, run, close } = await open();
        try {
            run("DELETE FROM parts WHERE name = 'cap'");
            const snapshot = view.buffer.snapshot?.();
            expect(snapshot).toBeDefined();
            expect(await rowCount(base64ToBytes(snapshot!.data)!)).toBe(1);

            view.buffer.revert();
            await view.ready;
            expect(view.buffer.isDirty()).toBe(false);
            expect(view.buffer.snapshot?.()).toBeUndefined();

            await view.buffer.restore?.(snapshot!);
            expect(view.buffer.isDirty()).toBe(true);
            expect(await rowCount(base64ToBytes(view.buffer.snapshot!()!.data)!)).toBe(1);
            expect(await rowCount(node.bytes)).toBe(2);
        } finally {
            close();
        }
    });
});
