// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    type I18nKeys,
    type IEdge,
    type IFace,
    type INodeVisual,
    type IVertex,
    type ShapeType,
    ShapeTypes,
    type VisualShapeData,
    VisualStates,
} from "@chili3d/core";
import { matchEdgeIndexes } from "../features/edgeMatcher";
import { captureEdgeRef, type EdgeRef } from "../features/edgeRef";
import type { FeatureScriptFaceRef, FeatureScriptQueryValue } from "../features/feature";
import { captureFeatureScriptFaceRef } from "../featurescript/featureScriptFeature";
import { type ReselectHost, runReselectSession } from "./reselectSession";

export type PickKind = "edge" | "face" | "vertex";

type PickedRef =
    | { readonly kind: "edge"; readonly ref: EdgeRef }
    | { readonly kind: "face"; readonly ref: FeatureScriptFaceRef }
    | { readonly kind: "vertex"; readonly ref: { point: { x: number; y: number; z: number } } };

const SHAPE_TYPES: Record<PickKind, ShapeType> = {
    edge: ShapeTypes.edge,
    face: ShapeTypes.face,
    vertex: ShapeTypes.vertex,
};

const PROMPTS: Record<PickKind, I18nKeys> = {
    edge: "prompt.select.edges",
    face: "prompt.select.faces",
    vertex: "prompt.select.entities",
};

/**
 * Picks the entities of one FeatureScript `Query` parameter on the host body.
 *
 * Same footing as the fillet edge re-pick (`EdgeReselectSession`): the body is rolled
 * back to just before the feature for the session, because the picks address the
 * feature's INPUT — the geometry the custom feature receives — not its output. Refs are
 * captured with the body's tracked ids while the rolled-back cache still describes that
 * input. Confirming with nothing picked clears the parameter.
 */
export class FeatureScriptPickSession {
    constructor(private readonly host: ReselectHost) {}

    async pick(
        current: FeatureScriptQueryValue | undefined,
        featureIndex: number,
        kinds: readonly PickKind[],
        controller: AsyncController,
    ): Promise<FeatureScriptQueryValue | undefined> {
        const wanted = kinds.length === 0 ? (["edge", "face"] as PickKind[]) : kinds;
        const shapeType = wanted.reduce<number>((mask, kind) => mask | SHAPE_TYPES[kind], 0) as ShapeType;
        const owner = this.host.document.visual.context.getVisual(this.host);
        const bodyShape = this.host.shape;
        const ownerShapeType = bodyShape.isOk ? bodyShape.value.shapeType : undefined;
        const transparent = wanted.includes("edge") || wanted.includes("vertex");
        const previousRollback = this.host.rollbackIndex;

        const picked = await runReselectSession<PickedRef>(this.host, controller, {
            prompt: wanted.length === 1 ? PROMPTS[wanted[0]] : "prompt.select.entities",
            shapeType,
            targetNode: this.host,
            emptyIsCancel: false,
            preview: () => {},
            setup: () => {
                if (!this.host.setRollbackIndex(featureIndex))
                    throw new Error("Cannot select entities because the feature input failed to rebuild.");
                if (transparent && owner !== undefined && ownerShapeType !== undefined) {
                    this.host.document.visual.highlighter.addState(
                        owner,
                        VisualStates.faceTransparent,
                        ownerShapeType,
                    );
                }
            },
            preselect: () => this.preselect(current),
            capture: (shapes) => shapes.flatMap((shape) => this.capture(shape)),
            teardown: () => {
                if (transparent && owner !== undefined && ownerShapeType !== undefined) {
                    this.host.document.visual.highlighter.removeState(
                        owner,
                        VisualStates.faceTransparent,
                        ownerShapeType,
                    );
                }
                this.host.setRollbackIndex(previousRollback);
            },
        });
        if (picked === undefined) return undefined;
        const value: {
            edges?: EdgeRef[];
            faces?: FeatureScriptFaceRef[];
            vertices?: { point: { x: number; y: number; z: number } }[];
        } = {};
        const edges = picked.flatMap((entry) => (entry.kind === "edge" ? [entry.ref] : []));
        const faces = picked.flatMap((entry) => (entry.kind === "face" ? [entry.ref] : []));
        const vertices = picked.flatMap((entry) => (entry.kind === "vertex" ? [entry.ref] : []));
        if (edges.length > 0) value.edges = edges;
        if (faces.length > 0) value.faces = faces;
        if (vertices.length > 0) value.vertices = vertices;
        return value;
    }

    private capture(picked: VisualShapeData): PickedRef[] {
        const index = picked.indexes[0];
        switch (picked.shape.shapeType) {
            case ShapeTypes.edge: {
                const id = this.host.edgeIdAt(index);
                return [
                    {
                        kind: "edge",
                        ref: captureEdgeRef(
                            picked.shape as unknown as IEdge,
                            id,
                            this.host.edgeIdIsShared(id),
                        ),
                    },
                ];
            }
            case ShapeTypes.face:
                return [
                    {
                        kind: "face",
                        ref: captureFeatureScriptFaceRef(
                            picked.shape as unknown as IFace,
                            this.host.faceIdAt(index),
                        ),
                    },
                ];
            case ShapeTypes.vertex: {
                const point = (picked.shape as unknown as IVertex).point();
                return [{ kind: "vertex", ref: { point: { x: point.x, y: point.y, z: point.z } } }];
            }
            default:
                return [];
        }
    }

    /** Selects the edges the parameter currently names so the pick starts from them. */
    private preselect(current: FeatureScriptQueryValue | undefined): void {
        const edges = current?.edges ?? [];
        if (edges.length === 0) return;
        const shape = this.host.shape;
        if (!shape.isOk) return;
        const indexes = matchEdgeIndexes(shape.value, edges);
        if (!indexes.isOk) return;
        const ranges = shape.value.mesh.edges?.range;
        const owner = this.host.document.visual.context.getVisual(this.host) as INodeVisual | undefined;
        if (ranges === undefined || owner === undefined) return;
        const picked: VisualShapeData[] = indexes.value.map((index) => ({
            owner,
            shape: ranges[index].shape,
            transform: owner.worldTransform(),
            indexes: [index],
        }));
        this.host.document.selection.setSelectedShapes(picked, VisualStates.edgeSelected, false);
    }
}
