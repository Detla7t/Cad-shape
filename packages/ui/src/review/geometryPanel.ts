// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CurveUtils,
    documentUnit,
    evaluateShapeProperties,
    formatDocumentValue,
    type IEdge,
    type IFace,
    type INodeVisual,
    type IShape,
    type IVertex,
    type IView,
    LENGTH_UNITS,
    Matrix4,
    PubSub,
    ShapeNode,
    type ShapeType,
    ShapeTypes,
    ShapeTypeUtils,
    VisualStates,
} from "@chili3d/core";
import { action, labeled, panelBody, table, textElement } from "./helpers";
import style from "./review.module.css";

export type GeometryPanelKind = "measure" | "analysis" | "mass";
export class GeometryPanel {
    readonly element: HTMLElement;
    private readonly output = document.createElement("div");
    private readonly density = document.createElement("input");
    private picker?: AsyncController;
    private disposed = false;
    private queued = false;
    constructor(
        private readonly view: IView,
        private readonly kind: GeometryPanelKind,
    ) {
        const { root, body } = panelBody(
            kind === "measure"
                ? "Measure details"
                : kind === "analysis"
                  ? "Analysis tools"
                  : "Mass and section properties",
        );
        this.element = root;
        const controls = document.createElement("div");
        controls.className = style.toolbar;
        controls.append(
            action("Select entities…", () => void this.pick()),
            action("Refresh", this.render),
        );
        if (kind === "analysis") controls.append(action("Section view…", () => view.showSectionView?.()));
        body.append(
            controls,
            textElement(
                "p",
                kind === "mass"
                    ? "Select solids for volume and center of mass, or planar faces for section area and moments. Density is optional and applies uniformly to the selection."
                    : "Select edges, faces, vertices or model items. Two entities also show their minimum distance.",
                style.muted,
            ),
        );
        if (kind === "mass") {
            this.density.type = "number";
            this.density.min = "0";
            this.density.step = "any";
            this.density.placeholder = "Enter density";
            this.density.setAttribute("aria-label", "Density in g/cm³");
            this.density.oninput = this.render;
            body.append(labeled("Density (g/cm³)", this.density));
        }
        body.append(this.output);
        view.document.selection.onNodeChanged.sub(this.render);
        view.document.selection.onShapeChanged.sub(this.render);
        PubSub.default.sub("documentUnitsChanged", this.unitsChanged);
        view.document.history.onChanged(this.modelChanged);
        this.render();
        root.addEventListener("keydown", (event) => event.stopPropagation());
    }
    private async pick() {
        this.picker?.cancel();
        const controller = new AsyncController();
        this.picker = controller;
        try {
            const picks = await this.view.document.picker.pickShape("prompt.select.shape", controller, {
                shapeType: (ShapeTypes.edge | ShapeTypes.face | ShapeTypes.vertex) as ShapeType,
                multi: true,
            });
            if (!this.disposed && picks.length) {
                this.view.document.selection.clearSelection();
                this.view.document.selection.setSelectedShapes(picks, VisualStates.edgeSelected, false);
            }
        } catch (error) {
            if (!this.disposed) this.output.replaceChildren(textElement("p", String(error), style.error));
        } finally {
            controller.dispose();
            if (this.picker === controller) this.picker = undefined;
        }
    }
    private readonly unitsChanged = (doc: IView["document"]) => {
        if (doc === this.view.document) this.render();
    };
    private readonly modelChanged = () => {
        if (this.queued || this.disposed) return;
        this.queued = true;
        queueMicrotask(() => {
            this.queued = false;
            this.render();
        });
    };
    private collect(): IShape[] {
        const doc = this.view.document,
            picks = doc.selection.getSelectedShapes();
        if (picks.length) return picks.map((pick) => pick.shape.transformedMul(pick.transform));
        return doc.selection.getSelectedNodes().flatMap((node) => {
            if (!(node instanceof ShapeNode) || !node.shape.isOk) return [];
            const visual = doc.visual.context.getVisual(node) as INodeVisual | undefined;
            return [node.shape.value.transformedMul(visual?.worldTransform() ?? Matrix4.identity())];
        });
    }
    private readonly render = () => {
        if (this.disposed) return;
        const shapes: IShape[] = [];
        try {
            shapes.push(...this.collect());
            if (!shapes.length) {
                this.output.replaceChildren(
                    textElement("p", "Select geometry to see its properties.", style.muted),
                );
                return;
            }
            const doc = this.view.document,
                unit = documentUnit(doc, LENGTH_UNITS);
            const length = (v: number) => formatDocumentValue(v, doc, LENGTH_UNITS);
            const power = (v: number, n: number) =>
                `${(v / unit.factor ** n).toFixed(unit.precision)} ${unit.suffix}${n === 2 ? "²" : n === 3 ? "³" : n === 4 ? "⁴" : n === 5 ? "⁵" : ""}`;
            const rows: string[][] = [
                ["Property", "Value"],
                ["Selected entities", String(shapes.length)],
            ];
            if (this.kind === "mass") {
                const result = evaluateShapeProperties(shapes);
                if (!result.isOk) {
                    this.output.replaceChildren(textElement("p", result.error, style.error));
                    return;
                }
                const props = result.value;
                rows.push(
                    [
                        props.dimension === 3
                            ? "Volume"
                            : props.dimension === 2
                              ? "Section / surface area"
                              : "Length",
                        power(props.measure, props.dimension),
                    ],
                    ["Centroid X", length(props.centroid[0])],
                    ["Centroid Y", length(props.centroid[1])],
                    ["Centroid Z", length(props.centroid[2])],
                );
                const density = this.density.valueAsNumber;
                if (props.dimension === 3 && Number.isFinite(density) && density > 0)
                    rows.push(["Mass", `${((props.measure * density) / 1e6).toFixed(6)} kg`]);
                for (let i = 0; i < 3; i++)
                    for (let j = i; j < 3; j++)
                        rows.push([
                            `I${"xyz"[i]}${"xyz"[j]} (centroid)`,
                            power(props.inertia[i][j], props.dimension + 2),
                        ]);
                this.output.replaceChildren(
                    table(rows),
                    textElement(
                        "p",
                        props.dimension === 3
                            ? "Geometric moments are per unit density about world-aligned centroid axes. Mass uses the density entered above."
                            : "Section/surface moments use world-aligned centroid axes. Select a planar face for a planar section.",
                        style.muted,
                    ),
                );
                return;
            }
            let lengthSum = 0,
                areaSum = 0,
                volumeSum = 0;
            shapes.forEach((shape, index) => {
                const edges = ShapeTypeUtils.hasEdge(shape.shapeType)
                    ? [shape as IEdge]
                    : (shape.findSubShapes(ShapeTypes.edge) as IEdge[]);
                const faces = ShapeTypeUtils.hasFace(shape.shapeType)
                    ? [shape as IFace]
                    : (shape.findSubShapes(ShapeTypes.face) as IFace[]);
                try {
                    if (shape.shapeType === ShapeTypes.vertex) {
                        const point = (shape as IVertex).point();
                        rows.push(
                            [`Point ${index + 1} X`, length(point.x)],
                            [`Point ${index + 1} Y`, length(point.y)],
                            [`Point ${index + 1} Z`, length(point.z)],
                        );
                    }
                    lengthSum += edges.reduce((sum, edge) => sum + edge.length(), 0);
                    areaSum += faces.reduce((sum, face) => sum + face.area(), 0);
                    if (ShapeTypeUtils.hasSolid(shape.shapeType) || shape.shapeType === ShapeTypes.compound)
                        volumeSum += Math.abs(shape.volume());
                    if (this.kind === "analysis") {
                        rows.push(
                            [`Entity ${index + 1}`, ShapeTypeUtils.stringValue(shape.shapeType)],
                            [`Entity ${index + 1} validity`, shape.checkShape() ? "Valid" : "Invalid"],
                            [`Entity ${index + 1} topology`, `${faces.length} faces · ${edges.length} edges`],
                        );
                        if (ShapeTypeUtils.hasFace(shape.shapeType)) {
                            const surface = (shape as IFace).surface();
                            try {
                                rows.push(
                                    ["Surface", surface.isPlanar() ? "Planar" : "Curved"],
                                    ["Continuity", surface.continuity()],
                                );
                            } finally {
                                surface.dispose();
                            }
                        }
                    }
                    if (ShapeTypeUtils.hasEdge(shape.shapeType)) {
                        const curve = (shape as IEdge).curve;
                        try {
                            const basis = curve.basisCurve;
                            try {
                                rows.push([`Edge ${index + 1} curve`, basis.curveType]);
                                if (CurveUtils.isCircle(basis))
                                    rows.push(
                                        ["Radius", length(basis.radius)],
                                        ["Diameter", length(2 * basis.radius)],
                                    );
                            } finally {
                                basis.dispose();
                            }
                        } finally {
                            curve.dispose();
                        }
                    }
                } finally {
                    for (const edge of edges) if (edge !== shape) edge.dispose();
                    for (const face of faces) if (face !== shape) face.dispose();
                }
            });
            rows.push(["Total edge length", length(lengthSum)]);
            if (areaSum) rows.push(["Surface area", power(areaSum, 2)]);
            if (volumeSum) rows.push(["Volume", power(volumeSum, 3)]);
            if (shapes.length === 2)
                rows.push(["Minimum distance", length(shapes[0].extremaDistance(shapes[1]))]);
            this.output.replaceChildren(table(rows));
        } catch (error) {
            this.output.replaceChildren(
                textElement("p", error instanceof Error ? error.message : String(error), style.error),
            );
        } finally {
            shapes.forEach((shape) => shape.dispose());
        }
    };
    dispose() {
        this.disposed = true;
        this.picker?.cancel();
        this.view.document.selection.onNodeChanged.remove(this.render);
        this.view.document.selection.onShapeChanged.remove(this.render);
        PubSub.default.remove("documentUnitsChanged", this.unitsChanged);
        this.view.document.history.removeChanged(this.modelChanged);
    }
}
