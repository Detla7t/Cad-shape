// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IDocument, isFeatureListNode, type ReviewTarget } from "@chili3d/core";
import style from "./review.module.css";

export function textElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text: string,
    className?: string,
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
}
export function action(text: string, run: () => void) {
    const button = textElement("button", text);
    button.type = "button";
    button.onclick = () => run();
    return button;
}
export function labeled<T extends HTMLElement>(text: string, input: T): HTMLLabelElement {
    const label = document.createElement("label");
    label.append(textElement("span", text), input);
    return label;
}
export function targetChoices(doc: IDocument): ReviewTarget[] {
    return [
        { documentId: doc.id, name: doc.name },
        ...doc.modelManager.findNodes().flatMap((node) => [
            { documentId: doc.id, nodeId: node.id, name: node.name },
            ...(isFeatureListNode(node)
                ? node.featureItems().map((feature, index) => ({
                      documentId: doc.id,
                      nodeId: node.id,
                      featureId: feature.id,
                      name: `${node.name} / ${feature.name ?? I18n.translate(feature.display)} ${index + 1}`,
                  }))
                : []),
        ]),
    ];
}
export const targetKey = (target: ReviewTarget) => `${target.nodeId ?? ""}/${target.featureId ?? ""}`;
export function selectionTarget(doc: IDocument): ReviewTarget {
    const node = doc.selection.getSelectedNodes()[0] ?? doc.selection.getSelectedShapes()[0]?.owner.node;
    return { documentId: doc.id, nodeId: node?.id, name: node?.name ?? doc.name };
}
export function targetSelect(doc: IDocument, target?: ReviewTarget) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Target");
    const choices = targetChoices(doc);
    for (const item of choices) select.add(new Option(item.name, targetKey(item)));
    select.value = targetKey(target ?? selectionTarget(doc));
    return { select, value: () => choices.find((item) => targetKey(item) === select.value) ?? choices[0] };
}
export function panelBody(title: string) {
    const root = document.createElement("section");
    root.className = style.panel;
    root.setAttribute("aria-label", title);
    const body = document.createElement("div");
    body.className = style.body;
    root.append(body);
    return { root, body };
}
export function table(rows: readonly (readonly string[])[]) {
    const table = document.createElement("table");
    table.className = style.table;
    rows.forEach((row, index) => {
        const tr = table.insertRow();
        for (const value of row) tr.append(textElement(index === 0 ? "th" : "td", value));
    });
    return table;
}
