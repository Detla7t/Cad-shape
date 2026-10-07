// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, PubSub } from "@chili3d/core";
import type { FeatureStudioNode } from "../featureStudioNode";
import type { FeatureScriptIde, FeatureScriptIdeOptions } from "./ide/featureScriptIde";

export { showInsertFeatureDialog } from "./insertFeatureDialog";

/**
 * Opens a Feature Studio in the FeatureScript IDE (`ide/featureScriptIde.ts`) inside a
 * floating panel — a floating panel rather than a dialog for the same reason as the
 * parameters panel: the point is watching the model follow as edits are applied.
 *
 * The IDE (CodeMirror and the language service) is its own chunk, loaded on first use.
 * A studio opens once; asking again focuses it (and reveals `reveal`, for go to
 * definition from another studio).
 */

interface OpenStudio {
    ide?: FeatureScriptIde;
    reveal?: { readonly from: number; readonly to: number };
}

const open = new Map<string, OpenStudio>();

/** Loads the IDE chunk and creates an IDE for `studio` — for hosts that mount it themselves (full-size views). */
export async function createFeatureScriptIde(
    studio: FeatureStudioNode,
    options?: FeatureScriptIdeOptions,
): Promise<FeatureScriptIde> {
    const { FeatureScriptIde } = await import("./ide/featureScriptIde");
    return new FeatureScriptIde(studio, options);
}

export function showFeatureStudioEditor(
    studio: FeatureStudioNode,
    reveal?: { readonly from: number; readonly to: number },
): void {
    const existing = open.get(studio.id);
    if (existing !== undefined) {
        if (reveal === undefined) existing.ide?.focus();
        else if (existing.ide !== undefined) existing.ide.reveal(reveal.from, reveal.to);
        else existing.reveal = reveal;
        return;
    }
    const entry: OpenStudio = { reveal };
    open.set(studio.id, entry);
    createFeatureScriptIde(studio, {
        openStudio: (target, from, to) => showFeatureStudioEditor(target, { from, to }),
    })
        .then((ide) => {
            if (open.get(studio.id) !== entry) {
                ide.dispose();
                return;
            }
            entry.ide = ide;
            mount(studio, ide, entry);
        })
        .catch((error: unknown) => {
            open.delete(studio.id);
            PubSub.default.pub("showToast", "error.default:{0}", String(error));
        });
}

function mount(studio: FeatureStudioNode, ide: FeatureScriptIde, entry: OpenStudio): void {
    const document = studio.document;
    const close = () => {
        if (open.get(studio.id) === entry) open.delete(studio.id);
        PubSub.default.remove("documentClosed", onDocumentClosed);
        ide.dispose();
    };
    // The panel removes itself when its document closes, without running onClose.
    const onDocumentClosed = (closed: IDocument) => {
        if (closed === document) close();
    };
    PubSub.default.sub("documentClosed", onDocumentClosed);
    const width = Math.min(900, Math.max(520, window.innerWidth - 420));
    const height = Math.min(640, Math.max(360, window.innerHeight - 190));
    PubSub.default.pub("showFloatPanel", {
        title: "featurescript.studio",
        content: ide.root,
        // Over the viewport, clear of the ribbon and the model tree, so the ribbon's insert
        // and sheet metal commands stay reachable while the studio is open.
        x: Math.max(20, Math.min(380, window.innerWidth - width - 20)),
        y: Math.max(20, Math.min(150, window.innerHeight - height - 20)),
        width,
        height,
        minWidth: 480,
        minHeight: 320,
        document,
        onClose: close,
    });
    requestAnimationFrame(() => {
        if (entry.reveal !== undefined) ide.reveal(entry.reveal.from, entry.reveal.to);
        else ide.focus();
        entry.reveal = undefined;
    });
}
