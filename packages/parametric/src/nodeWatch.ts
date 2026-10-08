// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type INode, isPropertyChanged } from "@chili3d/core";

/**
 * Syncs a watch set to exactly `wantedIds`: stale watches are unwatched and dropped,
 * new ids are resolved and watched with `handler`. Ids that fail to resolve (e.g. a
 * deleted node) are retried on the next sync, so a restored node is picked up again.
 */
export function syncNodeWatches(
    document: IDocument,
    watched: Map<string, INode>,
    wantedIds: ReadonlySet<string>,
    handler: (property: string) => void,
): void {
    const resolved = new Map<string, INode>();
    for (const id of wantedIds) {
        const node = document.modelManager.findNode((candidate) => candidate.id === id);
        if (node !== undefined) resolved.set(id, node);
    }
    for (const [nodeId, node] of watched) {
        if (resolved.get(nodeId) === node) continue;
        if (isPropertyChanged(node)) node.removePropertyChanged(handler);
        watched.delete(nodeId);
    }
    for (const [nodeId, node] of resolved) {
        if (watched.has(nodeId)) continue;
        if (isPropertyChanged(node)) {
            node.onPropertyChanged(handler);
            watched.set(nodeId, node);
        }
    }
}
