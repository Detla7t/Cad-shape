// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { download, type IDocument, PubSub } from "@chili3d/core";
import { button, div, input, label } from "@chili3d/element";
import type { AssemblyNode } from "../model/assemblyNode";
import { bomToCsv, buildBom } from "../model/bom";
import { evaluateAssembly } from "../model/evaluate";
import style from "./assembly.module.css";
import { t } from "./linkUi";

/** The assembly's bill of materials: flattened or structured, exportable as CSV. */
export function showBomPanel(assembly: AssemblyNode, document: IDocument): void {
    const structured = input({ type: "checkbox" });
    const table = createTable();
    const render = () => {
        const rows = buildBom(evaluateAssembly(document, assembly), { structured: structured.checked });
        const body = rows.map(
            (row) =>
                `<tr><td>${row.item}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.source)}</td><td>${row.quantity}</td></tr>`,
        );
        table.innerHTML = `<thead><tr><th>${escapeHtml(t("assembly.bom.item"))}</th><th>${escapeHtml(t("assembly.bom.name"))}</th><th>${escapeHtml(t("assembly.bom.source"))}</th><th>${escapeHtml(t("assembly.bom.quantity"))}</th></tr></thead><tbody>${body.join("")}</tbody>`;
        return rows;
    };
    structured.onchange = () => render();
    const exportCsv = () => {
        const rows = render();
        download([bomToCsv(rows)], `${assembly.name} BOM.csv`);
    };
    const onChanged = () => render();
    assembly.onPropertyChanged(onChanged);
    render();
    PubSub.default.pub("showFloatPanel", {
        title: "assembly.bom.title",
        content: div(
            { className: style.panel },
            div(
                { className: style.toolbar },
                label({ className: style.field }, structured, t("assembly.bom.structured")),
                button({
                    className: style.button,
                    textContent: t("assembly.bom.exportCsv"),
                    onclick: exportCsv,
                }),
            ),
            div({ className: style.scroll }, table),
        ),
        width: 560,
        height: 380,
        minWidth: 360,
        minHeight: 200,
        document,
        onClose: () => assembly.removePropertyChanged(onChanged),
    });
}

function createTable(): HTMLTableElement {
    const element = globalThis.document.createElement("table");
    element.className = style.table;
    return element;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
