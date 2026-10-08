// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    evaluateSelectionMeasurement,
    formatDocumentValue,
    type IDocument,
    type INode,
    type IView,
    LENGTH_UNITS,
    MEASUREMENT_LABELS,
    type MeasurementMode,
    type MeasurementResult,
    PubSub,
    type SelectionMeasurement,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import { MeasurementGuide } from "./measurementGuide";
import style from "./viewportUtilities.module.css";

/** One selection, one measurement definition shared by the readout, guide and variable editor. */
export class SelectionMeasurementControl {
    readonly element = document.createElement("div");
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
        this.element.append(this.readout, this.variable);
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
        this.view.document.application.activeView = this.view;
        const captured = this.current;
        this.close();
        try {
            await captured.createVariable(captured.measurement.mode);
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
        this.guide.show(result === undefined ? this.current?.measurement : (result ?? undefined));
    };
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
        this.variable.disabled = !result.isOk;
        if (!result.isOk) {
            this.current = undefined;
            this.element.hidden = this.mode === undefined;
            this.readout.textContent = "Measurement unavailable";
            this.status.textContent = result.error;
            this.guide.show(this.preview ?? undefined);
            if (!nodes.length) this.close();
            return;
        }
        this.current = result.value;
        this.element.hidden = false;
        const measured = result.value.measurement;
        this.readout.textContent = `${measured.label}: ${formatDocumentValue(measured.value, doc, LENGTH_UNITS)}`;
        this.status.textContent = this.readout.textContent;
        this.method.replaceChildren(
            ...result.value.modes.map((mode) => {
                const option = document.createElement("option");
                option.value = mode;
                option.textContent = MEASUREMENT_LABELS[mode];
                return option;
            }),
        );
        this.method.value = measured.mode;
        this.guide.show(this.preview === undefined ? measured : (this.preview ?? undefined));
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
