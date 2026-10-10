// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    I18n,
    type IDocument,
    type IVariableSource,
    openElement,
    PubSub,
    VariableStudioNode,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import { showElementMenu } from "../elements/elementMenu";
import { PartStudioVariables } from "../property/variables/partStudioVariables";
import { VariablesDataContent } from "../property/variables/variablesDataContent";
import { VariablesEditor } from "../property/variables/variablesEditor";
import style from "../property/variables/variablesEditor.module.css";

/**
 * Onshape's Variable table: the document's Variable Studios, each a collapsible group, then
 * the Part Studio's own variables — its variable features (assigned and measured) and the
 * document's parameter table as one list. "Insert Variable Studio" at the bottom right
 * creates a studio or opens one that exists.
 */
export class VariableTablePanel {
    readonly element = document.createElement("div");
    private readonly tables = document.createElement("div");
    private readonly editors = new Map<IVariableSource, VariablesEditor>();
    private readonly partStudio: PartStudioVariables;
    constructor(
        private readonly doc: IDocument,
        private readonly onApplied: () => void = () => {},
    ) {
        this.element.className = style.groups;
        this.tables.className = style.sources;
        this.partStudio = new PartStudioVariables(doc);
        const toolbar = document.createElement("div");
        toolbar.className = style.studioToolbar;
        const insert = document.createElement("button");
        insert.type = "button";
        insert.setAttribute("aria-haspopup", "menu");
        insert.append(
            createCadIcon("variableStudio"),
            document.createTextNode(`${I18n.translate("variable.insertStudio")} ▴`),
        );
        insert.onclick = () => this.openInsertMenu(insert);
        toolbar.append(insert);
        this.element.append(this.tables, toolbar);
        this.refresh();
        doc.modelManager.addNodeObserver(this.refresh);
    }
    private openInsertMenu(anchor: HTMLElement) {
        const rect = anchor.getBoundingClientRect();
        const studios = this.doc.modelManager
            .findNodes((node) => node instanceof VariableStudioNode)
            .filter((node): node is VariableStudioNode => node instanceof VariableStudioNode);
        showElementMenu(
            [
                {
                    label: "command.variable.newStudio",
                    cadIcon: "variableStudio",
                    onSelect: () => PubSub.default.pub("executeCommand", "variable.newStudio"),
                },
                ...studios.map((studio, index) => ({
                    label: "variable.openStudio{0}" as const,
                    text: I18n.translate("variable.openStudio{0}", studio.name),
                    cadIcon: "variableStudio",
                    separator: index === 0,
                    onSelect: () => openElement(this.doc, studio),
                })),
            ],
            { x: rect.left, y: rect.top },
        );
    }
    private readonly refresh = () => {
        const sources: IVariableSource[] = [
            ...this.doc.modelManager.findNodes().filter((node) => node instanceof VariableStudioNode),
            this.partStudio,
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
        this.partStudio.dispose();
    }
}
