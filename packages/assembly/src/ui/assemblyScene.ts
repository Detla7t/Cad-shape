// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type EdgeMeshData,
    type I18nKeys,
    type IApplication,
    type IDisposable,
    type IDocument,
    type IShape,
    type IView,
    type IVisualObject,
    Logger,
    Material,
    type Matrix4,
    ObservableCollection,
    Plane,
    Result,
    ShapeNode,
    type ShapeType,
    ShapeTypes,
    type VisualShapeData,
    VisualStates,
    XYZ,
} from "@chili3d/core";
import { DetachedDocument } from "../link/detachedDocument";
import { add, type Frame, fromMatrix4, scale, transformFrame, type Vec3 } from "../math/rigid";
import type { AssemblyEvaluation, PlacedPart } from "../model/evaluate";

/**
 * The assembly tab's own 3D scene.
 *
 * A document has one scene (its visual), shared by every view of it, and the Part Studio
 * owns it. Rather than hide Part Studio bodies and paint instances into that scene while the
 * tab is active (which would leak into selection, the model tree, snapping and saves), each
 * assembly view gets a PRESENTATION document — detached, never saved, never listed — with a
 * real visual from the application's visual factory and one view mounted in the tab. Its
 * nodes are lightweight, non-owning shape nodes, one per placed solid, whose `transform` is the
 * solid's placement; the regular renderer, picking, highlighting and mesh exporters all work on
 * it unchanged. The presentation document's application is the real one with its own view list,
 * so the scene's view never appears among the application's views or steals `activeView`.
 */

/** A placed solid in the presentation scene. It shows a shared shape and never disposes it. */
export class ScenePartNode extends ShapeNode {
    constructor(
        document: IDocument,
        readonly part: PlacedPart,
        materialId: string,
    ) {
        super({ document, name: part.name, materialId });
        this._shape = Result.ok(part.shape);
        this.setPrivateValue("transform", part.placement);
    }

    override display(): I18nKeys {
        return "assembly.instance";
    }

    /** Swaps in a new placed part (same solid, new placement, or a rebuilt shape). */
    update(part: PlacedPart): void {
        (this as { part: PlacedPart }).part = part;
        if (part.shape !== this._shape.unchecked()) {
            this._mesh = undefined;
            this._shape = Result.ok(part.shape);
            this.emitPropertyChanged("shape", Result.ok(part.shape));
        }
        this.transform = part.placement;
    }

    override disposeInternal(): void {
        // The shape belongs to the evaluation (a Part Studio node or the link cache).
        this._shape = Result.err("released");
        super.disposeInternal();
    }
}

/** The application seen by the presentation document: the real one, with a private view list. */
function sceneApplication(application: IApplication): IApplication {
    const scene = Object.create(application) as IApplication;
    Object.defineProperties(scene, {
        views: { value: new ObservableCollection<IView>() },
        documents: { value: new Set<IDocument>() },
        activeView: { value: undefined, writable: true },
    });
    return scene;
}

const PALETTE = [0x8fb3d9, 0xe0a96d, 0x9ccc9c, 0xd99a9a, 0xb8a9d9, 0xd9cf8f, 0x8fd1cc, 0xc4c4c4];

export interface ScenePick {
    readonly node: ScenePartNode;
    readonly part: PlacedPart;
    /** Hit point in world (assembly) coordinates. */
    readonly point: Vec3;
}

export interface SubShapePick extends ScenePick {
    readonly shape: IShape;
    readonly index: number;
    readonly data: VisualShapeData;
}

export class AssemblyScene implements IDisposable {
    readonly document: DetachedDocument;
    readonly view: IView | undefined;
    private readonly nodes = new Map<string, ScenePartNode>();
    private readonly materials = new Map<string, string>();
    private readonly highlighted = new Set<IVisualObject>();
    private markers: number[] = [];
    private subHighlights: VisualShapeData[] = [];
    private fitted = false;

