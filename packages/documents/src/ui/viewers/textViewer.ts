// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Transaction } from "@chili3d/core";
import { div } from "@chili3d/element";
import style from "../documents.module.css";
import type { IDocumentViewer, ViewerContext } from "../viewer";
import { createCodeEditor } from "./codeEditor";

/** Plain text, JSON, XML, G-code, …: the source in CodeMirror, saved as UTF-8. */
export function createTextViewer({ node, document, changed }: ViewerContext): IDocumentViewer {
    const host = div({ className: style.code });
    let saved = node.text;
    const editor = createCodeEditor(host, saved, changed);
    return {
        element: div({ className: style.body }, host),
        isDirty: () => editor.text() !== saved,
        save: async () => {
            const text = editor.text();
            Transaction.execute(document, "edit document", () => node.setText(text));
            saved = text;
            changed();
        },
        reload: () => {
            saved = node.text;
            editor.setText(saved);
            changed();
        },
        activated: () => editor.focus(),
        dispose: () => editor.dispose(),
    };
}
