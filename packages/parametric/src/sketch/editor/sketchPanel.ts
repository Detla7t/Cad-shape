// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createCadIcon } from "@chili3d/element";
import type { SketchLayer } from "../sketchModel";
import type { SolveOutcome } from "../solver";
import { showSketchDiagnostics } from "./sketchDiagnostics";
import type { SketchEditor } from "./sketchEditor";
import style from "./sketchPanel.module.css";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);
    if (text) result.textContent = text;
    return result;
}

/** Persistent sketch status and drawing styles, independent of transient command prompts. */
export class SketchPanel {
    private readonly root = element("section");
    private readonly title = element("strong");
    private readonly status = element("div");
    private readonly detail = element("div");
    private readonly selection = element("span");
    private readonly construction = element("input");
    private readonly layerSelect = element("select");
    private readonly layers = element("div");
    private readonly color = element("input");
    private layerSignature = "";

    constructor(private readonly editor: SketchEditor) {
        this.root.className = style.panel;
        this.root.setAttribute("aria-label", "Sketch properties");
        this.root.addEventListener("pointerdown", (event) => event.stopPropagation());
        this.root.addEventListener("pointermove", (event) => event.stopPropagation());
        this.root.addEventListener("keydown", (event) => event.stopPropagation());
        const header = element("header");
        const finish = this.action("Finish sketch", () => this.editor.exit());
        finish.className = style.finish;
        finish.title = "Finish sketch";
        finish.setAttribute("aria-label", "Finish sketch");
        finish.replaceChildren(createCadIcon("check"));
        const cancel = this.action("Cancel sketch", () => this.editor.cancel());
        cancel.className = style.cancel;
        cancel.title = "Cancel sketch edits";
        cancel.setAttribute("aria-label", "Cancel sketch");
        cancel.replaceChildren(createCadIcon("close"));
        header.append(this.title, finish, cancel);
        const plane = element("div");
        plane.className = style.plane;
        const normal = this.editor.node.plane.normal;
        const ref = this.editor.node.planeRef;
        const source = ref && this.editor.node.document.modelManager.findNode((n) => n.id === ref.nodeId);
        const planeName =
            source?.name ??
            (Math.abs(normal.z) > 0.999
                ? "Top (XY)"
                : Math.abs(normal.y) > 0.999
                  ? "Front (XZ)"
                  : Math.abs(normal.x) > 0.999
                    ? "Right (YZ)"
                    : "Custom plane");
        plane.append(element("small", "Sketch plane"), element("div", planeName));
        this.status.className = style.status;
        this.status.setAttribute("role", "status");
        this.detail.className = style.hint;
        const legend = element("div");
        legend.className = style.legend;
        for (const [name, color] of [
            ["Under-constrained", "#4a9eff"],
            ["Solved", "var(--foreground-color)"],
            ["Selected", "#ffc247"],
        ]) {
            const item = element("span", name);
            item.style.setProperty("--swatch", color);
            legend.append(item);
        }
        const constructionLabel = element("label");
        this.construction.type = "checkbox";
        this.construction.addEventListener("change", () =>
            this.editor.setConstruction(this.construction.checked),
        );
        constructionLabel.append(this.construction, document.createTextNode("Construction geometry"));
        const row = element("div");
        row.className = style.row;
        this.layerSelect.setAttribute("aria-label", "Active sketch layer");
        this.layerSelect.addEventListener("change", () => {
            this.editor.solver.setLayers(this.editor.solver.sketchLayers(), this.layerSelect.value);
            this.editor.commit();
        });
        row.append(
            this.layerSelect,
            this.action("Assign selection", () => {
                for (const id of this.editor.selectedEntityIds)
                    this.editor.solver.setEntityStyle(id, { layer: this.layerSelect.value });
                this.editor.commit();
            }),
        );
        const colorRow = element("div");
        colorRow.className = style.row;
        this.color.type = "color";
        this.color.value = "#4a9eff";
        this.color.title = "Selected geometry color";
        this.color.addEventListener("change", () => {
            for (const id of this.editor.selectedEntityIds)
                this.editor.solver.setEntityStyle(id, { color: this.color.value });
            this.editor.commit();
        });
        colorRow.append(
            this.selection,
            this.color,
            this.action("By layer", () => {
                for (const id of this.editor.selectedEntityIds)
                    this.editor.solver.setEntityStyle(id, { color: undefined });
                this.editor.commit();
            }),
        );
        const details = element("details");
        details.append(element("summary", "Layers & colors"), this.layers);
        const add = element("div");
        add.className = style.row;
        const name = element("input");
        name.placeholder = "New layer name";
        name.setAttribute("aria-label", "New layer name");
        add.append(
            name,
            this.action("Add layer", () => {
                const label = name.value.trim();
                const layers = this.editor.solver.sketchLayers();
                if (!label || layers.some((layer) => layer.name === label)) return;
                const id = crypto.randomUUID();
                this.editor.solver.setLayers([...layers, { id, name: label, color: "#4a9eff" }], id);
                this.editor.commit();
                name.value = "";
            }),
        );
        details.append(row, colorRow, add);
        const constraintsLabel = element("label");
        const constraints = element("input");
        constraints.type = "checkbox";
        constraints.onchange = () => {
            this.editor.annotations.showAllConstraints = constraints.checked;
        };
        constraintsLabel.append(constraints, document.createTextNode("Show constraints"));
        const dragHint = element("div", "Click to select · Space to clear · Alt + drag to move");
        dragHint.className = style.hint;
        const help = element("details");
        help.append(element("summary", "Sketch help"), legend, dragHint);
        const footer = element("footer");
        footer.append(this.status, this.detail);
        const expressionsLabel = element("label"),
            expressions = element("input");
        expressions.type = "checkbox";
        expressions.onchange = () => {
            this.editor.annotations.showExpressions = expressions.checked;
        };
        expressionsLabel.append(expressions, document.createTextNode("Show expressions"));
        const errorsLabel = element("label"),
            errors = element("input");
        errors.type = "checkbox";
        errors.checked = true;
        errors.onchange = () => {
            this.editor.showErrors = errors.checked;
            this.editor.annotations.showErrors = errors.checked;
            this.editor.solve(true);
        };
        errorsLabel.append(errors, document.createTextNode("Show errors"));
        const diagnostics = element("details");
        diagnostics.append(
            element("summary", "Sketch diagnostics"),
            this.action("Profile inspector…", () => showSketchDiagnostics(this.editor, "profiles")),
            this.action("Constraint manager…", () => showSketchDiagnostics(this.editor, "constraints")),
        );
        this.root.append(
            header,
            plane,
            constructionLabel,
            constraintsLabel,
            expressionsLabel,
            errorsLabel,
            details,
            diagnostics,
            help,
            footer,
        );
        if (editor.view.dom) {
            editor.view.dom.dataset["sketchEditing"] = "true";
            editor.view.dom.append(this.root);
        }
    }

