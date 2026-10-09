// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, type IView, LENGTH_UNITS, resolveUnitSpec, ShapeTypes, XYZ } from "@chili3d/core";
import type { ExtrudeFeatureData } from "../features/feature";
import type { ParametricBodyNode } from "../parametricBodyNode";
import { SketchNode } from "../sketch/sketchNode";
import {
    ARROW_COLOR,
    ARROW_HOVER_COLOR,
    ARROW_HOVER_TOLERANCE,
    arrowMeshes,
    distanceToSegment,
    pxSizedArrowLength,
} from "./arrowHandle";
import { extrudeArrowSegment } from "./extrudeDragStep";

/** Where the extrude starts and which way it goes, in world space. */
export interface ExtrudeFrame {
    /** A point on the profile plane, at the middle of the extruded profiles. */
    readonly anchor: XYZ;
    /** The sketch normal: positive depth extrudes along it. */
    readonly normal: XYZ;
}

/**
 * The frame of a sketch extrude: the sketch plane's normal, anchored at the centre of the
 * picked profiles (the whole sketch when none are picked). Press-pull extrudes have no
 * sketch frame and get no arrow.
 */
export function extrudeFrame(
    body: ParametricBodyNode,
    feature: ExtrudeFeatureData,
): ExtrudeFrame | undefined {
    if (feature.sketchId === undefined) return undefined;
    const sketch = body.document.modelManager.findNode((node) => node.id === feature.sketchId);
    if (!(sketch instanceof SketchNode)) return undefined;
    const plane = sketch.plane;
    const centers = (feature.profiles ?? []).flatMap((profile) =>
        profile.center === undefined ? [] : [new XYZ(profile.center)],
    );
    let anchor: XYZ;
    if (centers.length > 0) {
        anchor = centers.reduce((sum, point) => sum.add(point), XYZ.zero).multiply(1 / centers.length);
    } else {
        const shape = sketch.shape;
        if (!shape.isOk || shape.value.findSubShapes(ShapeTypes.edge).length === 0) anchor = plane.origin;
        else {
            const box = shape.value.boundingBox();
            anchor = new XYZ({
                x: (box.min.x + box.max.x) / 2,
                y: (box.min.y + box.max.y) / 2,
                z: (box.min.z + box.max.z) / 2,
            });
        }
    }
    // Keep the anchor on the profile plane.
    anchor = anchor.sub(plane.normal.multiply(anchor.sub(plane.origin).dot(plane.normal)));
    return { anchor, normal: plane.normal };
}

/**
 * The depth manipulator of an extrude open in the feature dialog — the blue arrow the
 * Extrude command drags, at the extrude's end face and pointing the way it goes, so the
 * direction reads at a glance as Onshape's manipulator does. Dragging it sets the depth
 * (through the profile plane flips the direction), live in the draft; it coexists with
 * whatever pick the dialog runs by taking only the pointer presses that land on it.
 */
export class ExtrudeEditArrow implements IDisposable {
    private meshIds: number[] = [];
    private hovered = false;
    private dragging = false;
    private pendingDepth: number | undefined;
    private frame?: number;
    private disposed = false;

    constructor(
        private readonly body: ParametricBodyNode,
        private readonly featureId: string,
        private readonly view: IView,
    ) {
        body.onPropertyChanged(this.handleBodyChanged);
        view.cameraController.onPropertyChanged(this.handleCameraChanged);
        view.dom?.addEventListener("pointerdown", this.handlePointerDown, { capture: true });
        view.dom?.addEventListener("pointermove", this.handleHover);
        this.refresh();
    }

    private feature(): ExtrudeFeatureData | undefined {
        const feature = this.body.features.find((candidate) => candidate.id === this.featureId);
        return feature?.type === "extrude" ? feature : undefined;
    }

    /** The arrow's current segment, or undefined when the extrude has no sketch frame. */
    segment(): { start: XYZ; end: XYZ; frame: ExtrudeFrame; startOffset: number } | undefined {
        const feature = this.feature();
        if (feature === undefined) return undefined;
        const frame = extrudeFrame(this.body, feature);
        if (frame === undefined) return undefined;
        const scope = this.body.document.variables.evaluate().scope;
        const depth = resolveUnitSpec(feature.depth, scope, LENGTH_UNITS);
        const offset = resolveUnitSpec(feature.startOffset ?? 0, scope, LENGTH_UNITS);
        if (!depth.isOk || !offset.isOk) return undefined;
        const { start, end } = extrudeArrowSegment({
            anchor: frame.anchor,
            normal: frame.normal,
            dist: this.pendingDepth ?? depth.value,
            startOffset: offset.value,
            arrowLength: pxSizedArrowLength(this.view, frame.anchor, frame.normal),
            node: this.body,
            faces: [],
            origin: frame.anchor,
            arrowHovered: this.hovered,
        });
        return { start, end, frame, startOffset: offset.value };
    }

