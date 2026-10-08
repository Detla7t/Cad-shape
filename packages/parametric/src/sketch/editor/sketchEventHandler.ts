// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    type CommandKeys,
    Config,
    DefaultDarkEdgeColor,
    debounce,
    type EdgeMeshData,
    type IDisposable,
    type IEventHandler,
    type IView,
    MeshDataUtils,
    Precision,
    SelectionRectangle,
    type ShapeMeshData,
    VisualConfig,
    XYZ,
} from "@chili3d/core";
import {
    applyDragAutoConstraints,
    type DragSnap,
    dragSnapPosition,
    sketchSnapOptions,
    snapConstraintKind,
    snapTargetEntityId,
} from "../autoConstraints";
import { sampleCurve } from "../curveGeometry";
import { entityDisplayMesh } from "../entityMesh";
import { sketchImageMeshes } from "../sketchImages";
import {
    arcAngles,
    ConstraintKind,
    DEFAULT_SKETCH_LAYER,
    entityPointCount,
    isDatumEntityId,
    isExternalEntityId,
    originRef,
    SKETCH_EDGE_LINE_WIDTH,
    SKETCH_X_AXIS_ID,
    SKETCH_Y_AXIS_ID,
    type SketchData,
    type SketchEntityData,
    type SketchEntityType,
    type SketchPointRef,
    toUV,
    toWorld,
    worldPerPixel,
} from "../sketchModel";
import { trimPreview } from "../sketchOperations";
import { constraintTargetEntities } from "../solverEntities";
import { applyConstraintIcon, type BadgeSymbol, badgeSymbol, isBadgeEventTarget } from "./sketchAnnotations";
import style from "./sketchAnnotations.module.css";
import { showSketchContextMenu } from "./sketchContextMenu";
import type { SketchEditor, SketchEntityTypeFilter, SketchPickTarget } from "./sketchEditor";

const PICK_TOLERANCE_PX = 8;
const CIRCLE_SEGMENTS = 256;
const DATUM_X_AXIS_COLOR = 0xcc5555;
const DATUM_Y_AXIS_COLOR = 0x55aa55;
/** External references (edges of another part): SolidWorks-style purple. */
const EXTERNAL_REF_COLOR = 0x9b59b6;
/** External references whose source edge no longer resolves. */
const EXTERNAL_DANGLING_COLOR = 0xdd4444;
/** Live-snap target accent — distinct from the green hover/selection and blue dimensions. */
const SNAP_HIGHLIGHT_COLOR = 0xff9800;

/**
 * Viewport event handler active while a sketch is being edited:
 * point dragging with live preview, entity hover highlight and click
 * selection (hovered and selected entities both reveal their constraint
 * symbols), and delegation to the editor's pending pick request.
 */
export class SketchEventHandler implements IEventHandler {
    isEnabled: boolean = true;

    resolveCommand(command: CommandKeys): CommandKeys {
        const aliases: Partial<Record<CommandKeys, CommandKeys>> = {
            "create.line": "sketch.line",
            "modify.trim": "sketch.trim",
            "create.offset": "sketch.offset",
            "modify.fillet": "sketch.fillet",
            "modify.chamfer": "sketch.chamfer",
            "modify.move": "sketch.transform",
            "create.rect": "sketch.rectangle",
            "create.circle": "sketch.circle",
            "create.arc": "sketch.arc",
            "measure.length": "dimension.distance",
        };
        return aliases[command] ?? command;
    }

    contextMenu(_view: IView, event: PointerEvent): boolean {
        if (this.editor.isPicking) {
            this.editor.cancelPick();
            return true;
        }
        showSketchContextMenu(this.editor, event);
        return true;
    }

    private draggingRef?: SketchPointRef;
    private dragStart?: [number, number];
    private dragMoved = false;
    private trimEntityUnderPointer?: number;
    private dragWithoutSnapping = false;
    private readonly pointSelection = new Map<string, SketchPointRef>();
    private geometryDisplayId?: number;
    private profileDisplayId?: number;
    private profileSignature?: string;
    private disposed = false;
    private readonly onCameraChanged = debounce(() => {
        if (!this.disposed && !this.draggingRef && !this.entityDrag) {
            this.refreshGeometryOverlays();
            this.editor.annotations.refresh();
        }
    }, 30);
    private entityDrag?: { id: number; start: [number, number]; params: number[]; radius?: boolean };
    private dragSnapshot?: SketchData;
    private selectionGlowId?: number;

    get selectedEntityIds(): number[] {
        return [...this.selectedEntities];
    }
    get selectedPoints(): SketchPointRef[] {
        return [...this.pointSelection.values()];
    }
    private dragPreviewId?: number;
    private hoverMeshId?: number;
    private hoverKey?: string;
    private readonly selectedEntities = new Set<number>();
    private boxSelection?: { x: number; y: number; element: HTMLDivElement };
    private selectionMeshId?: number;
    private pickMeshId?: number;
    private pickHighlightIds: number[] = [];
    private constraintHighlightIds: number[] = [];

    highlightPicks(ids: number[]): void {
        this.pickHighlightIds = [...ids];
        const context = this.editor.document.visual.context;
        if (this.pickMeshId !== undefined) context.removeMesh(this.pickMeshId);
        this.pickMeshId = undefined;
        const meshes = ids.flatMap((id) => {
            const entity = this.editor.solver.entity(id);
            return entity ? [entityDisplayMesh(this.editor.node.plane, entity, 0xffb020)] : [];
        });
        if (meshes.length) this.pickMeshId = context.displayMesh(meshes, { onTop: true });
        this.editor.view.update();
    }
    private constraintMeshId?: number;
    private datumDisplayId?: number;
    private externalDisplayId?: number;
    private pointDisplayId?: number;
    private snapTargetMeshId?: number;
    private snapHintItem?: IDisposable;
    private controller?: AsyncController;

    // ------------------------------------------------------------------ Session setup and the datum / external display

    constructor(private readonly editor: SketchEditor) {
        editor.view.cameraController.onPropertyChanged?.(this.onCameraChanged);
        VisualConfig.onPropertyChanged(this.onCameraChanged);
        Config.instance.onPropertyChanged(this.onCameraChanged);
        this.showDatum();
        this.showExternalRefs();
        this.showEntityPoints();
    }

    setController(view: IView, controller: AsyncController | undefined) {
        if (this.controller === controller) {
            return;
        }
        controller?.onCancelled((r) => this.handleEscape(view));
        this.controller = controller;
    }

