// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    GeometryNode,
    I18n,
    type IDocument,
    type INode,
    type InspectionSlot,
    type InspectionTolerance,
    inspectionCharacteristics,
    inspectionCsv,
    inspectionHeaders,
    inspectionSlots,
    inspectionTolerances,
    Transaction,
} from "@chili3d/core";
import { option } from "@chili3d/element";
import style from "./modelTable.module.css";

type Tolerance = InspectionTolerance;
const tolerances = inspectionTolerances;

/**
 * Onshape's Model definitions (inspection) panel: the model to inspect, and one row per
 * characteristic that carries a tolerance — a sketch dimension or a numeric feature
 * parameter added through "Add characteristic" — with its nominal, the tolerances (edited in
 * place, one undo step each) and the limits; empty until something is toleranced. Values read
 * in the document's units. Export CSV writes the table.
 */
export class InspectionPanel {
    readonly element = document.createElement("div");
    private readonly select = document.createElement("select");
    private readonly picker = document.createElement("select");
    private readonly output = document.createElement("div");
    private readonly watches = new Set<INode>();
    private writing = false;
    private queued = false;
    private disposed = false;
    constructor(private readonly doc: IDocument) {
        this.element.className = `${style.root} ${style.inspection}`;
        this.output.className = style.scroll;
        this.select.setAttribute("aria-label", "Inspection model");
        this.select.onchange = () => this.render();
        this.picker.setAttribute("aria-label", I18n.translate("inspection.addCharacteristic"));
        this.picker.onchange = () => {
            const slot = this.slots().find((s) => s.id === this.picker.value);
            this.picker.value = "";
            if (slot) this.writeTolerance(slot, { minus: 0, plus: 0 });
        };
        const exportButton = document.createElement("button");
        exportButton.textContent = I18n.translate("inspection.exportCsv");
        exportButton.onclick = () => {
            const csv = inspectionCsv(this.doc, this.select.value || undefined);
            const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "inspection.csv";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        const model = document.createElement("div");
        model.className = style.toolbar;
        const modelLabel = document.createElement("span");
        modelLabel.className = style.modelLabel;
        modelLabel.textContent = I18n.translate("inspection.model");
        model.append(modelLabel, this.select);
        const tools = document.createElement("div");
        tools.className = style.toolbar;
        tools.append(this.picker, exportButton);
        this.element.append(model, tools, this.output);
        doc.modelManager.addNodeObserver(this.changed);
        doc.variables.onPropertyChanged(this.changed);
        this.render();
    }
    private readonly changed = () => {
        if (this.writing || this.queued || this.disposed) return;
        this.queued = true;
        queueMicrotask(() => {
            this.queued = false;
            if (!this.disposed) this.render();
        });
    };
    /** The numeric slots of geometry nodes — what can be toleranced. */
    private slots(): InspectionSlot[] {
        return inspectionSlots(this.doc);
    }
    private writeTolerance(slot: InspectionSlot, value: Tolerance | undefined) {
        const node = slot.node;
        const all = tolerances(node);
        if (value === undefined) delete all[slot.id];
        else all[slot.id] = value;
        this.writing = true;
        try {
            Transaction.execute(
                this.doc,
                value === undefined ? "Remove inspection characteristic" : "Edit inspection tolerance",
                () => (node.inspectionJson = JSON.stringify(all)),
            );
        } finally {
            this.writing = false;
        }
        this.render();
    }
    private render() {
        for (const n of this.watches) n.removePropertyChanged(this.changed);
        this.watches.clear();
        const nodes = this.doc.modelManager.findNodes();
        for (const n of nodes) {
            n.onPropertyChanged(this.changed);
            this.watches.add(n);
        }
        const selected = this.select.value;
        const models = nodes.filter((n): n is GeometryNode => n instanceof GeometryNode);
        this.select.replaceChildren(
            option({
                textContent: models.length ? "All models" : I18n.translate("inspection.noModels"),
                value: "",
            }),
            ...models.map((n) => option({ textContent: n.name, value: n.id })),
        );
        this.select.value = selected;
        if (this.select.selectedIndex < 0) this.select.selectedIndex = 0;
        const slots = this.slots().filter((s) => !this.select.value || s.node.id === this.select.value);
        this.picker.replaceChildren(
            option({ textContent: `+ ${I18n.translate("inspection.addCharacteristic")}`, value: "" }),
            ...slots
                .filter((s) => tolerances(s.node)[s.id] === undefined)
                .map((s) => option({ textContent: `${s.node.name} / ${s.label}`, value: s.id })),
        );
        this.picker.disabled = this.picker.options.length <= 1;
        const table = document.createElement("table");
        table.className = style.table;
        const headers = inspectionHeaders();
        const head = table.createTHead().insertRow();
        for (const name of headers) {
            const th = document.createElement("th");
            th.textContent = name;
            head.append(th);
        }
        const removeHeader = document.createElement("th");
        head.append(removeHeader);
        for (const { slot, texts } of inspectionCharacteristics(this.doc, this.select.value || undefined)) {
            const node = slot.node;
            const row = table.insertRow();
            texts.forEach((text, index) => {
                const cell = row.insertCell();
                if (index !== 2 && index !== 3) {
                    cell.textContent = text;
                    return;
                }
                const input = document.createElement("input");
                input.type = "number";
                input.min = "0";
                input.step = "any";
                input.value = text;
                input.setAttribute(
                    "aria-label",
                    `${slot.label}: ${index === 2 ? "minus" : "plus"} tolerance`,
                );
                input.onchange = () => {
                    if (!input.checkValidity() || !Number.isFinite(input.valueAsNumber)) return;
                    const current = tolerances(node)[slot.id] ?? { minus: 0, plus: 0 };
                    this.writeTolerance(slot, {
                        ...current,
                        [index === 2 ? "minus" : "plus"]: input.valueAsNumber,
                    });
                };
                cell.append(input);
            });
            const remove = document.createElement("button");
            remove.className = style.remove;
            remove.textContent = "×";
            remove.title = `${I18n.translate("inspection.removeCharacteristic")}: ${node.name} / ${slot.label}`;
            remove.setAttribute("aria-label", remove.title);
            remove.onclick = (e) => {
                e.stopPropagation();
                this.writeTolerance(slot, undefined);
            };
            row.insertCell().append(remove);
            row.onclick = (e) => {
                if ((e.target as HTMLElement).tagName !== "INPUT")
                    this.doc.selection.setSelectedNodes([node], false);
            };
        }
        if (table.rows.length === 1) {
            const empty = document.createElement("div");
            empty.className = style.emptyState;
            empty.textContent = I18n.translate("inspection.empty");
            this.output.replaceChildren(empty);
        } else this.output.replaceChildren(table);
    }
    dispose() {
        this.disposed = true;
        this.doc.modelManager.removeNodeObserver(this.changed);
        this.doc.variables.removePropertyChanged(this.changed);
        for (const n of this.watches) n.removePropertyChanged(this.changed);
        this.watches.clear();
    }
}
