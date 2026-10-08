// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentPanels, type IDocument, type INode, PubSub } from "@chili3d/core";
import { ParametricBodyNode } from "../parametricBodyNode";
import { bendAllowance, sheetModelOf } from "./model";

/** Read the same live sheet model used by the folded solid and flat-pattern export. */
export class SheetMetalTablePanel {
    readonly element = document.createElement("div");
    private readonly watches = new Set<INode>();
    private pending = false;
    private disposed = false;
    constructor(private readonly doc: IDocument) {
        doc.modelManager.addNodeObserver(this.changed);
        this.render();
    }
    private readonly changed = () => {
        if (this.pending) return;
        this.pending = true;
        queueMicrotask(() => {
            this.pending = false;
            if (!this.disposed) this.render();
        });
    };
    private render() {
        for (const node of this.watches) node.removePropertyChanged(this.changed);
        this.watches.clear();
        this.element.replaceChildren();
        for (const node of this.doc.modelManager.findNodes()) {
            if (!(node instanceof ParametricBodyNode)) continue;
            node.onPropertyChanged(this.changed);
            this.watches.add(node);
            const model = sheetModelOf(node.shape.unchecked());
            if (!model) continue;
            const heading = document.createElement("h4");
            heading.textContent = node.name;
            const info = document.createElement("p");
            info.textContent = `${model.thickness} mm thick · R${model.radius} mm · K ${model.kFactor} · ${model.flat ? "Flat" : "Folded"}`;
            const table = document.createElement("table");
            table.style.cssText = "width:100%;border-collapse:collapse";
            const header = table.createTHead().insertRow();
            for (const title of ["Bend", "Angle", "Radius", "Allowance"]) {
                const cell = document.createElement("th");
                cell.textContent = title;
                header.append(cell);
            }
            model.bends.forEach((bend, index) => {
                const row = table.insertRow();
                for (const value of [
                    String(index + 1),
                    `${bend.angle}°`,
                    `${bend.radius} mm`,
                    `${bendAllowance(bend.angle, bend.radius, model.thickness, model.kFactor).toFixed(3)} mm`,
                ]) {
                    const cell = row.insertCell();
                    cell.textContent = value;
                    cell.style.cssText = "border:1px solid var(--border-color);padding:6px";
                }
            });
            const flatten = document.createElement("button");
            flatten.textContent = "Flatten";
            flatten.disabled = model.flat;
            flatten.onclick = () => {
                this.doc.selection.setSelectedNodes([node], false);
                PubSub.default.pub("executeCommand", "sheetMetal.flatten");
            };
            const exportFlat = document.createElement("button");
            exportFlat.textContent = "Export flat pattern…";
            exportFlat.onclick = () => {
                this.doc.selection.setSelectedNodes([node], false);
                PubSub.default.pub("executeCommand", "sheetMetal.exportFlat");
            };
            this.element.append(heading, info, table, flatten, exportFlat);
        }
        if (!this.element.children.length)
            this.element.textContent =
                "Create a sheet metal part to see its thickness, bend table and flat-pattern controls.";
    }
    dispose() {
        this.disposed = true;
        this.doc.modelManager.removeNodeObserver(this.changed);
        for (const node of this.watches) node.removePropertyChanged(this.changed);
    }
}
DocumentPanels.register({
    id: "sheetMetal",
    title: "ribbon.group.sheetMetal",
    icon: "sheetMetal",
    create: (doc) => new SheetMetalTablePanel(doc),
});
