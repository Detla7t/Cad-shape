// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    debounce,
    type FeaturePickKind,
    type I18nKeys,
    type IDocument,
    type IEdge,
    type IFace,
    type INode,
    type INodeVisual,
    type IShape,
    type IVertex,
    type IView,
    ReferencePlaneNode,
    Result,
    ShapeSelectionHandler,
    type ShapeType,
    ShapeTypes,
    type VisualShapeData,
    VisualStates,
    XYZ,
} from "@chili3d/core";
import { matchEdgeIndexes } from "../features/edgeMatcher";
import { captureEdgeRef, type EdgeRef } from "../features/edgeRef";
import {
    evaluateFeature,
    type FeatureScriptBodyRef,
    type FeatureScriptFaceRef,
    type FeatureScriptFeatureData,
    type FeatureScriptPlaneRef,
    type FeatureScriptQueryValue,
} from "../features/feature";
import {
    captureFeatureScriptBodyRef,
    captureFeatureScriptFaceRef,
    captureFeatureScriptPlaneRef,
    matchFeatureScriptFace,
} from "../featurescript/featureScriptFeature";
import { displayChainPreview, type ReselectHost, runReselectSession } from "./reselectSession";

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

/** One `Query` parameter of a FeatureScript feature on a body, as a pick session addresses it. */
export interface QueryPickTarget {
    readonly feature: FeatureScriptFeatureData;
    readonly featureIndex: number;
    readonly key: string;
}

/**
 * Picks the entities of one FeatureScript `Query` parameter on the host body.
 *
 * Same footing as the fillet edge re-pick (`EdgeReselectSession`): the body is rolled
 * back to just before the feature for the session, because the picks address the
 * feature's INPUT — the geometry the custom feature receives — not its output. Refs are
 * captured with the body's tracked ids while the rolled-back cache still describes that
 * input. Confirming with nothing picked clears the parameter.
 *
 * Every selection change previews the feature's result (`previewQueryPick`) as a temporary
 * mesh over the see-through input, as Onshape's dialog shows a fillet or shell the moment
 * its edges or faces are picked. A pick that fails to build simply shows no preview; the
 * dialog's own rebuild reports why once the pick is confirmed.
 *
 * A part pick (std's `EntityType.BODY`) takes the solid under the cursor. A parameter that
 * accepts planes (std's `ALLOWS_PLANE` / `ALLOWS_DIRECTION`) takes one entity per pick, as
 * Onshape's single-pick boxes do: a host face or edge, a reference plane in the viewport,
 * or a plane clicked in the model tree (Top, Front, Right…).
 */
export class FeatureScriptPickSession {
    private _preview: number | undefined;
    private _previewTransparent = false;

    constructor(private readonly host: ReselectHost) {}

    async pick(
        target: QueryPickTarget,
        kinds: readonly PickKind[],
        controller: AsyncController,
    ): Promise<FeatureScriptQueryValue | undefined> {
        const current = target.feature.definition[target.key];
        const wanted = kinds.length === 0 ? (["edge", "face"] as PickKind[]) : kinds;
        const shapeType = wanted.reduce<number>(
            (mask, kind) => (kind === "plane" ? mask : mask | SHAPE_TYPES[kind]),
            0,
        ) as ShapeType;
        const prompt = wanted.length === 1 ? PROMPTS[wanted[0]] : "prompt.select.entities";
        const session = this.openSession(target.featureIndex, wanted);
        let picked: PickedRef[] | undefined;
        if (wanted.includes("plane")) {
            picked = await this.pickWithPlanes(shapeType, prompt, controller, session);
        } else {
            let active = true;
            const preview = debounce((selected: VisualShapeData[]) => {
                if (active) this.previewSelection(target, selected);
            }, 20);
            picked = await runReselectSession<PickedRef>(this.host, controller, {
                prompt,
                shapeType,
                targetNode: this.host,
                emptyIsCancel: false,
                preview,
                setup: session.setup,
                preselect: () => this.preselect(typeof current === "object" ? current : undefined),
                capture: (shapes) => shapes.flatMap((shape) => this.capture(shape)),
                teardown: () => {
                    active = false;
                    this.clearPreview();
                    session.teardown();
                },
            });
        }
        if (picked === undefined) return undefined;
        return toQueryValue(picked);
    }

