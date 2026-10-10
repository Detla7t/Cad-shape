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
                    "documents.newDrawing",
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
    // The Drawing element's own toolbar (Onshape's drawing tools replace the Part Studio's).
    {
        tabName: "ribbon.tab.drawing",
        contextual: true,
        groups: [
            {
                groupName: "ribbon.group.drawing",
                items: ["drawing.insertViews", "drawing.createSketch", "drawing.fit", "drawing.preferences"],
            },
            {
                groupName: "ribbon.group.annotation2d",
                items: ["drawing.dimension", "drawing.note", "drawing.titleBlock"],
            },
            {
                groupName: "ribbon.group.templates",
                items: ["drawing.saveTemplate", "drawing.importTemplate"],
            },
            {
                groupName: "ribbon.group.export2d",
                items: ["drawing.exportDxf", "drawing.exportDwg", "drawing.exportSvg"],
            },
        ],
    },
];
