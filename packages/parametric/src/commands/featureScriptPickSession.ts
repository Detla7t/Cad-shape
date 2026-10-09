// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    type FeaturePickKind,
    type I18nKeys,
    type IDocument,
    type IEdge,
    type IFace,
    type INode,
    type INodeVisual,
    type IVertex,
    type IView,
    ReferencePlaneNode,
    ShapeSelectionHandler,
    type ShapeType,
    ShapeTypes,
    type VisualShapeData,
    VisualStates,
} from "@chili3d/core";
import { matchEdgeIndexes } from "../features/edgeMatcher";
import { captureEdgeRef, type EdgeRef } from "../features/edgeRef";
import type {
    FeatureScriptBodyRef,
    FeatureScriptFaceRef,
    FeatureScriptPlaneRef,
    FeatureScriptQueryValue,
} from "../features/feature";
import {
    captureFeatureScriptBodyRef,
    captureFeatureScriptFaceRef,
    captureFeatureScriptPlaneRef,
} from "../featurescript/featureScriptFeature";
import { type ReselectHost, runReselectSession } from "./reselectSession";

export type PickKind = FeaturePickKind;

type PickedRef =
    | { readonly kind: "edge"; readonly ref: EdgeRef }
    | { readonly kind: "face"; readonly ref: FeatureScriptFaceRef }
    | { readonly kind: "vertex"; readonly ref: { point: { x: number; y: number; z: number } } }
    | { readonly kind: "body"; readonly ref: FeatureScriptBodyRef }
    | { readonly kind: "plane"; readonly ref: FeatureScriptPlaneRef };

/** The kernel sub-shape a kind picks on the host body; planes are separate nodes. */
const SHAPE_TYPES: Record<Exclude<PickKind, "plane">, ShapeType> = {
    edge: ShapeTypes.edge,
    face: ShapeTypes.face,
    vertex: ShapeTypes.vertex,
    body: ShapeTypes.solid,
};

const PROMPTS: Record<PickKind, I18nKeys> = {
    edge: "prompt.select.edges",
    face: "prompt.select.faces",
    vertex: "prompt.select.entities",
    body: "prompt.select.shape",
    plane: "prompt.select.plane",
};

