// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { NodeActions, PhongMaterial, Plane, PubSub } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { BoxNode } from "../../src/bodys/box";
import "../../src/commands/partActions";

test("part transparency has its own material and undo restores the shared material", async () => {
    const doc = new TestDocument();
    const original = new PhongMaterial({ document: doc, name: "Steel", color: 0x888888 });
    doc.modelManager.materials.push(original);
    const part = new BoxNode({ document: doc, plane: Plane.XY, dx: 10, dy: 20, dz: 30 });
    part.materialId = original.id;
    doc.modelManager.addNode(part);
    try {
        const action = NodeActions.forNode(part).find((a) => a.id === "transparent");
        expect(action).not.toBeUndefined();
        await action!.run!();
        expect(part.materialId).not.toBe(original.id);
        expect(doc.modelManager.materials.find((m) => m.id === part.materialId)?.opacity).toBe(0.3);
        expect(original.opacity).toBe(1);
        doc.history.undo();
        expect(part.materialId).toBe(original.id);
        expect(doc.modelManager.materials.find((m) => m.id === original.id)?.opacity).toBe(1);
    } finally {
        doc.dispose();
    }
});

test("part comments are saved as an undoable property through the menu", async () => {
    const doc = new TestDocument();
    const part = new BoxNode({ document: doc, plane: Plane.XY, dx: 10, dy: 20, dz: 30 });
    doc.modelManager.addNode(part);
    let dialog: HTMLElement | undefined, confirm: (() => void) | undefined;
    const show: Parameters<typeof PubSub.default.sub<"showDialog">>[1] = (_title, content, onConfirm) => {
        dialog = content;
        confirm = typeof onConfirm === "function" ? onConfirm : undefined;
    };
    PubSub.default.sub("showDialog", show);
    try {
        const action = NodeActions.forNode(part).find((a) => a.id === "comment");
        expect(action).not.toBeUndefined();
        await action!.run!();
        expect(dialog).not.toBeUndefined();
        const field = dialog!.querySelector("textarea");
        expect(field).not.toBeNull();
        field!.value = "Check mounting holes";
        expect(confirm).not.toBeUndefined();
        confirm!();
        expect(part.partComment).toBe("Check mounting holes");
        doc.history.undo();
        expect(part.partComment).toBe("");
    } finally {
        PubSub.default.remove("showDialog", show);
        doc.dispose();
    }
});