    /** Session-persistent origin marker and dashed X/Y axis lines. */
    private showDatum(): void {
        const view = this.editor.document.application.activeView;
        if (view === undefined) return;
        const half = this.datumHalfLength();
        const plane = this.editor.node.plane;
        this.datumDisplayId = view.document.visual.context.displayMesh(
            [
                MeshDataUtils.createEdgeMesh(
                    toWorld(plane, -half, 0),
                    toWorld(plane, half, 0),
                    DATUM_X_AXIS_COLOR,
                    "dash",
                ),
                MeshDataUtils.createEdgeMesh(
                    toWorld(plane, 0, -half),
                    toWorld(plane, 0, half),
                    DATUM_Y_AXIS_COLOR,
                    "dash",
                ),
                MeshDataUtils.createVertexMesh(toWorld(plane, 0, 0), 9, 0x444444),
                MeshDataUtils.createVertexMesh(toWorld(plane, 0, 0), 6, 0xffffff),
                MeshDataUtils.createVertexMesh(toWorld(plane, 0, 0), 3, 0x444444),
            ],
            { onTop: true, lineOpacity: 0.25 },
        );
    }

    /** Session-persistent display of the external references: dashed purple, red when dangling. */
    private showExternalRefs(): void {
        const view = this.editor.document.application.activeView;
        if (view === undefined) return;
        const meshes: ShapeMeshData[] = [];
        // the solver carries the live refs — node.data lags behind until the next commit
        for (const ref of this.editor.solver.externalRefsData()) {
            const entity = this.editor.solver.entity(ref.entityId);
            if (entity === undefined) continue;
            const color = ref.dangling === true ? EXTERNAL_DANGLING_COLOR : EXTERNAL_REF_COLOR;
            // reference-role externals read as construction geometry; profile-role ones
            // build real profiles, so they get a solid line
            meshes.push(
                sketchEntityMesh(this.editor, entity, color, ref.role === "profile" ? "solid" : "dash"),
            );
        }
        if (meshes.length === 0) return;
        this.externalDisplayId = view.document.visual.context.displayMesh(meshes, { onTop: true });
    }

    /**
     * Re-renders the session's geometry overlays — the external references and the
     * entity point markers — after the geometry behind them was added, removed,
     * moved or re-resolved.
     */
    refreshGeometryOverlays(): void {
        const view = this.editor.document.application.activeView;
        if (view !== undefined) {
            for (const id of [this.externalDisplayId, this.pointDisplayId, this.geometryDisplayId]) {
                if (id !== undefined) view.document.visual.context.removeMesh(id);
            }
        }
        this.externalDisplayId = undefined;
        this.pointDisplayId = undefined;
        this.geometryDisplayId = undefined;
        if (view) {
            const profileSignature = `${VisualConfig.defaultEdgeColor}:${this.editor.node.dataJson}`;
            if (this.profileSignature !== profileSignature) {
                this.profileSignature = profileSignature;
                if (this.profileDisplayId !== undefined)
                    view.document.visual.context.removeMesh(this.profileDisplayId);
                this.profileDisplayId = undefined;
                const profiles = view.dom
                    ? [
                          ...this.editor.node.editingProfileMeshes(),
                          ...sketchImageMeshes(this.editor.node.plane, this.editor.solver.toData().images),
                      ]
                    : [];
                if (profiles.length)
                    this.profileDisplayId = view.document.visual.context.displayMesh(profiles, {
                        meshOpacity: VisualConfig.defaultEdgeColor === DefaultDarkEdgeColor ? 0.32 : 0.8,
                    });
            }
            const meshes = styledEntityMeshes(this.editor);
            if (meshes.length)
                this.geometryDisplayId = view.document.visual.context.displayMesh(meshes, { onTop: true });
            // Interaction meshes are snapshots too. Rebuild persistent highlights
            // from the solved entities and drop hover geometry at the old position.
            this.clearHover(view);
            this.highlightPicks(this.pickHighlightIds);
            this.updateConstraintHighlight(view);
            this.updateSelectionHighlight(view);
        }
        this.showExternalRefs();
        this.showEntityPoints();
        view?.update();
    }

    /**
     * Session-persistent markers on every entity point — line endpoints, circle and
     * arc centers, arc start and end. They are what drawing snaps to and what
     * dragging grabs, so they are worth seeing before the cursor reaches them.
     */
    private showEntityPoints(): void {
        const view = this.editor.document.application.activeView;
        if (view === undefined) return;
        const meshes = entityPointMeshes(this.editor);
        if (meshes.length === 0) return;
        this.pointDisplayId = view.document.visual.context.displayMesh(meshes, { onTop: true });
    }

    private clearEntityPoints(view: IView): void {
        if (this.pointDisplayId !== undefined) {
            view.document.visual.context.removeMesh(this.pointDisplayId);
            this.pointDisplayId = undefined;
        }
    }

    /** Half-length of the drawn axis lines: 1.5× the sketch extent, at least 100, and always spanning the visible viewport. */
    private datumHalfLength(): number {
        let extent = 0;
        for (const entity of this.editor.solver.entities()) {
            const p = entity.params;
            if (entity.type === "circle") {
                extent = Math.max(extent, Math.abs(p[0]) + p[2], Math.abs(p[1]) + p[2]);
            } else {
                for (let i = 0; i + 1 < p.length; i += 2) {
                    extent = Math.max(extent, Math.abs(p[i]), Math.abs(p[i + 1]));
                }
            }
        }
        // axes read as infinite construction lines when they reach past the viewport
        const view = this.editor.document.application.activeView;
        let visible = 0;
        if (view !== undefined) {
            const px = worldPerPixel(view, this.editor.node.plane, view.width / 2, view.height / 2);
            visible = px === undefined ? 0 : (px * Math.hypot(view.width, view.height)) / 2;
        }
        return Math.max(100, extent * 1.5, visible);
    }

    // ------------------------------------------------------------------ Hit testing

    pointerToUV(view: IView, event: PointerEvent): [number, number] | undefined {
        const point = this.editor.node.plane.intersectRay(view.rayAt(event.offsetX, event.offsetY));
        return point === undefined ? undefined : toUV(this.editor.node.plane, point);
    }

