// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    command,
    type IApplication,
    type ICommand,
    type IDocument,
    type IFace,
    Plane,
    PubSub,
    ReferencePlaneNode,
    ShapeTypes,
    Transaction,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import { SketchEditor } from "../editor/sketchEditor";
import panelStyle from "../editor/sketchPanel.module.css";
import { emptySketchData, type SketchData } from "../sketchModel";
import { SketchNode } from "../sketchNode";
import { type PickedPlane, resolvePlane } from "./pickedPlane";
import { PlanePickHandler } from "./planePickHandler";

export { captureBoundaryExternalRefs } from "./pickedPlane";

async function pickPlane(document: IDocument, controller: AsyncController): Promise<PickedPlane | undefined> {
    const face = document.selection
        .getSelectedShapes()
        .find(
            (data) => data.shape.shapeType === ShapeTypes.face && (data.shape as IFace).surface().isPlanar(),
        );
    if (face) {
        const picked = resolvePlane(document, { kind: "face", data: face });
        controller.dispose();
        document.selection.clearSelection();
        return picked;
    }
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
    async execute(_application: IApplication): Promise<void> {
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
