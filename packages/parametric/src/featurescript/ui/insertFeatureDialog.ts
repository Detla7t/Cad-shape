// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type IDocument, PubSub, showPartStudio } from "@chili3d/core";
import { ParametricBodyNode } from "../../parametricBodyNode";
import type { FeatureStudioNode } from "../featureStudioNode";
import { customFeatures, insertCustomFeature } from "../insertFeature";
import { providedOnshapeStd } from "../runtime";
import { insertStandardFeature, STANDARD_FEATURES } from "../standardFeatures";
import style from "./insertFeatureDialog.module.css";

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function translate(key: Parameters<typeof I18n.translate>[0], ...args: unknown[]): string {
    return I18n.translate(key, ...(args as never[])) ?? String(key);
}

/**
 * The insert dialog: which custom feature (all studios, or one), and where — a new body
 * or an existing parametric body (the selected one preselected).
 */
export function showInsertFeatureDialog(document: IDocument, studio?: FeatureStudioNode): void {
    const entries = customFeatures(document, studio);
    const standardEntries = studio === undefined && providedOnshapeStd() ? STANDARD_FEATURES : [];
    if (entries.length === 0 && standardEntries.length === 0) {
        PubSub.default.pub("showToast", "featurescript.insert.none");
        return;
    }
    const featureSelect = element("select");
    for (const entry of standardEntries) {
        const option = element("option", undefined, entry.displayName);
        option.value = `standard:${entry.featureName}`;
        featureSelect.append(option);
    }
    entries.forEach((entry, index) => {
        const option = element(
            "option",
            undefined,
            studio === undefined ? `${entry.studio.name} › ${entry.displayName}` : entry.displayName,
        );
        option.value = String(index);
        featureSelect.append(option);
    });
    const bodies = document.modelManager.findNodes(
        (node) => node instanceof ParametricBodyNode,
    ) as ParametricBodyNode[];
    const selected = document.selection.getSelectedNodes().find((node) => node instanceof ParametricBodyNode);
    const targetSelect = element("select");
    const newBody = element("option", undefined, translate("featurescript.insert.newBody"));
    newBody.value = "";
    targetSelect.append(newBody);
    for (const body of bodies) {
        const option = element("option", undefined, body.name);
        option.value = body.id;
        option.selected = body === selected;
        targetSelect.append(option);
    }
    const row = (label: string, control: HTMLElement) => {
        const container = element("div", style.dialogRow);
        container.append(element("span", undefined, label), control);
        return container;
    };
    const content = element("div", style.dialog);
    content.append(
        row(translate("featurescript.insert.feature"), featureSelect),
        row(translate("featurescript.insert.target"), targetSelect),
    );
    PubSub.default.pub("showDialog", "featurescript.insert.title", content, [
        {
            content: "common.confirm",
            onclick: () => {
                const body = bodies.find((candidate) => candidate.id === targetSelect.value);
                const standard = featureSelect.value.startsWith("standard:");
                const entry = entries[Number(featureSelect.value)];
                if (!standard && entry === undefined) return;
                const result = standard
                    ? insertStandardFeature(document, featureSelect.value.slice("standard:".length), body)
                    : insertCustomFeature(document, entry, body);
                if (!result.isOk) PubSub.default.pub("showToast", "error.default:{0}", result.error);
                // Inserted from a studio's tab: show the body taking the new feature.
                else showPartStudio(document);
            },
        },
        { content: "common.cancel", onclick: () => {} },
    ]);
}
