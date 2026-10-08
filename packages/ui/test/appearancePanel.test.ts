// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import {
    EditableShapeNode,
    type I18nKeys,
    type Material,
    PhongMaterial,
    Plane,
    PubSub,
    type PubSubEventMap,
} from "@chili3d/core";
import { createMockSelection, createMockVisualShapeData, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { AppearancePanel } from "../src/sidebar/appearancePanel";

let factory: ShapeFactory;
beforeAll(async () => {
    await initWasm({ wasmBinary: readFileSync("packages/wasm/lib/chili-wasm.wasm") });
    factory = new ShapeFactory();
});

function button(root: HTMLElement, label: string) {
    const result = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(result).not.toBeNull();
    return result!;
}

test("appearance drafts preserve shared materials, support cancellation and undo as one edit", async () => {
    const doc = new TestDocument();
    const material = new PhongMaterial({ document: doc, name: "Shared blue", color: "#123456" });
    material.shininess = 70;
    doc.modelManager.materials.push(material);
    const box = factory.box(Plane.XY, 10, 20, 30);
    expect(box.isOk).toBe(true);
    const part = new EditableShapeNode({
        document: doc,
        name: "Part 1",
        shape: box.value,
        materialId: material.id,
    });
    const other = new EditableShapeNode({
        document: doc,
        name: "Part 2",
        shape: box.value,
        materialId: material.id,
    });
    doc.modelManager.rootNode.add(part, other);
    const panel = new AppearancePanel(doc);
    let form: HTMLElement | undefined;
    let apply: (() => void) | undefined;
    const dialog = (
        _title: I18nKeys,
        content: HTMLElement,
        buttons?: Parameters<PubSubEventMap["showDialog"]>[2],
    ) => {
        form = content;
        apply = typeof buttons === "function" ? buttons : undefined;
    };
    PubSub.default.sub("showDialog", dialog);
    try {
        const before = doc.history.undoCount();
        button(panel.element, "Edit appearance: Part 1").click();
        expect(form).not.toBeUndefined();
        const color = form!.querySelector<HTMLInputElement>('[aria-label="Color"]');
        expect(color).not.toBeNull();
        color!.value = "#ff0000";
        // Dismissing a draft requires no rollback and changes neither part nor shared material.
        expect(part.materialId).toBe(material.id);
        expect(material.color).toBe("#123456");
        expect(doc.history.undoCount()).toBe(before);
        button(panel.element, "Edit appearance: Part 1").click();
        const reopened = form!.querySelector<HTMLInputElement>('[aria-label="Color"]');
        const transparency = form!.querySelector<HTMLInputElement>('[aria-label="Transparency"]');
        expect(reopened).not.toBeNull();
        expect(transparency).not.toBeNull();
        expect(reopened!.value).toBe("#123456");
        reopened!.value = "#008844";
        transparency!.value = "25";
        expect(apply).not.toBeUndefined();
        apply!();
        const replacement = doc.modelManager.materials.find((m) => m.id === part.materialId);
        expect(replacement).toBeInstanceOf(PhongMaterial);
        expect(replacement!.color).toBe("#008844");
        expect(replacement!.opacity).toBe(0.75);
        expect((replacement as PhongMaterial).shininess).toBe(70);
        expect(other.materialId).toBe(material.id);
        expect(material.color).toBe("#123456");
        expect(doc.history.undoCount()).toBe(before + 1);
        doc.history.undo();
        await Promise.resolve();
        expect(part.materialId).toBe(material.id);
        expect(button(panel.element, "Edit appearance: Part 1").title).toContain("#123456");
        doc.history.redo();
        expect(part.materialId).toBe(replacement!.id);
    } finally {
        PubSub.default.remove("showDialog", dialog);
        panel.dispose();
        doc.dispose();
    }
});

test("selected faces receive their own appearance and changing the part preserves the override", async () => {
    const selection = createMockSelection();
    const doc = new TestDocument({ selection });
    const material = new PhongMaterial({ document: doc, name: "Base", color: "#999999" });
    doc.modelManager.materials.push(material);
    const box = factory.box(Plane.XY, 10, 20, 30);
    expect(box.isOk).toBe(true);
    const part = new EditableShapeNode({
        document: doc,
        name: "Box",
        shape: box.value,
        materialId: material.id,
    });
    doc.modelManager.rootNode.add(part);
    const faces = part.mesh.faces;
    expect(faces?.range.length).toBe(6);
    const pick = createMockVisualShapeData();
    pick.owner = { ...pick.owner, node: part };
    pick.shape = faces!.range[0].shape;
    pick.indexes = [0];
    selection.getSelectedShapes = () => [pick];
    const panel = new AppearancePanel(doc);
    let form: HTMLElement | undefined;
    let apply: (() => void) | undefined;
    const dialog = (
        _title: I18nKeys,
        content: HTMLElement,
        buttons?: Parameters<PubSubEventMap["showDialog"]>[2],
    ) => {
        form = content;
        apply = typeof buttons === "function" ? buttons : undefined;
    };
    PubSub.default.sub("showDialog", dialog);
    const setColor = (value: string) => {
        expect(form).not.toBeUndefined();
        const input = form!.querySelector<HTMLInputElement>('[aria-label="Color"]');
        expect(input).not.toBeNull();
        input!.value = value;
        expect(apply).not.toBeUndefined();
        apply!();
    };
    try {
        const row = panel.element.querySelector(`[data-node-id="${part.id}"]`);
        expect(row).not.toBeNull();
        selection.onNodeChanged.emit([part]);
        await Promise.resolve();
        expect(panel.element.querySelector(`[data-node-id="${part.id}"]`)).toBe(row);
        const add = button(panel.element, "Add appearance to selected faces");
        expect(add.disabled).toBe(false);
        add.click();
        setColor("#ff8800");
        await Promise.resolve();
        expect(part.faceMaterialPair.map((pair) => pair.faceIndex)).toEqual([0]);
        const ids = part.materialId as string[];
        expect(ids[0]).toBe(material.id);
        const override = doc.modelManager.materials.find((m) => m.id === ids[1]) as Material;
        expect(override.color).toBe("#ff8800");
        button(panel.element, "Edit appearance: Box").click();
        setColor("#008844");
        expect(part.faceMaterialPair.map((pair) => pair.faceIndex)).toEqual([0]);
        expect(part.materialId[1]).toBe(override.id);
        doc.history.undo();
        expect(part.materialId).toEqual(ids);
        doc.history.undo();
        expect(part.materialId).toBe(material.id);
        expect(part.faceMaterialPair).toEqual([]);
    } finally {
        PubSub.default.remove("showDialog", dialog);
        panel.dispose();
        doc.dispose();
    }
});
