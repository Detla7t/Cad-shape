// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    Config,
    documentUnits,
    evaluateSelectionMeasurement,
    formatPreferenceNumber,
    type IDocument,
    type IView,
    type MeasuredEntity,
    type MeasurementFrame,
    type MeasurementMode,
    type MeasurementQuantity,
    type MeasurementResult,
    measurementAxis,
    measurementQuantity,
    type Plane,
    PubSub,
    ReferencePlaneNode,
    Result,
    type SelectionMeasurement,
    type ShapeType,
    ShapeTypes,
    unitSuffix,
    VisualStates,
} from "@chili3d/core";
import { textElement } from "./helpers";
import style from "./measurePanel.module.css";

/** Onshape's "Measure type" list: every value of the selection, or one kind of it. */
export const MEASURE_TYPES = [
    ["all", "Show all"],
    ["position", "Position"],
    ["centerPosition", "Center position"],
    ["distance", "Min distance"],
    ["maxDistance", "Max distance"],
    ["length", "Length"],
    ["diameter", "Diameter"],
    ["radius", "Radius"],
    ["angle", "Angle"],
    ["tangentAngle", "Face tangent angle"],
    ["curvature", "Curvature deviation"],
    ["area", "Surface area"],
] as const;
export type MeasureType = (typeof MEASURE_TYPES)[number][0];

/** The modes each measure type keeps; positions are told apart by their labels, `curvature` has none yet. */
const TYPE_MODES: Record<
    Exclude<MeasureType, "all" | "position" | "centerPosition">,
    readonly MeasurementMode[]
> = {
    distance: ["distance", "deltaX", "deltaY", "deltaZ"],
    maxDistance: ["maxDistance"],
    length: ["length"],
    diameter: ["diameter"],
    radius: ["radius"],
    angle: ["angle"],
    tangentAngle: ["tangentAngle"],
    curvature: [],
    area: ["area"],
};

/** Onshape's row order: the distance with its components first, then the sizes, positions, area and angles. */
const ROW_ORDER: readonly MeasurementMode[] = [
    "distance",
    "deltaX",
    "deltaY",
    "deltaZ",
    "maxDistance",
    "centerDistance",
    "length",
    "radius",
    "diameter",
    "positionX",
    "positionY",
    "positionZ",
    "area",
    "angle",
    "tangentAngle",
];

/** The panel's short names for the main values ("Min dist:" as Onshape prints it). */
const SHORT_LABELS: Partial<Record<MeasurementMode, string>> = {
    distance: "Min dist",
    maxDistance: "Max dist",
    centerDistance: "Center dist",
    tangentAngle: "Tangent angle",
};

/** One value of the selection: a row of the panel, and the mode a variable made of it reads. */
export interface MeasureRow {
    readonly mode: MeasurementMode;
    readonly label: string;
    readonly value: number;
    readonly quantity: MeasurementQuantity;
    readonly axis?: "x" | "y" | "z";
    readonly result: MeasurementResult;
}

/** Every value the selection measures, in Onshape's order, each evaluated on its own. */
export function measureRows(
    doc: IDocument,
    frame?: MeasurementFrame,
): Result<{ rows: MeasureRow[]; selection: SelectionMeasurement }> {
    const main = evaluateSelectionMeasurement(doc, undefined, frame);
    if (!main.isOk) return Result.err(main.error);
    const rows: MeasureRow[] = [];
    for (const mode of main.value.modes) {
        let measured = main.value.measurement?.mode === mode ? main.value.measurement : undefined;
        if (measured === undefined) {
            const one = evaluateSelectionMeasurement(doc, mode, frame);
            measured = one.isOk ? one.value.measurement : undefined;
        }
        if (measured === undefined || measured.mode !== mode) continue;
        rows.push({
            mode,
            label: measured.label,
            value: measured.value,
            quantity: measurementQuantity(mode),
            axis: measurementAxis(mode),
            result: measured,
        });
    }
    rows.sort((a, b) => ROW_ORDER.indexOf(a.mode) - ROW_ORDER.indexOf(b.mode));
    return Result.ok({ rows, selection: main.value });
}

