// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    documentParameterInput,
    formatDocumentValue,
    type IDocument,
    type INode,
    isConstantName,
    LENGTH_UNITS,
    MEASUREMENT_LABELS,
    PubSub,
    Result,
    resolveUnitSpec,
    type ShapeType,
    ShapeTypes,
    Transaction,
} from "@chili3d/core";
import { SketchEditor } from "../sketch/editor/sketchEditor";
import { MeasuredVariableNode } from "./measuredVariableNode";
import {
    captureMeasurement,
    type MeasuredVariableData,
    type MeasurementMode,
    type MeasurementReference,
    measureReferenceDetails,
} from "./measurement";
import style from "./variableEditor.module.css";

export function editMeasuredVariable(
    model: IDocument,
    controller: AsyncController,
    existing?: MeasuredVariableNode,
    initial?: Pick<MeasuredVariableData, "mode" | "entities">,
): Promise<void> {
    return new Promise((resolve) => {
        const editor = SketchEditor.getActive();
        const selected =
            editor?.document === model
                ? editor.selectedWholeEntityIds.map((entityId) => ({
                      kind: "entity" as const,
                      nodeId: editor.node.id,
                      entityId,
                      label: `Edge of ${editor.node.name}`,
                  }))
                : [];
        const initialPicks = selected.length
            ? selected
            : model.selection.getSelectedShapes().flatMap((pick) => {
                  const ref = captureMeasurement(pick);
                  return ref.isOk ? [ref.value] : [];
              });
        let draft: MeasuredVariableData = existing
            ? structuredClone(existing.definition)
            : {
                  name: initial ? MEASUREMENT_LABELS[initial.mode].replace(/ /g, "_") : "Length",
                  source: "measured",
                  mode: initial?.mode ?? "length",
                  entities: initial?.entities ?? initialPicks,
              };
        if (!existing) {
            const taken = model.variables.scope;
            const baseName = draft.name;
            for (let index = 1; taken.has(draft.name); index++) draft.name = `${baseName}${index}`;
        }
        const root = document.createElement("div");
        root.className = style.root;
        root.setAttribute("aria-label", "Variable editor");
        let picker: AsyncController | undefined;
        let closed = false;
        const watched = new Set<INode>();
        const finish = () => {
            if (closed) return;
            closed = true;
            picker?.cancel();
            PubSub.default.pub("measurementPreview", model, undefined);
            PubSub.default.remove("documentUnitsChanged", unitsChanged);
            for (const node of watched) node.removePropertyChanged(update);
            const panel = root.closest("chili-float-panel") as (HTMLElement & { close(): void }) | null;
            panel?.close();
            resolve();
        };
        controller.onCancelled(finish);
        const header = document.createElement("div");
        header.className = style.header;
        const title = document.createElement("strong");
        const accept = makeButton("✓", () => {
            update();
            if (accept.disabled) return;
            Transaction.execute(
                model,
                existing ? "edit measured variable" : "create measured variable",
                () => {
                    if (existing) existing.definition = draft;
                    else
                        model.modelManager.addNode(
                            new MeasuredVariableNode({ document: model, definition: draft }),
                        );
                },
            );
            finish();
        });
        accept.setAttribute("aria-label", "Accept variable");
        const cancel = makeButton("×", finish);
        cancel.setAttribute("aria-label", "Cancel variable");
        header.append(title, accept, cancel);
        const tabs = document.createElement("div");
        tabs.className = style.tabs;
        for (const source of ["assigned", "measured"] as const) {
            const tab = makeButton(source === "assigned" ? "Assigned" : "Measured", () => {
                draft = { ...draft, source };
                render();
            });
            tab.dataset["source"] = source;
            tabs.append(tab);
        }
        const modes = document.createElement("div");
        modes.className = style.tabs;
        for (const mode of ["distance", "length", "diameter"] as const) {
            const tab = makeButton(mode[0].toUpperCase() + mode.slice(1), () => {
                draft = { ...draft, mode };
                render();
            });
            tab.dataset["mode"] = mode;
            modes.append(tab);
        }
        const method = document.createElement("select");
        method.setAttribute("aria-label", "Measurement method");
        method.onchange = () => {
            draft = { ...draft, mode: method.value as MeasurementMode };
            render();
        };
        const name = document.createElement("input");
        name.value = draft.name;
        name.setAttribute("aria-label", "Variable name");
        name.oninput = () => {
            draft = { ...draft, name: name.value.trim().replace(/^#/, "") };
            update();
        };
        const description = document.createElement("input");
        description.value = draft.description ?? "";
        description.setAttribute("aria-label", "Variable description");
        description.placeholder = "Description";
        description.oninput = () => {
            draft = { ...draft, description: description.value };
        };
        const expression = document.createElement("input");
        expression.value = draft.expression ?? "0 mm";
        expression.setAttribute("aria-label", "Assigned expression");
        expression.oninput = () => {
            const parsed = documentParameterInput(
                expression.value,
                model,
                LENGTH_UNITS,
                model.variables.scope,
            );
            draft = {
                ...draft,
                expression: parsed.isOk
                    ? typeof parsed.value === "number"
                        ? `${parsed.value} mm`
                        : parsed.value
                    : expression.value,
            };
            update();
        };
        const entities = document.createElement("div");
        entities.className = style.entities;
        const pick = makeButton("Select entities…", async () => {
            if (picker) {
                picker.cancel();
                return;
            }
            picker = new AsyncController();
            const currentPicker = picker;
            pick.textContent = "Picking… (Escape to stop)";
            try {
                let ref: MeasurementReference | undefined;
                if (editor?.document === model && SketchEditor.getActive() === editor) {
                    if (draft.mode === "distance" || draft.mode === "maxDistance") {
                        const target = await editor.pickPointOrEntity("prompt.select.edges", currentPicker);
                        if (target)
                            ref = {
                                kind: "entity",
                                nodeId: editor.node.id,
                                entityId: target.kind === "point" ? target.ref.entityId : target.entityId,
                                ...(target.kind === "point" ? { pointIndex: target.ref.pointIndex } : {}),
                                label: `${target.kind === "point" ? "Point" : "Edge"} of ${editor.node.name}`,
                            };
                    } else {
                        const id = await editor.pickEntity(
                            "prompt.select.edges",
                            draft.mode === "diameter" || draft.mode === "radius"
                                ? ["circle", "arc"]
                                : undefined,
                            undefined,
                            currentPicker,
                        );
                        if (id !== undefined)
                            ref = {
                                kind: "entity",
                                nodeId: editor.node.id,
                                entityId: id,
                                label: `Edge of ${editor.node.name}`,
                            };
                    }
                } else {
                    const picks = await model.picker.pickShape("prompt.select.edges", currentPicker, {
                        multi: false,
                        shapeType: (ShapeTypes.edge | ShapeTypes.face | ShapeTypes.vertex) as ShapeType,
                    });
                    if (picks[0]) {
                        const result = captureMeasurement(picks[0]);
                        if (result.isOk) ref = result.value;
                        else status.textContent = result.error;
                    }
                }
                if (
                    ref &&
                    !closed &&
                    !draft.entities.some((item) => JSON.stringify(item) === JSON.stringify(ref))
                )
                    draft = { ...draft, entities: [...draft.entities, ref] };
            } finally {
                currentPicker.dispose();
                picker = undefined;
                if (!closed) render();
            }
        });
        const status = document.createElement("div");
        status.className = style.status;
        status.setAttribute("role", "status");
        root.append(header, tabs, modes, method, name, expression, entities, pick, description, status);
        root.onkeydown = (event) => {
            event.stopPropagation();
            if (event.key === "Escape") picker ? picker.cancel() : finish();
        };
        function update() {
            if (closed) return;
            const details =
                draft.source === "measured"
                    ? measureReferenceDetails(model, draft.mode, draft.entities)
                    : undefined;
            PubSub.default.pub("measurementPreview", model, details?.isOk ? details.value : null);
            const result =
                draft.source === "assigned"
                    ? resolveUnitSpec(draft.expression ?? "0", model.variables.scope, LENGTH_UNITS)
                    : details!.isOk
                      ? Result.ok(details!.value.value)
                      : Result.err(details!.error);
            const validName = /^[A-Za-z_]\w*$/.test(draft.name) && !isConstantName(draft.name);
            const duplicate =
                draft.name !== existing?.definition.name && model.variables.scope.has(draft.name);
            title.textContent = `#${draft.name || "Variable"}${result.isOk ? ` = ${formatDocumentValue(result.value, model, LENGTH_UNITS)}` : ""}`;
            status.textContent = !validName
                ? "Use a name beginning with a letter or underscore."
                : duplicate
                  ? "A variable with that name already exists."
                  : result.isOk
                    ? MEASUREMENT_LABELS[draft.mode]
                    : result.error;
            accept.disabled = !validName || duplicate || !result.isOk;
        }
        function render() {
            modes.hidden = entities.hidden = pick.hidden = draft.source !== "measured";
            method.hidden = draft.source !== "measured" || draft.mode === "length";
            const options: MeasurementMode[] =
                draft.mode === "distance" || draft.mode === "maxDistance"
                    ? ["distance", "maxDistance"]
                    : ["diameter", "radius"];
            method.replaceChildren(
                ...options.map((mode) => {
                    const option = document.createElement("option");
                    option.value = mode;
                    option.textContent = MEASUREMENT_LABELS[mode];
                    return option;
                }),
            );
            method.value = draft.mode;
            expression.hidden = draft.source !== "assigned";
            for (const tab of tabs.querySelectorAll("button"))
                tab.setAttribute("aria-pressed", String(tab.dataset["source"] === draft.source));
            for (const tab of modes.querySelectorAll("button"))
                tab.setAttribute(
                    "aria-pressed",
                    String(
                        tab.dataset["mode"] ===
                            (draft.mode === "maxDistance"
                                ? "distance"
                                : draft.mode === "radius"
                                  ? "diameter"
                                  : draft.mode),
                    ),
                );
            entities.replaceChildren();
            for (const [index, ref] of draft.entities.entries()) {
                const row = document.createElement("div");
                row.append(
                    ref.label,
                    makeButton("×", () => {
                        draft = { ...draft, entities: draft.entities.filter((_, i) => i !== index) };
                        render();
                    }),
                );
                row.lastElementChild?.setAttribute("aria-label", `Remove ${ref.label}`);
                entities.append(row);
                const node = model.modelManager.findNode((node) => node.id === ref.nodeId);
                if (node && !watched.has(node)) {
                    watched.add(node);
                    node.onPropertyChanged(update);
                }
            }
            pick.textContent = "Select entities…";
            update();
        }
        const unitsChanged = (document: IDocument) => {
            if (document === model) update();
        };
        PubSub.default.sub("documentUnitsChanged", unitsChanged);
        render();
        PubSub.default.pub("showFloatPanel", {
            title: "command.feature.variable",
            content: root,
            document: model,
            width: 300,
            height: 405,
            x: 285,
            y: 100,
            onClose: finish,
        });
    });
}
function makeButton(text: string, run: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.onclick = run;
    return button;
}
