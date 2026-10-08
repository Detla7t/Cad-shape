// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DocumentUnits,
    documentUnits,
    type IDocument,
    type IView,
    PubSub,
    setDocumentUnits,
} from "@chili3d/core";
import style from "./documentUnits.module.css";

export class DocumentUnitsControl extends HTMLElement {
    private model?: IDocument;
    private readonly button = document.createElement("button");
    constructor() {
        super();
        this.button.className = style.trigger;
        this.button.title = "Document units and precision";
        this.button.setAttribute("aria-label", "Document units and precision");
        this.button.onclick = () => {
            if (this.model) showDocumentUnits(this.model);
        };
        this.append(this.button);
        this.render();
    }
    connectedCallback() {
        PubSub.default.sub("activeViewChanged", this.onView);
        PubSub.default.sub("documentUnitsChanged", this.onUnits);
    }
    disconnectedCallback() {
        PubSub.default.remove("activeViewChanged", this.onView);
        PubSub.default.remove("documentUnitsChanged", this.onUnits);
    }
    private readonly onView = (view: IView | undefined) => {
        this.model = view?.document;
        this.render();
    };
    private readonly onUnits = (model: IDocument) => {
        if (model === this.model) this.render();
    };
    private render() {
        this.hidden = !this.model;
        if (!this.model) return;
        const units = documentUnits(this.model);
        this.button.textContent = `${units.length} · ${(0).toFixed(units.lengthPrecision)} ▾`;
    }
}

export function showDocumentUnits(model: IDocument): HTMLDialogElement {
    const values = documentUnits(model);
    const dialog = document.createElement("dialog");
    dialog.className = style.dialog;
    dialog.setAttribute("aria-label", "Document units and precision");
    const heading = document.createElement("h2");
    heading.textContent = "Document units and precision";
    dialog.append(heading);
    const controls = new Map<keyof DocumentUnits, HTMLSelectElement>();
    const row = (key: keyof DocumentUnits, label: string, choices: [string, string][]) => {
        const field = document.createElement("label");
        field.textContent = label;
        const select = document.createElement("select");
        select.setAttribute("aria-label", label);
        for (const [value, text] of choices) select.add(new Option(text, value));
        select.value = String(values[key]);
        controls.set(key, select);
        field.append(select);
        dialog.append(field);
    };
    const precision: [string, string][] = Array.from({ length: 9 }, (_, n) => [
        String(n),
        `${n} decimals · ${(0).toFixed(n)}`,
    ]);
    row("length", "Length units", [
        ["mm", "Millimetres (mm)"],
        ["cm", "Centimetres (cm)"],
        ["m", "Metres (m)"],
        ["in", "Inches (in)"],
        ["ft", "Feet (ft)"],
    ]);
    row("lengthPrecision", "Length precision", precision);
    row("angle", "Angle units", [
        ["deg", "Degrees (°)"],
        ["rad", "Radians (rad)"],
    ]);
    row("anglePrecision", "Angle precision", precision);
    const help = document.createElement("p");
    help.textContent =
        "Sets dimension display and the units for new dimension and extrusion input. Explicit units such as 25 mm or 1 in are also accepted.";
    dialog.append(help);
    const footer = document.createElement("footer");
    const close = () => dialog.remove();
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = close;
    const save = document.createElement("button");
    save.textContent = "Save";
    save.onclick = () => {
        setDocumentUnits(model, {
            length: controls.get("length")!.value as DocumentUnits["length"],
            angle: controls.get("angle")!.value as DocumentUnits["angle"],
            lengthPrecision: Number(controls.get("lengthPrecision")!.value),
            anglePrecision: Number(controls.get("anglePrecision")!.value),
        });
        close();
    };
    footer.append(cancel, save);
    dialog.append(footer);
    dialog.onkeydown = (event) => event.stopPropagation();
    dialog.oncancel = close;
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
}
customElements.define("chili-document-units", DocumentUnitsControl);
