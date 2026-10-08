// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type AsyncController, type IFace, type INodeVisual, ShapeTypes, VisualStates } from "@chili3d/core";
import type { ExtrudeFeatureData } from "../features/feature";
import { matchProfileIndexes } from "../features/profileMatcher";
import { captureProfileRef, type ProfileRef } from "../features/profileRef";
import type { ParametricBodyNode } from "../parametricBodyNode";
import { runReselectSession } from "./reselectSession";

/** Press-pull extrudes store world-space faces on the input body, with tracked identities. */
export async function reselectBodyFaces(
    host: ParametricBodyNode,
    source: ParametricBodyNode,
    feature: ExtrudeFeatureData,
    featureIndex: number,
    controller: AsyncController,
): Promise<ProfileRef[] | undefined> {
    const previous = host.rollbackIndex;
    return runReselectSession(host, controller, {
        prompt: "prompt.select.faces",
        shapeFilter: { allow: (shape) => (shape as IFace).surface().isPlanar() },
        shapeType: ShapeTypes.face,
        targetNode: source,
        emptyIsCancel: true,
        preview: () => {},
        setup: () => {
            if (!host.setRollbackIndex(featureIndex))
                throw new Error("The extrude input could not be rebuilt.");
        },
        preselect: () => {
            const owner = host.document.visual.context.getVisual(source) as INodeVisual | undefined;
            const ranges = source.mesh.faces?.range;
            if (!owner || !ranges) return;
            const world = owner.worldTransform();
            const faces = ranges.map((range) => range.shape.transformedMul(world) as IFace);
            try {
                const matched = matchProfileIndexes(faces, feature.source?.profiles ?? []);
                if (matched.isOk)
                    host.document.selection.setSelectedShapes(
                        matched.value.map((index) => ({
                            owner,
                            shape: ranges[index].shape,
                            transform: world,
                            indexes: [index],
                        })),
                        VisualStates.faceSelected,
                        false,
                    );
            } finally {
                for (const face of faces) face.dispose();
            }
        },
        capture: (picked) =>
            picked.map((pick) => {
                const face = pick.shape.transformedMul(pick.transform) as IFace;
                try {
                    const id = source.faceIdAt(pick.indexes[0]);
                    return captureProfileRef(face, id, source.faceIdIsShared(id), true);
                } finally {
                    face.dispose();
                }
            }),
        teardown: () => {
            host.setRollbackIndex(previous);
        },
    });
}
