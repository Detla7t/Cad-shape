// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    autocompletion,
    type CompletionResult as CmCompletionResult,
    type Completion,
    type CompletionContext,
    snippet,
} from "@codemirror/autocomplete";
import { type EditorState, type Extension, StateEffect, StateField, type Text } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { type CompletionItem, type CompletionKind, completeAt } from "./completion";
import { type Declaration, scanDeclarations } from "./declarations";
import { renderSignatureHelp, renderSymbol, renderTarget, renderText } from "./docView";
import { formatFeatureScript } from "./format";
import { type DefinitionLocation, definitionAt, signatureAt, targetAt } from "./navigation";
import { type ScanToken, scanTokens } from "./scanner";
import { buildSymbolTable, type SymbolEnvironment, type SymbolTable } from "./symbols";

/**
 * The language-service side of the editor as CodeMirror extensions — completion, hover
 * docs, signature help, go to definition (F12 / Ctrl+click), format document — over an
 * `FsAnalyzer` that scans each document version once.
 */

export interface FsAnalysis {
    readonly source: string;
    readonly tokens: readonly ScanToken[];
    readonly declarations: readonly Declaration[];
    readonly table: SymbolTable;
}

/** Scans and resolves each document version once; `invalidate` when what imports resolve to changes. */
export class FsAnalyzer {
    private readonly cache = new WeakMap<Text, { generation: number; analysis: FsAnalysis }>();
    private generation = 0;

    constructor(private readonly environment: () => SymbolEnvironment) {}

    /** Forget resolved imports (the std index finished warming, another studio changed). */
    invalidate(): void {
        this.generation++;
    }

    analyze(doc: Text): FsAnalysis {
        const cached = this.cache.get(doc);
        if (cached !== undefined && cached.generation === this.generation) return cached.analysis;
        const source = doc.toString();
        const scanned = cached?.analysis;
        const tokens = scanned?.tokens ?? scanTokens(source);
        const declarations = scanned?.declarations ?? scanDeclarations(source);
        const analysis = {
            source,
            tokens,
            declarations,
            table: buildSymbolTable(declarations, this.environment()),
        };
        this.cache.set(doc, { generation: this.generation, analysis });
        return analysis;
    }
}

export interface FsEditorHost {
    readonly analyzer: FsAnalyzer;
    /** Resolves once std symbols are available (the first completion waits for it). */
    ready(): Promise<void>;
    studioNames(): readonly string[];
    stdModules(): readonly string[];
    openDefinition(location: DefinitionLocation, view: EditorView): void;
}

const COMPLETION_TYPES: Record<CompletionKind, string> = {
    keyword: "keyword",
    function: "function",
    feature: "class",
    predicate: "function",
    const: "constant",
    type: "type",
    enum: "enum",
    enumMember: "constant",
    variable: "variable",
    parameter: "variable",
    property: "property",
    annotationKey: "property",
    snippet: "snippet",
    module: "namespace",
    unit: "constant",
};

function toCompletion(item: CompletionItem, table: SymbolTable): Completion {
    const symbol = item.symbol;
    let info: Completion["info"];
    if (item.info !== undefined && item.info !== "") {
        const text = item.info;
        info = () => renderText(text);
    } else if (symbol !== undefined) {
        info = () => renderSymbol(symbol, table);
    }
    return {
        label: item.label,
        detail: item.detail,
        type: COMPLETION_TYPES[item.kind],
        boost: item.boost,
        info,
        apply: item.snippet !== undefined ? snippet(item.snippet) : undefined,
    };
}

function completionSource(host: FsEditorHost) {
    return async (context: CompletionContext): Promise<CmCompletionResult | null> => {
        await host.ready();
        if (context.aborted) return null;
        const analysis = host.analyzer.analyze(context.state.doc);
        const result = completeAt({
            source: analysis.source,
            tokens: analysis.tokens,
            declarations: analysis.declarations,
            table: analysis.table,
            pos: context.pos,
            explicit: context.explicit,
            studioNames: host.studioNames(),
            stdModules: host.stdModules(),
        });
        if (result === null) return null;
        return {
            from: result.from,
            to: result.to,
            options: result.items.map((item) => toCompletion(item, analysis.table)),
            validFor: result.validFor,
        };
    };
}

