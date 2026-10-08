// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    CurveUtils,
    type IEdge,
    type ILine,
    isHistoryHidden,
    ShapeNode,
    ShapeTypes,
    Transaction,
} from "@chili3d/core";
import { captureEdgeRef } from "../features/edgeRef";
import { findSketch } from "../features/extrude";
import type { BooleanFeatureData, RevolveFeatureData } from "../features/feature";
import type { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";
import { ProfileReselectSession } from "./reselectSession";

export async function pickFeatureSources(
    host: ParametricBodyNode,
    feature: BooleanFeatureData | RevolveFeatureData,
    controller: AsyncController,
    key?: string,
): Promise<void> {
    const model = host.document,
        previous = host.rollbackIndex;
    const shown: ShapeNode[] = [];
    try {
        if (feature.type === "revolve" && key !== "axis") {
            const sketch = findSketch(model, feature.sketchId);
            if (!sketch) return;
            const profiles = await new ProfileReselectSession(host).pick(feature, sketch, controller);
            if (profiles)
                Transaction.execute(model, "Reselect revolve profiles", () => {
                    host.setFeaturesEmitShapeChanged(
                        host.features.map((f) =>
                            f.id === feature.id
                                ? { ...feature, profiles: profiles.length ? profiles : undefined }
                                : f,
                        ),
                    );
                });
            return;
        }
        if (!host.setRollbackIndex(host.features.findIndex((f) => f.id === feature.id)))
            throw new Error("The feature input could not be rebuilt.");
        for (const node of model.modelManager.findNodes()) {
            if (!(node instanceof ShapeNode) || isHistoryHidden(node)) continue;
            if (
                (feature.type === "boolean" && feature.toolIds.includes(node.id)) ||
                (feature.type === "revolve" && node instanceof SketchNode)
            ) {
                model.visual.context.setVisible(node, true);
                shown.push(node);
            }
        }
        model.selection.clearSelection();
        if (feature.type === "boolean") {
            model.selection.setSelectedNodes(shown, false);
            const nodes = await model.picker.pickNode("prompt.select.models", controller, {
                multi: true,
                nodeFilter: {
                    allow: (node) => node instanceof ShapeNode && node !== host && !isHistoryHidden(node),
                },
            });
            if (controller.result?.status === "cancel" || !nodes.length) return;
            Transaction.execute(model, "Reselect boolean tools", () =>
                host.setFeaturesEmitShapeChanged(
                    host.features.map((f) =>
                        f.id === feature.id ? { ...feature, toolIds: nodes.map((n) => n.id) } : f,
                    ),
                ),
            );
        } else {
            const shapes = await model.picker.pickShape("prompt.select.axis", controller, {
                shapeType: ShapeTypes.edge,
                shapeFilter: { allow: (shape) => CurveUtils.isLine((shape as IEdge).curve.basisCurve) },
                multi: false,
                nodeFilter: { allow: (node) => !isHistoryHidden(node) },
            });
            if (controller.result?.status === "cancel" || !shapes.length) return;
            const pick = shapes[0],
                curve = (pick.shape as IEdge).curve.basisCurve as ILine;
            const axis = {
                point: pick.transform.ofPoint(curve.value(0)),
                direction: pick.transform.ofVector(curve.direction),
            };
            const axisSource = { nodeId: pick.owner.node.id, edge: captureEdgeRef(pick.shape as IEdge) };
            Transaction.execute(model, "Reselect revolve axis", () =>
                host.setFeaturesEmitShapeChanged(
                    host.features.map((f) => (f.id === feature.id ? { ...feature, axis, axisSource } : f)),
                ),
            );
        }
    } finally {
        host.setRollbackIndex(previous);
        for (const node of shown)
            model.visual.context.setVisible(
                node,
                node.visible && node.parentVisible && !isHistoryHidden(node),
            );
        model.selection.clearSelection();
        model.visual.update();
    }
}
