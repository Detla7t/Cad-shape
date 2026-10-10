// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    documentUnit,
    evaluateSelectionMeasurement,
    formatDocumentValue,
    formatPreferenceNumber,
    type IDocument,
    type INode,
    type IView,
    LENGTH_UNITS,
    MEASUREMENT_LABELS,
    type MeasurementDetail,
    type MeasurementMode,
    type MeasurementResult,
    PubSub,
    type SelectionMeasurement,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import { MeasurementGuide } from "./measurementGuide";
import style from "./viewportUtilities.module.css";

/** The distances two entities measure at once; each gets a row of the card besides the main one. */
const DISTANCE_MODES = new Set<MeasurementMode>(["distance", "maxDistance", "centerDistance"]);

function textNode(text: string): HTMLSpanElement {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
}

/** A detail's value in the document's units (areas in the squared length unit). */
export function formatMeasurementDetail(detail: MeasurementDetail, doc: IDocument): string {
    if (detail.quantity === "angle") return formatDocumentValue(detail.value, doc, ANGLE_UNITS);
    if (detail.quantity === "area") {
        const unit = documentUnit(doc, LENGTH_UNITS);
        return `${formatPreferenceNumber(detail.value / unit.factor ** 2, unit.precision)} ${unit.suffix}²`;
    }
    return formatDocumentValue(detail.value, doc, LENGTH_UNITS);
}

/**
 * The selection measurement, Onshape style: select anything and the corner shows what it
 * measures — the main value (a distance switchable between Minimum, Maximum and Center, a
 * length, a diameter) with everything else beside it: a distance's ΔX/ΔY/ΔZ in the axis
 * colours, the angle between straight edges or flat faces, an area, a point's coordinates. The
 * viewport draws the same (see `MeasurementGuide`).
 */
export class SelectionMeasurementControl {
    readonly element = document.createElement("div");
    /** The stacked values above the readout. */
    readonly card = document.createElement("dl");
    readonly popup = document.createElement("section");
    readonly guide: MeasurementGuide;
    private readonly readout = document.createElement("button");
    private readonly variable = document.createElement("button");
    private readonly method = document.createElement("select");
    private readonly status = document.createElement("p");
    private current?: SelectionMeasurement;
    private mode?: MeasurementMode;
    private preview?: MeasurementResult | null;
    private signature = "";
    private queued = false;
    private disposed = false;
    private readonly watched = new Set<INode>();
    constructor(
        private readonly view: IView,
        private readonly closeOther: () => void,
    ) {
        this.guide = new MeasurementGuide(view);
        this.element.className = style.quickMeasure;
        this.element.setAttribute("aria-label", "Selection measurement");
        this.readout.className = style.readout;
        this.readout.setAttribute("aria-label", "Refine selection measurement");
        this.readout.setAttribute("aria-expanded", "false");
        this.readout.onclick = () => {
            const open = this.popup.hidden;
            this.closeOther();
            this.popup.hidden = !open;
            this.readout.setAttribute("aria-expanded", String(open));
            if (open) this.method.focus();
        };
        this.variable.append(createCadIcon("feature.variable", "icon-tag"));
        this.variable.title = "Create measured variable";
        this.variable.setAttribute("aria-label", "Create measured variable");
        this.variable.onclick = () => void this.create();
        this.card.className = style.measureCard;
        this.card.setAttribute("aria-label", "Measurement values");
        this.card.hidden = true;
        this.element.append(this.card, this.readout, this.variable);
        this.popup.className = `${style.popup} ${style.measurePopup}`;
        this.popup.setAttribute("aria-label", "Selection measurement options");
        this.popup.hidden = true;
        const heading = document.createElement("strong");
        heading.textContent = "Measurement";
        this.method.setAttribute("aria-label", "Selection measurement type");
        this.method.onchange = () => {
            this.mode = this.method.value as MeasurementMode;
            this.render();
        };
        const create = document.createElement("button");
        create.textContent = "Create measured variable…";
        create.onclick = () => void this.create();
        this.status.setAttribute("role", "status");
        this.popup.append(heading, this.method, this.status, create);
        this.popup.onkeydown = (event) => {
            if (event.key === "Escape") {
                this.close();
                this.readout.focus();
            }
        };
        const doc = view.document;
        doc.selection.onNodeChanged.sub(this.schedule);
        doc.selection.onShapeChanged.sub(this.schedule);
        doc.history.onChanged(this.schedule);
        doc.modelManager.addNodeObserver(this.schedule);
        PubSub.default.sub("documentUnitsChanged", this.unitsChanged);
        PubSub.default.sub("measurementPreview", this.previewChanged);
        this.schedule();
    }
    private async create() {
        if (!this.current || this.variable.disabled) return;
        const mode = this.current.measurement?.mode;
        if (mode !== undefined) await this.createFrom(mode);
    }
    /** Turns one value of the selection into a measured variable (the card's (x) buttons). */
    private async createFrom(mode: MeasurementMode) {
        if (!this.current) return;
        this.view.document.application.activeView = this.view;
        const captured = this.current;
        this.close();
        try {
            await captured.createVariable(mode);
        } catch (error) {
            PubSub.default.pub("showToast", "error.default:{0}", String(error));
        }
    }
    private readonly unitsChanged = (doc: IDocument) => {
        if (doc === this.view.document) this.schedule();
    };
    private readonly previewChanged = (doc: IDocument, result?: MeasurementResult | null) => {
        if (doc !== this.view.document) return;
        this.preview = result;
        this.guide.show(
            result === undefined ? this.current?.measurement : (result ?? undefined),
            result === undefined ? this.current?.details : undefined,
            { outline: this.outlined() },
        );
    };
    /** Whether the guide traces the extent: for picked sub-shapes, not for a whole node already outlined by its selection. */
    private outlined(): boolean {
        return this.view.document.selection.getSelectedShapes().length > 0;
    }