    hitTestPoint(view: IView, event: PointerEvent, exclude?: SketchPickTarget): SketchPointRef | undefined {
        const solver = this.editor.solver;
        const plane = this.editor.node.plane;
        let best: SketchPointRef | undefined;
        let bestDistance = PICK_TOLERANCE_PX;
        for (const entity of this.pickableEntities()) {
            const pointCount = entityPointCount(entity.type, entity.params);
            for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
                if (exclude?.kind === "entity" && exclude.entityId === entity.id) continue;
                if (
                    exclude?.kind === "point" &&
                    exclude.ref.entityId === entity.id &&
                    exclude.ref.pointIndex === pointIndex
                )
                    continue;
                const [u, v] = solver.pointOf({ entityId: entity.id, pointIndex });
                const screen = view.worldToScreen(toWorld(plane, u, v));
                const distance = Math.hypot(screen.x - event.offsetX, screen.y - event.offsetY);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = { entityId: entity.id, pointIndex };
                }
            }
        }
        // the origin is always a pickable datum point; real points win ties
        const originScreen = view.worldToScreen(toWorld(plane, 0, 0));
        const originDistance = Math.hypot(originScreen.x - event.offsetX, originScreen.y - event.offsetY);
        if (
            originDistance < bestDistance &&
            !(exclude?.kind === "point" && exclude.ref.entityId === originRef().entityId)
        ) {
            best = originRef();
        }
        return best;
    }

    /** Real entities plus the seeded external references (constraint targets). */
    private pickableEntities(): SketchEntityData[] {
        return constraintTargetEntities(this.editor.solver).filter((entity) =>
            this.editor.solver.entityVisible(entity),
        );
    }

    selectEntities(ids: number[]): void {
        this.pointSelection.clear();
        this.selectedEntities.clear();
        for (const id of ids)
            if (this.pickableEntities().some((e) => e.id === id)) this.selectedEntities.add(id);
        this.updateSelectionHighlight(this.editor.view);
        this.editor.refreshPanel();
    }

    entitiesAt(event: PointerEvent): number[] {
        const view = this.editor.view,
            uv = this.pointerToUV(view, event),
            tolerance = this.worldTolerance(view, event);
        if (!uv || tolerance === undefined) return [];
        return this.pickableEntities()
            .map((e) => ({ id: e.id, distance: entityDistance(uv, e) }))
            .filter((e) => e.distance <= tolerance)
            .sort((a, b) => a.distance - b.distance)
            .map((e) => e.id);
    }

    hitTestEntity(
        view: IView,
        event: PointerEvent,
        type?: SketchEntityTypeFilter,
        datum = false,
    ): number | undefined {
        const uv = this.pointerToUV(view, event);
        if (uv === undefined) return undefined;
        const tolerance = this.worldTolerance(view, event);
        if (tolerance === undefined) return undefined;
        const types: readonly SketchEntityType[] | undefined =
            type === undefined ? undefined : typeof type === "string" ? [type] : type;

        let best: number | undefined;
        let bestDistance = tolerance;
        const consider = (id: number, distance: number) => {
            if (distance < bestDistance) {
                bestDistance = distance;
                best = id;
            }
        };
        for (const entity of this.pickableEntities()) {
            if (types !== undefined && !types.includes(entity.type)) continue;
            consider(entity.id, entityDistance(uv, entity));
        }
        // datum axes are infinite lines, pickable only when the pick opts in;
        // Real geometry within the pick aperture wins over reference axes.
        // Otherwise a circle picked near an axis becomes a dimension of the unit axis.
        if (best === undefined && datum && (types === undefined || types.includes("line"))) {
            consider(SKETCH_X_AXIS_ID, Math.abs(uv[1]));
            consider(SKETCH_Y_AXIS_ID, Math.abs(uv[0]));
        }
        return best;
    }

    // ------------------------------------------------------------------ Pointer and keyboard input

    pointerMove(view: IView, event: PointerEvent): void {
        if (this.editor.powerTrim && event.buttons === 1 && this.editor.isPicking) {
            // Trimming retains the first surviving piece's id. Don't immediately
            // trim it again while the same stroke is still within its pick aperture.
            const id = this.hitTestEntity(view, event, ["line", "circle", "arc"]);
            if (id !== this.trimEntityUnderPointer) this.consumePickClick(view, event);
            this.trimEntityUnderPointer = id;
            return;
        }
        if (!this.isEnabled) return;
        if (this.boxSelection) {
            const { x, y, element } = this.boxSelection;
            const crossing = event.offsetX < x;
            Object.assign(element.style, {
                left: `${Math.min(x, event.offsetX)}px`,
                top: `${Math.min(y, event.offsetY)}px`,
                width: `${Math.abs(event.offsetX - x)}px`,
                height: `${Math.abs(event.offsetY - y)}px`,
                border: `1px ${crossing ? "dashed #279653" : "solid #4a9eff"}`,
                background: crossing ? "#2796532e" : "#4a9eff2e",
            });
            return;
        }
        // a dimension label drag is tracked on window by the annotation manager;
        // the viewport must not run its hover/drag logic alongside it
        if (this.editor.annotations.isLabelDragging) return;
        // events over an annotation badge carry badge-relative offsets; ignoring
        // them keeps the hover alive instead of clearing it with garbage uv
        if (isBadgeEventTarget(event.target)) return;
        if (this.entityDrag) {
            const uv = this.pointerToUV(view, event);
            if (
                !uv ||
                (this.dragStart &&
                    Math.hypot(event.offsetX - this.dragStart[0], event.offsetY - this.dragStart[1]) < 3)
            )
                return;
            this.dragMoved = true;
            const drag = this.entityDrag;
            if (drag.radius) {
                const distance = (p: [number, number]) =>
                    Math.hypot(p[0] - drag.params[0], p[1] - drag.params[1]);
                this.editor.solver.dragCircleRadiusTo(
                    drag.id,
                    Math.max(1e-6, drag.params[2] + distance(uv) - distance(drag.start)),
                );
            } else {
                this.editor.solver.dragEntityTo(
                    drag.id,
                    drag.params,
                    uv[0] - drag.start[0],
                    uv[1] - drag.start[1],
                );
            }
            this.updateDragPreview(view);
            this.editor.annotations.refresh();
            return;
        }
        if (this.draggingRef !== undefined) {
            if (
                !this.dragMoved &&
                this.dragStart &&
                Math.hypot(event.offsetX - this.dragStart[0], event.offsetY - this.dragStart[1]) < 3
            )
                return;
            this.dragMoved = true;
            const uv = this.pointerToUV(view, event);
            if (uv !== undefined) {
                const tolerance = this.editor.screenTolerance();
                this.dragWithoutSnapping = event.shiftKey || event.altKey;
                const { position, snap } = dragSnapPosition(
                    this.editor.solver,
                    this.draggingRef,
                    uv,
                    sketchSnapOptions(tolerance, this.dragWithoutSnapping),
                );
                this.editor.solver.dragTo(this.draggingRef, position[0], position[1]);
                this.updateDragPreview(view);
                this.showSnapFeedback(view, snap);
                this.editor.annotations.refresh();
            }
            return;
        }
        const preview = this.editor.activePick?.preview;
        if (preview !== undefined) {
            preview(this.pointerToUV(view, event));
        }
        this.updateHover(view, event);
    }

    pointerDown(view: IView, event: PointerEvent): void {
        if (!this.isEnabled) return;
        this.trimEntityUnderPointer = undefined;
        // a click while a dimension label follows the cursor drops it here
        if (this.editor.annotations.isLabelDragging) {
            this.editor.annotations.endLabelDrag(true);
            return;
        }
        // pick handling first: a right-click must be able to cancel an active pick
        if (this.consumePickClick(view, event)) return;
        if (event.button !== 0) return;

        const ref = this.hitTestPoint(view, event);
        // the datum origin and external references are pickable for constraints but never draggable
        if (ref !== undefined && !isDatumEntityId(ref.entityId) && !isExternalEntityId(ref.entityId)) {
            if (this.editor.solver.entityLocked(this.editor.solver.entity(ref.entityId)!)) return;
            if (this.editor.fullyConstrainedEntities.has(ref.entityId)) {
                this.selectPoint(view, ref);
                return;
            }
            this.dragStart = [event.offsetX, event.offsetY];
            this.dragMoved = false;
            this.dragWithoutSnapping = event.altKey || event.shiftKey;
            this.beginPointDrag(view, ref);
            return;
        }

        if (ref) {
            this.selectPoint(view, ref);
            return;
        }
        if (event.altKey) {
            const id = this.hitTestEntity(view, event);
            const entity = id === undefined ? undefined : this.editor.solver.entity(id);
            const start = this.pointerToUV(view, event);
            if (
                entity &&
                start &&
                !isDatumEntityId(entity.id) &&
                !isExternalEntityId(entity.id) &&
                !this.editor.solver.entityLocked(entity) &&
                !this.editor.fullyConstrainedEntities.has(entity.id)
            ) {
                event.preventDefault();
                this.dragSnapshot = this.editor.solver.toData();
                this.entityDrag = {
                    id: entity.id,
                    start,
                    params: [...entity.params],
                    radius: entity.type === "circle",
                };
                this.dragStart = [event.offsetX, event.offsetY];
                this.dragMoved = false;
                this.clearHover(view);
                this.editor.solver.beginDrag(
                    Array.from({ length: entityPointCount(entity.type, entity.params) }, (_, pointIndex) => ({
                        entityId: entity.id,
                        pointIndex,
                    })),
                );
                return;
            }
        }
        this.selectEntityAtPointer(view, event);
    }

    /** Hands the click to an active pick; returns whether the pick consumed it. */
    private consumePickClick(view: IView, event: PointerEvent): boolean {
        if (this.editor.powerTrim && this.editor.isPicking)
            this.trimEntityUnderPointer = this.hitTestEntity(view, event, ["line", "circle", "arc"]);
        if (!this.editor.handlePickPointerDown(view, event)) return false;

        // the pick consumed the click; drop the pre-click hover highlight and
        // force a repaint so it disappears even if the mouse stays put
        this.clearHover(view);
        this.syncAnnotationHighlights();
        view.update();
        return true;
    }

    /** No point hit: left-click selects the entity under the cursor. */
    private selectEntityAtPointer(view: IView, event: PointerEvent): void {
        const entityId = this.hitTestEntity(view, event);
        if (entityId === undefined) {
            // blank click drops both the constraint-badge and entity selections
            this.editor.annotations.clearConstraintSelection();
            if (!event.shiftKey && !event.ctrlKey && !event.metaKey) this.clearSelection(view);
            const element = document.createElement("div");
            element.style.cssText = "position:absolute;pointer-events:none;z-index:50";
            element.setAttribute("aria-label", "Sketch selection box");
            view.dom?.append(element);
            this.boxSelection = {
                x: event.offsetX,
                y: event.offsetY,
                element,
            };
            return;
        }
        this.selectEntity(view, entityId);
    }

    private beginPointDrag(view: IView, ref: SketchPointRef): void {
        this.dragSnapshot = this.editor.solver.toData();
        this.draggingRef = ref;
        this.clearHover(view);
        const group = this.editor.solver.coincidentGroup(ref);
        this.editor.solver.beginDrag(group);
        // keep the dragged entities' constraint symbols visible during the drag
        this.editor.annotations.setHighlightedEntities(
            new Set([...group.map((r) => r.entityId), ...this.selectedEntities]),
        );
    }

    /** Ordinary clicks accumulate constraint targets; clicking a target again removes it. */
    private selectPoint(view: IView, ref: SketchPointRef): void {
        const key = `${ref.entityId}:${ref.pointIndex}`;
        if (!this.pointSelection.delete(key)) this.pointSelection.set(key, ref);
        this.updateSelectionHighlight(view);
    }

    private selectEntity(view: IView, entityId: number, toggle = true): void {
        if (!toggle || !this.selectedEntities.delete(entityId)) {
            this.selectedEntities.add(entityId);
        }
        this.updateSelectionHighlight(view);
    }

    pointerOut(view: IView, event: PointerEvent): void {
        this.clearHover(view);
        if (event.type === "pointercancel" || event.type === "lostpointercapture") {
            this.boxSelection?.element.remove();
            this.boxSelection = undefined;
        }
    }

    pointerUp(view: IView, event: PointerEvent): void {
        if (this.boxSelection) {
            const { x, y, element } = this.boxSelection;
            element.remove();
            this.boxSelection = undefined;
            if (Math.hypot(event.offsetX - x, event.offsetY - y) > 3) {
                const rect = new SelectionRectangle(x, y, event.offsetX, event.offsetY);
                for (const entity of this.editor.solver.entities()) {
                    if (isDatumEntityId(entity.id)) continue;
                    const positions = entityDisplayMesh(this.editor.node.plane, entity, 0).position;
                    const hits: boolean[] = [];
                    for (let i = 0; i + 5 < positions.length; i += 6) {
                        hits.push(
                            rect.segment(
                                view.worldToScreen(
                                    new XYZ({ x: positions[i], y: positions[i + 1], z: positions[i + 2] }),
                                ),
                                view.worldToScreen(
                                    new XYZ({
                                        x: positions[i + 3],
                                        y: positions[i + 4],
                                        z: positions[i + 5],
                                    }),
                                ),
                            ),
                        );
                    }
                    if (hits.length && (rect.crossing ? hits.some(Boolean) : hits.every(Boolean)))
                        this.selectedEntities.add(entity.id);
                }
                this.updateSelectionHighlight(view);
            }
            return;
        }
        if (this.entityDrag) {
            const id = this.entityDrag.id;
            this.entityDrag = undefined;
            this.clearDragPreview(view);
            const result = this.editor.solver.endDrag();
            if (!result.result.startsWith("Ok") && this.dragSnapshot)
                this.editor.solver.reset(this.dragSnapshot);
            this.dragSnapshot = undefined;
            this.selectEntity(view, id, !this.dragMoved);
            this.editor.solve(true);
            if (this.dragMoved) this.editor.commit();
            return;
        }
        if (this.draggingRef === undefined) return;
        const ref = this.draggingRef;
        this.draggingRef = undefined;
        this.clearDragPreview(view);
        this.clearSnapFeedback();
        this.editor.solver.endDrag();
        if (!this.dragMoved) {
            this.dragSnapshot = undefined;
            this.selectPoint(view, ref);
            this.refreshGeometryOverlays();
            return;
        }
        // the drag is over: add an auto-constraint now, only if the point still
        // satisfies a snap condition
        const tolerance = this.editor.screenTolerance();
        if (!this.dragWithoutSnapping) {
            applyDragAutoConstraints(this.editor.solver, ref, sketchSnapOptions(tolerance));
        }
        this.syncAnnotationHighlights();
        const result = this.editor.solve(true);
        if (!result.result.startsWith("Ok") && this.dragSnapshot) {
            this.editor.solver.reset(this.dragSnapshot);
            this.editor.solve(true);
        }
        this.dragSnapshot = undefined;
        this.editor.commit();
    }

    keyDown(view: IView, event: KeyboardEvent): void {
        const key = event.key.toLowerCase();
        const shortcutCommand =
            key === "q" ? "sketch.construction" : key === "n" ? "sketch.normal" : undefined;
        const overrides = Config.instance.customShortcuts;
        if (
            shortcutCommand &&
            overrides[shortcutCommand] === undefined &&
            !Object.values(overrides).includes(key) &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.shiftKey
        ) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.key.toLowerCase() === "q") this.editor.toggleConstruction();
            else this.editor.normalView();
            return;
        }
        if (event.key === " " && !this.editor.isPicking && !this.draggingRef && !this.entityDrag) {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.editor.annotations.clearConstraintSelection();
            this.clearSelection(view);
            return;
        }
        if (event.key === "Escape") {
            this.handleEscape(view);
            return;
        }
        if (event.key !== "Delete" && event.key !== "Backspace") return;
        this.handleDelete(view, event);
    }

    /** Escape peels off one layer at a time: label placement, pick, constraint selection, entity selection, session. */
    private handleEscape(view: IView): void {
        if (this.boxSelection) {
            this.boxSelection.element.remove();
            this.boxSelection = undefined;
            return;
        }
        if (this.draggingRef || this.entityDrag) {
            this.draggingRef = undefined;
            this.entityDrag = undefined;
            this.clearDragPreview(view);
            this.clearSnapFeedback();
            this.editor.solver.endDrag();
            if (this.dragSnapshot) this.editor.solver.reset(this.dragSnapshot);
            this.dragSnapshot = undefined;
            this.editor.solve(true);
        } else if (this.editor.annotations.isLabelDragging) {
            this.editor.annotations.cancelLabelDrag();
        } else if (this.editor.isPicking) {
            this.editor.cancelPick();
        } else if (this.editor.annotations.selectedConstraintIds.length > 0) {
            this.editor.annotations.clearConstraintSelection();
        } else if (this.selectedEntities.size > 0 || this.pointSelection.size > 0) {
            this.clearSelection(view);
        }
        // Escape ends tools and selection; only the explicit accept/cancel controls leave the sketch.
    }

    private handleDelete(view: IView, event: KeyboardEvent): void {
        // swallow the key: HotkeyService would otherwise also fire modify.deleteNode,
        // whose node-selection step can delete the very sketch node being edited,
        // leaving the editor drawing into an invisible orphan
        event.stopImmediatePropagation();
        if (this.editor.isPicking || this.draggingRef !== undefined || this.entityDrag !== undefined) return;
        // a label being placed follows the cursor — it is the delete target
        const draggingLabel = this.editor.annotations.draggingLabelId;
        if (draggingLabel !== undefined) {
            this.editor.deleteConstraints([draggingLabel]);
            return;
        }
        const hoveredConstraint = this.editor.annotations.hoveredConstraintId;
        if (hoveredConstraint !== undefined) {
            this.editor.deleteConstraints([hoveredConstraint]);
            return;
        }
        const selectedConstraints = this.editor.annotations.selectedConstraintIds;
        if (selectedConstraints.length > 0) {
            this.editor.deleteConstraints(selectedConstraints);
            return;
        }
        const hovered = this.hoveredEntityId();
        const ids = (hovered !== undefined ? [hovered] : [...this.selectedEntities]).filter(
            // the datum can be hovered through the origin point but never deleted
            (id) => !isDatumEntityId(id),
        );
        if (ids.length === 0) return;
        this.clearHover(view);
        this.clearSelection(view);
        // regular entities and external references delete together in one transaction
        this.editor.deleteEntities(ids);
    }

    // ------------------------------------------------------------------ Constraint highlighting

    /** Highlights the entities a hovered/selected constraint badge refers to. */
    highlightConstraintEntities(entityIds: number[]): void {
        this.constraintHighlightIds = [...entityIds];
        const view = this.editor.document.application.activeView;
        if (view === undefined) return;
        // a badge hover replaces any entity hover: pointerMove ignores events over
        // badges, so the entity highlight would otherwise linger next to the badge's
        this.clearHover(view);
        this.syncAnnotationHighlights();
        this.updateConstraintHighlight(view);
        view.update();
    }

    private updateConstraintHighlight(view: IView): void {
        this.clearConstraintHighlight(view);
        const meshes = this.constraintHighlightMeshes(this.constraintHighlightIds);
        if (meshes.length > 0) {
            this.constraintMeshId = view.document.visual.context.displayMesh(meshes, { onTop: true });
        }
    }

    private constraintHighlightMeshes(entityIds: number[]): ShapeMeshData[] {
        const meshes: ShapeMeshData[] = [];
        for (const id of entityIds) {
            if (id === SKETCH_X_AXIS_ID || id === SKETCH_Y_AXIS_ID) {
                meshes.push(this.datumAxisMesh(id, VisualConfig.highlightEdgeColor));
            } else if (isDatumEntityId(id)) {
                meshes.push(
                    MeshDataUtils.createVertexMesh(
                        toWorld(this.editor.node.plane, 0, 0),
                        VisualConfig.editVertexSize,
                        VisualConfig.highlightEdgeColor,
                    ),
                );
            } else {
                // solver.entity also answers external references and datum axes
                const entity = this.editor.solver.entity(id);
                if (entity !== undefined) meshes.push(sketchEntityMesh(this.editor, entity));
            }
        }
        return meshes;
    }

    /** Entity id of the current hover highlight (`entity:<id>` or `point:<id>:<index>`). */
    private hoveredEntityId(): number | undefined {
        const parts = this.hoverKey?.split(":");
        if (parts === undefined || parts.length < 2) return undefined;
        const id = Number(parts[1]);
        return Number.isInteger(id) ? id : undefined;
    }

    dispose(): void {
        this.highlightPicks([]);
        this.boxSelection?.element.remove();
        this.boxSelection = undefined;
        this.disposed = true;
        this.editor.view.cameraController.removePropertyChanged?.(this.onCameraChanged);
        VisualConfig.removePropertyChanged(this.onCameraChanged);
        Config.instance.removePropertyChanged(this.onCameraChanged);
        const view = this.editor.view;
        this.clearSnapFeedback();
        if (!view.isClosed) {
            this.clearHover(view);
            this.clearDragPreview(view);
            this.clearSelectionHighlight(view);
            this.clearConstraintHighlight(view);
            if (this.datumDisplayId !== undefined) {
                view.document.visual.context.removeMesh(this.datumDisplayId);
                this.datumDisplayId = undefined;
            }
            if (this.externalDisplayId !== undefined) {
                view.document.visual.context.removeMesh(this.externalDisplayId);
                this.externalDisplayId = undefined;
            }
            this.clearEntityPoints(view);
            if (this.profileDisplayId !== undefined)
                view.document.visual.context.removeMesh(this.profileDisplayId);
            if (this.geometryDisplayId !== undefined)
                view.document.visual.context.removeMesh(this.geometryDisplayId);
        }
        this.pointSelection.clear();
        this.selectedEntities.clear();
        this.draggingRef = undefined;
    }

    // ------------------------------------------------------------------ Hover, drag and snap feedback

    /** Pick tolerance converted to sketch-plane units at the event position. */
    private worldTolerance(view: IView, event: PointerEvent): number | undefined {
        const size = worldPerPixel(view, this.editor.node.plane, event.offsetX, event.offsetY);
        return size === undefined ? undefined : size * PICK_TOLERANCE_PX;
    }

    private updateHover(view: IView, event: PointerEvent): void {
        const { key, mesh } = this.computeHoverTarget(view, event);

        if (key === this.hoverKey) return;
        if (key === undefined && this.hoverKey !== undefined && this.isCrossingToBadge(view, event)) {
            return;
        }
        this.clearHover(view);
        if (mesh !== undefined) {
            this.hoverMeshId = view.document.visual.context.displayMesh([mesh], { onTop: true });
            this.hoverKey = key;
        }
        this.syncAnnotationHighlights();
    }

    private computeHoverTarget(view: IView, event: PointerEvent): { key?: string; mesh?: ShapeMeshData } {
        if (this.editor.powerTrim) {
            const id = this.hitTestEntity(view, event),
                uv = this.pointerToUV(view, event);
            const preview =
                id === undefined || !uv ? undefined : trimPreview(this.editor.solver.toData(), id, uv);
            if (!preview) return {};
            const mesh = entityDisplayMesh(this.editor.node.plane, preview, 0xf29b24);
            mesh.lineWidth = 4;
            return { key: `trim:${id}:${preview.params.map((v) => v.toFixed(6)).join(",")}`, mesh };
        }
        const pick = this.editor.activePick;

        if (
            pick === undefined ||
            pick.kind === "point" ||
            pick.kind === "pointOrEntity" ||
            pick.kind === "dimension"
        ) {
            const ref = this.hitTestPoint(view, event);
            if (ref !== undefined) {
                const [u, v] = this.editor.solver.pointOf(ref);
                return {
                    key: `point:${ref.entityId}:${ref.pointIndex}`,
                    mesh: MeshDataUtils.createVertexMesh(
                        toWorld(this.editor.node.plane, u, v),
                        VisualConfig.editVertexSize,
                        VisualConfig.editVertexColor,
                    ),
                };
            }
        }

        if (
            pick === undefined ||
            pick.kind === "entity" ||
            pick.kind === "pointOrEntity" ||
            pick.kind === "dimension"
        ) {
            const entityId = this.hitTestEntity(view, event, pick?.entityType, pick?.datum ?? false);
            if (entityId !== undefined && isDatumEntityId(entityId)) {
                return {
                    key: `entity:${entityId}`,
                    mesh: this.datumAxisMesh(entityId, VisualConfig.highlightEdgeColor),
                };
            }
            const entity = entityId === undefined ? undefined : this.editor.solver.entity(entityId);
            if (entity !== undefined) {
                return { key: `entity:${entityId}`, mesh: sketchEntityMesh(this.editor, entity) };
            }
        }
        return {};
    }

    /** Full-length dashed axis line used for datum hover/constraint highlight. */
    private datumAxisMesh(axisId: number, color: number): ShapeMeshData {
        const half = this.datumHalfLength();
        const plane = this.editor.node.plane;
        return axisId === SKETCH_X_AXIS_ID
            ? MeshDataUtils.createEdgeMesh(toWorld(plane, -half, 0), toWorld(plane, half, 0), color, "dash")
            : MeshDataUtils.createEdgeMesh(toWorld(plane, 0, -half), toWorld(plane, 0, half), color, "dash");
    }

    /**
     * Crossing the gap from an entity to its offset badge keeps the hover alive,
     * otherwise the badge would vanish before the cursor can reach it.
     */
    private isCrossingToBadge(view: IView, event: PointerEvent): boolean {
        const previous = this.hoveredEntityId();
        const uv = this.pointerToUV(view, event);
        return (
            previous !== undefined &&
            uv !== undefined &&
            this.editor.annotations.isNearVisibleBadge(previous, uv)
        );
    }

    /** Constraint symbols show for the union of hovered and selected entities. */
    private syncAnnotationHighlights(): void {
        const ids = new Set([...this.selectedEntities, ...this.selectedPoints.map((ref) => ref.entityId)]);
        const hovered = this.hoveredEntityId();
        if (hovered !== undefined) ids.add(hovered);
        this.editor.annotations.setHighlightedEntities(ids);
    }

    private updateSelectionHighlight(view: IView): void {
        this.clearSelectionHighlight(view);
        this.editor.refreshPanel();
        if (this.selectedEntities.size === 0 && this.pointSelection.size === 0) {
            this.syncAnnotationHighlights();
            return;
        }
        const meshes = [...this.selectedEntities]
            .map((id) => this.editor.solver.entity(id))
            .filter(
                (entity): entity is SketchEntityData =>
                    entity !== undefined && this.editor.solver.entityVisible(entity),
            )
            .map((entity) => sketchEntityMesh(this.editor, entity, VisualConfig.selectedEdgeColor));
        if (meshes.length)
            this.selectionGlowId = view.document.visual.context.displayMesh(
                meshes.map((mesh) => ({ ...mesh, lineWidth: 8 })),
                { onTop: true, lineOpacity: 0.22 },
            );
        const points = this.selectedPoints
            .filter(
                (ref) =>
                    this.editor.solver.entity(ref.entityId) !== undefined || isDatumEntityId(ref.entityId),
            )
            .map((ref) => {
                const [u, v] = this.editor.solver.pointOf(ref);
                return MeshDataUtils.createVertexMesh(
                    toWorld(this.editor.node.plane, u, v),
                    9,
                    VisualConfig.selectedEdgeColor,
                );
            });
        this.selectionMeshId = view.document.visual.context.displayMesh([...meshes, ...points], {
            onTop: true,
        });
        this.syncAnnotationHighlights();
        view.update();
    }

    clearSelection(view: IView): void {
        if (this.selectedEntities.size === 0 && this.pointSelection.size === 0) return;
        this.pointSelection.clear();
        this.selectedEntities.clear();
        this.editor.refreshPanel();
        this.clearSelectionHighlight(view);
        this.syncAnnotationHighlights();
        view.update();
    }

    private clearSelectionHighlight(view: IView): void {
        if (this.selectionGlowId !== undefined) {
            view.document.visual.context.removeMesh(this.selectionGlowId);
            this.selectionGlowId = undefined;
        }
        if (this.selectionMeshId !== undefined) {
            view.document.visual.context.removeMesh(this.selectionMeshId);
            this.selectionMeshId = undefined;
        }
    }

    private clearConstraintHighlight(view: IView): void {
        if (this.constraintMeshId !== undefined) {
            view.document.visual.context.removeMesh(this.constraintMeshId);
            this.constraintMeshId = undefined;
        }
    }

    private clearHover(view: IView): void {
        if (this.hoverMeshId !== undefined) {
            view.document.visual.context.removeMesh(this.hoverMeshId);
            this.hoverMeshId = undefined;
            this.hoverKey = undefined;
        }
    }

    private updateDragPreview(view: IView): void {
        // A press is still a selection until the drag threshold is crossed. Keep
        // the sketch visible until a preview is ready to replace its geometry.
        this.clearPersistentDragGeometry(view);
        this.clearDragPreview(view);
        // the markers ride along with the dragged geometry; the persistent overlay
        // was dropped when the drag began, and comes back on the commit that ends it
        this.dragPreviewId = view.document.visual.context.displayMesh(
            [...styledEntityMeshes(this.editor), ...entityPointMeshes(this.editor)],
            { onTop: true },
        );
    }

    private clearPersistentDragGeometry(view: IView): void {
        this.clearEntityPoints(view);
        for (const id of [this.geometryDisplayId, this.profileDisplayId]) {
            if (id !== undefined) view.document.visual.context.removeMesh(id);
        }
        this.geometryDisplayId = undefined;
        this.profileDisplayId = undefined;
        this.profileSignature = undefined;
        this.clearSelectionHighlight(view);
    }

    private clearDragPreview(view: IView): void {
        if (this.dragPreviewId !== undefined) {
            view.document.visual.context.removeMesh(this.dragPreviewId);
            this.dragPreviewId = undefined;
        }
    }

    /** Highlights the live snap target and shows a floating hint while a drag is snapping onto it. */
    showSnapFeedback(view: IView, snap: DragSnap | undefined, hint = true): void {
        this.clearSnapFeedback();
        if (snap === undefined) return;
        this.snapTargetMeshId = this.displaySnapTarget(view, snap);
        if (hint) this.snapHintItem = this.displaySnapHint(view, snap);
    }

    /** Displays the highlighted snap target (a point marker or a curve highlight); returns its mesh id. */
    private displaySnapTarget(view: IView, snap: DragSnap): number | undefined {
        const plane = this.editor.node.plane;
        const targetId = snapTargetEntityId(snap);
        const mesh =
            targetId === undefined
                ? MeshDataUtils.createVertexMesh(
                      toWorld(plane, snap.position[0], snap.position[1]),
                      VisualConfig.editVertexSize,
                      SNAP_HIGHLIGHT_COLOR,
                  )
                : this.snapEntityHighlight(targetId, SNAP_HIGHLIGHT_COLOR);
        return mesh === undefined
            ? undefined
            : view.document.visual.context.displayMesh([mesh], { onTop: true });
    }

    /** Highlight mesh for a line/axis/circle/arc snap target, or undefined. */
    private snapEntityHighlight(targetId: number, color: number): ShapeMeshData | undefined {
        if (targetId === SKETCH_X_AXIS_ID || targetId === SKETCH_Y_AXIS_ID) {
            return this.datumAxisMesh(targetId, color);
        }
        const entity = this.editor.solver.entity(targetId);
        return entity === undefined ? undefined : sketchEntityMesh(this.editor, entity, color);
    }

    /** Displays the floating hint (constraint icon) beside the snap position. */
    private displaySnapHint(view: IView, snap: DragSnap): IDisposable {
        const plane = this.editor.node.plane;
        const symbol = snapHintSymbol(snap);
        const px = worldPerPixel(view, plane, view.width / 2, view.height / 2) ?? 1;
        const off = 18 * px * Math.SQRT1_2;
        return view.htmlText(symbol.label, toWorld(plane, snap.position[0] + off, snap.position[1] + off), {
            hideDelete: true,
            className: `${style.badge} ${style.preview}`,
            onCreated: (element) => applyConstraintIcon(element, symbol),
        });
    }

    clearSnapFeedback(): void {
        const view = this.editor.view;
        if (this.snapTargetMeshId !== undefined && !view.isClosed) {
            view.document.visual.context.removeMesh(this.snapTargetMeshId);
        }
        this.snapTargetMeshId = undefined;
        this.snapHintItem?.dispose();
        this.snapHintItem = undefined;
    }
}

