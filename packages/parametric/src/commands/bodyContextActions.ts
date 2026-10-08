// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, NodeActions, type NodeMenuAction, PubSub, Transaction } from "@chili3d/core";
import { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";

NodeActions.register((node, context) => {
    if (!(node instanceof ParametricBodyNode)) return [];
    const features = node.featureItems(),
        latest = features.at(-1);
    if (!latest) return [];
    const name = latest.name ?? `${I18n.translate(latest.display)} ${features.length}`;
    const sketchRefs = features.flatMap((feature) =>
        (feature.references ?? [])
            .filter((ref) => ref.node instanceof SketchNode)
            .map((ref) => ({ feature, ref })),
    );
    const first = sketchRefs.at(0);
    const actions: NodeMenuAction[] = [
        {
            id: "editFeature",
            label: `Edit ${name}…`,
            order: -100,
            run: () => PubSub.default.pub("editFeature", node, latest.id),
        },
        ...sketchRefs
            .filter(
                (entry, index, all) => all.findIndex((other) => other.ref.node === entry.ref.node) === index,
            )
            .map(({ feature, ref }, index) => ({
                id: `editSourceSketch${index}`,
                label: `Edit ${ref.node.name}…`,
                order: -99 + index,
                run: () => node.activateReference(feature.id, ref.key),
            })),
        {
            id: "showDimensions",
            label: "Show dimensions",
            order: -80,
            disabled: !first,
            run: () => {
                if (first) node.activateReference(first.feature.id, first.ref.key);
            },
        },
        {
            id: "dependencies",
            label: `Show dependencies of ${name}…`,
            order: -70,
            run: () => {
                const list = document.createElement("div");
                list.setAttribute("aria-label", "Feature dependencies");
                for (const feature of features) {
                    const row = document.createElement("p");
                    row.textContent = `${feature.name ?? I18n.translate(feature.display)} → ${(feature.references ?? []).map((ref) => ref.node.name).join(", ") || "Previous feature result"}`;
                    list.append(row);
                }
                PubSub.default.pub("showDialog", "properties.header", list);
            },
        },
        {
            id: "deleteFeature",
            label: `Delete ${name}`,
            order: 205,
            run: () =>
                Transaction.execute(node.document, `Delete ${name}`, () => node.removeFeature(latest.id)),
        },
    ];
    return context
        ? actions
        : actions.filter((action) => action.id === "editFeature" || action.id === "dependencies");
});
