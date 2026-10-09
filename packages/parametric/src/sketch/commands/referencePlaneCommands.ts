// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    CancelableCommand,
    command,
    documentParameterInput,
    type FaceMeshData,
    formatDocumentValue,
    I18n,
    LENGTH_UNITS,
    MeshGroup,
    Plane,
    PubSub,
    ReferencePlaneNode,
    resolveUnitSpec,
    Transaction,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import { SketchEditor } from "../editor/sketchEditor";
import style from "../editor/sketchPanel.module.css";

@command({ key: "plane.create", icon: "icon-setWorkingPlane" })
export class CreateReferencePlane extends CancelableCommand {
    async executeAsync(): Promise<void> {
        SketchEditor.exit();
        const view = this.application.activeView;
        if (!view?.dom) return;
        const doc = view.document;
        const selected = doc.selection.getSelectedNodes().find((n) => n instanceof ReferencePlaneNode);
        this.controller = new AsyncController();
        const controller = this.controller;
        const root = document.createElement("form");
        root.className = style.panel;
        root.setAttribute("aria-label", "Create reference plane");
        const header = document.createElement("header");
        const title = document.createElement("strong");
        title.textContent = "Plane";
        const accept = document.createElement("button");
        accept.type = "submit";
        accept.className = style.finish;
        accept.setAttribute("aria-label", "Create plane");
        accept.append(createCadIcon("check"));
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = style.cancel;
        cancel.setAttribute("aria-label", "Cancel plane");
        cancel.append(createCadIcon("close"));
        cancel.onclick = () => controller.cancel();
        header.append(title, accept, cancel);
        root.append(header);
        const add = (label: string, control: HTMLElement) => {
            const row = document.createElement("label");
            row.textContent = label;
            row.style.display = "grid";
            row.style.gap = "4px";
            row.append(control);
            root.append(row);
        };
        const base = document.createElement("select");
        base.setAttribute("aria-label", "Reference plane");
        const choices = [
            { name: "Top (XY)", plane: Plane.XY },
            { name: "Front (XZ)", plane: Plane.ZX },
            { name: "Right (YZ)", plane: Plane.YZ },
            { name: "Current workplane", plane: view.workplane },
            ...doc.modelManager
                .findNodes()
                .filter((n) => n instanceof ReferencePlaneNode)
                .map((node) => ({ name: node.name, plane: node.plane, node })),
        ];
        choices.forEach((item, i) => {
            const option = document.createElement("option");
            option.value = String(i);
            option.textContent = item.name;
            base.add(option);
        });
        const index = choices.findIndex((item) => "node" in item && item.node === selected);
        if (index >= 0) base.value = String(index);
        add("Reference plane", base);
        // The offset reads and writes in the document's length unit ("25 mm", "1 in", "w / 2"):
        // the box shows the value with its unit, the model keeps millimetres.
        const scope = doc.variables.evaluate().scope;
        const offset = document.createElement("input");
        offset.type = "text";
        offset.spellcheck = false;
        offset.required = true;
        offset.value = formatDocumentValue(25, doc, LENGTH_UNITS);
        offset.setAttribute("aria-label", I18n.translate("plane.offset"));
        offset.onfocus = () => offset.select();
        const offsetValue = (): number | undefined => {
            const parsed = documentParameterInput(offset.value, doc, LENGTH_UNITS, scope);
            if (!parsed.isOk) {
                offset.setCustomValidity(parsed.error);
                return undefined;
            }
            const resolved = resolveUnitSpec(parsed.value, scope, LENGTH_UNITS);
            offset.setCustomValidity(resolved.isOk ? "" : resolved.error);
            return resolved.isOk ? resolved.value : undefined;
        };
        add(I18n.translate("plane.offset"), offset);
        const name = document.createElement("input");
        name.placeholder = "Plane";
        name.setAttribute("aria-label", "Plane name");
        add("Name", name);
        const sketch = document.createElement("input");
        sketch.type = "checkbox";
        sketch.setAttribute("aria-label", "Start sketch on plane");
        add("Start sketch on plane", sketch);
        let mesh: number | undefined;
        const clear = () => {
            if (mesh !== undefined) doc.visual.context.removeMesh(mesh);
            mesh = undefined;
        };
        const frame = (distance: number) => {
            const p = choices[Number(base.value)].plane;
            return p.translateTo(p.origin.add(p.normal.multiply(distance)));
        };
        const preview = () => {
            clear();
            const distance = offsetValue();
            if (distance === undefined) {
                view.update();
                return;
            }
            const p = frame(distance);
            const positions = [
                [-100, -100],
                [100, -100],
                [100, 100],
                [-100, 100],
            ].flatMap(([x, y]) => {
                const v = p.origin.add(p.xvec.multiply(x)).add(p.yvec.multiply(y));
                return [v.x, v.y, v.z];
            });
            const data: FaceMeshData = {
                position: new Float32Array(positions),
                index: new Uint32Array([0, 1, 2, 0, 2, 3]),
                normal: new Float32Array(4 * 3),
                uv: new Float32Array(8),
                range: [],
                groups: [new MeshGroup({ start: 0, count: 6, materialIndex: 0 })],
                color: 0xffc45c,
            };
            for (let i = 0; i < 4; i++) data.normal.set([p.normal.x, p.normal.y, p.normal.z], i * 3);
            mesh = doc.visual.context.displayMesh([data], { meshOpacity: 0.25 });
            view.update();
        };
        base.onchange = preview;
        offset.oninput = preview;
        root.onsubmit = (event) => {
            event.preventDefault();
            offsetValue();
            if (root.reportValidity()) controller.success();
        };
        root.onkeydown = (event) => {
            event.stopPropagation();
            if (event.key === "Escape") controller.cancel();
        };
        root.onpointerdown = (event) => event.stopPropagation();
        root.onpointermove = (event) => event.stopPropagation();
        const done = new Promise<boolean>((resolve) => {
            controller.onCompleted(() => resolve(true));
            controller.onCancelled(() => resolve(false));
            controller.onFailed(() => resolve(false));
        });
        view.dom.append(root);
        preview();
        try {
            if (!(await done)) return;
            const distance = offsetValue();
            if (distance === undefined) return;
            const node = new ReferencePlaneNode({
                document: doc,
                basePlane: choices[Number(base.value)].plane,
                offset: distance,
                name: name.value.trim() || undefined,
            });
            Transaction.execute(doc, "Create reference plane", () => doc.modelManager.addNode(node));
            doc.selection.setSelectedNodes([node], false);
            if (sketch.checked) {
                // The command service starts the next command after this one releases its controller.
                setTimeout(() => PubSub.default.pub("executeCommand", "sketch.create"), 0);
            }
        } finally {
            clear();
            root.remove();
            controller.dispose();
            view.update();
        }
    }
}
