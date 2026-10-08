// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    Config,
    CurveUtils,
    documentQuantityUnit,
    documentUnit,
    documentUnits,
    evaluateSelectionMeasurement,
    evaluateShapeProperties,
    formatDocumentQuantity,
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
    unitSuffix,
    VisualStates,
} from "@chili3d/core";
import { action, labeled, panelBody, table, textElement } from "./helpers";
import style from "./review.module.css";

export type GeometryPanelKind = "measure" | "analysis" | "mass";
export class GeometryPanel {
    readonly element: HTMLElement;
    private readonly output = document.createElement("div");
    private readonly density = document.createElement("input");
    private readonly densityLabel = document.createElement("label");
    private densityFactor = 1000;
    private readonly measureType = document.createElement("select");
    private readonly lengthUnit = document.createElement("select");
    private readonly angleUnit = document.createElement("select");
    private massMode: "part" | "face" = "part";
    private picker?: AsyncController;
    private disposed = false;
    private queued = false;
    constructor(
        private readonly view: IView,
        private readonly kind: GeometryPanelKind,
        private readonly analysisTool: "geometry" | "interference" = "geometry",
    ) {
        const { root, body } = panelBody(
            kind === "measure"
                ? "Measure details"
                : kind === "analysis"
                  ? "Analysis tools"
                  : "Mass and section properties",
        );
        this.element = root;
        root.classList.add(style.geometryPanel);
        const controls = document.createElement("div");
        controls.className = style.toolbar;
        controls.append(
            action(
                kind === "measure" ? "Select entities to measure" : "Select entities…",
                () => void this.pick(),
            ),
            action("Refresh", this.render),
        );
        if (kind === "analysis") controls.append(action("Section view…", () => view.showSectionView?.()));
        body.append(
            controls,
            textElement(
                "p",
                kind === "analysis"
                    ? analysisTool === "interference"
                        ? "Select two solid parts to calculate their common volume. Touching faces or edges have zero interference volume."
                        : "Numerical geometry inspection. Curvature combs and surface analysis overlays are not yet supported."
                    : kind === "mass"
                      ? "Select solids for volume and center of mass, or planar faces for section area and moments. Density is optional and applies uniformly to the selection."
                      : "Select edges, faces, vertices or model items. Two entities also show their minimum distance.",
                style.muted,
            ),
        );
        if (kind === "measure") {
            this.addSelect(body, "Measure type", this.measureType, [
                ["all", "Show all"],
                ["position", "Position"],
                ["length", "Length"],
                ["radius", "Radius"],
                ["diameter", "Diameter"],
                ["angle", "Angle"],
                ["distance", "Minimum distance"],
                ["maxDistance", "Maximum distance"],
                ["area", "Area"],
                ["volume", "Volume"],
            ]);
            this.addSelect(body, "Length unit", this.lengthUnit, [
                ["mm", "Millimeter"],
                ["cm", "Centimeter"],
                ["m", "Meter"],
                ["in", "Inch"],
                ["ft", "Foot"],
            ]);
            this.addSelect(body, "Angle unit", this.angleUnit, [
                ["deg", "Degree"],
                ["rad", "Radian"],
            ]);
            const units = documentUnits(view.document);
            this.lengthUnit.value = units.length;
            this.angleUnit.value = units.angle;
            body.append(
                this.unavailable(
                    "Reference coordinate system",
                    "Mate connector reference frames are not yet supported by this inspector.",
                ),
            );
        }
        if (kind === "mass") {
            const tabs = document.createElement("div");
            tabs.className = style.toolbar;
            tabs.setAttribute("role", "tablist");
            tabs.setAttribute("aria-label", "Mass or section properties");
            for (const mode of ["part", "face"] as const) {
                const tab = action(mode === "part" ? "Part" : "Face", () => {
                    this.massMode = mode;
                    for (const item of tabs.children)
                        item.setAttribute("aria-selected", String(item === tab));
                    this.density.disabled = mode === "face";
                    this.render();
                });
                tab.setAttribute("role", "tab");
                tab.setAttribute("aria-selected", String(mode === this.massMode));
                tabs.append(tab);
            }
            body.prepend(tabs);
            body.append(
                this.unavailable(
                    "Mate connector for reference frame",
                    "Reference frame selection is not yet supported; results use world-aligned centroid axes.",
                ),
                this.unavailable(
                    "Show calculation variance",
                    "The current integration provider does not return a certified error bound.",
                ),
            );
            this.density.type = "number";
            this.density.min = "0";
            this.density.step = "any";
            this.density.placeholder = "Enter density";
            this.updateDensityUnit();
            this.density.oninput = this.render;
            body.append(this.densityLabel);
        }
        body.append(this.output);
        view.document.selection.onNodeChanged.sub(this.render);
        view.document.selection.onShapeChanged.sub(this.render);
        PubSub.default.sub("documentUnitsChanged", this.unitsChanged);
        Config.instance.onPropertyChanged(this.preferencesChanged);
        view.document.history.onChanged(this.modelChanged);
        this.render();
        root.addEventListener("keydown", (event) => event.stopPropagation());
    }
    private addSelect(body: HTMLElement, label: string, select: HTMLSelectElement, options: string[][]) {
        for (const [value, text] of options) {
            const option = textElement("option", text);
            option.value = value;
            select.add(option);
        }
        select.value = options[0][0];
        select.setAttribute("aria-label", label);
        select.onchange = this.render;
        body.append(labeled(label, select));
    }
    private unavailable(label: string, reason: string) {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.disabled = true;
        input.setAttribute("aria-label", label);
        const row = labeled(label, input);
        row.title = reason;
        row.append(textElement("small", reason, style.muted));
        return row;
    }
    private async pick() {
        this.picker?.cancel();
        const controller = new AsyncController();
        this.picker = controller;
        try {
            const picks = await this.view.document.picker.pickShape("prompt.select.shape", controller, {
                shapeType:
                    this.kind === "analysis" && this.analysisTool === "interference"
                        ? ShapeTypes.solid
                        : this.kind === "mass"
                          ? this.massMode === "part"
                              ? ShapeTypes.solid
                              : ShapeTypes.face
                          : ((ShapeTypes.edge | ShapeTypes.face | ShapeTypes.vertex) as ShapeType),
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
        if (doc === this.view.document) {
            this.updateDensityUnit();
            this.render();
        }
    };
    private readonly preferencesChanged = (key: keyof Config) => {
        if (key === "preferences") this.render();
    };
    private updateDensityUnit() {
        const unit = documentQuantityUnit(this.view.document, "density");
        if (Number.isFinite(this.density.valueAsNumber))
            this.density.value = String((this.density.valueAsNumber * this.densityFactor) / unit.factor);
        this.densityFactor = unit.factor;
        this.density.setAttribute("aria-label", `Density in ${unit.suffix}`);
        this.densityLabel.replaceChildren(document.createTextNode(`Density (${unit.suffix})`), this.density);
    }
    private readonly modelChanged = () => {
        if (this.queued || this.disposed) return;
        this.queued = true;
        queueMicrotask(() => {
            this.queued = false;
            this.render();
        });
    };
    private collect(shapes: IShape[]): void {
        const doc = this.view.document;
        const picks = doc.selection.getSelectedShapes();
        const requireValid = (node: unknown) => {
            if (node instanceof ShapeNode && (node.evaluationError || !node.shape.isOk))
                throw new Error(
                    "Cannot measure a model with a failed rebuild. Resolve its feature errors first.",
                );
        };
        if (picks.length) {
            for (const pick of picks) {
                requireValid(pick.owner.node);
                shapes.push(pick.shape.transformedMul(pick.transform));
            }
            return;
        }
        for (const node of doc.selection.getSelectedNodes()) {
            if (!(node instanceof ShapeNode)) continue;
            requireValid(node);
            if (!node.shape.isOk) continue;
            const visual = doc.visual.context.getVisual(node) as INodeVisual | undefined;
            shapes.push(node.shape.value.transformedMul(visual?.worldTransform() ?? Matrix4.identity()));
        }
    }
    private readonly render = () => {
        if (this.disposed) return;
        const shapes: IShape[] = [];
        try {
            this.collect(shapes);
            if (!shapes.length) {
                this.output.replaceChildren(
                    textElement("p", "Select geometry to see its properties.", style.muted),
                );
                return;
            }
            const doc = this.view.document,
                unit = documentUnit(doc, LENGTH_UNITS);
            if (this.kind === "measure") {
                unit.suffix = this.lengthUnit.value;
                unit.factor = unitSuffix(unit.suffix)?.factor ?? 1;
            }
            const length = (v: number) => `${(v / unit.factor).toFixed(unit.precision)} ${unit.suffix}`;
            const power = (v: number, n: number) =>
                `${(v / unit.factor ** n).toFixed(unit.precision)} ${unit.suffix}${n === 2 ? "²" : n === 3 ? "³" : n === 4 ? "⁴" : n === 5 ? "⁵" : ""}`;
            const rows: string[][] = [
                ["Property", "Value"],
                ["Selected entities", String(shapes.length)],
            ];
            if (this.kind === "analysis" && this.analysisTool === "interference") {
                if (shapes.length !== 2 || shapes.some((shape) => shape.shapeType !== ShapeTypes.solid)) {
                    this.output.replaceChildren(
                        textElement("p", "Select exactly two solid parts.", style.muted),
                    );
                    return;
                }
                if (shapes.some((shape) => !shape.checkShape()))
                    throw new Error("Cannot analyze invalid solid geometry.");
                const common = shapeFactory.booleanCommon([shapes[0]], [shapes[1]]);
                if (!common.isOk) throw new Error(common.error);
                try {
                    const volume = Math.abs(common.value.volume());
                    rows.push(["Common volume", power(volume, 3)]);
                    rows.push([
                        "Result",
                        volume > 1e-9 ? "Interference detected" : "No volumetric interference",
                    ]);
                    this.output.replaceChildren(table(rows));
                } finally {
                    common.value.dispose();
                }
                return;
            }
            if (this.kind === "mass") {
                const validSelection = shapes.every((shape) =>
                    this.massMode === "face"
                        ? shape.shapeType === ShapeTypes.face
                        : shape.shapeType === ShapeTypes.solid ||
                          shape.shapeType === ShapeTypes.compoundSolid,
                );
                if (!validSelection) {
                    this.output.replaceChildren(
                        textElement(
                            "p",
                            this.massMode === "face"
                                ? "Select planar faces for section properties."
                                : "Select solid parts for mass properties.",
                            style.muted,
                        ),
                    );
                    return;
                }
                if (this.massMode === "face") {
                    let reference: ReturnType<IFace["normal"]> | undefined;
                    for (const shape of shapes) {
                        const face = shape as IFace;
                        const surface = face.surface();
                        try {
                            const bounds = surface.bounds();
                            const current = face.normal(
                                (bounds.u1 + bounds.u2) / 2,
                                (bounds.v1 + bounds.v2) / 2,
                            );
                            if (
                                !surface.isPlanar() ||
                                (reference &&
                                    (reference[1].cross(current[1]).length() > 1e-7 ||
                                        Math.abs(current[0].sub(reference[0]).dot(reference[1])) > 1e-7))
                            ) {
                                this.output.replaceChildren(
                                    textElement(
                                        "p",
                                        "Section properties require coplanar planar faces.",
                                        style.error,
                                    ),
                                );
                                return;
                            }
                            reference = current;
                        } finally {
                            surface.dispose();
                        }
                    }
                }
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
                const density = (this.density.valueAsNumber * this.densityFactor) / 1000;
                if (props.dimension === 3 && Number.isFinite(density) && density > 0)
                    rows.push([
                        "Mass",
                        formatDocumentQuantity((props.measure * density) / 1e6, this.view.document, "mass"),
                    ]);
                else if (props.dimension === 3)
                    rows.push(["Mass", "Enter a density; material densities are not assigned."]);
                let surfaceArea = 0;
                let perimeter = 0;
                for (const shape of shapes) {
                    const faces =
                        shape.shapeType === ShapeTypes.face
                            ? [shape as IFace]
                            : (shape.findSubShapes(ShapeTypes.face) as IFace[]);
                    try {
                        surfaceArea += faces.reduce((sum, face) => sum + face.area(), 0);
                    } finally {
                        for (const face of faces) if (face !== shape) face.dispose();
                    }
                    if (this.massMode === "face") {
                        const edges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
                        try {
                            perimeter += edges.reduce((sum, edge) => sum + edge.length(), 0);
                        } finally {
                            for (const edge of edges) edge.dispose();
                        }
                    }
                }
                if (this.massMode === "part") rows.push(["Surface area", power(surfaceArea, 2)]);
                else rows.push(["Perimeter (sum of face boundaries)", length(perimeter)]);
                for (let i = 0; i < 3; i++)
                    for (let j = 0; j < 3; j++)
                        rows.push([
                            `I${"xyz"[i]}${"xyz"[j]} (centroid)`,
                            props.dimension === 3 && Number.isFinite(density) && density > 0
                                ? `${((props.inertia[i][j] * density) / 1e6 / unit.factor ** 2).toFixed(unit.precision)} kg·${unit.suffix}²`
                                : power(props.inertia[i][j], props.dimension + 2),
                        ]);
                this.output.replaceChildren(
                    table(rows),
                    textElement(
                        "p",
                        props.dimension === 3
                            ? "Without density, moments are geometric (per unit density). With density, they are mass moments. Axes are world-aligned through the centroid. Overrides are not yet supported."
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
                        // Edge.curve and its basis are borrowed, cached values owned by the edge.
                        const basis = (shape as IEdge).curve.basisCurve;
                        rows.push([`Edge ${index + 1} curve`, basis.curveType]);
                        if (CurveUtils.isCircle(basis))
                            rows.push(
                                ["Radius", length(basis.radius)],
                                ["Diameter", length(2 * basis.radius)],
                            );
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
            if (
                this.kind === "measure" &&
                shapes.length === 2 &&
                ["all", "maxDistance"].includes(this.measureType.value)
            ) {
                const maximum = shapes[0].distanceMeasure?.(shapes[1], true);
                if (maximum?.isOk) rows.push(["Maximum distance", length(maximum.value.value)]);
            }
            if (this.kind === "measure" && shapes.length === 1 && shapes[0].shapeType === ShapeTypes.face) {
                const radial = evaluateSelectionMeasurement(doc, "diameter");
                if (radial.isOk && radial.value.measurement.mode === "diameter")
                    rows.push(
                        ["Radius", length(radial.value.measurement.value / 2)],
                        ["Diameter", length(radial.value.measurement.value)],
                    );
            }
            if (shapes.length === 2 && shapes.every((shape) => shape.shapeType === ShapeTypes.edge)) {
                const curves = shapes.map((shape) => (shape as IEdge).curve);
                if (curves.every((curve) => CurveUtils.isLine(curve.basisCurve))) {
                    const a = curves[0].d1(curves[0].firstParameter()).vec;
                    const b = curves[1].d1(curves[1].firstParameter()).vec;
                    const radians = Math.acos(
                        Math.max(-1, Math.min(1, a.dot(b) / (a.length() * b.length()))),
                    );
                    rows.push([
                        "Angle",
                        this.angleUnit.value === "rad"
                            ? `${radians.toFixed(6)} rad`
                            : `${((radians * 180) / Math.PI).toFixed(3)}°`,
                    ]);
                }
            }
            const filters: Record<string, RegExp> = {
                position: /^Point /,
                length: /length/i,
                radius: /^Radius$/,
                diameter: /^Diameter$/,
                angle: /^Angle$/,
                distance: /^Minimum distance$/,
                maxDistance: /^Maximum distance$/,
                area: /area/i,
                volume: /^Volume$/,
            };
            const filter = this.kind === "measure" ? filters[this.measureType.value] : undefined;
            const visible = filter ? [rows[0], ...rows.slice(1).filter(([name]) => filter.test(name))] : rows;
            this.output.replaceChildren(
                visible.length > 1
                    ? table(visible)
                    : textElement(
                          "p",
                          "This measurement does not apply to the selected entities.",
                          style.muted,
                      ),
            );
        } catch (error) {
            this.output.replaceChildren(
                textElement("p", error instanceof Error ? error.message : String(error), style.error),
            );
        } finally {
            for (const shape of shapes) shape.dispose();
        }
    };
    dispose() {
        Config.instance.removePropertyChanged(this.preferencesChanged);
        this.disposed = true;
        this.picker?.cancel();
        this.view.document.selection.onNodeChanged.remove(this.render);
        this.view.document.selection.onShapeChanged.remove(this.render);
        PubSub.default.remove("documentUnitsChanged", this.unitsChanged);
        this.view.document.history.removeChanged(this.modelChanged);
    }
}
