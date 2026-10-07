// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, PubSub } from "@chili3d/core";
import { ConfigurationDataContent } from "./configurationDataContent";
import { ConfigurationEditor } from "./configurationEditor";

/**
 * The Configuration panel as a floating window, like the parameters panel: the point of
 * switching configurations is watching the Part Studio follow, so nothing covers the viewport
 * and there is no confirm step. Bound to its document — it writes straight into the table.
 */
export function showConfigurationPanel(document: IDocument): void {
    PubSub.default.pub("showFloatPanel", {
        title: "configuration.title",
        content: new ConfigurationEditor(new ConfigurationDataContent(document)),
        width: 520,
        height: 420,
        minWidth: 380,
        minHeight: 220,
        document,
    });
}