function entityColor(editor: SketchEditor, entity: SketchEntityData): number {
    if (
        editor.showErrors &&
        (!editor.lastSolveOutcome.result.startsWith("Ok") || editor.solver.datumErrors.size > 0)
    )
        return 0xee6262;
    if (editor.lastSolveOutcome.dofs === 0 || editor.fullyConstrainedEntities.has(entity.id))
        return Config.instance.graphics.constrainedColor
            ? Number.parseInt(Config.instance.graphics.constrainedColor.slice(1), 16)
            : VisualConfig.defaultEdgeColor;
    const layer = editor.solver.sketchLayers().find((layer) => layer.id === (entity.layer ?? "0"));
    const layerColor =
        layer?.id === "0" && layer.color === DEFAULT_SKETCH_LAYER.color ? undefined : layer?.color;
    return Number.parseInt(
        (entity.color ?? layerColor ?? Config.instance.graphics.underconstrainedColor).slice(1),
        16,
    );
}

function styledEntityMeshes(editor: SketchEditor): ShapeMeshData[] {
    const pixel =
        worldPerPixel(editor.view, editor.node.plane, editor.view.width / 2, editor.view.height / 2) ?? 0.1;
    const layers = editor.solver.sketchLayers();
    return editor.solver
        .entities()
        .filter((entity) => editor.solver.entityVisible(entity))
        .map((entity) => {
            const layer = layers.find((layer) => layer.id === (entity.layer ?? "0"));
            const mesh = entityDisplayMesh(
                editor.node.plane,
                entity,
                entityColor(editor, entity),
                !!(entity.construction || entity.dashed || layer?.dashed),
                pixel,
            );
            if (editor.lastSolveOutcome.dofs > 0 && !editor.fullyConstrainedEntities.has(entity.id))
                mesh.occludedColor = Number.parseInt(Config.instance.graphics.occludedColor.slice(1), 16);
            return mesh;
        });
}

