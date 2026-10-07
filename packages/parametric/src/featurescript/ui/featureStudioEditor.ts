// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IDocument, PubSub, Transaction } from "@chili3d/core";
import { ParametricBodyNode } from "../../parametricBodyNode";
import type { FeatureStudioNode } from "../featureStudioNode";
import { customFeatures, insertCustomFeature } from "../insertFeature";
import { type CompiledStudio, compileStudioSource, findStudio } from "../studioCompiler";
import style from "./featureStudioEditor.module.css";

/**
 * The Feature Studio editor: a floating panel with the studio's FeatureScript source, a
 * live compile check (errors point at the line), the `println` output of the studio's
 * latest runs, and the custom features it exports.
 *
 * Edits are drafts until applied (Apply, Ctrl/Cmd+S or Ctrl/Cmd+Enter): applying writes
 * the studio's `source` as one undo step, which rebuilds every body using its features.
 * A floating panel rather than a dialog for the same reason as the parameters panel —
 * the point is watching the model follow.
 */

const open = new Set<string>();

export function showFeatureStudioEditor(studio: FeatureStudioNode): void {
    if (open.has(studio.id)) return;
    open.add(studio.id);
    const editor = new FeatureStudioEditor(studio);
    PubSub.default.pub("showFloatPanel", {
        title: "featurescript.studio",
        content: editor.root,
        width: 760,
        height: 560,
        minWidth: 420,
        minHeight: 300,
        document: studio.document,
        onClose: () => {
            open.delete(studio.id);
            editor.dispose();
        },
    });
}

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

export class FeatureStudioEditor {
    readonly root = element("div", style.root);
    private readonly name = element("input", style.name);
    private readonly status = element("span", style.status);
    private readonly applyButton = element(
        "button",
        `${style.button} ${style.primary}`,
        translate("featurescript.editor.apply"),
    );
    private readonly revertButton = element("button", style.button, translate("featurescript.editor.revert"));
    private readonly insertButton = element("button", style.button, translate("featurescript.editor.insert"));
    private readonly gutter = element("pre", style.gutter);
    readonly code = element("textarea", style.code);
    private readonly output = element("div", style.output);
    private compileTimer: ReturnType<typeof setTimeout> | undefined;
    private lastCompiled: CompiledStudio | undefined;
    /** The studio source the draft was last in sync with. */
    private baseline: string;

