// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { registerElementKind, registerElementView } from "@chili3d/core";
import { type FeatureStudioNode, isFeatureStudioNode } from "../featureStudioNode";
import { FeatureStudioEditor } from "./featureStudioEditor";

/**
 * Feature Studios as document elements: each studio gets a tab in the element strip, and
 * its tab shows the studio editor full-size. The view is only the default — a richer
 * editor replaces it by registering its own view for `FEATURE_STUDIO_KIND`.
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
    const editor = new FeatureStudioEditor(node as FeatureStudioNode);
    return {
        element: editor.root,
        activated: () => editor.code.focus({ preventScroll: true }),
        dispose: () => editor.dispose(),
    };
});