    private refresh(): void {
        if (this.disposed) return;
        const context = this.body.document.visual.context;
        for (const id of this.meshIds) context.removeMesh(id);
        this.meshIds = [];
        const segment = this.segment();
        if (segment !== undefined) {
            const direction = segment.end.sub(segment.start);
            const length = direction.length();
            const unit = direction.normalize();
            if (unit !== undefined && length > 1e-9) {
                const color = this.hovered || this.dragging ? ARROW_HOVER_COLOR : ARROW_COLOR;
                for (const mesh of arrowMeshes(segment.start, unit, length, color)) {
                    this.meshIds.push(context.displayMesh([mesh], { meshOpacity: 1, onTop: true }));
                }
            }
        }
        this.body.document.visual.update();
    }

    private isOverArrow(x: number, y: number): boolean {
        const segment = this.segment();
        if (segment === undefined) return false;
        const a = this.view.worldToScreen(segment.start);
        const b = this.view.worldToScreen(segment.end);
        return distanceToSegment(x, y, a, b) <= ARROW_HOVER_TOLERANCE;
    }

    private readonly handleHover = (event: PointerEvent) => {
        if (this.dragging) return;
        const over = this.isOverArrow(event.offsetX, event.offsetY);
        if (over === this.hovered) return;
        this.hovered = over;
        if (this.view.dom) this.view.dom.style.cursor = over ? "grab" : "";
        this.refresh();
    };

    private readonly handlePointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || !this.isOverArrow(event.offsetX, event.offsetY)) return;
        // The press is the arrow's: the dialog's pick handler must not see it.
        event.stopImmediatePropagation();
        event.preventDefault();
        this.dragging = true;
        if (this.view.dom) this.view.dom.style.cursor = "grabbing";
        window.addEventListener("pointermove", this.handleDrag, true);
        window.addEventListener("pointerup", this.handlePointerUp, true);
    };

    private readonly handleDrag = (event: PointerEvent) => {
        event.stopImmediatePropagation();
        const segment = this.segment();
        const rect = this.view.dom?.getBoundingClientRect();
        if (segment === undefined || rect === undefined) return;
        const ray = this.view.rayAt(event.clientX - rect.left, event.clientY - rect.top);
        const along = closestAlong(segment.frame.anchor, segment.frame.normal, ray.point, ray.direction);
        if (along === undefined) return;
        const depth = Math.round((along - segment.startOffset) * 100) / 100;
        if (Math.abs(depth) < 1e-9) return;
        this.pendingDepth = depth;
        this.refresh();
        // Rebuilding the chain is the expensive part: once per frame at most.
        this.frame ??= requestAnimationFrame(() => {
            this.frame = undefined;
            this.commitPending();
        });
    };

    private readonly handlePointerUp = (event: PointerEvent) => {
        event.stopImmediatePropagation();
        window.removeEventListener("pointermove", this.handleDrag, true);
        window.removeEventListener("pointerup", this.handlePointerUp, true);
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.frame = undefined;
        this.commitPending();
        this.dragging = false;
        if (this.view.dom) this.view.dom.style.cursor = this.hovered ? "grab" : "";
        this.refresh();
    };

    private commitPending(): void {
        const depth = this.pendingDepth;
        if (depth === undefined) return;
        this.pendingDepth = undefined;
        // The signed depth itself: the dialog shows its magnitude and direction separately.
        this.body.setFeaturesEmitShapeChanged(
            this.body.features.map((feature) =>
                feature.id === this.featureId ? { ...feature, depth } : feature,
            ),
        );
    }

    private readonly handleBodyChanged = (property: string) => {
        if (property === "featuresJson" || property === "shape") this.refresh();
    };

    private readonly handleCameraChanged = () => this.refresh();

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        window.removeEventListener("pointermove", this.handleDrag, true);
        window.removeEventListener("pointerup", this.handlePointerUp, true);
        this.view.dom?.removeEventListener("pointerdown", this.handlePointerDown, { capture: true });
        this.view.dom?.removeEventListener("pointermove", this.handleHover);
        if (this.view.dom) this.view.dom.style.cursor = "";
        this.body.removePropertyChanged(this.handleBodyChanged);
        this.view.cameraController.removePropertyChanged(this.handleCameraChanged);
        const context = this.body.document.visual.context;
        for (const id of this.meshIds) context.removeMesh(id);
        this.meshIds = [];
        this.body.document.visual.update();
    }
}

/**
 * The parameter along the line `origin + t·axis` of its point nearest the ray — where a
 * drag lands on the extrude axis; undefined when the ray runs parallel to it.
 */
export function closestAlong(origin: XYZ, axis: XYZ, rayPoint: XYZ, rayDirection: XYZ): number | undefined {
    const w = origin.sub(rayPoint);
    const a = axis.dot(axis);
    const b = axis.dot(rayDirection);
    const c = rayDirection.dot(rayDirection);
    const d = axis.dot(w);
    const e = rayDirection.dot(w);
    const denominator = a * c - b * b;
    if (Math.abs(denominator) < 1e-12) return undefined;
    return (b * e - c * d) / denominator;
}
