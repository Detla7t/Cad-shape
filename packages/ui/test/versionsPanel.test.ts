// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentVersionControl, FolderNode, Transaction } from "@chili3d/core";
import { createMockApplication, createMockView, TestDocument } from "@chili3d/core/test-utils";
import { VersionsPanel } from "../src/versions/versionsPanel";

function clickText(root: ParentNode, text: string) {
    const button = [...root.querySelectorAll("button")].find((b) => b.textContent === text);
    expect(button).not.toBeUndefined();
    button!.click();
}

test("commits expand independently and selected fields can be reverted through the preview", () => {
    const doc = new TestDocument();
    const node = new FolderNode({ document: doc, name: "Original" });
    doc.modelManager.rootNode.add(node);
    const control = DocumentVersionControl.create(doc);
    Transaction.execute(doc, "Rename and hide", () => {
        node.name = "Edited";
        node.visible = false;
    });
    control.flush();
    const edited = control.head;
    const checkpoint = control.createCommit("Review checkpoint");
    expect(checkpoint.isOk).toBe(true);
    const app = createMockApplication();
    app.activeView = createMockView({ document: doc });
    const panel = new VersionsPanel(app);
    document.body.append(panel);
    try {
        for (const id of [checkpoint.value, edited]) {
            const disclosure = panel.querySelector<HTMLButtonElement>(
                `[data-commit="${id}"] button[aria-expanded]`,
            );
            expect(disclosure).not.toBeNull();
            disclosure!.click();
        }
        expect(panel.querySelectorAll('button[aria-expanded="true"]')).toHaveLength(2);
        const row = panel.querySelector(`[data-commit="${edited}"]`);
        expect(row).not.toBeNull();
        const rename = [...row!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((c) =>
            c.ariaLabel?.endsWith(" › name"),
        );
        expect(rename).not.toBeUndefined();
        rename!.click();
        clickText(row!, "Revert selected…");
        const preview = document.querySelector<HTMLDialogElement>(
            'dialog[aria-label="Revert selected changes"]',
        );
        expect(preview).not.toBeNull();
        expect(node.name).toBe("Edited");
        clickText(preview!, "Apply");
        expect(node.name).toBe("Original");
        expect(node.visible).toBe(false);
        expect(document.querySelector('dialog[aria-label="Revert selected changes"]')).toBeNull();
        doc.history.undo();
        expect(node.name).toBe("Edited");
    } finally {
        panel.remove();
        document.querySelector('dialog[aria-label="Revert selected changes"]')?.remove();
        control.dispose();
        doc.dispose();
    }
});
