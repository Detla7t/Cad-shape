// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type FeatureItem,
    I18n,
    type IDocument,
    type IFeatureListNode,
    type INode,
    isFeatureListNode,
} from "@chili3d/core";

/**
 * How panels name a feature: its own name, else its type numbered across the document's
 * feature lists in tree order ("Extrude 2"). The feature tree and the timeline share it.
 */
export function featureDisplayName(
    document: IDocument | undefined,
    node: INode & IFeatureListNode,
    item: FeatureItem,
): string {
    if (item.name) return item.name;
    const nodes = document?.modelManager?.findNodes?.() ?? [node];
    let count = 0;
    for (const candidate of nodes) {
        if (!isFeatureListNode(candidate)) continue;
        for (const feature of candidate.featureItems()) {
            if (feature.display === item.display) count++;
            if (candidate === node && feature.id === item.id)
                return `${I18n.translate(item.display)} ${count}`;
        }
    }
    const index = node
        .featureItems()
        .filter((feature) => feature.display === item.display)
        .findIndex((feature) => feature.id === item.id);
    return `${I18n.translate(item.display)} ${index + 1}`;
}
