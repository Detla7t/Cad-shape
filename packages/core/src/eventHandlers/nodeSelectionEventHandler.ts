// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { AsyncController, IHistoryRecord } from "../foundation";
import { Transaction } from "../foundation/transaction";
import type { XYZ } from "../math";
import type { INode } from "../model/node";
import type { INodeFilter } from "../selectionFilter";
import { type IVertex, ShapeTypes } from "../shape";
import { selectsSubShapes } from "../subShapeSelection";
import { type IView, type IVisualObject, type VisualShapeData, VisualStates } from "../visual";
import { SelectionHandler } from "./selectionEventHandler";

export class NodeSelectionHandler extends SelectionHandler {
    private _highlights: IVisualObject[] | undefined;
    private _detectAtMouse: IVisualObject[] | undefined;
    private _lockDetected: IVisualObject | undefined; // 用于切换捕获的对象
    /** The curve or point under the cursor of a node that selects its parts (a sketch), highlighted on its own. */
    private _subShape: VisualShapeData | undefined;
    protected highlighState = VisualStates.edgeHighlight;

    constructor(
        document: IDocument,
        multiMode: boolean,
        controller?: AsyncController,
        readonly filter?: INodeFilter,
    ) {
        super(document, multiMode, controller);
    }

    protected override select(view: IView, event: PointerEvent): number {
        if (!this._highlights?.length) {
            this.clearIntoVoid();
            return 0;
        }
        const click = Math.hypot(this.mouse.x - event.offsetX, this.mouse.y - event.offsetY) <= 3;
        // A click on a sketch's curve or point selects that part (Onshape), not the sketch —
        // and the parts gather: every click toggles one in or out, so two points or two
        // curves are picked without a modifier, until a click into the void clears them.
        if (click && this._subShape !== undefined) {
            const pick = this._subShape;
            const selection = this.document.selection;
            if (selection.getSelectedShapes().length === 0) selection.clearSelection();
            return selection.setSelectedShapes([pick], VisualStates.edgeSelected, true);
        }
        const models = this._highlights
            .map((x) => view.document.visual.context.getNode(x))
            .filter((x) => x !== undefined);

        const alreadySelected =
            click && models.length === 1 && this.document.selection.getSelectedNodes().includes(models[0]);
        return this.document.selection.setSelectedNodes(models, alreadySelected || this.toggleSelect(event));
    }

    protected toggleSelect(event: PointerEvent) {
        return event.shiftKey;
    }

    /**
     * A click on nothing clears the selection. Picked parts (a sketch's points and curves)
     * took clicks to gather, so their clearing is an undo step: Ctrl+Z brings them back.
     */
    private clearIntoVoid(): void {
        const selection = this.document.selection;
        const shapes = [...selection.getSelectedShapes()];
        this.clearSelected(this.document);
        if (shapes.length === 0) return;
        const document = this.document;
        const record: IHistoryRecord = {
            name: "selection.clear",
            undo: () => {
                document.selection.clearSelection();
                document.selection.setSelectedShapes(shapes, VisualStates.edgeSelected, false);
            },
            redo: () => document.selection.clearSelection(),
            dispose: () => {},
        };
        Transaction.add(document, record);
    }

    getDetecteds(view: IView, event: PointerEvent) {
        if (
            this.rect &&
            Math.abs(this.mouse.x - event.offsetX) > 3 &&
            Math.abs(this.mouse.y - event.offsetY) > 3
        ) {
            return view.detectVisualRect(
                this.mouse.x,
                this.mouse.y,
                event.offsetX,
                event.offsetY,
                this.filter,
            );
        }
        this._detectAtMouse = view.detectVisual(event.offsetX, event.offsetY, this.filter);
        const detected = this.getDetecting();
        return detected ? [detected] : [];
    }

    private getDetecting() {
        if (!this._detectAtMouse) return undefined;
        const index = this._lockDetected ? this.getDetcedtingIndex() : 0;
        return this._detectAtMouse[index] || undefined;
    }

    private getDetcedtingIndex() {
        if (!this._detectAtMouse) return -1;
        for (let i = 0; i < this._detectAtMouse.length; i++) {
            if (this._lockDetected === this._detectAtMouse[i]) {
                return i;
            }
        }
        return -1;
    }

    override pointerMove(view: IView, event: PointerEvent): void {
        super.pointerMove(view, event);
        this._lockDetected = undefined;
    }

    protected override setHighlight(view: IView, event: PointerEvent) {
        const detecteds = this.getDetecteds(view, event);
        this.highlightDetecteds(view, detecteds, event);
    }

