// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { createCodeEditor, minimalChange } from "../src";

function mount(text: string, options: Partial<Parameters<typeof createCodeEditor>[1]> = {}) {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onChange = rs.fn(() => {});
    const onSave = rs.fn(() => {});
    const editor = createCodeEditor(parent, { text, onChange, onSave, ...options });
    return { editor, onChange, onSave, parent };
}

describe("createCodeEditor", () => {
    test("a user edit reports a change; setText does not", () => {
        const { editor, onChange } = mount("abc");
        editor.view.dispatch({ changes: { from: 3, insert: "d" } });
        expect(editor.text()).toBe("abcd");
        expect(onChange).toHaveBeenCalledTimes(1);

        editor.setText("abc");
        expect(editor.text()).toBe("abc");
        expect(onChange).toHaveBeenCalledTimes(1);
        editor.dispose();
    });

    test("setText replaces only what differs, so the cursor stays put", () => {
        const { editor } = mount("first line\nsecond line\nthird");
        editor.view.dispatch({ selection: { anchor: 20 } });
        editor.setText("first line\nsecond line\nthird line");
        expect(editor.selection()).toEqual({ anchor: 20, head: 20 });
        editor.dispose();
    });

    test("setText puts a given selection back, clamped to the text", () => {
        const { editor } = mount("");
        editor.setText("hello world", { anchor: 6, head: 11 });
        expect(editor.selection()).toEqual({ anchor: 6, head: 11 });
        editor.setText("hi", { anchor: 1, head: 50 });
        expect(editor.selection()).toEqual({ anchor: 1, head: 2 });
        editor.dispose();
    });

    test("Ctrl+S runs onSave", () => {
        const { editor, onSave } = mount("x");
        editor.view.contentDOM.dispatchEvent(
            new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }),
        );
        expect(onSave).toHaveBeenCalledTimes(1);
        editor.dispose();
    });

    test("cursor moves by the user are reported per line, quiet dispatches are not", () => {
        const onCursorLine = rs.fn((_line: number) => {});
        const { editor } = mount("a\nb\nc", { onCursorLine });
        editor.view.dispatch({ selection: { anchor: 2 } });
        editor.view.dispatch({ selection: { anchor: 3 } });
        editor.quietly(() => editor.view.dispatch({ selection: { anchor: 4 } }));
        expect(onCursorLine.mock.calls).toEqual([[2]]);
        editor.dispose();
    });
});

describe("minimalChange", () => {
    test.each([
        ["abc", "abXc", { from: 2, to: 2, insert: "X" }],
        ["abc", "ac", { from: 1, to: 2, insert: "" }],
        ["same", "same", { from: 4, to: 4, insert: "" }],
        ["", "new", { from: 0, to: 0, insert: "new" }],
    ])("%s → %s", (current, next, change) => {
        expect(minimalChange(current, next)).toEqual(change);
        const applied = current.slice(0, change.from) + change.insert + current.slice(change.to);
        expect(applied).toBe(next);
    });
});