    constructor(private readonly studio: FeatureStudioNode) {
        this.baseline = studio.source;
        this.code.value = studio.source;
        this.code.spellcheck = false;
        this.code.wrap = "off";
        this.name.value = studio.name;

        const toolbar = element("div", style.toolbar);
        toolbar.append(this.name, this.status, this.revertButton, this.applyButton, this.insertButton);
        const editor = element("div", style.editor);
        editor.append(this.gutter, this.code);
        this.root.append(toolbar, editor, this.output);

        this.code.addEventListener("input", () => this.onEdited());
        this.code.addEventListener("keydown", (e) => this.onKeyDown(e));
        this.code.addEventListener("scroll", () => {
            this.gutter.scrollTop = this.code.scrollTop;
        });
        this.name.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") this.name.blur();
        });
        this.name.addEventListener("change", () => this.rename());
        this.applyButton.addEventListener("click", () => this.apply());
        this.revertButton.addEventListener("click", () => this.revert());
        this.insertButton.addEventListener("click", () => this.insert());
        studio.onPropertyChanged(this.onStudioChanged);
        this.refresh();
    }

    get dirty(): boolean {
        return this.code.value !== this.studio.source;
    }

    dispose(): void {
        this.studio.removePropertyChanged(this.onStudioChanged);
        if (this.compileTimer !== undefined) clearTimeout(this.compileTimer);
    }

    /** Writes the draft into the studio — one undo step; bodies using it rebuild. */
    apply(): void {
        if (!this.dirty) return;
        const source = this.code.value;
        this.baseline = source;
        Transaction.execute(this.studio.document, "edit feature studio", () => {
            this.studio.source = source;
        });
        this.studio.document.visual.update();
        this.refresh();
    }

    private revert(): void {
        this.code.value = this.studio.source;
        this.refresh();
    }

    private rename(): void {
        const name = this.name.value.trim();
        if (name === "" || name === this.studio.name) {
            this.name.value = this.studio.name;
            return;
        }
        Transaction.execute(this.studio.document, "rename feature studio", () => {
            this.studio.name = name;
        });
    }

    /** Applies pending edits, then offers this studio's features for insertion. */
    private insert(): void {
        this.apply();
        showInsertFeatureDialog(this.studio.document, this.studio);
    }

    private readonly onStudioChanged = (property: string) => {
        // Undo/redo or another writer changed the source: follow it unless the draft
        // holds edits of the user's own, which are kept.
        if (property === "source") {
            if (this.code.value === this.baseline) this.code.value = this.studio.source;
            this.baseline = this.studio.source;
        }
        if (property === "name") this.name.value = this.studio.name;
        this.refresh();
    };

    private onEdited(): void {
        this.updateGutter(this.lastCompiled?.line);
        this.updateButtons();
        if (this.compileTimer !== undefined) clearTimeout(this.compileTimer);
        this.compileTimer = setTimeout(() => this.refresh(), 300);
    }

    private onKeyDown(e: KeyboardEvent): void {
        // Keep keystrokes away from the app's hotkeys and the panel's own handling.
        e.stopPropagation();
        const mod = e.ctrlKey || e.metaKey;
        if (mod && (e.key === "s" || e.key === "Enter")) {
            e.preventDefault();
            this.apply();
            return;
        }
        if (e.key === "Tab" && !mod) {
            e.preventDefault();
            const { selectionStart, selectionEnd, value } = this.code;
            this.code.value = `${value.slice(0, selectionStart)}    ${value.slice(selectionEnd)}`;
            this.code.selectionStart = this.code.selectionEnd = selectionStart + 4;
            this.onEdited();
        }
    }

    /** Recompiles the draft and redraws status, gutter, buttons and output. */
    refresh(): void {
        this.compileTimer = undefined;
        const document = this.studio.document;
        const compiled = compileStudioSource(this.studio.id, this.studio.name, this.code.value, (path) => {
            const studio = findStudio(document, path);
            return studio === undefined
                ? undefined
                : { id: studio.id, name: studio.name, source: studio.source };
        });
        this.lastCompiled = compiled;
        this.status.classList.toggle(style.error, compiled.error !== undefined);
        this.status.classList.toggle(style.ok, compiled.error === undefined);
        const unsaved = this.dirty ? ` · ${translate("featurescript.editor.unsaved")}` : "";
        this.status.textContent =
            compiled.error !== undefined
                ? compiled.error.split("\n")[0]
                : translate("featurescript.editor.compiled{0}", compiled.features.length) + unsaved;
        this.status.title = compiled.error ?? "";
        this.updateGutter(compiled.line);
        this.updateButtons();
        this.updateOutput(compiled);
    }

    private updateButtons(): void {
        this.applyButton.disabled = !this.dirty;
        this.revertButton.disabled = !this.dirty;
        this.insertButton.disabled =
            this.lastCompiled?.error !== undefined || (this.lastCompiled?.features.length ?? 0) === 0;
    }

    private updateGutter(errorLine: number | undefined): void {
        const lines = this.code.value.split("\n").length;
        this.gutter.replaceChildren(
            ...Array.from({ length: lines }, (_, i) => {
                const line = element("div", i + 1 === errorLine ? style.errorLine : undefined, String(i + 1));
                return line;
            }),
        );
        this.gutter.scrollTop = this.code.scrollTop;
    }

    private updateOutput(compiled: CompiledStudio): void {
        const title = element("div", style.outputTitle, translate("featurescript.editor.output"));
        const rows: HTMLElement[] = [title];
        for (const feature of compiled.features) {
            rows.push(element("div", style.feature, `${feature.displayName}  (${feature.name})`));
        }
        if (compiled.error !== undefined) rows.push(element("div", style.errorLine, compiled.error));
        for (const line of compiled.log.slice(-50)) rows.push(element("div", undefined, line));
        this.output.replaceChildren(...rows);
        this.output.scrollTop = this.output.scrollHeight;
    }
}

/**
 * The insert dialog: which custom feature (all studios, or one), and where — a new body
 * or an existing parametric body (the selected one preselected).
 */
export function showInsertFeatureDialog(document: IDocument, studio?: FeatureStudioNode): void {
    const entries = customFeatures(document, studio);
    if (entries.length === 0) {
        PubSub.default.pub("showToast", "featurescript.insert.none");
        return;
    }
    const featureSelect = element("select");
    entries.forEach((entry, index) => {
        const option = element(
            "option",
            undefined,
            studio === undefined ? `${entry.studio.name} › ${entry.displayName}` : entry.displayName,
        );
        option.value = String(index);
        featureSelect.append(option);
    });
    const bodies = document.modelManager.findNodes(
        (node) => node instanceof ParametricBodyNode,
    ) as ParametricBodyNode[];
    const selected = document.selection.getSelectedNodes().find((node) => node instanceof ParametricBodyNode);
    const targetSelect = element("select");
    const newBody = element("option", undefined, translate("featurescript.insert.newBody"));
    newBody.value = "";
    targetSelect.append(newBody);
    for (const body of bodies) {
        const option = element("option", undefined, body.name);
        option.value = body.id;
        option.selected = body === selected;
        targetSelect.append(option);
    }
    const row = (label: string, control: HTMLElement) => {
        const container = element("div", style.dialogRow);
        container.append(element("span", undefined, label), control);
        return container;
    };
    const content = element("div", style.dialog);
    content.append(
        row(translate("featurescript.insert.feature"), featureSelect),
        row(translate("featurescript.insert.target"), targetSelect),
    );
    PubSub.default.pub("showDialog", "featurescript.insert.title", content, [
        {
            content: "common.confirm",
            onclick: () => {
                const entry = entries[Number(featureSelect.value)];
                const body = bodies.find((candidate) => candidate.id === targetSelect.value);
                if (entry === undefined) return;
                const result = insertCustomFeature(document, entry, body);
                if (!result.isOk) PubSub.default.pub("showToast", "error.default:{0}", result.error);
            },
        },
        { content: "common.cancel", onclick: () => {} },
    ]);
}