    private highlightDetecteds(view: IView, detecteds: IVisualObject[], event?: PointerEvent) {
        if (detecteds.length === 0 && !this._highlights?.length) return;
        this.cleanHighlights();
        detecteds.forEach((x) => {
            const pick = event === undefined || this.rect ? undefined : this.subShapeAt(view, x, event);
            if (pick !== undefined) {
                // Only the curve under the cursor lights up, as the click will take it alone.
                this._subShape = pick;
                view.document.visual.highlighter.addState(
                    x,
                    this.highlighState,
                    pick.shape.shapeType,
                    ...pick.indexes,
                );
                return;
            }
            view.document.visual.highlighter.addState(x, this.highlighState, ShapeTypes.shape);
        });
        this._highlights = detecteds;
        view.update();
    }

    /** The part of a sub-shape-selecting node under the cursor, when the visual is such a node's. */
    private subShapeAt(view: IView, visual: IVisualObject, event: PointerEvent): VisualShapeData | undefined {
        const node = view.document.visual.context.getNode(visual);
        if (!selectsSubShapes(node) || typeof view.detectShapes !== "function") return undefined;
        const picks = view.detectShapes(
            node.selectsSubShapes,
            event.offsetX,
            event.offsetY,
            undefined,
            this.filter,
        );
        const own = picks.filter((pick) => pick.owner === visual || (pick.owner.node as INode) === node);
        // A point is the smaller target: when the cursor is on one, it wins over the curve it ends.
        // The ray reports hits by depth, so among close points (or curves) the one nearest the
        // cursor is taken, not the first one within the tolerance.
        const vertices = own.filter((pick) => pick.shape.shapeType === ShapeTypes.vertex);
        return nearestToPointer(view, vertices.length > 0 ? vertices : own, event.offsetX, event.offsetY);
    }

    protected override cleanHighlights(): void {
        this._highlights?.forEach((x) => {
            const subShape = this._subShape;
            if (
                subShape !== undefined &&
                (subShape.owner === x ||
                    (subShape.owner.node as INode) === this.document.visual.context.getNode(x))
            ) {
                this.document.visual.highlighter.removeState(
                    x,
                    this.highlighState,
                    subShape.shape.shapeType,
                    ...subShape.indexes,
                );
                return;
            }
            this.document.visual.highlighter.removeState(x, this.highlighState, ShapeTypes.shape);
        });
        this._highlights = undefined;
        this._subShape = undefined;
    }

    protected override highlightNext(view: IView): void {
        if (this._detectAtMouse && this._detectAtMouse.length > 1) {
            const index = this._lockDetected
                ? (this.getDetcedtingIndex() + 1) % this._detectAtMouse.length
                : 1;
            this._lockDetected = this._detectAtMouse[index];
            const detected = this.getDetecting();
            if (detected) this.highlightDetecteds(view, [detected]);
        }
    }
}

/** The pick closest to the pointer: on screen when the view projects, else by world distance to its ray. */
function nearestToPointer(
    view: IView,
    picks: VisualShapeData[],
    x: number,
    y: number,
): VisualShapeData | undefined {
    if (picks.length < 2) return picks[0];
    let nearest = picks[0];
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const pick of picks) {
        const distance = pointerDistance(view, pick, x, y);
        if (distance < nearestDistance) {
            nearest = pick;
            nearestDistance = distance;
        }
    }
    return nearest;
}

function pointerDistance(view: IView, pick: VisualShapeData, x: number, y: number): number {
    const anchor = pickAnchor(pick);
    if (anchor === undefined) return Number.POSITIVE_INFINITY;
    if (typeof view.worldToScreen === "function") {
        const screen = view.worldToScreen(anchor);
        return Math.hypot(screen.x - x, screen.y - y);
    }
    if (typeof view.rayAt === "function") {
        const ray = view.rayAt(x, y);
        const direction = ray.direction.normalize();
        if (direction === undefined) return Number.POSITIVE_INFINITY;
        return anchor.sub(ray.point).cross(direction).length();
    }
    return Number.POSITIVE_INFINITY;
}

/**
 * Where a pick lies: a vertex at its own point (a point hit's `point` is the nearest point on
 * the ray, so the cursor itself), anything else at the hit point on it.
 */
function pickAnchor(pick: VisualShapeData): XYZ | undefined {
    const shape = pick.shape as Partial<IVertex>;
    if (pick.shape.shapeType === ShapeTypes.vertex && typeof shape.point === "function") {
        return pick.transform.ofPoint(shape.point());
    }
    return pick.point;
}