    /** The rollback + see-through state a pick runs under, opened and closed around it. */
    private openSession(featureIndex: number, wanted: readonly PickKind[]) {
        const transparent = wanted.includes("edge") || wanted.includes("vertex");
        const previousRollback = this.host.rollbackIndex;
        return {
            setup: () => {
                if (!this.host.setRollbackIndex(featureIndex))
                    throw new Error("Cannot select entities because the feature input failed to rebuild.");
                if (transparent) this.setTransparent(true);
            },
            teardown: () => {
                if (transparent) this.setTransparent(false);
                this.host.setRollbackIndex(previousRollback);
            },
        };
    }

    private setTransparent(on: boolean): void {
        const owner = this.host.document.visual.context.getVisual(this.host);
        const shape = this.host.shape;
        if (owner === undefined || !shape.isOk) return;
        this.host.document.visual.highlighter[on ? "addState" : "removeState"](
            owner,
            VisualStates.faceTransparent,
            shape.value.shapeType,
        );
    }

    /**
     * Live preview while picking: the feature evaluated with the selected entities in the
     * target box, shown as a temporary opaque mesh. The input turns see-through while a
     * preview is up (a shell's cavity or a fillet's recessed surface would otherwise hide
     * inside the opaque input) and back when the selection empties or fails to build.
     */
    private previewSelection(target: QueryPickTarget, selected: VisualShapeData[]): void {
        this.clearPreview();
        const value = captureQueryPicks(this.host, selected);
        if (!isEmptyQuery(value)) {
            const shape = previewQueryPick(this.host, target.feature, target.key, value);
            if (shape.isOk) {
                this._preview = displayChainPreview(this.host, shape.value);
                if (this._preview !== undefined) {
                    this._previewTransparent = true;
                    this.setTransparent(true);
                }
            }
        }
        this.host.document.visual.update();
    }

    private clearPreview(): void {
        if (this._previewTransparent) {
            this._previewTransparent = false;
            this.setTransparent(false);
        }
        if (this._preview === undefined) return;
        this.host.document.visual.context.removeMesh(this._preview);
        this._preview = undefined;
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
        return captureHostPick(this.host, picked);
    }

    /**
     * Selects the entities the parameter currently names — edges, faces and parts — so the
     * pick starts from them and the box counts them. Entities that no longer match are
     * left out: a failed match is a common reason to re-pick.
     */
    private preselect(current: FeatureScriptQueryValue | undefined): void {
        if (current === undefined) return;
        const shape = this.host.shape;
        if (!shape.isOk) return;
        const owner = this.host.document.visual.context.getVisual(this.host) as INodeVisual | undefined;
        if (owner === undefined) return;
        const transform = owner.worldTransform();
        const mesh = shape.value.mesh;
        const selection = this.host.document.selection;

        const edgeRanges = mesh.edges?.range;
        const edges = current.edges ?? [];
        if (edges.length > 0 && edgeRanges !== undefined) {
            const indexes = matchEdgeIndexes(shape.value, edges);
            if (indexes.isOk) {
                // Mesh ranges enumerate edges in the same order as findSubShapes (both use
                // TopExp::MapShapes), so a matched position indexes into the ranges directly.
                // The range shapes also carry the sub-edge ids detection produces, which the
                // selection's toggle matching relies on.
                const picked: VisualShapeData[] = indexes.value.map((index) => ({
                    owner,
                    shape: edgeRanges[index].shape,
                    transform,
                    indexes: [index],
                }));
                selection.setSelectedShapes(picked, VisualStates.edgeSelected, false);
            }
        }

        const faceRanges = mesh.faces?.range;
        if (faceRanges === undefined) return;
        const faces = shape.value.findSubShapes(ShapeTypes.face) as IFace[];
        const ids = faces.map((_, index) => this.host.faceIdAt(index) ?? "");
        const pickedFaces: VisualShapeData[] = [];
        for (const ref of current.faces ?? []) {
            const index = matchFeatureScriptFace(faces, ref, ids);
            if (index !== undefined && faceRanges[index] !== undefined)
                pickedFaces.push({ owner, shape: faceRanges[index].shape, transform, indexes: [index] });
        }
        // A part is picked as its solid with every face range it owns, the way the view
        // reports a click on one of its faces.
        const solids = shape.value.findSubShapes(ShapeTypes.solid);
        for (const ref of current.bodies ?? []) {
            const solid = matchSolid(solids, ref);
            if (solid === undefined) continue;
            const indexes: number[] = [];
            for (const face of solid.findSubShapes(ShapeTypes.face)) {
                const index = faceRanges.findIndex((range) => range.shape.isEqual(face));
                if (index >= 0) indexes.push(index);
            }
            pickedFaces.push({ owner, shape: solid, transform, indexes });
        }
        if (pickedFaces.length > 0)
            selection.setSelectedShapes(pickedFaces, VisualStates.faceSelected, false);
    }
}