    constructor(application: IApplication, container: HTMLElement | undefined) {
        const app = sceneApplication(application);
        this.document = new DetachedDocument(app, "Assembly", undefined, (document) =>
            application.visualFactory.create(document),
        );
        if (container === undefined) {
            this.view = undefined;
            return;
        }
        try {
            this.view = this.document.visual.createView("assembly", Plane.XY);
            this.view.setDom(container);
        } catch (error) {
            Logger.warn("assembly: no 3D view could be created", error);
            this.view = undefined;
        }
    }

    dispose(): void {
        this.clearMarkers();
        for (const node of this.nodes.values()) node.dispose();
        this.nodes.clear();
        this.view?.dispose();
        this.document.dispose();
    }

    get partNodes(): ScenePartNode[] {
        return [...this.nodes.values()];
    }

    private materialFor(key: string): string {
        let id = this.materials.get(key);
        if (id === undefined) {
            const material = new Material({
                document: this.document,
                name: key,
                color: PALETTE[this.materials.size % PALETTE.length],
            });
            this.document.modelManager.materials.push(material);
            id = material.id;
            this.materials.set(key, id);
        }
        return id;
    }

    /** Brings the scene in line with an evaluation: adds, updates and removes solids. */
    update(evaluation: AssemblyEvaluation): void {
        const seen = new Set<string>();
        const added: ScenePartNode[] = [];
        for (const part of evaluation.parts) {
            const key = `${part.instanceId}:${part.partIndex}`;
            seen.add(key);
            const node = this.nodes.get(key);
            if (node !== undefined) {
                node.update(part);
                continue;
            }
            const created = new ScenePartNode(this.document, part, this.materialFor(part.bomKey));
            this.nodes.set(key, created);
            added.push(created);
        }
        if (added.length > 0) this.document.modelManager.addNode(...added);
        for (const [key, node] of [...this.nodes]) {
            if (seen.has(key)) continue;
            this.nodes.delete(key);
            this.document.modelManager.rootNode.remove(node);
            node.dispose();
        }
        if (!this.fitted && this.nodes.size > 0 && this.view !== undefined) {
            this.fitted = true;
            this.view.cameraController.fitContent();
        }
        this.redraw();
    }

    /** Moves an instance's solids to `placement(part)` without touching the assembly (drag preview). */
    preview(instanceId: string, placementOf: (part: PlacedPart) => Matrix4): void {
        for (const node of this.nodes.values()) {
            if (node.part.instanceId === instanceId) node.transform = placementOf(node.part);
        }
        this.redraw();
    }

    redraw(): void {
        this.document.visual.update();
        this.view?.update();
    }

    fit(): void {
        this.view?.cameraController.fitContent();
        this.redraw();
    }

    // ------------------------------------------------------------------ Picking

    pickPart(x: number, y: number): ScenePick | undefined {
        const view = this.view;
        if (view === undefined) return undefined;
        const detected = view.detectShapes(ShapeTypes.shape, x, y);
        for (const data of detected) {
            const node = this.document.visual.context.getNode(data.owner);
            if (node instanceof ScenePartNode) {
                const point = data.point ?? view.screenToWorld(x, y);
                return { node, part: node.part, point: [point.x, point.y, point.z] };
            }
        }
        return undefined;
    }

    /**
     * The face, edge or vertex under the cursor. Faces win (their candidate origins already
     * include rim centers, edge midpoints and corners); `preferEdges` (Alt held) picks the
     * edge or vertex the viewport snaps to instead, for connectors along an edge.
     */
    pickSubShape(x: number, y: number, preferEdges = false): SubShapePick | undefined {
        const view = this.view;
        if (view === undefined) return undefined;
        const types = (ShapeTypes.face | ShapeTypes.edge | ShapeTypes.vertex) as ShapeType;
        const detected = view.detectShapes(types, x, y);
        const isFace = (data: VisualShapeData) => data.shape.shapeType === ShapeTypes.face;
        const ordered = preferEdges
            ? detected
            : [...detected.filter(isFace), ...detected.filter((d) => !isFace(d))];
        for (const data of ordered) {
            const node = this.document.visual.context.getNode(data.owner);
            if (!(node instanceof ScenePartNode) || data.indexes.length === 0) continue;
            const point = data.point ?? view.screenToWorld(x, y);
            return {
                node,
                part: node.part,
                point: [point.x, point.y, point.z],
                shape: data.shape,
                index: data.indexes[0],
                data,
            };
        }
        return undefined;
    }

