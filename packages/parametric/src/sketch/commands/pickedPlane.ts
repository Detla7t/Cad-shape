// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument, IEdge, IFace, INode, Plane } from "@chili3d/core";
import { ShapeTypes } from "@chili3d/core";
import { reportSilentIdLoss } from "../../features/idDiagnostics";
import { ParametricBodyNode } from "../../parametricBodyNode";
import { captureExternalRef } from "../externalRef";
import { captureFaceRef, type PlaneFaceRef, sketchPlaneOfFace } from "../planeRef";
import { type ExternalRefData, FIRST_EXTERNAL_ENTITY_ID } from "../sketchModel";
import type { PlanePickResult } from "./planePickHandler";

/**
 * What a sketch plane pick resolves to — shared by the New sketch command and the sketch
 * panel's plane box, so a reference plane, a datum or a solid's face is read the same way
 * whether the sketch is being created or moved.
 */
export interface PickedPlane {
    plane: Plane;
    /** Set when the plane comes from a solid's face, so the sketch follows that face. */
    planeRef?: PlaneFaceRef;
    /** Boundary edges of the picked face, captured as reference-role external refs. */
    externalRefs?: ExternalRefData[];
    /** Timeline anchor of the picked body (its feature count now), for session rollback. */
    refPositions?: Record<string, number>;
}

/** The source body's edges, matched against a picked face's boundary to recover tracked ids. */
function sourceBodyEdges(owner: INode): IEdge[] {
    return owner instanceof ParametricBodyNode && owner.shape.isOk
        ? (owner.shape.unchecked()!.findSubShapes(ShapeTypes.edge) as IEdge[])
        : [];
}

/**
 * The source body's tracked id for one boundary edge of a picked face, reporting the
 * loss when the body carries ids but has none for this edge.
 */
function trackedIdOfFaceEdge(owner: INode, ownerEdges: IEdge[], localEdge: IEdge): string | undefined {
    if (!(owner instanceof ParametricBodyNode)) return undefined;
    // isSame, not isEqual: wire exploration may decorate the edge with a
    // reversed orientation, which IsEqual rejects — boolean-born faces
    // (a groove's floor) would otherwise lose their tracked ids here.
    const index = ownerEdges.findIndex((edge) => edge.isSame(localEdge));
    const edgeId = index < 0 ? undefined : owner.edgeIdAt(index);
    if (edgeId === undefined) {
        reportSilentIdLoss(
            owner,
            "edge",
            index < 0
                ? "a boundary edge of the picked face was not found on the source body"
                : "a boundary edge of the picked face has no tracked id",
        );
    }
    return edgeId;
}

/**
 * The picked face's boundary edges as reference-role external refs (profile would
 * surprise-extrude the whole face boundary). Edges whose curve is not a line or a
 * circle are skipped silently. `localFace` is in the owner's coordinates; the world
 * transform projects them onto the new sketch plane.
 */
export function captureBoundaryExternalRefs(
    owner: INode,
    result: PlanePickResult & { kind: "face" },
    plane: Plane,
): ExternalRefData[] | undefined {
    const localFace = result.data.shape as IFace;
    const localEdges = localFace.findSubShapes(ShapeTypes.edge) as IEdge[];
    const ownerEdges = sourceBodyEdges(owner);
    const refs: ExternalRefData[] = [];
    let nextId = FIRST_EXTERNAL_ENTITY_ID;
    for (const localEdge of localEdges) {
        const worldEdge = localEdge.transformedMul(result.data.transform) as IEdge;
        try {
            const edgeId = trackedIdOfFaceEdge(owner, ownerEdges, localEdge);
            const ref = captureExternalRef(nextId, owner.id, plane, worldEdge, edgeId, "reference");
            if (ref === undefined) continue;
            refs.push(ref);
            nextId--;
        } finally {
            worldEdge.dispose();
        }
    }
    return refs.length === 0 ? undefined : refs;
}

export function resolvePlane(
    document: IDocument,
    result: PlanePickResult | undefined,
): PickedPlane | undefined {
    if (result === undefined) return undefined;
    if (result.kind === "datum") return { plane: result.plane };
    if (result.kind === "reference") {
        const plane = result.node.plane;
        return {
            plane,
            planeRef: {
                kind: "plane",
                nodeId: result.node.id,
                normal: plane.normal,
                offset: plane.normal.dot(plane.origin),
            },
        };
    }

    const face = result.data.shape.transformedMul(result.data.transform) as IFace;
    const plane = sketchPlaneOfFace(face);
    const owner = document.visual.context.getNode(result.data.owner);
    const picked = owner === undefined ? undefined : capturePlaneOwner(owner, result, face, plane);
    face.dispose();
    return { plane, ...picked };
}

/** The plane ref, boundary refs and timeline anchor captured for a face picked on `owner`. */
function capturePlaneOwner(
    owner: INode,
    result: Extract<PlanePickResult, { kind: "face" }>,
    face: IFace,
    plane: Plane,
): Omit<PickedPlane, "plane"> {
    const planeRef = captureFaceRef(owner.id, face);
    let refPositions: Record<string, number> | undefined;
    // Faces of a parametric body carry a stable id across rebuilds — store it so
    // the sketch tracks the face exactly instead of re-matching geometrically.
    if (owner instanceof ParametricBodyNode) {
        const faceId = owner.faceIdAt(result.data.indexes[0]);
        if (faceId !== undefined) {
            planeRef.faceId = faceId;
        } else {
            reportSilentIdLoss(owner, "face", "the sketch-plane face has no tracked id");
        }
        // anchor the sketch's timeline position: the features that exist now are
        // the state the sketch was created against (see computeSketchRollback).
        // On a rollback preview (a fillet/chamfer reselect pick) that state IS the
        // preview — `features.length` would read as "no rollback" to
        // seedRollbackIndices and resolve the boundary refs against later geometry
        // the user never saw (same correction as sketch.projectEdges).
        refPositions = { [owner.id]: owner.rollbackIndex ?? owner.features.length };
    }
    return {
        planeRef,
        externalRefs: captureBoundaryExternalRefs(owner, result, plane),
        refPositions,
    };
}