/** The ref of one picked sub-shape of the host, with the body's tracked id where it has one. */
function captureHostPick(host: ReselectHost, picked: VisualShapeData): PickedRef[] {
    const index = picked.indexes[0];
    switch (picked.shape.shapeType) {
        case ShapeTypes.edge: {
            const id = host.edgeIdAt(index);
            return [
                {
                    kind: "edge",
                    ref: captureEdgeRef(picked.shape as unknown as IEdge, id, host.edgeIdIsShared(id)),
                },
            ];
        }
        case ShapeTypes.face:
            return [
                {
                    kind: "face",
                    ref: captureFeatureScriptFaceRef(picked.shape as unknown as IFace, host.faceIdAt(index)),
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

/**
 * The query value of the selected sub-shapes that belong to `host` — what a box takes from
 * a selection made before the tool was started (Onshape fills the first box with the
 * preselection) and what the live preview evaluates. `kinds` limits what counts.
 */
export function captureQueryPicks(
    host: ReselectHost,
    selected: readonly VisualShapeData[],
    kinds?: readonly PickKind[],
): FeatureScriptQueryValue {
    const allowed =
        kinds === undefined || kinds.length === 0
            ? undefined
            : kinds.flatMap((kind) => (kind === "plane" ? [] : [SHAPE_TYPES[kind]]));
    const picks = selected
        .filter((data) => (data.owner.node as INode) === host)
        .filter((data) => allowed === undefined || allowed.includes(data.shape.shapeType))
        .flatMap((data) => captureHostPick(host, data));
    return toQueryValue(picks);
}

export function isEmptyQuery(value: FeatureScriptQueryValue): boolean {
    return (
        (value.edges?.length ?? 0) +
            (value.faces?.length ?? 0) +
            (value.vertices?.length ?? 0) +
            (value.bodies?.length ?? 0) +
            (value.planes?.length ?? 0) ===
        0
    );
}

/**
 * The feature's result with `key` picked as `value`, evaluated on the host's CURRENT
 * shape — the feature's input while the body is rolled back to the feature for a pick.
 * Fails when the feature does not build or leaves its input untouched; the caller owns
 * a successful shape.
 */
export function previewQueryPick(
    host: ReselectHost,
    feature: FeatureScriptFeatureData,
    key: string,
    value: FeatureScriptQueryValue,
): Result<IShape> {
    const input = host.shape;
    if (!input.isOk) return Result.err(input.error);
    const preview: FeatureScriptFeatureData = {
        ...feature,
        definition: { ...feature.definition, [key]: value },
    };
    const scope = host.document.variables.evaluate().scope;
    let result: Result<IShape>;
    try {
        result = evaluateFeature(preview, { document: host.document, host, input: input.value, scope });
    } catch (error) {
        return Result.err(String(error));
    }
    if (!result.isOk) return result;
    if (result.value === input.value) return Result.err("The feature leaves its input unchanged");
    return result;
}

/** The solid a part fingerprint names, when exactly one is nearest. */
function matchSolid(solids: readonly IShape[], ref: FeatureScriptBodyRef): IShape | undefined {
    const size = Math.cbrt(Math.max(Math.abs(ref.volume), 1e-9));
    const ranked = solids
        .map((solid) => {
            try {
                const print = captureFeatureScriptBodyRef(solid);
                const score =
                    new XYZ(print.center).distanceTo(new XYZ(ref.center)) +
                    Math.abs(print.volume - ref.volume) / (size * size);
                return { solid, score };
            } catch {
                return { solid, score: Number.POSITIVE_INFINITY };
            }
        })
        .filter((entry) => Number.isFinite(entry.score))
        .sort((a, b) => a.score - b.score);
    const best = ranked[0];
    if (best === undefined) return undefined;
    if (ranked[1] !== undefined && ranked[1].score - best.score < 1e-6 * size) return undefined;
    return best.solid;
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
    /** The tree's Top/Front/Right rows are picks too (`pickWithPlanes` listens to the selection). */
    readonly treeSelection = true;
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