    private readonly schedule = () => {
        if (this.queued || this.disposed) return;
        this.queued = true;
        queueMicrotask(() => {
            this.queued = false;
            if (!this.disposed) this.render();
        });
    };
    private render() {
        const doc = this.view.document;
        const picks = doc.selection.getSelectedShapes();
        const nodes: INode[] = picks.length
            ? picks.map((pick) => pick.owner.node)
            : doc.selection.getSelectedNodes();
        const signature = JSON.stringify(
            picks.length
                ? picks.map((pick) => [pick.owner.node.id, pick.shape.shapeType, pick.indexes])
                : nodes.map((node) => node.id),
        );
        if (signature !== this.signature) {
            this.mode = undefined;
            this.signature = signature;
        }
        for (const node of this.watched)
            if (!nodes.includes(node)) {
                node.removePropertyChanged(this.schedule);
                this.watched.delete(node);
            }
        for (const node of nodes)
            if (!this.watched.has(node)) {
                this.watched.add(node);
                node.onPropertyChanged(this.schedule);
            }
        const result = evaluateSelectionMeasurement(doc, this.mode);
        if (!result.isOk) {
            this.current = undefined;
            this.variable.disabled = true;
            this.element.hidden = this.mode === undefined;
            this.readout.textContent = "Measurement unavailable";
            this.status.textContent = result.error;
            this.renderCard([]);
            this.guide.show(this.preview ?? undefined);
            if (!nodes.length) this.close();
            return;
        }
        this.current = result.value;
        this.element.hidden = false;
        const measured = result.value.measurement;
        const details = result.value.details ?? [];
        this.variable.disabled = measured === undefined;
        this.readout.textContent = measured
            ? `${measured.label}: ${formatDocumentValue(measured.value, doc, LENGTH_UNITS)}`
            : details.map((detail) => `${detail.label} ${formatMeasurementDetail(detail, doc)}`).join("  ");
        this.status.textContent = this.readout.textContent;
        this.method.replaceChildren(
            ...result.value.modes.map((mode) => {
                const option = document.createElement("option");
                option.value = mode;
                option.textContent = MEASUREMENT_LABELS[mode];
                return option;
            }),
        );
        this.method.hidden = result.value.modes.length < 2;
        if (measured) this.method.value = measured.mode;
        // a lone point's coordinates are the readout itself; otherwise the card lists the rest:
        // the other distances first (two curves measure a minimum, a maximum and a centre
        // distance at once), then the components and the rest
        this.renderCard(measured ? [...this.otherDistances(result.value, measured), ...details] : []);
        this.showCurrent();
    }

