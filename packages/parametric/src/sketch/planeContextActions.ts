// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    GeometryNode,
    NodeActions,
    type NodeMenuAction,
    PubSub,
    ReferencePlaneNode,
    Transaction,
    XYZ,
} from "@chili3d/core";

/** Fit the plane's local square around model geometry, excluding the datum planes themselves. */
export function sizePlaneToPartStudio(plane: ReferencePlaneNode): number {
    const frame = plane.plane;
    let extent = 0;
    for (const node of plane.document.modelManager.findNodes()) {
        if (!(node instanceof GeometryNode) || !node.visible) continue;
        const box = node.boundingBox();
        if (!box) continue;
        for (const x of [box.min.x, box.max.x])
            for (const y of [box.min.y, box.max.y])
                for (const z of [box.min.z, box.max.z]) {
                    const point = new XYZ(x, y, z).sub(frame.origin);
                    extent = Math.max(
                        extent,
                        Math.abs(point.dot(frame.xvec)),
                        Math.abs(point.dot(frame.yvec)),
                    );
                }
    }
    return extent > 0 ? extent * 2.2 : 200;
}

NodeActions.register((node, context) => {
    if (!(node instanceof ReferencePlaneNode)) return [];
    const doc = node.document;
    const view = () => context?.view ?? doc.application.activeView;
    const select = () => doc.selection.setSelectedNodes([node], false);
    const change = (name: string, run: () => void) => Transaction.execute(doc, name, run);
    const actions: NodeMenuAction[] = [
        {
            id: "rename",
            label: "Rename",
            run: () => {
                const field = document.createElement("input");
                field.value = node.name;
                field.setAttribute("aria-label", "Plane name");
                PubSub.default.pub("showDialog", "body.referencePlane", field, () => {
                    if (field.value.trim())
                        change("Rename plane", () => {
                            node.name = field.value.trim();
                        });
                });
            },
        },
        {
            id: "sketch",
            label: "New sketch…",
            icon: "sketch",
            separatorBefore: true,
            run: () => {
                select();
                PubSub.default.pub("executeCommand", "sketch.create");
            },
        },
        {
            id: "offsetPlane",
            label: "Offset plane…",
            icon: "plane",
            run: () => {
                select();
                PubSub.default.pub("executeCommand", "plane.create");
            },
        },
        {
            id: "sizePlane",
            label: "Size to Part Studio",
            run: () =>
                change("Size plane to Part Studio", () => {
                    node.size = sizePlaneToPartStudio(node);
                }),
        },
        {
            id: "hide",
            label: node.visible ? "Hide" : "Show",
            icon: node.visible ? "hide" : "show",
            separatorBefore: true,
            run: () =>
                change("Toggle plane visibility", () => {
                    node.visible = !node.visible;
                }),
        },
        {
            id: "hideOtherPlanes",
            label: "Hide other planes",
            run: () =>
                change("Hide other planes", () => {
                    for (const other of doc.modelManager.findNodes())
                        if (other instanceof ReferencePlaneNode && other !== node) other.visible = false;
                }),
        },
        {
            id: "hideAllPlanes",
            label: "Hide all planes",
            run: () =>
                change("Hide all planes", () => {
                    for (const other of doc.modelManager.findNodes())
                        if (other instanceof ReferencePlaneNode) other.visible = false;
                }),
        },
        {
            id: "section",
            label: "Section view…",
            icon: "section",
            separatorBefore: true,
            run: () => view()?.showSectionView?.(node.plane),
        },
        {
            id: "comment",
            label: "Add comment",
            icon: "comments",
            separatorBefore: true,
            run: () =>
                PubSub.default.pub("openReviewComments", {
                    documentId: doc.id,
                    nodeId: node.id,
                    name: node.name,
                }),
        },
        {
            id: "zoom",
            label: "Zoom to selection",
            separatorBefore: true,
            run: () => {
                select();
                view()?.cameraController.fitContent();
                view()?.update();
            },
        },
        {
            id: "normal",
            label: "View normal to",
            run: () => {
                const v = view();
                if (!v) return;
                const p = node.plane,
                    cc = v.cameraController;
                const distance = Math.max(1, cc.cameraPosition.distanceTo(cc.cameraTarget));
                cc.lookAt(p.origin.add(p.normal.multiply(distance)), p.origin, p.yvec);
                v.update();
            },
        },
        {
            id: "dependencies",
            label: "Show dependencies…",
            separatorBefore: true,
            run: () =>
                PubSub.default.pub("openWhereUsed", { documentId: doc.id, nodeId: node.id, name: node.name }),
        },
    ];
    return actions.map((action, index) => ({ ...action, order: index * 10 }));
});
