// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EditorBuffers, FolderNode, type IEditorBuffer, Result } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorBufferControls } from "../src";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

function draft() {
    const document = new TestDocument();
    const node = new FolderNode({ document, name: "Notes" });
    const state = { draft: "a", committed: "a" };
    const buffer: IEditorBuffer = {
        document,
        node,
        editor: "test",
        isDirty: () => state.draft !== state.committed,
        commit: rs.fn(async () => {
            state.committed = state.draft;
            registration.changed();
            return Result.ok(undefined);
        }),
        revert: rs.fn(() => {
            state.draft = state.committed;
            registration.changed();
        }),
    };
    const registration = EditorBuffers.register(buffer);
    const type = (text: string) =>
        act(() => {
            state.draft = text;
            registration.changed();
        });
    return { buffer, registration, type, state };
}

const button = (action: string) => {
    const found = host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    expect(found).not.toBeNull();
    return found!;
};

describe("EditorBufferControls", () => {
    test("shows the unsaved mark and enables Discard and Save while the draft differs", () => {
        const { buffer, registration, type } = draft();
        try {
            act(() => root.render(<EditorBufferControls buffer={buffer} />));
            expect(host.querySelector('[role="status"]')).toBeNull();
            expect(button("save").disabled).toBe(true);
            expect(button("discard").disabled).toBe(true);

            type("b");
            expect(host.querySelector('[role="status"]')?.textContent).toBe("editorBuffers.marker");
            expect(button("save").disabled).toBe(false);

            act(() => button("discard").click());
            expect(buffer.revert).toHaveBeenCalledTimes(1);
            expect(host.querySelector('[role="status"]')).toBeNull();
        } finally {
            registration.dispose();
        }
    });

    test("Save commits the buffer, or runs the host's own save", async () => {
        const { buffer, registration, type, state } = draft();
        try {
            act(() => root.render(<EditorBufferControls buffer={buffer} />));
            type("b");
            await act(async () => button("save").click());
            expect(buffer.commit).toHaveBeenCalledTimes(1);
            expect(state.committed).toBe("b");
            expect(button("save").disabled).toBe(true);

            const onSave = rs.fn(async () => {});
            act(() => root.render(<EditorBufferControls buffer={buffer} onSave={onSave} />));
            type("c");
            await act(async () => button("save").click());
            expect(onSave).toHaveBeenCalledTimes(1);
            expect(buffer.commit).toHaveBeenCalledTimes(1);
        } finally {
            registration.dispose();
        }
    });
});
