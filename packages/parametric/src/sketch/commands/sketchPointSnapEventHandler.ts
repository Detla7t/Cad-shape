// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    type IDocument,
    type IView,
    MeshDataUtils,
    type MessageType,
    PointSnapEventHandler,
    type ShapeType,
    type SnapResult,
} from "@chili3d/core";
import { type DragSnap, sketchSnapOptions, snapConstraintKind, snapPosition } from "../autoConstraints";
import { applyConstraintIcon, badgeSymbol } from "../editor/sketchAnnotations";
import style from "../editor/sketchAnnotations.module.css";
import { SketchEditor } from "../editor/sketchEditor";
import { type ConstraintKind, toUV, toWorld } from "../sketchModel";
import type { SketchPointSnapData } from "./sketchPointStep";

export interface SketchPointSnapResult extends SnapResult {
    sketchSnap?: DragSnap;
    suppressInference?: boolean;
    /** The pick was completed by releasing a press-and-drag rather than by a click. */
    dragged?: boolean;
}

/** Pointer travel (CSS px) with the button held before a release counts as a drag-to-draw. */
const DRAG_DRAW_THRESHOLD_PX = 4;

/**
 * Point-snap handler for sketch drawing: snaps the cursor onto sketch targets
 * (origin, existing points, lines, axes, circles, arcs) before the core object
 * snap, and shows the constraint icon it would add as the float tip instead of a
 * text prompt. When the entity the probe would complete is about to come out
 * tangent, the hint shows that instead — the tangency is the constraint that
 * shapes the entity, the incidence it rides on is already implied by the snap.
 */
export class SketchPointSnapEventHandler extends PointSnapEventHandler {
    private sketchSnap?: DragSnap;
    /** Tangency the probe's entity would get: shown in place of the snap's own icon. */
    private sketchTangentKind?: ConstraintKind;
    private guide?: number;
    /**
     * Where the pointer first moved with the left button still held — the press
     * that completed the previous step. Releasing past the threshold completes
     * this step too, so a line, circle or rectangle can be drawn in one gesture.
     */
    private heldFrom?: [number, number];
    private heldMoved = false;

    constructor(
        document: IDocument,
        controller: AsyncController,
        private readonly sketchData: SketchPointSnapData,
    ) {
        super(document, controller, sketchData);
    }

    protected override findSnapPoint(shapeType: ShapeType, view: IView, event: PointerEvent): void {
        const editor = SketchEditor.getActive();
        this.clearGuide();
        editor?.showDrawingSnap();
        this.sketchSnap = undefined;
        const hit = editor?.node.plane.intersectRay(view.rayAt(event.offsetX, event.offsetY));
        if (editor === undefined || hit === undefined) {
            this.sketchTangentKind = undefined;
            this.fallbackToCoreSnap(shapeType, view, event);
            return;
        }

        const probe = toUV(editor.node.plane, hit);
        const tolerance = editor.screenTolerance();
        const { position, snap, tangentKind, alignmentKind } = snapPosition(
            editor.solver,
            probe,
            sketchSnapOptions(tolerance, event.shiftKey),
            (snapped) => this.sketchData.tentative?.(snapped),
        );
        const point = toWorld(editor.node.plane, position[0], position[1]);
        // honour the step's validator (e.g. a circle radius point must not land on its center)
        if (
            (this.data.validator !== undefined && !this.data.validator(point)) ||
            (this.sketchData.acceptSnap !== undefined && !this.sketchData.acceptSnap(snap))
        ) {
            this.sketchTangentKind = undefined;
            this._snaped = undefined;
            return;
        }

        this.sketchSnap = snap;
        this.sketchTangentKind = tangentKind ?? alignmentKind;
        const result: SketchPointSnapResult = {
            view,
            point,
            info: "",
            shapes: [],
            type: "feature",
            sketchSnap: snap,
            suppressInference: event.shiftKey,
        };
        this._snaped = result;
        editor.showDrawingSnap(snap);
        this.clearGuide();
        const tentative = this.sketchData.tentative?.(position);
        if (alignmentKind && tentative?.type === "line") {
            this.guide = this.document.visual.context.displayMesh(
                [
                    MeshDataUtils.createEdgeMesh(
                        toWorld(editor.node.plane, tentative.params[0], tentative.params[1]),
                        point,
                        0xff9800,
                        "dash",
                    ),
                ],
                { onTop: true },
            );
        }
    }

    override pointerMove(view: IView, event: PointerEvent): void {
        if (event.pointerType === "mouse" && (event.buttons & 1) === 1) {
            this.heldFrom ??= [event.offsetX, event.offsetY];
            if (
                Math.hypot(event.offsetX - this.heldFrom[0], event.offsetY - this.heldFrom[1]) >=
                DRAG_DRAW_THRESHOLD_PX
            )
                this.heldMoved = true;
        }
        super.pointerMove(view, event);
    }

    override pointerDown(view: IView, event: PointerEvent): void {
        // A click can arrive without a preceding move (touch, or a newly activated tool).
        this.findSnapPoint(0 as ShapeType, view, event);
        super.pointerDown(view, event);
    }

    override pointerUp(view: IView, event: PointerEvent): void {
        if (event.pointerType === "mouse" && event.button === 0) {
            const dragged = this.heldMoved;
            this.heldFrom = undefined;
            this.heldMoved = false;
            if (dragged && this.state !== "completed" && this.state !== "cancelled") {
                this.findSnapPoint(0 as ShapeType, view, event);
                const snaped = this._snaped as SketchPointSnapResult | undefined;
                if (snaped !== undefined) {
                    snaped.dragged = true;
                    this.controller.success();
                }
            }
            return;
        }
        super.pointerUp(view, event);
    }

    override dispose(): void {
        SketchEditor.getActive()?.showDrawingSnap();
        this.clearGuide();
        super.dispose();
    }

    private clearGuide() {
        if (this.guide !== undefined) this.document.visual.context.removeMesh(this.guide);
        this.guide = undefined;
    }

    private fallbackToCoreSnap(shapeType: ShapeType, view: IView, event: PointerEvent): void {
        this.sketchSnap = undefined;
        super.findSnapPoint(shapeType, view, event);
    }

    protected override formatSnapPrompt(
        snaped: SnapResult,
    ): HTMLElement | { level: MessageType; msg: string } | undefined {
        const icon = this.sketchSnapIcon();
        return icon ?? super.formatSnapPrompt(snaped);
    }

    private sketchSnapIcon(): HTMLElement | undefined {
        const snap = this.sketchSnap;
        const kind = this.sketchTangentKind ?? (snap === undefined ? undefined : snapConstraintKind(snap));
        if (kind === undefined) return undefined;
        const symbol = badgeSymbol(kind);
        if (symbol === undefined) return undefined;

        const element = document.createElement("div");
        element.className = style.badge;
        applyConstraintIcon(element, symbol);
        return element;
    }
}
