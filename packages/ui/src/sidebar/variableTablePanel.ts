// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IDocument, type IVariableSource, PubSub, VariableStudioNode } from "@chili3d/core";
import { VariablesDataContent } from "../property/variables/variablesDataContent";
import { VariablesEditor } from "../property/variables/variablesEditor";
import style from "../property/variables/variablesEditor.module.css";

export class VariableTablePanel {
    readonly element = document.createElement("div");
    private readonly tables = document.createElement("div");
    private readonly editors = new Map<IVariableSource, VariablesEditor>();
    constructor(
        private readonly doc: IDocument,
        private readonly onApplied: () => void = () => {},
    ) {
        this.element.className = style.groups;
        this.tables.className = style.sources;
        const toolbar = document.createElement("div");
        toolbar.className = style.studioToolbar;
        const insert = document.createElement("button");
        insert.type = "button";
        insert.textContent = I18n.translate("command.variable.newStudio");
        insert.onclick = () => PubSub.default.pub("executeCommand", "variable.newStudio");
        toolbar.append(insert);
        this.element.append(this.tables, toolbar);
        this.refresh();
        doc.modelManager.addNodeObserver(this.refresh);
    }
    private readonly refresh = () => {
        const sources: IVariableSource[] = [
            this.doc.variables,
            ...this.doc.modelManager.findNodes().filter((node) => node instanceof VariableStudioNode),
        ];
        for (const [source, editor] of this.editors) {
            if (sources.includes(source)) continue;
            editor.dispose();
            editor.remove();
            this.editors.delete(source);
        }
        sources.forEach((source, index) => {
            let editor = this.editors.get(source);
            if (!editor) {
                editor = new VariablesEditor(new VariablesDataContent(this.doc, this.onApplied, source));
                editor.dataset["docked"] = "true";
                this.editors.set(source, editor);
            }
            // Preserve focused cells and unfinished expressions on unrelated model changes.
            if (this.tables.children[index] !== editor) {
                this.tables.insertBefore(editor, this.tables.children[index] ?? null);
            }
        });
    };
    dispose() {
        this.doc.modelManager.removeNodeObserver(this.refresh);
        for (const editor of this.editors.values()) editor.dispose();
        this.editors.clear();
    }
}
