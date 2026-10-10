// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type EditorBufferRegistration,
    EditorBuffers,
    PubSub,
    registerElementKind,
    registerElementView,
} from "@chili3d/core";
import { type FeatureStudioNode, isFeatureStudioNode } from "../featureStudioNode";
import { mountFeatureScriptIde } from "./featureStudioEditor";

/**
 * Feature Studios as document elements: each studio gets a tab in the element strip, and
 * its tab shows the FeatureScript IDE full-size. The view stays mounted while other tabs
 * are active, so unapplied drafts survive switching to the Part Studio and back; once the IDE
 * is up its draft is registered with `EditorBuffers` (`featureStudioBuffer.ts`), which marks
 * the tab, asks about it on close and keeps it in the recovery autosave.
 */
export const FEATURE_STUDIO_KIND = "featureStudio";

registerElementKind({
    kind: FEATURE_STUDIO_KIND,
    icon: "icon-macro",
    display: "featurescript.studio",
    isElement: isFeatureStudioNode,
    newCommand: "featurescript.newStudio",
});

registerElementView(FEATURE_STUDIO_KIND, (node) => {
    const element = document.createElement("div");
    element.style.cssText =
        "display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0;";
    let registration: EditorBufferRegistration | undefined;
    let disposed = false;
    const onError = (error: unknown) => PubSub.default.pub("showToast", "error.default:{0}", String(error));
    const ide = mountFeatureScriptIde(node as FeatureStudioNode, element, onError, (mounted) => {
        // The adapter uses CodeMirror, so it loads with the IDE's chunk, not with this module.
        import("./featureStudioBuffer")
            .then(({ featureStudioBuffer }) => {
                if (disposed) return;
                registration = EditorBuffers.register(
                    featureStudioBuffer(mounted, () => registration?.changed()),
                );
            })
            .catch(onError);
    });
    return {
        element,
        activated: () => ide.focus(),
        dispose: () => {
            disposed = true;
            registration?.dispose();
            ide.dispose();
        },
    };
});
