// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
    drawSelection,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
} from "@codemirror/view";

/**
 * A plain-text CodeMirror 6 editor for document sources (Markdown, text, JSON, XML):
 * line numbers, history, search (Ctrl+F), line wrapping, the app's theme colors.
 */

const theme = EditorView.theme({
    "&": {
        height: "100%",
        fontSize: "13px",
        color: "var(--foreground-color)",
        backgroundColor: "var(--control-background-color)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    },
    ".cm-content": { caretColor: "var(--foreground-color)" },
    ".cm-cursor": { borderLeftColor: "var(--foreground-color)" },
    ".cm-gutters": {
        backgroundColor: "var(--background-color)",
        color: "var(--foreground-muted-color)",
        borderRight: "1px solid var(--border-color)",
    },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--title-background)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "var(--checked-color)",
    },
    ".cm-panels": { backgroundColor: "var(--panel-background-color)", color: "var(--foreground-color)" },
});

export interface CodeEditor {
    readonly view: EditorView;
    text(): string;
    setText(text: string): void;
    focus(): void;
    dispose(): void;
}

export function createCodeEditor(
    parent: HTMLElement,
    text: string,
    onChange: () => void,
    readOnly = false,
): CodeEditor {
    let silent = false;
    const view = new EditorView({
        parent,
        state: EditorState.create({
            doc: text,
            extensions: [
                lineNumbers(),
                highlightActiveLineGutter(),
                highlightSpecialChars(),
                drawSelection(),
                highlightActiveLine(),
                highlightSelectionMatches(),
                search({ top: true }),
                EditorView.lineWrapping,
                history(),
                keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
                EditorState.readOnly.of(readOnly),
                theme,
                EditorView.updateListener.of((update) => {
                    if (update.docChanged && !silent) onChange();
                }),
            ],
        }),
    });
    return {
        view,
        text: () => view.state.doc.toString(),
        setText: (next) => {
            silent = true;
            try {
                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
            } finally {
                silent = false;
            }
        },
        focus: () => view.focus(),
        dispose: () => view.destroy(),
    };
}