export function sketchEntityMeshes(editor: SketchEditor): ShapeMeshData[] {
    return editor.solver
        .entities()
        .filter((entity) => editor.solver.entityVisible(entity))
        .map((entity) => sketchEntityMesh(editor, entity));
}

/** An origin-attached center stays fixed even when its circle still has a free radius. */
function pointColor(editor: SketchEditor, entity: SketchEntityData, ref: SketchPointRef): number {
    const color = entityColor(editor, entity);
    if (!editor.lastSolveOutcome.result.startsWith("Ok") || editor.solver.datumErrors.size) return color;
    const pinned = editor.solver
        .coincidentGroup(ref)
        .some(
            (point) =>
                editor.solver.isFixed(point.entityId) ||
                editor.solver.constraintKindsOnPoint(point).includes(ConstraintKind.Fix),
        );
    return pinned
        ? Number.parseInt((Config.instance.graphics.constrainedColor || "#000000").slice(1), 16)
        : color;
}

/** Vertex meshes at every entity point of the constraint targets — see `showEntityPoints`. */
function entityPointMeshes(editor: SketchEditor): ShapeMeshData[] {
    const plane = editor.node.plane;
    const meshes: ShapeMeshData[] = [];
    for (const entity of constraintTargetEntities(editor.solver).filter((entity) =>
        editor.solver.entityVisible(entity),
    )) {
        for (let pointIndex = 0; pointIndex < entityPointCount(entity.type, entity.params); pointIndex++) {
            const [u, v] = editor.solver.pointOf({ entityId: entity.id, pointIndex });
            meshes.push(
                MeshDataUtils.createVertexMesh(
                    toWorld(plane, u, v),
                    VisualConfig.editVertexSize,
                    pointColor(editor, entity, { entityId: entity.id, pointIndex }),
                ),
            );
        }
    }
    return meshes;
}

