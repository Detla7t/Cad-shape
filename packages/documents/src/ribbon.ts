// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { RibbonTabKeys, RibbonTabProfile } from "@chili3d/core";

type RibbonProfileExtra = RibbonTabProfile & { before?: RibbonTabKeys };

/** Ribbon contributions of the documents module, applied by `AppBuilder.useDocuments`. */
export const DocumentsRibbonProfiles: RibbonProfileExtra[] = [
    {
        tabName: "ribbon.tab.file",
        groups: [
            {
                groupName: "ribbon.group.documents",
                items: [
                    "documents.newMarkdown",
                    "documents.newSpreadsheet",
                    ["documents.newRichText", "documents.newText"],
                ],
            },
            {
                groupName: "ribbon.group.export2d",
                items: ["drawing.exportViews"],
            },
        ],
    },
];