/**
 * Picks the entities of one FeatureScript `Query` parameter on the host body.
 *
 * Same footing as the fillet edge re-pick (`EdgeReselectSession`): the body is rolled
 * back to just before the feature for the session, because the picks address the
 * feature's INPUT — the geometry the custom feature receives — not its output. Refs are
 * captured with the body's tracked ids while the rolled-back cache still describes that
 * input. Confirming with nothing picked clears the parameter.
 *
 * A part pick (std's `EntityType.BODY`) takes the solid under the cursor. A parameter that
 * accepts planes (std's `ALLOWS_PLANE` / `ALLOWS_DIRECTION`) takes one entity per pick, as
 * Onshape's single-pick boxes do: a host face or edge, a reference plane in the viewport,
 * or a plane clicked in the model tree (Top, Front, Right…).
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
        const shapeType = wanted.reduce<number>(
            (mask, kind) => (kind === "plane" ? mask : mask | SHAPE_TYPES[kind]),
            0,
        ) as ShapeType;
        const prompt = wanted.length === 1 ? PROMPTS[wanted[0]] : "prompt.select.entities";
        const session = this.openSession(featureIndex, wanted);
        let picked: PickedRef[] | undefined;
        if (wanted.includes("plane")) {
            picked = await this.pickWithPlanes(shapeType, prompt, controller, session);
        } else {
            picked = await runReselectSession<PickedRef>(this.host, controller, {
                prompt,
                shapeType,
                targetNode: this.host,
                emptyIsCancel: false,
                preview: () => {},
                setup: session.setup,
                preselect: () => this.preselect(current),
                capture: (shapes) => shapes.flatMap((shape) => this.capture(shape)),
                teardown: session.teardown,
            });
        }
        if (picked === undefined) return undefined;
        return toQueryValue(picked);
    }

    /** The rollback + see-through state a pick runs under, opened and closed around it. */
    private openSession(featureIndex: number, wanted: readonly PickKind[]) {
        const owner = this.host.document.visual.context.getVisual(this.host);
        const bodyShape = this.host.shape;
        const ownerShapeType = bodyShape.isOk ? bodyShape.value.shapeType : undefined;
        const transparent = wanted.includes("edge") || wanted.includes("vertex");
        const previousRollback = this.host.rollbackIndex;
        return {
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
        };
    }

    /** One entity: a host sub-shape, a reference plane in the viewport, or one picked in the tree. */
    private async pickWithPlanes(
        shapeType: ShapeType,
        prompt: I18nKeys,
        controller: AsyncController,
        session: { setup(): void; teardown(): void },
    ): Promise<PickedRef[] | undefined> {
        const document = this.host.document;
        const selection = document.selection;
        const history = document.history;
        const historyWasDisabled = history.disabled;
        history.disabled = true;
        selection.clearSelection();
        let cancelled = false;
        controller.onCancelled(() => (cancelled = true));
        const handler = new QueryPlanePickHandler(document, controller, shapeType, this.host);
        const fromTree = (nodes: INode[]) => {
            const plane = nodes.find((node) => node instanceof ReferencePlaneNode);
            if (plane === undefined) return;
            handler.result = { kind: "plane", node: plane };
            controller.success();
        };
        try {
            session.setup();
            selection.onNodeChanged.sub(fromTree);
            await document.picker.pickAsync(handler, prompt, controller, false, "select.default");
            if (cancelled) return undefined;
            const result = handler.result;
            if (result === undefined) return [];
            if (result.kind === "plane")
                return [{ kind: "plane", ref: captureFeatureScriptPlaneRef(result.node) }];
            return this.capture(result.data);
        } finally {
            selection.onNodeChanged.remove(fromTree);
            handler.dispose();
            session.teardown();
            history.disabled = historyWasDisabled;
            selection.setSelectedNodes([this.host], false);
        }
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
            case ShapeTypes.solid:
                return [{ kind: "body", ref: captureFeatureScriptBodyRef(picked.shape) }];
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

function toQueryValue(picked: readonly PickedRef[]): FeatureScriptQueryValue {
    const of = <K extends PickedRef["kind"]>(kind: K) =>
        picked.flatMap((entry) =>
            entry.kind === kind ? [entry.ref as Extract<PickedRef, { kind: K }>["ref"]] : [],
        );
    const value: {
        edges?: EdgeRef[];
        faces?: FeatureScriptFaceRef[];
        vertices?: { point: { x: number; y: number; z: number } }[];
        bodies?: FeatureScriptBodyRef[];
        planes?: FeatureScriptPlaneRef[];
    } = {};
    const edges = of("edge");
    const faces = of("face");
    const vertices = of("vertex");
    const bodies = of("body");
    const planes = of("plane");
    if (edges.length > 0) value.edges = edges;
    if (faces.length > 0) value.faces = faces;
    if (vertices.length > 0) value.vertices = vertices;
    if (bodies.length > 0) value.bodies = bodies;
    if (planes.length > 0) value.planes = planes;
    return value;
}

type QueryPlanePickResult =
    | { readonly kind: "shape"; readonly data: VisualShapeData }
    | { readonly kind: "plane"; readonly node: ReferencePlaneNode };

/**
 * One click: a sub-shape of the host body under the cursor, else a reference plane — the
 * shape wins, as a face in front of a datum plane should.
 */
class QueryPlanePickHandler extends ShapeSelectionHandler {
    result: QueryPlanePickResult | undefined;
    private hoveredPlane?: ReferencePlaneNode;

    constructor(document: IDocument, controller: AsyncController, shapeType: ShapeType, host: INode) {
        super(document, shapeType, false, controller, undefined, { allow: (node) => node === host });
        this.highlightState = VisualStates.faceHighlight;
    }

    protected override setHighlight(view: IView, event: PointerEvent): void {
        if (this.shapeType !== 0) super.setHighlight(view, event);
        const previous = this.hoveredPlane;
        this.hoveredPlane = this._highlights?.length
            ? undefined
            : (view
                  .detectVisual(event.offsetX, event.offsetY, {
                      allow: (node) => node instanceof ReferencePlaneNode,
                  })
                  .map((visual) => this.document.visual.context.getNode(visual))
                  .find((node) => node instanceof ReferencePlaneNode) as ReferencePlaneNode | undefined);
        if (previous !== this.hoveredPlane) {
            this.highlightPlane(previous, false);
            this.highlightPlane(this.hoveredPlane, true);
            view.update();
        }
    }

    override pointerOut(view: IView, event: PointerEvent): void {
        super.pointerOut(view, event);
        this.highlightPlane(this.hoveredPlane, false);
        this.hoveredPlane = undefined;
    }

    private highlightPlane(node: ReferencePlaneNode | undefined, add: boolean): void {
        if (node === undefined) return;
        const visual = this.document.visual.context.getVisual(node);
        if (visual === undefined) return;
        this.document.visual.highlighter[add ? "addState" : "removeState"](
            visual,
            VisualStates.faceHighlight,
            ShapeTypes.shape,
        );
    }

    protected override select(view: IView, event: PointerEvent): number {
        // A click may arrive without a preceding hover: pick at the release position.
        this.setHighlight(view, event);
        const shape = this._highlights?.[0];
        if (shape !== undefined) {
            this.result = { kind: "shape", data: shape };
            return 1;
        }
        if (this.hoveredPlane !== undefined) {
            this.result = { kind: "plane", node: this.hoveredPlane };
            return 1;
        }
        return 0;
    }

    protected override highlightNext(_view: IView): void {
        // One entity per pick: no cycling through stacked candidates.
    }

    protected override disposeInternal(): void {
        this.highlightPlane(this.hoveredPlane, false);
        super.disposeInternal();
    }
}