export function sketchEntityMesh(
    editor: SketchEditor,
    entity: SketchEntityData,
    color: number = VisualConfig.highlightEdgeColor,
    lineType: "solid" | "dash" = entity.construction || entity.dashed ? "dash" : "solid",
): EdgeMeshData {
    const plane = editor.node.plane;
    if (["point", "bezier", "spline"].includes(entity.type))
        return entityDisplayMesh(plane, entity, color, lineType === "dash");
    const [x1, y1, x2, y2] = entity.params;
    let mesh: EdgeMeshData;
    if (entity.type === "line") {
        mesh = MeshDataUtils.createEdgeMesh(toWorld(plane, x1, y1), toWorld(plane, x2, y2), color, lineType);
    } else if (entity.type === "arc") {
        const [cx, cy, r, a0, sweep] = arcGeometry(entity.params);
        mesh = arcSegmentMesh(editor, cx, cy, r, a0, a0 + sweep, color, lineType);
    } else {
        mesh = arcSegmentMesh(editor, x1, y1, entity.params[2], 0, Math.PI * 2, color, lineType);
    }
    mesh.lineWidth = SKETCH_EDGE_LINE_WIDTH;
    const pixel = worldPerPixel(editor.view, plane, editor.view.width / 2, editor.view.height / 2) ?? 0.1;
    mesh.dashSize = pixel * 7;
    mesh.gapSize = pixel * 4;
    return mesh;
}

