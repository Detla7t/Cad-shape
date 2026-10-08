// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { download, NodeActions, openElement, PubSub, Transaction } from "@chili3d/core";
import { SketchNode, sketchDrawing, writeDxf } from "@chili3d/parametric";
import { writeDwg } from "./cad/dwg";
import { DocumentFileNode } from "./documentFileNode";

NodeActions.register((node) => {
    if (!(node instanceof SketchNode)) return [];
    return [
        {
            id: "drawing",
            order: 55,
            label: `Create Drawing of ${node.name}…`,
            run: () => {
                const file = new DocumentFileNode({
                    document: node.document,
                    fileName: `${node.name}.dxf`,
                    text: writeDxf(sketchDrawing(node.data)),
                });
                Transaction.execute(node.document, "Create sketch drawing", () =>
                    node.document.modelManager.addNode(file),
                );
                openElement(node.document, file);
            },
        },
        {
            id: "dwg",
            order: 65,
            label: "Export as DWG…",
            run: async () => {
                const result = await writeDwg(sketchDrawing(node.data));
                if (result.isOk) download([new Uint8Array(result.value)], `${node.name}.dwg`);
                else PubSub.default.pub("displayError", result.error);
            },
        },
    ];
});
