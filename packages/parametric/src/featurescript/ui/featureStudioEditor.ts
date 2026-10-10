// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { openElement } from "@chili3d/core";
import type { FeatureStudioNode } from "../featureStudioNode";
import type { FeatureScriptIde, FeatureScriptIdeOptions } from "./ide/featureScriptIde";

export { showInsertFeatureDialog } from "./insertFeatureDialog";

/**
 * Feature Studios open in the FeatureScript IDE (`ide/featureScriptIde.ts`), shown full-size
 * in the studio's element tab (`featureStudioElement.ts`) — or in a floating panel when no
 * tab strip is up, which the element registry provides from the same view.
 *
 * The IDE (CodeMirror and the language service) is its own chunk, loaded on first use.
 */

/** A text range to reveal once a studio's IDE is up (go to definition from another studio). */
export interface StudioReveal {
    readonly from: number;
    readonly to: number;
}

/** The IDEs of the studios whose views are mounted, by studio id (see `featureStudioElement.ts`). */
const mounted = new Map<string, { ide?: FeatureScriptIde; reveal?: StudioReveal }>();

/** Loads the IDE chunk and creates an IDE for `studio` — for hosts that mount it themselves (full-size views). */
export async function createFeatureScriptIde(
    studio: FeatureStudioNode,
    options?: FeatureScriptIdeOptions,
): Promise<FeatureScriptIde> {
    const { FeatureScriptIde } = await import("./ide/featureScriptIde");
    return new FeatureScriptIde(studio, options);
}

/** Switches to the studio's element tab, revealing `reveal` once its IDE is ready. */
export function showFeatureStudioEditor(studio: FeatureStudioNode, reveal?: StudioReveal): void {
    openElement(studio.document, studio);
    const entry = mounted.get(studio.id);
    if (entry === undefined || reveal === undefined) return;
    if (entry.ide !== undefined) entry.ide.reveal(reveal.from, reveal.to);
    else entry.reveal = reveal;
}

/**
 * Mounts an IDE for `studio` into `container` (the element view's root): the chunk loads
 * asynchronously, so a reveal asked for meanwhile is kept and applied once it is up, and
 * `onReady` gets the IDE then (the element view registers its editor buffer).
 * Returns the view's dispose.
 */
export function mountFeatureScriptIde(
    studio: FeatureStudioNode,
    container: HTMLElement,
    onError: (error: unknown) => void,
    onReady?: (ide: FeatureScriptIde) => void,
): { focus(): void; dispose(): void } {
    const entry: { ide?: FeatureScriptIde; reveal?: StudioReveal } = {};
    let disposed = false;
    mounted.set(studio.id, entry);
    createFeatureScriptIde(studio, {
        openStudio: (target, from, to) => showFeatureStudioEditor(target, { from, to }),
    })
        .then((ide) => {
            if (disposed) {
                ide.dispose();
                return;
            }
            entry.ide = ide;
            container.append(ide.root);
            onReady?.(ide);
            requestAnimationFrame(() => {
                if (entry.reveal !== undefined) ide.reveal(entry.reveal.from, entry.reveal.to);
                else ide.focus();
                entry.reveal = undefined;
            });
        })
        .catch(onError);
    return {
        focus: () => entry.ide?.focus(),
        dispose: () => {
            disposed = true;
            if (mounted.get(studio.id) === entry) mounted.delete(studio.id);
            entry.ide?.dispose();
            entry.ide?.root.remove();
        },
    };
}