/** Icon (and fallback label) for the constraint a snap release would add. */
function snapHintSymbol(snap: DragSnap): BadgeSymbol {
    const kind = snapConstraintKind(snap);
    return badgeSymbol(kind) ?? { label: kind === ConstraintKind.P2PCoincident ? "◇" : "⊙" };
}

/**
 * Center, radius, start angle and counter-clockwise sweep (normalized to (0, 2π],
 * matching SketchNode.arcEdge) of an arc entity's params [cx, cy, sx, sy, ex, ey].
 */
function arcGeometry(params: number[]): [number, number, number, number, number] {
    const [cx, cy, sx, sy] = params;
    const r = Math.hypot(sx - cx, sy - cy);
    const [a0, sweep] = arcAngles(params);
    return [cx, cy, r, a0, sweep];
}

/** uv distance to an arc: radial gap inside the sweep, endpoint gap outside it. */
function pointToArcDistance(x: number, y: number, params: number[]): number {
    const [cx, cy, sx, sy, ex, ey] = params;
    const r = Math.hypot(sx - cx, sy - cy);
    if (r < Precision.Distance) return Math.hypot(x - cx, y - cy);
    const [, sweep] = arcAngles(params);
    // the probe direction measured like an arc sweep from the start ray — the
    // same counter-clockwise (0, 2π] convention as arcAngles
    const [, probeSweep] = arcAngles([cx, cy, sx, sy, x, y]);
    if (probeSweep <= sweep) {
        return Math.abs(Math.hypot(x - cx, y - cy) - r);
    }
    return Math.min(Math.hypot(x - sx, y - sy), Math.hypot(x - ex, y - ey));
}

