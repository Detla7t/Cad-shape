// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { findWhereUsed, type IDocument, type ReviewTarget } from "@chili3d/core";
import { action, labeled, panelBody, selectionTarget, targetKey, targetSelect, textElement } from "./helpers";
import style from "./review.module.css";

export class WhereUsedPanel {
    readonly element: HTMLElement;
    private abort?: AbortController;
    constructor(doc: IDocument, target?: ReviewTarget) {
        const { root, body } = panelBody("Where used");
        this.element = root;
        const targets = targetSelect(doc, target),
            history = document.createElement("input"),
            output = document.createElement("div");
        history.type = "checkbox";
        history.checked = true;
        const refresh = async () => {
            this.abort?.abort();
            const controller = new AbortController();
            this.abort = controller;
            const target = targets.value();
            if (!target.nodeId) {
                output.replaceChildren(
                    textElement("p", "Select a sketch, part, assembly or feature to find its references."),
                );
                return;
            }
            output.replaceChildren(textElement("p", "Looking for references…"));
            try {
                const result = await findWhereUsed(
                    doc.application,
                    target,
                    history.checked,
                    controller.signal,
                );
                if (controller.signal.aborted) return;
                output.replaceChildren(
                    textElement("p", `${result.references.length} references`, style.muted),
                );
                for (const warning of result.warnings) output.append(textElement("p", warning, style.error));
                for (const row of result.references) {
                    const card = document.createElement("article");
                    card.className = style.entry;
                    card.append(
                        textElement(
                            "strong",
                            `${row.documentName} / ${row.nodeName}${row.featureName ? ` / ${row.featureName}` : ""}`,
                        ),
                        textElement("p", `${row.label}${row.commit ? ` · ${row.commit.slice(0, 9)}` : ""}`),
                        textElement("p", row.path, style.muted),
                    );
                    if (row.sourceVersion)
                        card.append(
                            textElement(
                                "p",
                                `Source ${row.sourceVersion}${row.sourceCommit ? ` · resolved ${row.sourceCommit.slice(0, 9)}` : ""}`,
                                style.muted,
                            ),
                        );
                    card.append(
                        action("Locate in current workspace", () => {
                            void (async () => {
                                const model =
                                    [...doc.application.documents].find((d) => d.id === row.documentId) ??
                                    (await doc.application.openDocument(row.documentId));
                                if (!model) return;
                                const view = doc.application.views.find((v) => v.document === model);
                                if (view) doc.application.activeView = view;
                                const node = model.modelManager.findNode((n) => n.id === row.nodeId);
                                if (node) model.selection.setSelectedNodes([node], false);
                            })().catch((error) =>
                                output.append(textElement("p", String(error), style.error)),
                            );
                        }),
                    );
                    output.append(card);
                }
                if (!result.references.length)
                    output.append(
                        textElement(
                            "p",
                            "No references found in the scanned documents and versions.",
                            style.muted,
                        ),
                    );
            } catch (error) {
                if (!controller.signal.aborted)
                    output.replaceChildren(textElement("p", String(error), style.error));
            }
        };
        targets.select.onchange = () => void refresh();
        history.onchange = () => void refresh();
        body.append(
            labeled("Target", targets.select),
            action("Use selection", () => {
                targets.select.value = targetKey(selectionTarget(doc));
                void refresh();
            }),
            labeled("Include named versions and branch heads", history),
            action("Refresh", () => void refresh()),
            textElement(
                "p",
                "Searches open documents and documents saved in this browser. Version rows describe that snapshot; Locate selects the current workspace without restoring history.",
                style.muted,
            ),
            output,
        );
        void refresh();
    }
    dispose() {
        this.abort?.abort();
    }
}
