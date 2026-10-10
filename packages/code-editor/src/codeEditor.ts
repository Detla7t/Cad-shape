// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { EditorSelection } from "@chili3d/core";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
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
 * The app's plain CodeMirror 6 editor, one setup for every source editor that is not the
 * FeatureScript IDE (a text or Markdown document, an NC program): line numbers, history
 * (Ctrl+Z / Ctrl+Y), search and replace (Ctrl+F / Ctrl+H), Tab indentation, Ctrl+S, the app's
 * theme colors, and the two things an editor buffer needs (`IEditorBuffer`): replacing the text
 * without it counting as the user's edit, and the selection for a recovery snapshot.
 * Format-specific parts (a language, lint marks, decorations) come in through `extensions`.
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export const codeEditorTheme = EditorView.theme({
    "&": {
        height: "100%",
        fontSize: "13px",
        color: "var(--foreground-color)",
        backgroundColor: "var(--control-background-color)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: MONO },
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
    ".cm-tooltip": {
        backgroundColor: "var(--panel-background-color)",
        color: "var(--foreground-color)",
        border: "1px solid var(--border-color)",
    },
});

export interface CodeEditorOptions {
    /** The text to start with. */
    readonly text: string;
    /** The user changed the text (typing, undo inside the editor) — not `setText`. */
    readonly onChange?: () => void;
    /** Ctrl/Cmd+S. */
    readonly onSave?: () => void;
    /** The user moved the cursor to another line (1-based) — not `setText` or `quietly`. */
    readonly onCursorLine?: (line: number) => void;
    /** Format-specific extensions (a language, lint, decorations, theme additions). */
    readonly extensions?: readonly Extension[];
    readonly readOnly?: boolean;
    /** Wrap long lines (prose) instead of scrolling sideways (code). */
    readonly lineWrapping?: boolean;
}

export interface CodeEditor {
    readonly view: EditorView;
    text(): string;
    /**
     * Replaces the text without reporting a change — a revert, a restored draft, a reload.
     * Only the part that differs is replaced, so the cursor stays put unless `selection` is given.
     */
    setText(text: string, selection?: EditorSelection): void;
    /** The main selection, for a recovery snapshot. */
    selection(): EditorSelection;
    /** Runs dispatches that are not the user's (a marked line, diagnostics) without reporting them. */
    quietly(run: () => void): void;
    focus(): void;
    dispose(): void;
}

export function createCodeEditor(parent: HTMLElement, options: CodeEditorOptions): CodeEditor {
    let silent = false;
    let lastLine = 1;
    const saveKeys =
        options.onSave === undefined
            ? []
            : [
                  {
                      key: "Mod-s",
                      preventDefault: true,
                      run: () => {
                          options.onSave?.();
                          return true;
                      },
                  },
              ];
    const view = new EditorView({
        parent,
        state: EditorState.create({
            doc: options.text,
            extensions: [
                lineNumbers(),
                highlightActiveLineGutter(),
                highlightSpecialChars(),
                drawSelection(),
                highlightActiveLine(),
                highlightSelectionMatches(),
                search({ top: true }),
                options.lineWrapping ? EditorView.lineWrapping : [],
                history(),
                keymap.of([...saveKeys, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
                EditorState.readOnly.of(options.readOnly === true),
                codeEditorTheme,
                ...(options.extensions ?? []),
                EditorView.updateListener.of((update) => {
                    if (silent) return;
                    if (update.docChanged) options.onChange?.();
                    if (!update.selectionSet || options.onCursorLine === undefined) return;
                    const line = update.state.doc.lineAt(update.state.selection.main.head).number;
                    if (line === lastLine && !update.docChanged) return;
                    lastLine = line;
                    options.onCursorLine(line);
                }),
            ],
        }),
    });
    const quietly = (run: () => void) => {
        const outer = silent;
        silent = true;
        try {
            run();
        } finally {
            silent = outer;
        }
    };
    return {
        view,
        text: () => view.state.doc.toString(),
        setText: (text, selection) => {
            const current = view.state.doc.toString();
            const changes = current === text ? undefined : minimalChange(current, text);
            const length = text.length;
            const clamp = (offset: number) => Math.max(0, Math.min(length, offset));
            if (changes === undefined && selection === undefined) return;
            quietly(() =>
                view.dispatch({
                    ...(changes === undefined ? {} : { changes }),
                    ...(selection === undefined
                        ? {}
                        : {
                              selection: { anchor: clamp(selection.anchor), head: clamp(selection.head) },
                              scrollIntoView: true,
                          }),
                }),
            );
            if (selection !== undefined)
                lastLine = view.state.doc.lineAt(view.state.selection.main.head).number;
        },
        selection: () => {
            const main = view.state.selection.main;
            return { anchor: main.anchor, head: main.head };
        },
        quietly,
        focus: () => view.focus(),
        dispose: () => view.destroy(),
    };
}

/** The one replacement turning `current` into `next`: the common prefix and suffix stay. */
export function minimalChange(current: string, next: string): { from: number; to: number; insert: string } {
    let start = 0;
    const max = Math.min(current.length, next.length);
    while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
    let end = 0;
    while (
        end < max - start &&
        current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
    ) {
        end++;
    }
    return { from: start, to: current.length - end, insert: next.slice(start, next.length - end) };
}
