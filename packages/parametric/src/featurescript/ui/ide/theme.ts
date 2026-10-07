// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import style from "./ide.module.css";

/**
 * The editor's look: the app's theme variables for chrome (so it follows light/dark with
 * the rest of the app) and CSS-module classes for syntax colors (`ide.module.css`).
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const editorTheme = EditorView.theme({
    "&": {
        height: "100%",
        fontSize: "12.5px",
        color: "var(--foreground-color)",
        backgroundColor: "var(--fs-editor-background)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: MONO, lineHeight: "18px" },
    ".cm-content": { caretColor: "var(--foreground-color)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground-color)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "var(--fs-selection)" },
    ".cm-gutters": {
        backgroundColor: "var(--fs-gutter-background)",
        color: "var(--foreground-muted-color)",
        borderRight: "1px solid var(--border-color)",
    },
    ".cm-activeLine": { backgroundColor: "var(--fs-active-line)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--fs-active-line)", color: "var(--foreground-color)" },
    ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", padding: "0 2px" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: "var(--fs-bracket-match)",
        outline: "1px solid var(--fs-bracket-match)",
    },
    ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": { color: "var(--error-color)" },
    ".cm-selectionMatch": { backgroundColor: "var(--fs-selection-match)" },
    ".cm-searchMatch": {
        backgroundColor: "var(--fs-search-match)",
        outline: "1px solid var(--warning-color)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--fs-selection)" },
    ".cm-foldPlaceholder": {
        backgroundColor: "var(--fs-active-line)",
        border: "1px solid var(--border-color)",
        color: "var(--foreground-secondary-color)",
        padding: "0 4px",
    },
    ".cm-tooltip": {
        backgroundColor: "var(--panel-background-color)",
        color: "var(--foreground-color)",
        border: "1px solid var(--border-color)",
        borderRadius: "4px",
        boxShadow: "var(--panel-shadow)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: MONO, fontSize: "12px", maxHeight: "16em" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "1px 6px" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--primary-color)",
        color: "#fff",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail": { color: "#fff" },
    ".cm-completionDetail": {
        color: "var(--foreground-muted-color)",
        fontStyle: "normal",
        marginLeft: "8px",
    },
    ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "700" },
    ".cm-completionInfo": { padding: "0", maxWidth: "520px" },
    ".cm-tooltip-hover": { maxWidth: "540px" },
    ".cm-panels": {
        backgroundColor: "var(--panel-background-color)",
        color: "var(--foreground-color)",
    },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border-color)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border-color)" },
    ".cm-panel input, .cm-panel button, .cm-panel label": { fontSize: "12px" },
    ".cm-textfield": {
        backgroundColor: "var(--input-background-color)",
        color: "var(--input-text-color)",
        border: "1px solid var(--input-border-color)",
        borderRadius: "3px",
    },
    ".cm-button": {
        backgroundImage: "none",
        backgroundColor: "var(--control-background-color)",
        color: "var(--foreground-color)",
        border: "1px solid var(--border-color)",
        borderRadius: "3px",
    },
    ".cm-diagnostic": { fontFamily: MONO, fontSize: "12px", whiteSpace: "pre-wrap" },
    ".cm-diagnostic-error": { borderLeft: "4px solid var(--error-color)" },
    ".cm-diagnostic-warning": { borderLeft: "4px solid var(--warning-color)" },
    ".cm-lintRange-error": {
        backgroundImage: "none",
        textDecoration: "underline wavy var(--error-color)",
        textUnderlineOffset: "3px",
    },
});

export const featureScriptHighlight = HighlightStyle.define([
    {
        tag: [tags.keyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword],
        class: style.tkKeyword,
    },
    { tag: tags.controlKeyword, class: style.tkControl },
    { tag: [tags.typeName, tags.definition(tags.typeName)], class: style.tkType },
    { tag: tags.meta, class: style.tkAnnotation },
    { tag: tags.attributeName, class: style.tkAnnotationKey },
    { tag: tags.standard(tags.variableName), class: style.tkBuiltin },
    { tag: tags.string, class: style.tkString },
    { tag: tags.escape, class: style.tkEscape },
    { tag: tags.number, class: style.tkNumber },
    { tag: tags.unit, class: style.tkUnit },
    { tag: [tags.bool, tags.null], class: style.tkAtom },
    { tag: tags.comment, class: style.tkComment },
    { tag: tags.docComment, class: style.tkDoc },
    { tag: tags.labelName, class: style.tkDocTag },
    { tag: tags.operator, class: style.tkOperator },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: style.tkFunction },
    {
        tag: [tags.definition(tags.variableName), tags.function(tags.definition(tags.variableName))],
        class: style.tkDefinition,
    },
    { tag: tags.constant(tags.variableName), class: style.tkConstant },
    { tag: tags.propertyName, class: style.tkProperty },
    { tag: tags.invalid, class: style.tkInvalid },
]);

export function featureScriptTheme(): Extension {
    return [editorTheme, syntaxHighlighting(featureScriptHighlight)];
}

/** The class that defines the editor's color variables; put it on an ancestor of the editor. */
export const THEME_CLASS: string = style.theme;

let host: HTMLElement | undefined;

/**
 * Where editor tooltips (completion, hover, signature help, lint) live: a themed layer at
 * the top of the page, so a floating panel's `overflow: hidden` and `backdrop-filter`
 * (which turns the panel into the containing block of fixed elements) cannot clip them.
 */
export function tooltipHost(): HTMLElement {
    if (host === undefined || !host.isConnected) {
        host = document.createElement("div");
        host.className = `${style.theme} ${style.tooltipHost}`;
        document.body.appendChild(host);
    }
    return host;
}
