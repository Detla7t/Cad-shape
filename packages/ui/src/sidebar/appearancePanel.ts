// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    GeometryNode,
    type IDocument,
    Id,
    type IPropertyChanged,
    type Material,
    MeshNode,
    PhongMaterial,
    PubSub,
    ReferencePlaneNode,
    Serializer,
    ShapeTypeUtils,
    Transaction,
} from "@chili3d/core";
import { createCadIcon } from "@chili3d/element";
import style from "./appearancePanel.module.css";

type AppearanceNode = GeometryNode | MeshNode;
type AppearanceTarget = { node: AppearanceNode; faces?: number[] };

function colorCss(color: number | string): string {
    return typeof color === "number" ? `#${color.toString(16).padStart(6, "0")}` : color;
}

/** Document appearances, with separate overrides for individual faces. */
export class AppearancePanel {
    readonly element = document.createElement("div");
    private readonly list = document.createElement("div");
    private readonly add = document.createElement("button");
    private readonly watches = new Set<IPropertyChanged>();
    private sketches = false;
    private queued = false;
    private disposed = false;

    constructor(private readonly doc: IDocument) {
        this.element.className = style.root;
        const tabs = document.createElement("div");
        tabs.className = style.tabs;
        tabs.setAttribute("role", "tablist");
        for (const [index, label] of ["Parts and surfaces", "Sketches and curves"].entries()) {
            const tab = document.createElement("button");
            tab.type = "button";
            tab.textContent = label;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-selected", String(index === 0));
            tab.onclick = () => {
                this.sketches = index === 1;
                for (const child of tabs.children) child.setAttribute("aria-selected", String(child === tab));
                this.render();
            };
            tabs.append(tab);
        }
        const toolbar = document.createElement("div");
        toolbar.className = style.toolbar;
        this.add.type = "button";
        this.add.title = "Add appearance to selected faces";
        this.add.setAttribute("aria-label", this.add.title);
        this.add.append(createCadIcon("addAppearance"), document.createTextNode("Add face appearance"));
        this.add.onclick = () => this.edit(this.selectedFaces());
        toolbar.append(this.add);
        this.list.className = style.list;
        this.element.append(tabs, toolbar, this.list);
        doc.modelManager.addNodeObserver(this.changed);
        doc.modelManager.materials.onCollectionChanged(this.changed);
        doc.history.onChanged(this.changed);
        doc.selection.onShapeChanged.sub(this.selectionChanged);
        doc.selection.onNodeChanged.sub(this.selectionChanged);
        this.render();
    }

    private selectedFaces(): AppearanceTarget[] {
        const targets = new Map<GeometryNode, Set<number>>();
        for (const pick of this.doc.selection.getSelectedShapes()) {
            const node = pick.owner.node;
            if (!(node instanceof GeometryNode) || node instanceof ReferencePlaneNode) continue;
            if (!ShapeTypeUtils.hasFace(pick.shape.shapeType)) continue;
            const faces = targets.get(node) ?? new Set<number>();
            for (const index of pick.indexes) faces.add(index);
            targets.set(node, faces);
        }
        return [...targets].map(([node, faces]) => ({ node, faces: [...faces] }));
    }

    private material(target: AppearanceTarget): Material | undefined {
        const ids = target.node.materialId;
        const pair =
            target.node instanceof GeometryNode && target.faces?.length
                ? target.node.faceMaterialPair.find((pair) => pair.faceIndex === target.faces![0])
                : undefined;
        const id = Array.isArray(ids) ? ids[pair ? pair.materialIndex : 0] : ids;
        return this.doc.modelManager.materials.find((material) => material.id === id);
    }

    private readonly changed = () => {
        if (this.queued || this.disposed) return;
        this.queued = true;
        queueMicrotask(() => {
            this.queued = false;
            if (!this.disposed) this.render();
        });
    };

    private readonly selectionChanged = () => {
        // Keep rows mounted during selection so the second click still reaches the same row.
        this.add.disabled = this.selectedFaces().length === 0;
    };

    private render() {
        for (const watch of this.watches) watch.removePropertyChanged(this.changed);
        this.watches.clear();
        const nodes = this.doc.modelManager
            .findNodes()
            .filter(
                (node): node is AppearanceNode =>
                    (node instanceof GeometryNode || node instanceof MeshNode) &&
                    !(node instanceof ReferencePlaneNode),
            );
        const watched: IPropertyChanged[] = [...nodes, ...this.doc.modelManager.materials];
        for (const node of watched) {
            node.onPropertyChanged(this.changed);
            this.watches.add(node);
        }
        this.add.disabled = this.selectedFaces().length === 0;
        this.list.replaceChildren();
        for (const node of nodes) {
            const sketchOrCurve =
                node.display() === "body.sketch" ||
                (node instanceof GeometryNode && !node.mesh.faces?.range.length);
            if (sketchOrCurve !== this.sketches) continue;
            this.list.append(this.row({ node }, node.name));
            if (!(node instanceof GeometryNode)) continue;
            const groups = new Map<number, number[]>();
            for (const pair of node.faceMaterialPair) {
                const faces = groups.get(pair.materialIndex) ?? [];
                faces.push(pair.faceIndex);
                groups.set(pair.materialIndex, faces);
            }
            for (const faces of groups.values()) {
                this.list.append(this.row({ node, faces }, `Faces ${faces.map((i) => i + 1).join(", ")}`));
            }
        }
        if (!this.list.childElementCount) {
            const empty = document.createElement("p");
            empty.className = style.empty;
            empty.textContent = this.sketches
                ? "Sketch and curve appearances will appear here."
                : "Part and surface appearances will appear here. Select faces to add an appearance override.";
            this.list.append(empty);
        }
    }

