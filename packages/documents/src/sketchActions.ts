// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, NodeActions, openElement, PubSub, ShapeNode, Transaction } from "@chili3d/core";
import { SketchNode, sketchDrawing, writeDxf } from "@chili3d/parametric";
import { projectionDrawing } from "./cad/projection";
import { DocumentFileNode } from "./documentFileNode";
import { showExportDrawingDialog } from "./ui/exportDialog";

NodeActions.register((node) => {
    if (!(node instanceof ShapeNode) || node instanceof SketchNode) return [];
    return [
        {
            id: "drawing",
            order: 55,
            icon: "drawing",
            label: `Create Drawing of ${node.name}…`,
            run: () => {
                if (!node.shape.isOk) {
                    PubSub.default.pub("displayError", node.shape.error);
                    return;
                }
                const shape = node.shape.value.transformedMul(node.worldTransform());
                try {
                    const drawing = projectionDrawing([shape], { angle: "third", iso: true });
                    const file = new DocumentFileNode({
                        document: node.document,
                        fileName: `${node.name}.dxf`,
                        text: writeDxf(drawing),
                    });
                    Transaction.execute(node.document, "Create part drawing", () =>
                        node.document.modelManager.addNode(file),
                    );
                    openElement(node.document, file);
                } finally {
                    shape.dispose();
                }
            },
        },
        {
            id: "exportDrawing",
            order: 66,
            icon: "export",
            label: I18n.translate("command.documents.exportDrawing"),
            run: () => {
                if (!node.shape.isOk) {
                    PubSub.default.pub("displayError", node.shape.error);
                    return;
                }
                showExportDrawingDialog({
                    document: node.document,
                    name: node.name,
                    drawing: () => {
                        const shape = node.shape.value.transformedMul(node.worldTransform());
                        try {
                            return projectionDrawing([shape], { angle: "third", iso: true });
                        } finally {
                            shape.dispose();
                        }
                    },
                });
            },
        },
    ];
});

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
            // Onshape's "Export as DXF/DWG…": replaces the parametric module's plain export (same id).
            id: "export",
            order: 60,
            icon: "export",
            label: I18n.translate("command.documents.exportDrawing"),
            run: () =>
                showExportDrawingDialog({
                    document: node.document,
                    name: node.name,
                    drawing: () => sketchDrawing(node.data),
                }),
        },
    ];
});
