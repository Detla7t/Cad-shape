// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    documentParameterInput,
    documentUnit,
    formatDocumentValue,
    type I18nKeys,
    type IDocument,
    LENGTH_UNITS,
    type ParameterValue,
    resolveUnitSpec,
} from "@chili3d/core";
import style from "./extrudePanel.module.css";

export interface ExtrudePanelModel {
    document: IDocument;
    operation: I18nKeys;
    depth: ParameterValue;
    symmetric: boolean;
    startOffset: ParameterValue;
    onPropertyChanged(callback: (name: string) => void): void;
    removePropertyChanged(callback: (name: string) => void): void;
}

/** One persistent feature panel: choose a profile, adjust its live preview, then accept. */
export class ExtrudePanel {
    readonly element = document.createElement("section");
    private readonly accept = document.createElement("button");
    private readonly profile = document.createElement("button");
    private readonly error = document.createElement("div");
    private readonly depth = document.createElement("input");
    private readonly offset = document.createElement("input");
    private readonly symmetric = document.createElement("input");
    private readonly operations = new Map<string, HTMLButtonElement>();
    private ready = false;
    private readonly errors = new Map<"depth" | "startOffset", string>();
    constructor(
        private readonly model: ExtrudePanelModel,
        confirm: () => void,
        cancel: () => void,
    ) {
        const root = this.element;
        root.className = style.panel;
        root.setAttribute("aria-label", "Extrude feature");
        root.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") cancel();
            if (event.key === "Enter" && !this.accept.disabled) confirm();
        });
        const header = document.createElement("header");
        const title = document.createElement("strong");
        title.textContent = "Extrude";
        this.accept.textContent = "✓";
        this.accept.setAttribute("aria-label", "Accept extrude");
        this.accept.onclick = confirm;
        const close = document.createElement("button");
        close.textContent = "×";
        close.setAttribute("aria-label", "Cancel extrude");
        close.onclick = cancel;
        header.append(title, this.accept, close);
        root.append(header);
        const kind = document.createElement("div");
        kind.className = style.kind;
        kind.textContent = "Solid";
        root.append(kind);
        const tabs = document.createElement("nav");
        tabs.setAttribute("aria-label", "Extrude operation");
        for (const [name, value] of [
            ["New", "new"],
            ["Add", "join"],
            ["Remove", "cut"],
            ["Intersect", "intersect"],
        ]) {
            const button = document.createElement("button");
            button.textContent = name;
            const key = `option.command.operation.${value}` as I18nKeys;
            button.onclick = () => {
                model.operation = key;
                this.refresh();
            };
            this.operations.set(key, button);
            tabs.append(button);
        }
        root.append(tabs);
        this.profile.className = style.profile;
        this.profile.title = "Select a sketch region or planar face in the viewport; Shift adds regions";
        this.profile.onclick = () => model.document.application.activeView?.dom?.focus();
        root.append(this.profile);
        const endType = document.createElement("div");
        endType.className = style.endType;
        endType.textContent = "Blind";
        root.append(endType);
        const depthRow = this.lengthField("Depth", this.depth, "depth");
        const reverse = document.createElement("button");
        reverse.textContent = "⇅";
        reverse.title = "Reverse direction";
        reverse.setAttribute("aria-label", "Reverse extrude direction");
        reverse.onclick = () => {
            const value = resolveUnitSpec(model.depth, model.document.variables.scope, LENGTH_UNITS);
            if (value.isOk) model.depth = -value.value;
        };
        depthRow.append(reverse);
        root.append(depthRow);
        this.symmetric.type = "checkbox";
        this.symmetric.onchange = () => {
            model.symmetric = this.symmetric.checked;
        };
        const symmetricLabel = document.createElement("label");
        symmetricLabel.append(this.symmetric, " Symmetric");
        root.append(symmetricLabel);
        const offsetEnabled = document.createElement("input");
        offsetEnabled.type = "checkbox";
        const offsetLabel = document.createElement("label");
        offsetLabel.append(offsetEnabled, " Starting offset");
        const offsetRow = this.lengthField("Offset", this.offset, "startOffset");
        offsetRow.hidden = !model.startOffset;
        offsetEnabled.checked = !!model.startOffset;
        offsetEnabled.onchange = () => {
            offsetRow.hidden = !offsetEnabled.checked;
            if (!offsetEnabled.checked) {
                this.errors.delete("startOffset");
                model.startOffset = 0;
                this.refresh();
            }
        };
        root.append(offsetLabel, offsetRow);
        this.error.className = style.error;
        this.error.setAttribute("role", "status");
        root.append(this.error);
        document.body.append(root);
        model.onPropertyChanged(this.refresh);
        this.refresh();
    }
    private lengthField(
        label: string,
        input: HTMLInputElement,
        key: "depth" | "startOffset",
    ): HTMLLabelElement {
        const row = document.createElement("label");
        row.className = style.length;
        const name = document.createElement("span");
        name.textContent = label;
        input.setAttribute("aria-label", `Extrude ${label.toLowerCase()}`);
        input.spellcheck = false;
        const unit = document.createElement("small");
        unit.textContent = documentUnit(this.model.document, LENGTH_UNITS).suffix;
        input.onfocus = () => input.select();
        input.oninput = () => {
            const parsed = documentParameterInput(
                input.value,
                this.model.document,
                LENGTH_UNITS,
                this.model.document.variables.scope,
            );
            const resolved = parsed.isOk
                ? resolveUnitSpec(parsed.value, this.model.document.variables.scope, LENGTH_UNITS)
                : parsed;
            const error = !resolved.isOk
                ? resolved.error
                : key === "depth" && Math.abs(Number(resolved.value)) < 1e-7
                  ? "Depth must be nonzero."
                  : "";
            if (error) this.errors.set(key, error);
            else this.errors.delete(key);
            input.setAttribute("aria-invalid", String(!!error));
            if (!error && parsed.isOk) this.model[key] = parsed.value;
            this.refreshValidation();
        };
        row.append(name, input, unit);
        return row;
    }
    readonly refresh = () => {
        for (const [key, button] of this.operations)
            button.setAttribute("aria-pressed", String(key === this.model.operation));
        for (const [input, value] of [
            [this.depth, this.model.depth],
            [this.offset, this.model.startOffset],
        ] as const)
            if (
                document.activeElement !== input &&
                !this.errors.has(input === this.depth ? "depth" : "startOffset")
            )
                input.value =
                    typeof value === "number"
                        ? formatDocumentValue(value, this.model.document, LENGTH_UNITS, false)
                        : value;
        this.symmetric.checked = this.model.symmetric;
        this.refreshValidation();
    };
    private refreshValidation() {
        const depth = resolveUnitSpec(this.model.depth, this.model.document.variables.scope, LENGTH_UNITS);
        const depthError = !depth.isOk
            ? depth.error
            : Math.abs(depth.value) < 1e-7
              ? "Depth must be nonzero."
              : "";
        this.error.textContent = this.errors.values().next().value ?? depthError;
        this.accept.disabled = !this.ready || this.errors.size > 0 || !!depthError;
    }
    get canConfirm(): boolean {
        return !this.accept.disabled;
    }
    setProfile(name?: string, count = 0) {
        const wasReady = this.ready;
        this.ready = name !== undefined;
        this.profile.textContent = name
            ? `${count > 1 ? `${count} regions` : "Face"} of ${name}`
            : "Select faces or sketch regions…";
        this.refresh();
        if (this.ready && !wasReady) {
            this.depth.focus();
            this.depth.select();
        }
    }
    dispose() {
        this.model.removePropertyChanged(this.refresh);
        this.element.remove();
    }
}