    private row(target: AppearanceTarget, name: string): HTMLElement {
        const row = document.createElement("div");
        row.className = style.row;
        row.dataset["nodeId"] = target.node.id;
        if (target.faces) row.dataset["faces"] = target.faces.join(",");
        const label = document.createElement("button");
        label.type = "button";
        label.textContent = name;
        label.title = `${target.node.name}: ${name} — double-click to edit appearance`;
        label.onclick = () => {
            this.doc.selection.clearSelection();
            this.doc.selection.setSelectedNodes([target.node], false);
        };
        label.ondblclick = () => this.edit([target]);
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = style.swatch;
        swatch.setAttribute(
            "aria-label",
            `Edit appearance: ${target.faces ? `${target.node.name} / ` : ""}${name}`,
        );
        const material = this.material(target);
        const fill = document.createElement("span");
        fill.style.backgroundColor = colorCss(material?.color ?? 0xdedede);
        fill.style.opacity = String(material?.opacity ?? 1);
        swatch.append(fill);
        swatch.title = `${colorCss(material?.color ?? 0xdedede)} · ${Math.round((1 - (material?.opacity ?? 1)) * 100)}% transparent`;
        swatch.onclick = () => this.edit([target]);
        row.append(label, swatch);
        return row;
    }

    private edit(targets: AppearanceTarget[]) {
        if (!targets.length) return;
        const current = this.material(targets[0]);
        const form = document.createElement("div");
        form.className = style.editor;
        const names = document.createElement("p");
        names.textContent = targets
            .map(({ node, faces }) =>
                faces ? `${node.name}: faces ${faces.map((i) => i + 1).join(", ")}` : node.name,
            )
            .join("; ");
        form.append(names);
        const color = document.createElement("input");
        color.type = "color";
        color.value = colorCss(current?.color ?? 0xdedede);
        const transparency = document.createElement("input");
        transparency.type = "range";
        transparency.min = "0";
        transparency.max = "100";
        transparency.value = String(Math.round((1 - (current?.opacity ?? 1)) * 100));
        const amount = document.createElement("output");
        amount.textContent = `${transparency.value}%`;
        transparency.oninput = () => {
            amount.textContent = `${transparency.value}%`;
        };
        for (const [name, input] of [
            ["Color", color],
            ["Transparency", transparency],
        ] as const) {
            const label = document.createElement("label");
            label.textContent = name;
            input.setAttribute("aria-label", name);
            label.append(input);
            if (input === transparency) label.append(amount);
            form.append(label);
        }
        PubSub.default.pub("showDialog", "sidebar.appearance", form, () => {
            // The dialog is a draft: opening, changing controls and cancelling never alters the model.
            Transaction.execute(this.doc, "Edit appearance", () => {
                for (const target of targets) {
                    if (!this.doc.modelManager.findNodes().includes(target.node)) continue;
                    const source = this.material(target);
                    const replacement: Material = source
                        ? Serializer.deserializeObject(this.doc, {
                              ...Serializer.serializeObject(source),
                              id: Id.generate(),
                          })
                        : new PhongMaterial({
                              document: this.doc,
                              name: target.node.name,
                              color: color.value,
                          });
                    replacement.name = `${target.node.name} appearance`;
                    replacement.color = color.value;
                    replacement.opacity = 1 - Number(transparency.value) / 100;
                    this.doc.modelManager.materials.push(replacement);
                    if (target.faces && target.node instanceof GeometryNode) {
                        target.node.removeFaceMaterial(target.faces);
                        target.node.addFaceMaterial(
                            target.faces.map((faceIndex) => ({ faceIndex, materialId: replacement.id })),
                        );
                    } else {
                        const ids = target.node.materialId;
                        // Keep face overrides when changing the underlying part appearance.
                        target.node.materialId = Array.isArray(ids)
                            ? [replacement.id, ...ids.slice(1)]
                            : replacement.id;
                    }
                }
            });
            this.doc.visual.update();
            this.changed();
        });
    }

    dispose() {
        this.disposed = true;
        this.doc.modelManager.removeNodeObserver(this.changed);
        this.doc.modelManager.materials.removeCollectionChanged(this.changed);
        this.doc.history.removeChanged(this.changed);
        this.doc.selection.onShapeChanged.remove(this.selectionChanged);
        this.doc.selection.onNodeChanged.remove(this.selectionChanged);
        for (const watch of this.watches) watch.removePropertyChanged(this.changed);
        this.watches.clear();
    }
}