    /** The guide of the selection as it stands: a preview, else the main value with its details. */
    private showCurrent() {
        const measured = this.current?.measurement;
        this.guide.show(
            this.preview === undefined ? measured : (this.preview ?? undefined),
            this.current?.details,
            {
                outline: this.outlined(),
            },
        );
    }

    /** The distance modes the selection offers besides the one shown, each measured, as card rows. */
    private otherDistances(
        selection: SelectionMeasurement,
        measured: MeasurementResult,
    ): MeasurementDetail[] {
        const rows: MeasurementDetail[] = [];
        for (const mode of selection.modes) {
            if (mode === measured.mode || !DISTANCE_MODES.has(mode)) continue;
            const other = evaluateSelectionMeasurement(this.view.document, mode);
            const result = other.isOk ? other.value.measurement : undefined;
            // two points measure the same distance every way: no row repeats the main value
            if (result === undefined || Math.abs(result.value - measured.value) < 1e-6) continue;
            rows.push({
                label: result.label,
                value: result.value,
                quantity: "length",
                mode,
                segments: result.segments,
            });
        }
        return rows;
    }

    private renderCard(details: readonly MeasurementDetail[]) {
        const doc = this.view.document;
        this.card.replaceChildren(
            ...details.flatMap((detail) => {
                const term = document.createElement("dt");
                term.textContent = detail.label;
                if (detail.axis) term.dataset["axis"] = detail.axis;
                const value = document.createElement("dd");
                value.append(textNode(formatMeasurementDetail(detail, doc)));
                // hovering a row traces that value in the viewport until the pointer leaves
                if (detail.segments?.length) {
                    const trace = () =>
                        this.guide.show(
                            {
                                mode: detail.mode ?? "distance",
                                value: detail.value,
                                label: detail.label,
                                segments: detail.segments ?? [],
                            },
                            [],
                            { outline: true },
                        );
                    term.addEventListener("pointerenter", trace);
                    value.addEventListener("pointerenter", trace);
                    term.addEventListener("pointerleave", () => this.showCurrent());
                    value.addEventListener("pointerleave", () => this.showCurrent());
                }
                const mode = detail.mode;
                if (mode !== undefined) {
                    const make = document.createElement("button");
                    make.type = "button";
                    make.className = style.rowVariable;
                    make.textContent = "(x)";
                    make.title = `Create variable from ${detail.label}`;
                    make.setAttribute("aria-label", `Create variable from ${detail.label}`);
                    make.onclick = () => void this.createFrom(mode);
                    value.append(make);
                }
                return [term, value];
            }),
        );
        this.card.hidden = details.length === 0;
    }

    close() {
        this.popup.hidden = true;
        this.readout.setAttribute("aria-expanded", "false");
    }
    dispose() {
        this.disposed = true;
        const doc = this.view.document;
        doc.selection.onNodeChanged.remove(this.schedule);
        doc.selection.onShapeChanged.remove(this.schedule);
        doc.history.removeChanged(this.schedule);
        doc.modelManager.removeNodeObserver(this.schedule);
        PubSub.default.remove("documentUnitsChanged", this.unitsChanged);
        PubSub.default.remove("measurementPreview", this.previewChanged);
        for (const node of this.watched) node.removePropertyChanged(this.schedule);
        this.guide.dispose();
    }
}
