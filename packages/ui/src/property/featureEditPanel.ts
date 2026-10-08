// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    I18n,
    type IDocument,
    type IFeatureEditSession,
    type IFeatureListNode,
    type INode,
    Transaction,
} from "@chili3d/core";
import { createCadIcon, createEditableTitle } from "@chili3d/element";
import { showFloatPanel } from "../floatPanel";
import { FeatureListProperty } from "./featureListProperty";
import style from "./featureListProperty.module.css";

export function showFeatureEditPanel(
    model: IDocument,
    node: INode & IFeatureListNode,
    session: IFeatureEditSession,
): void {
    const content = document.createElement("section");
    content.setAttribute("aria-label", "Edit feature");
    const title = createEditableTitle(
        () => {
            const feature = node.featureItems().find((item) => item.id === session.featureId);
            return feature?.name ?? (feature ? I18n.translate(feature.display) : "Edit feature");
        },
        (name) =>
            Transaction.execute(model, "Rename feature", () => node.renameFeature?.(session.featureId, name)),
    );
    const hint = document.createElement("p");
    hint.className = style.editHint;
    hint.textContent = "Later features are rolled back while editing. Apply rebuilds the remaining history.";
    const error = document.createElement("p");
    error.setAttribute("role", "alert");
    error.className = style.errorText;
    const apply = document.createElement("button");
    apply.type = "button";
    apply.setAttribute("aria-label", "Apply feature changes");
    apply.title = "Apply feature changes";
    apply.className = style.accept;
    apply.append(createCadIcon("check"));
    apply.onclick = async () => {
        // Flush a currently focused field before committing the draft.
        (document.activeElement as HTMLElement | null)?.blur();
        const result = await session.apply();
        if (!result.isOk) error.textContent = result.error;
    };
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.setAttribute("aria-label", "Cancel feature changes");
    cancel.title = "Cancel feature changes";
    cancel.className = style.cancel;
    cancel.append(createCadIcon("close"));
    cancel.onclick = () => void session.cancel();
    content.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.stopPropagation();
            void session.cancel();
        }
    });
    content.append(title.element, new FeatureListProperty(model, node, session.featureId), hint, error);
    const panel = showFloatPanel({
        title: "properties.header",
        document: model,
        content,
        actions: [apply, cancel],
        x: 282,
        y: 76,
        width: 300,
        height: 420,
        onClose: () => {
            void session.cancel();
        },
    });
    session.onClose = () => panel.close();
}
