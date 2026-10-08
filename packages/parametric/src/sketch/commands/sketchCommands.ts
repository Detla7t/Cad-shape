// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    command,
    type IApplication,
    type ICommand,
    type IDocument,
    type IEdge,
    type IFace,
    type INode,
    Plane,
    PubSub,
    ReferencePlaneNode,
    ShapeTypes,
    Transaction,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import { reportSilentIdLoss } from "../../features/idDiagnostics";
import { ParametricBodyNode } from "../../parametricBodyNode";
import { SketchEditor } from "../editor/sketchEditor";
import panelStyle from "../editor/sketchPanel.module.css";
import { captureExternalRef } from "../externalRef";
import { captureFaceRef, type PlaneFaceRef, sketchPlaneOfFace } from "../planeRef";
import {
    type ExternalRefData,
    emptySketchData,
    FIRST_EXTERNAL_ENTITY_ID,
    type SketchData,
} from "../sketchModel";
import { SketchNode } from "../sketchNode";
import { PlanePickHandler, type PlanePickResult } from "./planePickHandler";

interface PickedPlane {
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

function resolvePlane(document: IDocument, result: PlanePickResult | undefined): PickedPlane | undefined {
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

async function pickPlane(document: IDocument, controller: AsyncController): Promise<PickedPlane | undefined> {
    const selected = document.selection.getSelectedNodes().find((n) => n instanceof ReferencePlaneNode);
    if (selected instanceof ReferencePlaneNode) {
        controller.dispose();
        document.selection.clearSelection();
        return resolvePlane(document, { kind: "reference", node: selected });
    }
    document.selection.clearSelection();
    const handler = new PlanePickHandler(document, controller);
    const view = document.application.activeView;
    const panel = globalThis.document.createElement("section");
    panel.className = panelStyle.panel;
    panel.setAttribute("aria-label", "Choose sketch plane");
    const header = globalThis.document.createElement("header");
    const title = globalThis.document.createElement("strong");
    title.textContent = "New sketch";
    const cancel = globalThis.document.createElement("button");
    cancel.className = panelStyle.cancel;
    cancel.setAttribute("aria-label", "Cancel new sketch");
    cancel.append(createCadIcon("close"));
    cancel.onclick = () => controller.cancel();
    header.append(title, cancel);
    const hint = globalThis.document.createElement("div");
    hint.textContent = "Select a plane or planar face";
    hint.className = panelStyle.plane;
    panel.append(header, hint);
    const storedPlanes = document.modelManager.findNodes().filter((n) => n instanceof ReferencePlaneNode);
    for (const [name, plane] of storedPlanes.length
        ? []
        : ([
              ["Top (XY)", Plane.XY],
              ["Front (XZ)", Plane.ZX],
              ["Right (YZ)", Plane.YZ],
          ] as const)) {
        const choice = globalThis.document.createElement("button");
        choice.textContent = name;
        choice.onclick = () => {
            handler.result = { kind: "datum", plane };
            controller.success();
        };
        panel.append(choice);
    }
    for (const node of document.modelManager.findNodes().filter((n) => n instanceof ReferencePlaneNode)) {
        const choice = globalThis.document.createElement("button");
        choice.textContent = node.name;
        choice.dataset["planeId"] = node.id;
        choice.onclick = () => {
            handler.result = { kind: "reference", node };
            controller.success();
        };
        panel.append(choice);
    }
    panel.addEventListener("pointerdown", (event) => event.stopPropagation());
    panel.addEventListener("pointermove", (event) => event.stopPropagation());
    view?.dom?.append(panel);
    try {
        await document.picker.pickAsync(handler, "prompt.select.plane", controller, false, "select.default");
        return resolvePlane(document, handler.result);
    } finally {
        panel.remove();
        controller.dispose();
        handler.dispose();
        document.selection.clearSelection();
    }
}

function sketchDataFromPick(picked: PickedPlane): SketchData | undefined {
    if (picked.externalRefs === undefined && picked.refPositions === undefined) return undefined;
    return {
        ...emptySketchData(),
        externalRefs: picked.externalRefs,
        refPositions: picked.refPositions,
        // captureBoundaryExternalRefs numbered the refs from
        // FIRST_EXTERNAL_ENTITY_ID down before the solver existed —
        // persist the counter so the no-reuse invariant is explicit
        // instead of relying on the load-time Math.min recovery
        // (undefined drops out of the serialized JSON). The next counter
        // derives from the actual refs; it is never read on an empty list
        // (captureBoundaryExternalRefs returns undefined for one), so the
        // Math.min spread cannot see an empty array.
        externalIdSeq:
            picked.externalRefs === undefined
                ? undefined
                : Math.min(...picked.externalRefs.map((ref) => ref.entityId)) - 1,
    };
}

@command({ key: "sketch.create", icon: "icon-sketchNew" })
export class CreateSketch extends CancelableCommand {
    async executeAsync(): Promise<void> {
        SketchEditor.exit();

        const document = this.application.activeView?.document;
        if (document === undefined) {
            PubSub.default.pub("displayError", "No active view");
            return;
        }
        this.controller = new AsyncController();
        const picked = await pickPlane(document, this.controller);
        if (picked === undefined) return;
        const node = new SketchNode({
            document,
            plane: picked.plane,
            planeRef: picked.planeRef,
            data: sketchDataFromPick(picked),
        });
        Transaction.execute(document, "create sketch", () => {
            document.modelManager.addNode(node);
        });
        SketchEditor.enter(node, { newSketch: true });
    }
}

@command({ key: "sketch.enter", icon: "icon-sketchEdit" })
export class EnterSketch extends CancelableCommand {
    async executeAsync(): Promise<void> {
        SketchEditor.exit();

        const document = this.application.activeView?.document;
        if (document === undefined) {
            PubSub.default.pub("displayError", "No active view");
            return;
        }
        this.controller = new AsyncController();
        const node = await pickSketch(document, this.controller);
        if (node !== undefined) SketchEditor.enter(node);
    }
}

/** The selected sketch, or an interactive pick when nothing suitable is selected. */
async function pickSketch(document: IDocument, controller: AsyncController): Promise<SketchNode | undefined> {
    const selected = document.selection.getSelectedNodes().find((n) => n instanceof SketchNode);
    if (selected !== undefined) return selected as SketchNode;

    const picked = await document.picker.pickNode("prompt.select.sketch", controller, {
        nodeFilter: { allow: (node) => node instanceof SketchNode },
    });
    controller.dispose();
    document.selection.clearSelection();
    return picked[0] as SketchNode | undefined;
}

@command({ key: "sketch.exit", icon: "icon-back" })
export class ExitSketch implements ICommand {
    async execute(application: IApplication): Promise<void> {
        SketchEditor.exit();
    }
}

@command({ key: "sketch.cancel", icon: "icon-times" })
export class CancelSketch implements ICommand {
    async execute(): Promise<void> {
        SketchEditor.getActive()?.cancel();
    }
}

@command({ key: "sketch.construction", icon: "icon-line" })
export class ConstructionSketch implements ICommand {
    async execute(): Promise<void> {
        SketchEditor.getActive()?.toggleConstruction();
    }
}

@command({ key: "sketch.normal", icon: "icon-sketchNew" })
export class NormalToSketch implements ICommand {
    async execute(): Promise<void> {
        SketchEditor.getActive()?.normalView();
    }
}