function hover(host: FsEditorHost): Extension {
    return hoverTooltip(
        (view, pos) => {
            const analysis = host.analyzer.analyze(view.state.doc);
            const target = targetAt({ ...analysis, pos });
            if (target === undefined) return null;
            return {
                pos: target.from,
                end: target.to,
                above: true,
                create: () => ({ dom: renderTarget(target, analysis.table) }),
            };
        },
        { hoverTime: 350 },
    );
}

// ------------------------------------------------------------------ Signature help

const closeSignature = StateEffect.define<null>();
const openSignature = StateEffect.define<null>();

function signatureExtension(host: FsEditorHost): Extension {
    const compute = (state: EditorState): Tooltip | null => {
        const selection = state.selection.main;
        if (!selection.empty) return null;
        const analysis = host.analyzer.analyze(state.doc);
        const help = signatureAt({ ...analysis, pos: selection.head });
        if (help === undefined) return null;
        return { pos: help.open, above: true, create: () => ({ dom: renderSignatureHelp(help) }) };
    };
    const field = StateField.define<Tooltip | null>({
        create: () => null,
        update(value, tr) {
            for (const effect of tr.effects) {
                if (effect.is(closeSignature)) return null;
                if (effect.is(openSignature)) return compute(tr.state);
            }
            // Typing opens it; moving the cursor keeps it up only while it is already showing.
            if (tr.docChanged && tr.isUserEvent("input")) return compute(tr.state);
            if (tr.docChanged || tr.selection) return value === null ? null : compute(tr.state);
            return value;
        },
        provide: (f) => showTooltip.from(f),
    });
    return [
        field,
        keymap.of([
            {
                key: "Mod-Shift-Space",
                run: (view) => {
                    view.dispatch({ effects: openSignature.of(null) });
                    return true;
                },
            },
            {
                key: "Escape",
                run: (view) => {
                    if (view.state.field(field) === null) return false;
                    view.dispatch({ effects: closeSignature.of(null) });
                    return true;
                },
            },
        ]),
    ];
}

// ------------------------------------------------------------------ Navigation and formatting

export function goToDefinition(
    host: FsEditorHost,
    view: EditorView,
    pos = view.state.selection.main.head,
): boolean {
    const analysis = host.analyzer.analyze(view.state.doc);
    const location = definitionAt({ ...analysis, pos });
    if (location === undefined) return false;
    host.openDefinition(location, view);
    return true;
}

/** Re-indents the document; only lines whose text changes are touched. */
export function formatDocument(view: EditorView): boolean {
    if (view.state.readOnly) return false;
    const doc = view.state.doc;
    const formatted = formatFeatureScript(doc.toString()).split("\n");
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let number = 1; number <= doc.lines; number++) {
        const line = doc.line(number);
        const text = formatted[number - 1] ?? line.text;
        if (text !== line.text) changes.push({ from: line.from, to: line.to, insert: text });
    }
    if (changes.length > 0) view.dispatch({ changes, userEvent: "format" });
    return true;
}

/** Selects `from`..`to` and scrolls it to the middle of the editor. */
export function revealRange(view: EditorView, from: number, to = from): void {
    const length = view.state.doc.length;
    const anchor = Math.min(Math.max(0, from), length);
    const head = Math.min(Math.max(anchor, to), length);
    view.dispatch({
        selection: { anchor, head },
        effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    });
    view.focus();
}

/** Completion, hover, signature help, F12 / Ctrl+click navigation and Shift+Alt+F formatting. */
export function languageService(host: FsEditorHost, options: { readOnly?: boolean } = {}): Extension {
    const extensions: Extension[] = [
        hover(host),
        keymap.of([{ key: "F12", run: (view) => goToDefinition(host, view) }]),
        EditorView.domEventHandlers({
            mousedown(event, view) {
                if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false;
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (pos === null || !goToDefinition(host, view, pos)) return false;
                event.preventDefault();
                return true;
            },
        }),
        // Ctrl/Cmd+click navigates; Alt+click adds a cursor.
        EditorView.clickAddsSelectionRange.of((event) => event.altKey),
        EditorView.theme({
            ".cm-completionIcon-snippet::after": { content: "'⧉'" },
            ".cm-completionIcon-namespace::after": { content: "'▤'" },
        }),
    ];
    if (!options.readOnly) {
        extensions.push(
            autocompletion({ override: [completionSource(host)], icons: true, maxRenderedOptions: 120 }),
            signatureExtension(host),
            keymap.of([{ key: "Shift-Alt-f", run: formatDocument }]),
        );
    }
    return extensions;
}
