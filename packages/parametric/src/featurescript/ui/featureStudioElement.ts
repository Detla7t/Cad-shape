// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub, registerElementKind, registerElementView } from "@chili3d/core";
import { type FeatureStudioNode, isFeatureStudioNode } from "../featureStudioNode";
import { mountFeatureScriptIde } from "./featureStudioEditor";

/**
 * Feature Studios as document elements: each studio gets a tab in the element strip, and
 * its tab shows the FeatureScript IDE full-size. The view stays mounted while other tabs
 * are active, so unapplied drafts survive switching to the Part Studio and back.
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
    const ide = mountFeatureScriptIde(node as FeatureStudioNode, element, (error) =>
        PubSub.default.pub("showToast", "error.default:{0}", String(error)),
    );
    return {
        element,
        activated: () => ide.focus(),
        dispose: () => ide.dispose(),
    };
});