/** The rows a measure type keeps. */
export function filterRows(rows: readonly MeasureRow[], type: MeasureType): MeasureRow[] {
    if (type === "all") return [...rows];
    if (type === "position" || type === "centerPosition")
        return rows.filter(
            (row) =>
                row.mode.startsWith("position") &&
                row.label.startsWith("Center ") === (type === "centerPosition"),
        );
    return rows.filter((row) => TYPE_MODES[type].includes(row.mode));
}

/** The coordinate system a plane defines: its origin and axes. */
export function planeFrame(plane: Plane): MeasurementFrame {
    return { origin: plane.origin, xvec: plane.xvec, yvec: plane.yvec, zvec: plane.normal };
}

const LENGTH_UNIT_CHOICES: readonly (readonly [string, string])[] = [
    ["mm", "Millimeter"],
    ["cm", "Centimeter"],
    ["m", "Meter"],
    ["in", "Inch"],
    ["ft", "Foot"],
];

/**
 * Onshape's Measure panel: the entities picked (each removable), the measure type, the units,
 * an optional reference coordinate system, then every value of the selection — a distance
 * with its ΔX/ΔY/ΔZ in the axis colours, lengths, radii, positions, areas, angles — each with
 * a (x) button that turns it into a measured variable. The viewport draws the chosen value's
 * geometry (see `MeasurementGuide`).
 */
export class MeasurePanel {
    readonly element: HTMLElement;
    private readonly entities = document.createElement("div");
    private readonly measureType = document.createElement("select");
    private readonly lengthUnit = document.createElement("select");
    private readonly angleUnit = document.createElement("select");
    private readonly useFrame = document.createElement("input");
    private readonly frame = document.createElement("select");
    private readonly output = document.createElement("div");
    private current?: SelectionMeasurement;
    private picker?: AsyncController;
    private disposed = false;
    private queued = false;
    private previewing = false;

