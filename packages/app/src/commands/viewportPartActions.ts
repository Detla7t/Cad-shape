// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    formatDocumentValue,
    type IEdge,
    type IFace,
    type INodeVisual,
    LENGTH_UNITS,
    NodeActions,
    type NodeMenuAction,
    PhongMaterial,
    PubSub,
    ShapeNode,
    ShapeTypeUtils,
    Transaction,
    type VisualShapeData,
    VisualStates,
    XYZ,
} from "@chili3d/core";

NodeActions.register((node, context) => {
    if (!context || !(node instanceof ShapeNode) || node.display() === "body.sketch") return [];
    const doc = node.document,
        view = context.view;
    const pick = context.picks.find((pick) => pick.owner.node === node);
    const facePick = context.picks.find(
        (pick) => pick.owner.node === node && ShapeTypeUtils.hasFace(pick.shape.shapeType),
    );
    const choose = (pick: VisualShapeData) => {
        doc.selection.clearSelection();
        doc.selection.setSelectedShapes([pick], VisualStates.edgeSelected, false);
    };
    const selectAll = (kind: "faces" | "edges") => {
        const owner = doc.visual.context.getVisual(node) as INodeVisual | undefined;
        if (!owner) return;
        const world = owner.worldTransform();
        const picks =
            node.mesh[kind]?.range.map((range, index) => ({
                owner,
                shape: range.shape,
                indexes: [index],
                transform: range.transform ? world.multiply(range.transform) : world,
            })) ?? [];
        doc.selection.clearSelection();
        doc.selection.setSelectedShapes(picks, VisualStates.edgeSelected, false);
    };
    const other = context.picks.filter(
        (pick, index, all) =>
            all.findIndex(
                (candidate) => candidate.owner === pick.owner && candidate.shape.id === pick.shape.id,
            ) === index,
    );
    const actions: NodeMenuAction[] = [
        {
            id: "analysis",
            label: "Curve/surface analysis…",
            order: 135,
            disabled: !pick,
            run: () => {
                if (!pick) return;
                const shape = pick.shape.transformedMul(pick.transform);
                const content = document.createElement("div");
                content.setAttribute("aria-label", "Geometry analysis");
                const add = (label: string, value: string) => {
                    const row = document.createElement("p");
                    row.textContent = `${label}: ${value}`;
                    content.append(row);
                };
                try {
                    if (ShapeTypeUtils.hasEdge(shape.shapeType)) {
                        const edge = shape as IEdge,
                            curve = edge.curve;
                        try {
                            add("Curve", curve.curveType);
                            add("Length", formatDocumentValue(edge.length(), doc, LENGTH_UNITS));
                            add("Continuity", curve.continuity());
                        } finally {
                            curve.dispose();
                        }
                    } else if (ShapeTypeUtils.hasFace(shape.shapeType)) {
                        const face = shape as IFace,
                            surface = face.surface();
                        try {
                            add("Surface", surface.isPlanar() ? "Planar" : "Curved");
                            add("Area", `${face.area().toFixed(4)} mm²`);
                            add("Continuity", surface.continuity());
                        } finally {
                            surface.dispose();
                        }
                    } else add("Selection", "Select a face or edge for geometric measurements.");
                    PubSub.default.pub("showDialog", "properties.header", content);
                } finally {
                    shape.dispose();
                }
            },
        },
        {
            id: "section",
            label: "Section view…",
            order: 165,
            disabled: !view.showSectionView,
            run: () => view.showSectionView?.(),
        },
        {
            id: "selectEntities",
            label: "Select",
            order: 175,
            children: [
                {
                    id: "selectPart",
                    label: "Part",
                    run: () => {
                        doc.selection.clearSelection();
                        doc.selection.setSelectedNodes([node], false);
                    },
                },
                { id: "selectFaces", label: "All faces of this part", run: () => selectAll("faces") },
                { id: "selectEdges", label: "All edges of this part", run: () => selectAll("edges") },
                { id: "clear", label: "Clear selection", run: () => doc.selection.clearSelection() },
            ],
        },
        {
            id: "selectOther",
            label: "Select other…",
            order: 176,
            children: other.map((pick, index) => ({
                id: `pick-${index}`,
                label: `${pick.owner.node.name} · ${ShapeTypeUtils.stringValue(pick.shape.shapeType)} ${pick.indexes[0] + 1}`,
                run: () => choose(pick),
            })),
        },
        {
            id: "fit",
            label: "Zoom to fit",
            order: 185,
            run: () => {
                doc.selection.clearSelection();
                view.cameraController.fitContent();
                view.update();
            },
        },
        {
            id: "normal",
            label: "View normal to",
            order: 195,
            disabled: !facePick,
            run: () => {
                if (!facePick) return;
                const face = facePick.shape.transformedMul(facePick.transform) as IFace;
                const surface = face.surface();
                try {
                    const b = surface.bounds();
                    const uv = facePick.point ? surface.parameter(facePick.point, 1) : undefined;
                    const [point, normal] = face.normal(
                        uv?.u ?? (b.u1 + b.u2) / 2,
                        uv?.v ?? (b.v1 + b.v2) / 2,
                    );
                    const camera = view.cameraController,
                        distance = camera.cameraPosition.distanceTo(camera.cameraTarget);
                    const up = Math.abs(normal.dot(XYZ.unitZ)) > 0.95 ? XYZ.unitY : XYZ.unitZ;
                    camera.lookAt(point.add(normal.multiply(distance)), point, up);
                    view.update();
                } finally {
                    surface.dispose();
                    face.dispose();
                }
            },
        },
        {
            id: "faceAppearance",
            label: "Add appearance to face…",
            order: 220,
            disabled: !facePick,
            run: () => {
                if (!facePick) return;
                const input = document.createElement("input");
                input.type = "color";
                input.value = "#a9c6df";
                input.setAttribute("aria-label", "Face color");
                PubSub.default.pub("showDialog", "properties.header", input, () =>
                    Transaction.execute(doc, "Edit face appearance", () => {
                        const material = new PhongMaterial({
                            document: doc,
                            name: `${node.name} face`,
                            color: input.value,
                        });
                        doc.modelManager.materials.push(material);
                        node.addFaceMaterial(
                            facePick.indexes.map((faceIndex) => ({ faceIndex, materialId: material.id })),
                        );
                    }),
                );
            },
        },
    ];
    return actions;
});