function arcSegmentMesh(
    editor: SketchEditor,
    cx: number,
    cy: number,
    r: number,
    a0: number,
    a1: number,
    color: number,
    lineType: "solid" | "dash" = "solid",
): EdgeMeshData {
    const plane = editor.node.plane;
    const segments = Math.max(2, Math.ceil((CIRCLE_SEGMENTS * (a1 - a0)) / (Math.PI * 2)));
    const position = new Float32Array(segments * 6);
    for (let i = 0; i < segments; i++) {
        const t0 = a0 + ((a1 - a0) * i) / segments;
        const t1 = a0 + ((a1 - a0) * (i + 1)) / segments;
        const p0 = toWorld(plane, cx + r * Math.cos(t0), cy + r * Math.sin(t0));
        const p1 = toWorld(plane, cx + r * Math.cos(t1), cy + r * Math.sin(t1));
        position.set([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z], i * 6);
    }
    return { position, range: [], color, lineType };
}

/** uv distance to an entity's curve: segment, arc sweep, or circle circumference. */
function entityDistance(uv: [number, number], entity: SketchEntityData): number {
    const [x1, y1, x2, y2] = entity.params;
    if (entity.type === "point") return Math.hypot(uv[0] - x1, uv[1] - y1);
    if (entity.type === "bezier" || entity.type === "spline") {
        const p = sampleCurve(entity);
        return Math.min(...p.slice(1).map((b, i) => pointToSegmentDistance(...uv, ...p[i], ...b)));
    }
    if (entity.type === "line") return pointToSegmentDistance(uv[0], uv[1], x1, y1, x2, y2);
    if (entity.type === "arc") return pointToArcDistance(uv[0], uv[1], entity.params);
    return Math.abs(Math.hypot(uv[0] - x1, uv[1] - y1) - entity.params[2]);
}

function pointToSegmentDistance(
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    const t =
        lengthSquared < 1e-12
            ? 0
            : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
