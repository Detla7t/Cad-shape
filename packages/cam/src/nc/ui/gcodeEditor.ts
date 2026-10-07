// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { type Diagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
    Decoration,
    type DecorationSet,
    drawSelection,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
} from "@codemirror/view";
import type { NcDiagnostic } from "../program";
import { gcode } from "./gcodeLanguage";

/**
 * The NC program editor: CodeMirror 6 with G-code highlighting, line numbers, history,
 * search (Ctrl+F), the reader's diagnostics as lint marks, Ctrl+S to save, and a marked
 * line for the move the backplot shows. Loaded on first use (its own chunk).
 */

export interface GcodeEditorCallbacks {
    /** The text changed (typing, undo inside the editor). */
    changed(): void;
    /** The cursor moved to another line by the user (1-based). */
    cursorLine(line: number): void;
    save(): void;
}

export interface GcodeEditor {
    readonly view: EditorView;
    text(): string;
    /** Replaces the text without reporting a change (a reload from the node). */
    setText(text: string): void;
    /** Puts the cursor on a line and scrolls it into view, without reporting a cursor move. */
    goToLine(line: number): void;
    /** Marks the line of the move the backplot shows (undefined: none). */
    markLine(line: number | undefined): void;
    setDiagnostics(diagnostics: readonly NcDiagnostic[]): void;
    focus(): void;
    dispose(): void;
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const theme = EditorView.theme({
    "&": {
        height: "100%",
        fontSize: "12.5px",
        color: "var(--foreground-color)",
        backgroundColor: "var(--control-background-color)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: MONO, lineHeight: "18px" },
    ".cm-content": { caretColor: "var(--foreground-color)" },
    ".cm-cursor": { borderLeftColor: "var(--foreground-color)" },
    ".cm-gutters": {
        backgroundColor: "var(--background-color)",
        color: "var(--foreground-muted-color)",
        borderRight: "1px solid var(--border-color)",
    },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--title-background)" },
    ".cm-nc-current": { backgroundColor: "rgba(255, 152, 0, 0.22)" },
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

const markEffect = StateEffect.define<number | undefined>();
const currentLine = Decoration.line({ class: "cm-nc-current" });

const markField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
        let next = value.map(transaction.changes);
        for (const effect of transaction.effects) {
            if (!effect.is(markEffect)) continue;
            const line = effect.value;
            if (line === undefined || line < 1 || line > transaction.state.doc.lines) {
                next = Decoration.none;
            } else {
                const builder = new RangeSetBuilder<Decoration>();
                const from = transaction.state.doc.line(line).from;
                builder.add(from, from, currentLine);
                next = builder.finish();
            }
        }
        return next;
    },
    provide: (field) => EditorView.decorations.from(field),
});

const SEVERITY: Record<NcDiagnostic["severity"], Diagnostic["severity"]> = {
    error: "error",
    warning: "warning",
    info: "info",
};

export function createGcodeEditor(
    parent: HTMLElement,
    text: string,
    callbacks: GcodeEditorCallbacks,
): GcodeEditor {
    let silent = false;
    let lastLine = 1;
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
                history(),
                lintGutter(),
                gcode(),
                markField,
                keymap.of([
                    {
                        key: "Mod-s",
                        preventDefault: true,
                        run: () => {
                            callbacks.save();
                            return true;
                        },
                    },
                    ...defaultKeymap,
                    ...searchKeymap,
                    ...historyKeymap,
                    indentWithTab,
                ]),
                theme,
                EditorView.updateListener.of((update) => {
                    if (update.docChanged && !silent) callbacks.changed();
                    if (!update.selectionSet || silent) return;
                    const line = update.state.doc.lineAt(update.state.selection.main.head).number;
                    if (line === lastLine && !update.docChanged) return;
                    lastLine = line;
                    callbacks.cursorLine(line);
                }),
            ],
        }),
    });
    const quietly = (run: () => void) => {
        silent = true;
        try {
            run();
        } finally {
            silent = false;
        }
    };
    return {
        view,
        text: () => view.state.doc.toString(),
        setText: (next) => {
            if (next === view.state.doc.toString()) return;
            quietly(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } }));
        },
        goToLine: (line) => {
            const doc = view.state.doc;
            if (line < 1 || line > doc.lines) return;
            const from = doc.line(line).from;
            lastLine = line;
            quietly(() =>
                view.dispatch({
                    selection: { anchor: from },
                    effects: [EditorView.scrollIntoView(from, { y: "center" }), markEffect.of(line)],
                }),
            );
        },
        markLine: (line) => {
            const doc = view.state.doc;
            const effects: StateEffect<unknown>[] = [markEffect.of(line)];
            if (line !== undefined && line >= 1 && line <= doc.lines) {
                effects.push(EditorView.scrollIntoView(doc.line(line).from, { y: "nearest" }));
            }
            quietly(() => view.dispatch({ effects }));
        },
        setDiagnostics: (diagnostics) => {
            const doc = view.state.doc;
            const marks: Diagnostic[] = [];
            for (const diagnostic of diagnostics) {
                if (diagnostic.line < 1 || diagnostic.line > doc.lines) continue;
                const line = doc.line(diagnostic.line);
                marks.push({
                    from: line.from,
                    to: line.to,
                    severity: SEVERITY[diagnostic.severity],
                    message:
                        diagnostic.count > 1
                            ? `${diagnostic.message} (×${diagnostic.count})`
                            : diagnostic.message,
                });
                if (marks.length >= 500) break;
            }
            quietly(() => view.dispatch(setDiagnostics(view.state, marks)));
        },
        focus: () => view.focus(),
        dispose: () => view.destroy(),
    };
}
