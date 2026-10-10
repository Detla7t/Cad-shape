// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { INode } from "./node";

const hidden = new WeakSet<INode>();
/** Runtime-only history visibility. The document's recorded visibility is never changed. */
export function isHistoryHidden(node: INode): boolean {
    return hidden.has(node) || (node.parent != null && isHistoryHidden(node.parent));
}
export function setHistoryHidden(document: IDocument, node: INode, value: boolean): void {
    if (value) hidden.add(node);
    else hidden.delete(node);
    refreshHistoryVisibility(document);
}

/** Sets several nodes at once with one visibility pass; nothing happens when none changes. */
export function setHistoryHiddenNodes(
    document: IDocument,
    changes: Iterable<readonly [node: INode, hidden: boolean]>,
): void {
    let changed = false;
    for (const [node, value] of changes) {
        if (hidden.has(node) === value) continue;
        if (value) hidden.add(node);
        else hidden.delete(node);
        changed = true;
    }
    if (changed) refreshHistoryVisibility(document);
}

function refreshHistoryVisibility(document: IDocument): void {
    for (const candidate of document.modelManager.findNodes())
        document.visual.context.setVisible(
            candidate,
            candidate.visible && candidate.parentVisible && !isHistoryHidden(candidate),
        );
    document.visual.update();
}