    private action(text: string, run: () => void): HTMLButtonElement {
        const button = element("button", text);
        button.type = "button";
        button.onclick = run;
        return button;
    }

    refresh(outcome: SolveOutcome): void {
        this.title.textContent = this.editor.node.name || "Sketch";
        const ok = outcome.result.startsWith("Ok") && this.editor.solver.datumErrors.size === 0;
        const count = this.editor.solver.entities().length;
        this.status.dataset["state"] = ok ? (outcome.dofs === 0 ? "solved" : "under") : "error";
        this.status.textContent =
            count === 0
                ? "Empty sketch"
                : !ok
                  ? "Constraint error"
                  : outcome.dofs === 0
                    ? "Solved · fully constrained"
                    : "Under-constrained";
        this.detail.textContent =
            count === 0
                ? "Choose a drawing tool to begin."
                : !ok
                  ? `Unable to solve: ${outcome.result}. Review the constraints or undo.`
                  : `${outcome.dofs} degrees of freedom · ${this.editor.solver.entities().length} entities`;
        const ids = this.editor.selectedEntityIds;
        const selected = ids
            .map((id) => this.editor.solver.entity(id))
            .filter((entity) => entity !== undefined);
        this.selection.textContent = `${ids.length} selected`;
        this.color.disabled = ids.length === 0;
        this.construction.checked = selected.length
            ? selected.every((entity) => entity.construction)
            : this.editor.solver.constructionMode;
        this.root.dispatchEvent(
            new CustomEvent("chili-sketch-style", {
                bubbles: true,
                detail: { construction: this.construction.checked },
            }),
        );
        this.construction.indeterminate =
            selected.some((entity) => entity.construction) && !this.construction.checked;
        const layers = this.editor.solver.sketchLayers();
        const signature = JSON.stringify(layers);
        if (signature !== this.layerSignature) {
            this.layerSignature = signature;
            this.renderLayers(layers);
        }
        this.layerSelect.value = this.editor.solver.activeLayer;
    }

    private renderLayers(layers: SketchLayer[]): void {
        this.layers.replaceChildren();
        this.layerSelect.replaceChildren();
        for (const layer of layers) {
            const option = element("option", layer.name);
            option.value = layer.id;
            this.layerSelect.append(option);
            const row = element("div");
            row.className = style.row;
            const update = (change: Partial<SketchLayer>) => {
                this.editor.solver.setLayers(
                    this.editor.solver
                        .sketchLayers()
                        .map((item) => (item.id === layer.id ? { ...item, ...change } : item)),
                );
                this.editor.commit();
            };
            const visible = element("input");
            visible.type = "checkbox";
            visible.checked = layer.visible !== false;
            visible.title = `Show ${layer.name}`;
            visible.onchange = () => update({ visible: visible.checked });
            const color = element("input");
            color.type = "color";
            color.value = layer.color;
            color.title = `${layer.name} color`;
            color.onchange = () => update({ color: color.value });
            const name = element("input");
            name.value = layer.name;
            name.setAttribute("aria-label", `Layer name: ${layer.name}`);
            name.onchange = () => {
                if (
                    name.value.trim() &&
                    !layers.some((item) => item.id !== layer.id && item.name === name.value.trim())
                )
                    update({ name: name.value.trim() });
            };
            row.append(visible, color, name);
            if (layer.id !== "0")
                row.append(
                    this.action("×", () => {
                        for (const entity of this.editor.solver.entities())
                            if (entity.layer === layer.id)
                                this.editor.solver.setEntityStyle(entity.id, { layer: "0" });
                        this.editor.solver.setLayers(layers.filter((item) => item.id !== layer.id));
                        this.editor.commit();
                    }),
                );
            this.layers.append(row);
        }
    }

    dispose(): void {
        this.root.remove();
        if (this.editor.view.dom) delete this.editor.view.dom.dataset["sketchEditing"];
    }
}