    constructor(private readonly view: IView) {
        const root = document.createElement("section");
        root.className = style.panel;
        root.setAttribute("aria-label", "Measure");
        this.element = root;
        this.entities.className = style.entities;
        this.entities.setAttribute("role", "listbox");
        this.entities.setAttribute("aria-label", "Select entities to measure");
        this.entities.tabIndex = 0;
        this.entities.title = "Click, then pick entities in the viewport";
        this.entities.addEventListener("click", (event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            void this.pick();
        });
        this.entities.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void this.pick();
            }
        });
        root.append(
            this.entities,
            this.row("Measure type", this.measureType, MEASURE_TYPES),
            this.row("Length unit", this.lengthUnit, LENGTH_UNIT_CHOICES),
            this.row("Angle unit", this.angleUnit, [
                ["deg", "Degree"],
                ["rad", "Radian"],
            ]),
        );
        const curvature = this.measureType.querySelector<HTMLOptionElement>('option[value="curvature"]');
        if (curvature) {
            curvature.disabled = true;
            curvature.title =
                "Curvature deviation needs surface curvature, which the kernel does not report yet.";
        }
        const units = documentUnits(view.document);
        this.lengthUnit.value = units.length;
        this.angleUnit.value = units.angle;
        this.useFrame.type = "checkbox";
        this.useFrame.setAttribute("aria-label", "Reference coordinate system");
        this.useFrame.onchange = () => {
            this.frame.hidden = !this.useFrame.checked;
            this.render();
        };
        const reference = document.createElement("label");
        reference.className = style.check;
        reference.append(this.useFrame, "Reference coordinate system");
        this.frame.className = style.frame;
        this.frame.setAttribute("aria-label", "Coordinate system");
        this.frame.hidden = true;
        this.frame.onchange = this.render;
        this.output.className = style.values;
        root.append(reference, this.frame, this.output);
        const doc = view.document;
        doc.selection.onNodeChanged.sub(this.schedule);
        doc.selection.onShapeChanged.sub(this.schedule);
        doc.history.onChanged(this.schedule);
        doc.modelManager.addNodeObserver(this.schedule);
        PubSub.default.sub("documentUnitsChanged", this.unitsChanged);
        Config.instance.onPropertyChanged(this.preferencesChanged);
        root.addEventListener("keydown", (event) => event.stopPropagation());
        this.render();
    }

    private row(label: string, select: HTMLSelectElement, options: readonly (readonly [string, string])[]) {
        for (const [value, text] of options) {
            const option = textElement("option", text);
            option.value = value;
            select.add(option);
        }
        select.value = options[0][0];
        select.setAttribute("aria-label", label);
        select.onchange = this.render;
        const row = document.createElement("label");
        row.className = style.row;
        row.append(textElement("span", `${label}:`), select);
        return row;
    }
    private readonly unitsChanged = (doc: IDocument) => {
        if (doc === this.view.document) this.render();
    };
    private readonly preferencesChanged = (key: keyof Config) => {
        if (key === "preferences") this.render();
    };
    private readonly schedule = () => {
        if (this.queued || this.disposed) return;
        this.queued = true;
        queueMicrotask(() => {
            this.queued = false;
            if (!this.disposed) this.render();
        });
    };

    /** Picks edges, faces and vertices in the viewport; they join what is already selected. */
    private async pick() {
        this.picker?.cancel();
        const controller = new AsyncController();
        this.picker = controller;
        this.entities.dataset["picking"] = "true";
        try {
            const doc = this.view.document;
            const picks = await doc.picker.pickShape("prompt.select.shape", controller, {
                shapeType: (ShapeTypes.edge | ShapeTypes.face | ShapeTypes.vertex) as ShapeType,
                multi: true,
            });
            if (!this.disposed && picks.length) {
                const existing = doc.selection.getSelectedShapes();
                doc.selection.clearSelection();
                doc.selection.setSelectedShapes([...existing, ...picks], VisualStates.edgeSelected, false);
            }
        } catch (error) {
            if (!this.disposed) this.output.replaceChildren(textElement("p", String(error), style.error));
        } finally {
            controller.dispose();
            if (this.picker === controller) this.picker = undefined;
            delete this.entities.dataset["picking"];
        }
    }

    /** Drops one entity from the selection; the measurement follows. */
    private removeEntity(index: number) {
        const doc = this.view.document;
        const picks = doc.selection.getSelectedShapes();
        if (picks.length) {
            const remaining = picks.filter((_, i) => i !== index);
            doc.selection.clearSelection();
            if (remaining.length)
                doc.selection.setSelectedShapes(remaining, VisualStates.edgeSelected, false);
            return;
        }
        const nodes = doc.selection.getSelectedNodes();
        doc.selection.setSelectedNodes(
            nodes.filter((_, i) => i !== index),
            false,
        );
    }

    private frameValue(): MeasurementFrame | undefined {
        if (!this.useFrame.checked) return undefined;
        const node =
            this.frame.value === "view"
                ? undefined
                : this.view.document.modelManager.findNodes().find((node) => node.id === this.frame.value);
        return planeFrame(node instanceof ReferencePlaneNode ? node.plane : this.view.workplane);
    }

    /** The coordinate systems on offer: the view's workplane and every reference plane. */
    private refreshFrames() {
        const planes = this.view.document.modelManager
            .findNodes()
            .filter((node): node is ReferencePlaneNode => node instanceof ReferencePlaneNode);
        const wanted: [string, string][] = [
            ["view", "View workplane"],
            ...planes.map((p) => [p.id, p.name] as [string, string]),
        ];
        const shown = [...this.frame.options]
            .map((option) => `${option.value}=${option.textContent}`)
            .join("|");
        if (shown === wanted.map(([value, text]) => `${value}=${text}`).join("|")) return;
        const current = this.frame.value;
        this.frame.replaceChildren(
            ...wanted.map(([value, text]) => {
                const option = textElement("option", text);
                option.value = value;
                return option;
            }),
        );
        this.frame.value = wanted.some(([value]) => value === current) ? current : "view";
    }

    private readonly render = () => {
        if (this.disposed) return;
        this.refreshFrames();
        const doc = this.view.document;
        const measured = measureRows(doc, this.frameValue());
        this.renderEntities(measured.isOk ? (measured.value.selection.entities ?? []) : []);
        if (!measured.isOk) {
            this.current = undefined;
            this.output.replaceChildren(textElement("p", measured.error, style.muted));
            this.preview(undefined);
            return;
        }
        this.current = measured.value.selection;
        const rows = filterRows(measured.value.rows, this.measureType.value as MeasureType);
        if (!rows.length) {
            this.output.replaceChildren(
                textElement("p", "This measurement does not apply to the selected entities.", style.muted),
            );
            this.preview(undefined);
            return;
        }
        this.output.replaceChildren(...rows.map((row) => this.renderRow(row, doc)));
        this.preview(this.measureType.value === "all" ? undefined : rows[0].result);
    };

    private renderEntities(entities: readonly MeasuredEntity[]) {
        const caption = textElement("span", "Select entities to measure", style.caption);
        if (!entities.length) {
            this.entities.dataset["empty"] = "true";
            this.entities.replaceChildren(caption);
            return;
        }
        delete this.entities.dataset["empty"];
        this.entities.replaceChildren(
            caption,
            ...entities.map((entity, index) => {
                const row = document.createElement("div");
                row.className = style.entity;
                row.setAttribute("role", "option");
                const remove = document.createElement("button");
                remove.type = "button";
                remove.textContent = "×";
                remove.title = "Remove from the measurement";
                remove.setAttribute("aria-label", `Remove ${entity.label}`);
                remove.onclick = (event) => {
                    event.stopPropagation();
                    this.removeEntity(index);
                };
                row.append(textElement("span", entity.label), remove);
                return row;
            }),
        );
    }

    private renderRow(row: MeasureRow, doc: IDocument): HTMLElement {
        const line = document.createElement("div");
        line.className = style.value;
        line.dataset["mode"] = row.mode;
        if (row.axis) line.dataset["axis"] = row.axis;
        const label = textElement(
            "span",
            row.axis
                ? `${row.label.startsWith("Center ") ? "Center " : ""}${row.axis.toUpperCase()} ≑`
                : `${SHORT_LABELS[row.mode] ?? row.label}:`,
            style.label,
        );
        const number = textElement("span", this.formatNumber(row, doc), style.number);
        const unit = textElement("span", this.unitOf(row.quantity), style.unit);
        const make = document.createElement("button");
        make.type = "button";
        make.className = style.variable;
        make.textContent = "(x)";
        make.title = `Create variable from ${row.label}`;
        make.setAttribute("aria-label", `Create variable from ${row.label}`);
        make.onclick = () => void this.createVariable(row.mode);
        line.append(label, number, unit, make);
        return line;
    }

    /** The value in the chosen units: degrees to three places, radians to six, lengths as the document shows them. */
    private formatNumber(row: MeasureRow, doc: IDocument): string {
        if (row.quantity === "angle")
            return this.angleUnit.value === "rad"
                ? formatPreferenceNumber((row.value * Math.PI) / 180, 6)
                : formatPreferenceNumber(row.value, 3);
        const factor = unitSuffix(this.lengthUnit.value)?.factor ?? 1;
        const precision = documentUnits(doc).lengthPrecision;
        return formatPreferenceNumber(row.value / factor ** (row.quantity === "area" ? 2 : 1), precision);
    }
    private unitOf(quantity: MeasurementQuantity): string {
        if (quantity === "angle") return this.angleUnit.value === "rad" ? "rad" : "°";
        return quantity === "area" ? `${this.lengthUnit.value}²` : this.lengthUnit.value;
    }

    private async createVariable(mode: MeasurementMode) {
        const current = this.current;
        if (!current) return;
        this.view.document.application.activeView = this.view;
        try {
            await current.createVariable(mode);
        } catch (error) {
            PubSub.default.pub("showToast", "error.default:{0}", String(error));
        }
    }

    /** The viewport shows the chosen value's geometry; `undefined` hands the guide back to the readout. */
    private preview(result: MeasurementResult | undefined) {
        if (result === undefined && !this.previewing) return;
        this.previewing = result !== undefined;
        PubSub.default.pub("measurementPreview", this.view.document, result);
    }

    dispose() {
        this.disposed = true;
        this.picker?.cancel();
        const doc = this.view.document;
        doc.selection.onNodeChanged.remove(this.schedule);
        doc.selection.onShapeChanged.remove(this.schedule);
        doc.history.removeChanged(this.schedule);
        doc.modelManager.removeNodeObserver(this.schedule);
        PubSub.default.remove("documentUnitsChanged", this.unitsChanged);
        Config.instance.removePropertyChanged(this.preferencesChanged);
        this.preview(undefined);
    }
}
