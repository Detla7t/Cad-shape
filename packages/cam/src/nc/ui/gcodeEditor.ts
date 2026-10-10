// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createCodeEditor } from "@chili3d/code-editor";
import type { EditorSelection } from "@chili3d/core";
import { type Diagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { NcDiagnostic } from "../program";
import { gcode } from "./gcodeLanguage";

/**
 * The NC program editor: the app's code editor (`@chili3d/code-editor`: line numbers, history,
 * search, Ctrl+S) with G-code highlighting, the reader's diagnostics as lint marks and a marked
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
    /** Replaces the text (and selection) without reporting a change (a reload, a restored draft). */
    setText(text: string, selection?: EditorSelection): void;
    /** The main selection, kept with a recovery snapshot. */
    selection(): EditorSelection;
    /** Puts the cursor on a line and scrolls it into view, without reporting a cursor move. */
    goToLine(line: number): void;
    /** Marks the line of the move the backplot shows (undefined: none). */
    markLine(line: number | undefined): void;
    setDiagnostics(diagnostics: readonly NcDiagnostic[]): void;
    focus(): void;
    dispose(): void;
}

const theme = EditorView.theme({
    "&": { fontSize: "12.5px" },
    ".cm-scroller": { lineHeight: "18px" },
    ".cm-nc-current": { backgroundColor: "rgba(255, 152, 0, 0.22)" },
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
    const editor = createCodeEditor(parent, {
        text,
        onChange: callbacks.changed,
        onSave: callbacks.save,
        onCursorLine: callbacks.cursorLine,
        extensions: [lintGutter(), gcode(), markField, theme],
    });
    const { view, quietly } = editor;
    return {
        view,
        text: editor.text,
        setText: editor.setText,
        selection: editor.selection,
        goToLine: (line) => {
            const doc = view.state.doc;
            if (line < 1 || line > doc.lines) return;
            const from = doc.line(line).from;
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
        focus: editor.focus,
        dispose: editor.dispose,
    };
}
