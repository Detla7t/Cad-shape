// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    GeometryNode,
    type IDocument,
    type INode,
    modelParameters,
    resolveUnitSpec,
    Transaction,
} from "@chili3d/core";
import style from "./modelTable.module.css";

type Tolerance = { minus: number; plus: number };
function tolerances(node: GeometryNode): Record<string, Tolerance> {
    try {
        return JSON.parse(node.inspectionJson);
    } catch {
        return {};
    }
}
export class InspectionPanel {
    readonly element = document.createElement("div");
    private readonly select = document.createElement("select");
    private readonly output = document.createElement("div");
    private readonly watches = new Set<INode>();
    private rows: string[][] = [];
    private writing = false;
    private queued = false;
    private disposed = false;
    constructor(private readonly doc: IDocument) {
        this.element.className = style.root;
        this.output.className = style.scroll;
        this.select.setAttribute("aria-label", "Inspection model");
        this.select.onchange = () => this.render();
        const exportButton = document.createElement("button");
        exportButton.textContent = "Export CSV";
        exportButton.onclick = () => {
            const csv = this.rows
                .map((row) => row.map((s) => `"${s.replaceAll('"', '""')}"`).join(","))
                .join("\r\n");
            const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "inspection.csv";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        const toolbar = document.createElement("div");
        toolbar.className = style.toolbar;
        toolbar.append(this.select, exportButton);
        this.element.append(toolbar, this.output);
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
    private render() {
        for (const n of this.watches) n.removePropertyChanged(this.changed);
        this.watches.clear();
        const nodes = this.doc.modelManager.findNodes();
        for (const n of nodes) {
            n.onPropertyChanged(this.changed);
            this.watches.add(n);
        }
        const selected = this.select.value;
        this.select.replaceChildren(new Option("All models", ""));
        for (const n of nodes) if (n instanceof GeometryNode) this.select.add(new Option(n.name, n.id));
        this.select.value = selected;
        if (this.select.selectedIndex < 0) this.select.selectedIndex = 0;
        const slots = modelParameters(this.doc).filter(
            (s) => !this.select.value || s.node.id === this.select.value,
        );
        const table = document.createElement("table");
        table.className = style.table;
        const headers = ["Characteristic", "Nominal", "− tolerance", "+ tolerance", "Lower", "Upper"];
        this.rows = [headers];
        const head = table.createTHead().insertRow();
        for (const name of headers) {
            const th = document.createElement("th");
            th.textContent = name;
            head.append(th);
        }
        for (const slot of slots) {
            if (slot.boolean) continue;
            const node = slot.node;
            if (!(node instanceof GeometryNode)) continue;
            const resolved = resolveUnitSpec(slot.value, this.doc.variables.evaluate().scope, slot.unit);
            if (!resolved.isOk) continue;
            const value = resolved.value,
                unit = slot.unit.angle ? "°" : slot.unit.length ? "mm" : "";
            const t = tolerances(node)[slot.id] ?? { minus: 0, plus: 0 };
            const formatted = (v: number) => `${Number(v.toFixed(5))} ${unit}`.trim();
            const texts = [
                `${node.name} / ${slot.label}`,
                formatted(value),
                String(t.minus),
                String(t.plus),
                formatted(value - t.minus),
                formatted(value + t.plus),
            ];
            this.rows.push(texts);
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
                    const all = tolerances(node),
                        current = all[slot.id] ?? { minus: 0, plus: 0 };
                    all[slot.id] = { ...current, [index === 2 ? "minus" : "plus"]: input.valueAsNumber };
                    this.writing = true;
                    try {
                        Transaction.execute(
                            this.doc,
                            "Edit inspection tolerance",
                            () => (node.inspectionJson = JSON.stringify(all)),
                        );
                    } finally {
                        this.writing = false;
                    }
                    this.render();
                };
                cell.append(input);
            });
            row.onclick = (e) => {
                if ((e.target as HTMLElement).tagName !== "INPUT")
                    this.doc.selection.setSelectedNodes([node], false);
            };
        }
        if (this.rows.length === 1) {
            const empty = document.createElement("div");
            empty.className = style.empty;
            empty.textContent =
                "Add sketch dimensions or numeric feature parameters to inspect their nominal values and tolerance limits.";
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
