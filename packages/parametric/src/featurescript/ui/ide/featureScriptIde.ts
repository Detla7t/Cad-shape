// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IDocument, Transaction } from "@chili3d/core";
import { providedOnshapeStd } from "@chili3d/featurescript";
import {
    type DefinitionLocation,
    diagnosticsFor,
    editorBasics,
    FsAnalyzer,
    type FsEditorHost,
    formatDocument,
    languageService,
    normalizeNewlines,
    type OutlineItem,
    outlineOf,
    revealRange,
    type StdIndex,
    type SymbolEnvironment,
    showStdSource,
    stdIndexFor,
    ideStyle as style,
    THEME_CLASS,
} from "@chili3d/featurescript/ide";
import { setDiagnostics } from "@codemirror/lint";
import { Transaction as CmTransaction, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { FeatureStudioNode } from "../../featureStudioNode";
import { type CompiledStudio, compileStudioSource, documentStudios, findStudio } from "../../studioCompiler";
import { showInsertFeatureDialog } from "../insertFeatureDialog";

/**
 * The FeatureScript IDE for one Feature Studio: a CodeMirror editor with FeatureScript
 * highlighting, completion (std, imported studios, locals, enum members, definition
 * fields, annotation keys, snippets), hover docs and signature help from std's doc
 * comments, go to definition (into the std source viewer for std symbols), live compile
 * diagnostics, an outline, format document — plus the studio workflow: edits are a draft
 * until applied (Apply, Ctrl/Cmd+S or Ctrl/Cmd+Enter) as one undo step, Revert, Insert
 * feature, the `println` output, and following undo/redo of the studio's source.
 *
 * A standalone component: mount `root` anywhere (a floating panel, a full-size view) —
 * it fills its container — and call `dispose()` when it is removed.
 */

export interface FeatureScriptIdeOptions {
    /** The document whose studios imports resolve against; defaults to the studio's. */
    readonly document?: IDocument;
    /** Opens another studio of the document at `from`..`to` (go to definition into an imported studio). */
    readonly openStudio?: (studio: FeatureStudioNode, from: number, to: number) => void;
    /** Show the outline beside the editor (default true). */
    readonly outline?: boolean;
}

const COMPILE_DELAY = 300;

const KIND_BADGES: Record<OutlineItem["kind"], string> = {
    feature: "F",
    function: "ƒ",
    predicate: "P",
    operator: "O",
    const: "C",
    type: "T",
    enum: "E",
};

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function translate(key: Parameters<typeof I18n.translate>[0], ...args: unknown[]): string {
    return I18n.translate(key, ...(args as never[])) ?? String(key);
}

export class FeatureScriptIde {
    readonly root = element("div", `${style.root} ${THEME_CLASS}`);
    readonly view: EditorView;
    readonly document: IDocument;
    private readonly name = element("input", style.name);
    private readonly status = element("span", style.status);
    private readonly outlineButton = element("button", style.button, translate("featurescript.ide.outline"));
    private readonly formatButton = element("button", style.button, translate("featurescript.ide.format"));
    private readonly revertButton = element("button", style.button, translate("featurescript.editor.revert"));
    private readonly applyButton = element(
        "button",
        `${style.button} ${style.primary}`,
        translate("featurescript.editor.apply"),
    );
    private readonly insertButton = element("button", style.button, translate("featurescript.editor.insert"));
    private readonly outline = element("div", style.outline);
    private readonly output = element("div", style.output);
    private readonly analyzer: FsAnalyzer;
    private compileTimer: ReturnType<typeof setTimeout> | undefined;
    private lastCompiled: CompiledStudio | undefined;
    private lastProblem: { from: number; to: number } | undefined;
    /** The studio source the draft was last in sync with. */
    private baseline: string;
    private disposed = false;
    private readonly stdReady: Promise<void>;

    constructor(
        readonly studio: FeatureStudioNode,
        private readonly options: FeatureScriptIdeOptions = {},
    ) {
        this.document = options.document ?? studio.document;
        this.baseline = normalizeNewlines(studio.source);
        this.name.value = studio.name;
        this.name.spellcheck = false;
        this.outlineButton.title = translate("featurescript.ide.outlineHint");
        this.formatButton.title = translate("featurescript.ide.formatHint");
        this.applyButton.title = translate("featurescript.ide.applyHint");
        this.analyzer = new FsAnalyzer(() => this.environment());

        const toolbar = element("div", style.toolbar);
        toolbar.append(
            this.name,
            this.status,
            this.outlineButton,
            this.formatButton,
            this.revertButton,
            this.applyButton,
            this.insertButton,
        );
        const editorHost = element("div", style.editor);
        const main = element("div", style.main);
        main.append(this.outline, editorHost);
        this.root.append(toolbar, main, this.output);
        this.setOutlineVisible(options.outline ?? true);

        const host: FsEditorHost = {
            analyzer: this.analyzer,
            ready: () => this.stdReady,
            studioNames: () => this.studioNames(),
            stdModules: () => this.std()?.scannedModules() ?? [],
            openDefinition: (location) => this.openDefinition(location),
        };
        this.view = new EditorView({
            parent: editorHost,
            state: EditorState.create({
                doc: this.baseline,
                extensions: [
                    editorBasics(),
                    languageService(host),
                    Prec.highest(
                        keymap.of([
                            { key: "Mod-s", run: () => this.applyCommand() },
                            { key: "Mod-Enter", run: () => this.applyCommand() },
                        ]),
                    ),
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged) this.onEdited();
                    }),
                ],
            }),
        });

        // Keep keystrokes away from the app's hotkeys (a full-size view has no float panel to stop them).
        this.root.addEventListener("keydown", (event) => event.stopPropagation());
        this.name.addEventListener("keydown", (event) => {
            if (event.key === "Enter") this.name.blur();
        });
        this.name.addEventListener("change", () => this.rename());
        this.applyButton.addEventListener("click", () => this.apply());
        this.revertButton.addEventListener("click", () => this.revert());
        this.insertButton.addEventListener("click", () => this.insert());
        this.formatButton.addEventListener("click", () => {
            formatDocument(this.view);
            this.view.focus();
        });
        this.outlineButton.addEventListener("click", () =>
            this.setOutlineVisible(this.outline.classList.contains(style.hidden)),
        );
        this.status.addEventListener("click", () => this.revealProblem());
        studio.onPropertyChanged(this.onStudioChanged);

        // Index the std in idle slices; once done, names resolve against it.
        const std = this.std();
        this.stdReady =
            std === undefined
                ? Promise.resolve()
                : std.warm().then(() => {
                      if (this.disposed) return;
                      this.analyzer.invalidate();
                  });
        this.refresh();
    }

    /** The draft in the editor. */
    get source(): string {
        return this.view.state.doc.toString();
    }

    /** Whether the draft differs from the studio's source. */
    get dirty(): boolean {
        return this.source !== this.studioSource();
    }

    /** The studio's source with `\n` line endings, as the editor holds it. */
    private studioSource(): string {
        return normalizeNewlines(this.studio.source);
    }

    focus(): void {
        this.view.focus();
    }

    /** Selects `from`..`to` in the draft and scrolls it into view. */
    reveal(from: number, to = from): void {
        revealRange(this.view, from, to);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.studio.removePropertyChanged(this.onStudioChanged);
        if (this.compileTimer !== undefined) clearTimeout(this.compileTimer);
        this.view.destroy();
    }

    /** Writes the draft into the studio — one undo step; bodies using it rebuild. */
    apply(): void {
        if (!this.dirty) return;
        const source = this.source;
        this.baseline = source;
        Transaction.execute(this.document, "edit feature studio", () => {
            this.studio.source = source;
        });
        this.document.visual.update();
        this.refresh();
    }

    private applyCommand(): boolean {
        this.apply();
        return true;
    }

    /** Drops the draft's edits. */
    revert(): void {
        this.replaceDraft(this.studioSource(), true);
        this.refresh();
    }

    /** Recompiles the draft now and redraws status, diagnostics, outline, buttons and output. */
    refresh(): void {
        if (this.disposed) return;
        if (this.compileTimer !== undefined) clearTimeout(this.compileTimer);
        this.compileTimer = undefined;
        const source = this.source;
        const compiled = compileStudioSource(this.studio.id, this.studio.name, source, (path) => {
            const studio = findStudio(this.document, path);
            return studio === undefined
                ? undefined
                : { id: studio.id, name: studio.name, source: studio.source };
        });
        this.lastCompiled = compiled;
        // Imported studios may have changed since the last analysis.
        this.analyzer.invalidate();
        const diagnostics = diagnosticsFor(source, compiled, this.studio.name);
        this.lastProblem = diagnostics[0];
        this.view.dispatch(
            setDiagnostics(
                this.view.state,
                diagnostics.map((diagnostic) => ({ ...diagnostic, source: "FeatureScript" })),
            ),
        );
        this.updateStatus();
        this.updateButtons();
        this.updateOutput(compiled);
        this.updateOutline();
    }

    private std(): StdIndex | undefined {
        const source = providedOnshapeStd();
        return source === undefined ? undefined : stdIndexFor(source);
    }

    private environment(): SymbolEnvironment {
        return {
            std: this.std(),
            studio: (path) => {
                const studio = findStudio(this.document, path);
                return studio === undefined || studio.id === this.studio.id
                    ? undefined
                    : { id: studio.id, name: studio.name, source: normalizeNewlines(studio.source) };
            },
        };
    }

    private studioNames(): string[] {
        return documentStudios(this.document)
            .filter((studio) => studio.id !== this.studio.id)
            .map((studio) => studio.name);
    }

    private openDefinition(location: DefinitionLocation): void {
        if (location.kind === "local") {
            this.reveal(location.from, location.to);
            return;
        }
        if (location.kind === "studio") {
            const studio = findStudio(this.document, location.studioId);
            if (studio !== undefined) this.options.openStudio?.(studio, location.from, location.to);
            return;
        }
        const std = this.std();
        if (std !== undefined) showStdSource(std, location.module, location.from, location.to, this.document);
    }

    /** Replaces the draft with `text`, touching only the part that differs (so the cursor stays put). */
    private replaceDraft(text: string, addToHistory: boolean): void {
        const current = this.source;
        if (current === text) return;
        let start = 0;
        const max = Math.min(current.length, text.length);
        while (start < max && current.charCodeAt(start) === text.charCodeAt(start)) start++;
        let end = 0;
        while (
            end < max - start &&
            current.charCodeAt(current.length - 1 - end) === text.charCodeAt(text.length - 1 - end)
        ) {
            end++;
        }
        this.view.dispatch({
            changes: { from: start, to: current.length - end, insert: text.slice(start, text.length - end) },
            annotations: addToHistory ? [] : [CmTransaction.addToHistory.of(false)],
        });
    }

    private rename(): void {
        const name = this.name.value.trim();
        if (name === "" || name === this.studio.name) {
            this.name.value = this.studio.name;
            return;
        }
        Transaction.execute(this.document, "rename feature studio", () => {
            this.studio.name = name;
        });
    }

    /** Applies pending edits, then offers this studio's features for insertion. */
    private insert(): void {
        this.apply();
        showInsertFeatureDialog(this.document, this.studio);
    }

    private readonly onStudioChanged = (property: string) => {
        // Undo/redo or another writer changed the source: follow it unless the draft
        // holds edits of the user's own, which are kept.
        if (property === "source") {
            if (this.source === this.baseline) this.replaceDraft(this.studioSource(), false);
            this.baseline = this.studioSource();
        }
        if (property === "name") this.name.value = this.studio.name;
        this.refresh();
    };

    private onEdited(): void {
        this.updateStatus();
        this.updateButtons();
        if (this.compileTimer !== undefined) clearTimeout(this.compileTimer);
        this.compileTimer = setTimeout(() => this.refresh(), COMPILE_DELAY);
    }

    private setOutlineVisible(visible: boolean): void {
        this.outline.classList.toggle(style.hidden, !visible);
        this.outlineButton.classList.toggle(style.toggled, visible);
    }

    private revealProblem(): void {
        if (this.lastProblem !== undefined) this.reveal(this.lastProblem.from, this.lastProblem.to);
    }

    private updateStatus(): void {
        const compiled = this.lastCompiled;
        if (compiled === undefined) return;
        this.status.classList.toggle(style.error, compiled.error !== undefined);
        this.status.classList.toggle(style.ok, compiled.error === undefined);
        const unsaved = this.dirty ? ` · ${translate("featurescript.editor.unsaved")}` : "";
        this.status.textContent =
            compiled.error !== undefined
                ? compiled.error.split("\n")[0]
                : translate("featurescript.editor.compiled{0}", compiled.features.length) + unsaved;
        this.status.title = compiled.error ?? "";
    }

    private updateButtons(): void {
        const dirty = this.dirty;
        this.applyButton.disabled = !dirty;
        this.revertButton.disabled = !dirty;
        this.insertButton.disabled =
            this.lastCompiled?.error !== undefined || (this.lastCompiled?.features.length ?? 0) === 0;
    }

    private updateOutput(compiled: CompiledStudio): void {
        const rows: HTMLElement[] = [
            element("div", style.outputTitle, translate("featurescript.editor.output")),
        ];
        for (const feature of compiled.features) {
            rows.push(element("div", style.outputFeature, `${feature.displayName}  (${feature.name})`));
        }
        if (compiled.error !== undefined) {
            const error = element("div", style.errorLine, compiled.error);
            error.addEventListener("click", () => this.revealProblem());
            rows.push(error);
        }
        for (const line of compiled.log.slice(-50)) rows.push(element("div", undefined, line));
        this.output.replaceChildren(...rows);
        this.output.scrollTop = this.output.scrollHeight;
    }

    private updateOutline(): void {
        const items = outlineOf(this.analyzer.analyze(this.view.state.doc).declarations);
        const rows: HTMLElement[] = [
            element("div", style.outlineTitle, translate("featurescript.ide.outline")),
        ];
        for (const item of items) {
            const row = element("div", `${style.outlineItem} ${item.exported ? "" : style.private}`);
            const badge = element(
                "span",
                `${style.outlineKind} ${style[item.kind] ?? ""}`,
                KIND_BADGES[item.kind],
            );
            const name = element("span", style.outlineName, item.label ?? item.name);
            row.title =
                item.label !== undefined
                    ? `${item.label} (${item.name})`
                    : `${item.name}${item.detail ?? ""}`;
            row.append(badge, name);
            row.addEventListener("click", () => this.reveal(item.from, item.to));
            rows.push(row);
        }
        if (items.length === 0)
            rows.push(element("div", style.outlineEmpty, translate("featurescript.ide.noDeclarations")));
        this.outline.replaceChildren(...rows);
    }
}
