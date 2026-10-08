// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type IVariableSource, VariableStudioNode } from "@chili3d/core";
import { VariablesDataContent } from "../property/variables/variablesDataContent";
import { VariablesEditor } from "../property/variables/variablesEditor";

export class VariableTablePanel {
    readonly element = document.createElement("div");
    private readonly source = document.createElement("select");
    private editor?: VariablesEditor;
    constructor(
        private readonly doc: IDocument,
        private readonly onApplied: () => void = () => {},
    ) {
        this.source.setAttribute("aria-label", "Variable source");
        this.element.append(this.source);
        this.source.onchange = () => this.mount();
        this.refresh();
        doc.modelManager.addNodeObserver(this.refresh);
    }
    private readonly refresh = () => {
        const selected = this.source.value;
        this.source.replaceChildren(new Option("Part Studio variables", ""));
        for (const node of this.doc.modelManager.findNodes()) {
            if (node instanceof VariableStudioNode) this.source.add(new Option(node.name, node.id));
        }
        this.source.value = selected;
        if (this.source.selectedIndex < 0) this.source.selectedIndex = 0;
        this.mount();
    };
    private mount() {
        this.editor?.dispose();
        this.editor?.remove();
        const source = this.doc.modelManager.findNode((n) => n.id === this.source.value);
        const variables: IVariableSource = source instanceof VariableStudioNode ? source : this.doc.variables;
        this.editor = new VariablesEditor(new VariablesDataContent(this.doc, this.onApplied, variables));
        this.editor.dataset["docked"] = "true";
        this.element.append(this.editor);
    }
    dispose() {
        this.doc.modelManager.removeNodeObserver(this.refresh);
        this.editor?.dispose();
    }
}
