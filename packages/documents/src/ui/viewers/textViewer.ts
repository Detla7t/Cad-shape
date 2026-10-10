// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CodeEditor, createCodeEditor } from "@chili3d/code-editor";
import { TextEditorBuffer } from "@chili3d/core";
import { div } from "@chili3d/element";
import style from "../documents.module.css";
import type { IDocumentViewer, ViewerContext } from "../viewer";

/** Plain text, JSON, XML, G-code, …: the source in CodeMirror, saved as UTF-8. */
export function createTextViewer({ node, document, changed }: ViewerContext): IDocumentViewer {
    const host = div({ className: style.code });
    const editor = createCodeEditor(host, { text: node.text, onChange: changed, lineWrapping: true });
    const buffer = textDocumentBuffer({ node, document, changed }, editor);
    return {
        element: div({ className: style.body }, host),
        ...buffer,
        activated: () => editor.focus(),
        dispose: () => editor.dispose(),
    };
}

/**
 * The draft of a document edited as text (plain text, Markdown, HTML): a `TextEditorBuffer`
 * over the editor, as the viewer methods the shell adapts.
 */
export function textDocumentBuffer(
    { node, document, changed }: ViewerContext,
    editor: CodeEditor,
    shown?: (text: string) => void,
): Required<Pick<IDocumentViewer, "isDirty" | "save" | "reload" | "snapshot" | "restore">> {
    const buffer = new TextEditorBuffer({
        document,
        node,
        editor: `document.${node.viewKind}`,
        transaction: "edit document",
        read: () => node.text,
        write: (text) => node.setText(text),
        text: () => editor.text(),
        show: (text, selection) => {
            editor.setText(text, selection);
            shown?.(text);
        },
        selection: () => editor.selection(),
        changed,
    });
    return {
        isDirty: () => buffer.isDirty(),
        save: async () => {
            await buffer.commit();
        },
        reload: () => buffer.revert(),
        snapshot: () => buffer.snapshot(),
        restore: (draft) => buffer.restore(draft),
    };
}
