// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
    drawSelection,
    dropCursor,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    rectangularSelection,
    tooltips,
} from "@codemirror/view";
import { featureScript } from "./language";
import { featureScriptTheme, tooltipHost } from "./theme";

/**
 * The editor basics both the studio editor and the read-only std viewer use: line
 * numbers, folding, active line, bracket matching, search (Ctrl+F, Ctrl+H to replace),
 * multiple cursors (Alt+click, Ctrl+D), Shift+Alt+drag column selection, 4-space
 * indentation and the FeatureScript language and theme. Editing adds history,
 * auto-closed brackets, indent-on-input, Tab indentation and the lint gutter.
 */
export function editorBasics(options: { readOnly?: boolean } = {}): Extension {
    const common: Extension[] = [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        foldGutter(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        bracketMatching(),
        rectangularSelection({ eventFilter: (event) => event.altKey && event.shiftKey }),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        indentUnit.of("    "),
        EditorState.tabSize.of(4),
        featureScript(),
        featureScriptTheme(),
        tooltips({ parent: tooltipHost() }),
    ];
    if (options.readOnly) {
        return [
            ...common,
            EditorState.readOnly.of(true),
            keymap.of([...defaultKeymap, ...searchKeymap, ...foldKeymap]),
        ];
    }
    return [
        ...common,
        history(),
        dropCursor(),
        indentOnInput(),
        closeBrackets(),
        lintGutter(),
        keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...lintKeymap,
            indentWithTab,
        ]),
    ];
}