    // ------------------------------------------------------------------ Highlighting

    highlightInstances(instanceIds: ReadonlySet<string>): void {
        const highlighter = this.document.visual.highlighter;
        for (const visual of this.highlighted)
            highlighter.removeState(visual, VisualStates.edgeSelected, ShapeTypes.shape);
        this.highlighted.clear();
        for (const node of this.nodes.values()) {
            if (!instanceIds.has(node.part.instanceId)) continue;
            const visual = this.document.visual.context.getVisual(node);
            if (visual === undefined) continue;
            highlighter.addState(visual, VisualStates.edgeSelected, ShapeTypes.shape);
            this.highlighted.add(visual);
        }
        this.redraw();
    }

    highlightSubShapes(picks: readonly VisualShapeData[]): void {
        const highlighter = this.document.visual.highlighter;
        for (const data of this.subHighlights) {
            highlighter.removeState(
                data.owner,
                VisualStates.faceSelected,
                data.shape.shapeType,
                ...data.indexes,
            );
            highlighter.removeState(
                data.owner,
                VisualStates.edgeSelected,
                data.shape.shapeType,
                ...data.indexes,
            );
        }
        this.subHighlights = [...picks];
        for (const data of picks) {
            const state =
                data.shape.shapeType === ShapeTypes.face
                    ? VisualStates.faceSelected
                    : VisualStates.edgeSelected;
            highlighter.addState(data.owner, state, data.shape.shapeType, ...data.indexes);
        }
        this.redraw();
    }

    /** Draws mate connector triads (Z long, X short), each given in its instance's coordinates. */
    showConnectors(
        connectors: readonly { frame: Frame; placement: Matrix4; color?: number }[],
        size: number,
    ): void {
        this.clearMarkers();
        const context = this.document.visual.context;
        for (const { frame, placement, color } of connectors) {
            const world = transformFrame(fromMatrix4(placement), frame);
            const o = world.origin;
            const z = add(o, scale(world.z, size));
            const x = add(o, scale(world.x, size * 0.6));
            const mesh: EdgeMeshData = {
                lineType: "solid",
                position: new Float32Array([...o, ...z, ...o, ...x]),
                range: [],
                color: color ?? 0xff8800,
                lineWidth: 3,
            };
            this.markers.push(context.displayMesh([mesh], { onTop: true }));
        }
        this.redraw();
    }

    clearMarkers(): void {
        for (const id of this.markers) this.document.visual.context.removeMesh(id);
        this.markers = [];
    }

    /** World point under the cursor on a plane through `through`, facing the camera. */
    pointOnViewPlane(x: number, y: number, through: Vec3): Vec3 | undefined {
        const view = this.view;
        if (view === undefined) return undefined;
        const ray = view.rayAt(x, y);
        const normal = view.direction();
        const plane = new Plane({
            origin: new XYZ(through[0], through[1], through[2]),
            normal,
            xvec: perpendicularTo(normal),
        });
        const hit = plane.intersectRay(ray);
        return hit === undefined ? undefined : [hit.x, hit.y, hit.z];
    }
}

function perpendicularTo(normal: XYZ): XYZ {
    const candidate = Math.abs(normal.z) < 0.9 ? XYZ.unitZ : XYZ.unitX;
    return normal.cross(candidate).normalize() ?? XYZ.unitX;
}
