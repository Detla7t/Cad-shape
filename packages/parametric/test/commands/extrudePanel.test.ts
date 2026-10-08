// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { setDocumentUnits } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { ExtrudePanel, type ExtrudePanelModel } from "../../src/commands/extrudePanel";

test("invalid depth stays invalid when offset changes; cancel does not confirm", () => {
    const doc = new TestDocument();
    setDocumentUnits(doc, { length: "in", angle: "deg", lengthPrecision: 3, anglePrecision: 1 });
    const model: ExtrudePanelModel = {
        document: doc,
        operation: "option.command.operation.new",
        depth: 25.4,
        symmetric: false,
        startOffset: 0,
        onPropertyChanged() {},
        removePropertyChanged() {},
    };
    const confirm = rs.fn(),
        cancel = rs.fn();
    const panel = new ExtrudePanel(model, confirm, cancel);
    try {
        panel.setProfile("Sketch1", 1);
        const depth = panel.element.querySelector<HTMLInputElement>('[aria-label="Extrude depth"]')!;
        const offset = panel.element.querySelector<HTMLInputElement>('[aria-label="Extrude offset"]')!;
        expect(depth).not.toBeNull();
        expect(offset).not.toBeNull();
        expect(depth.value).toBe("1.000");
        expect([depth.selectionStart, depth.selectionEnd]).toEqual([0, 5]);
        depth.value = "bad(";
        depth.dispatchEvent(new Event("input"));
        offset.value = "2";
        offset.dispatchEvent(new Event("input"));
        expect(model.startOffset).toBe(50.8);
        expect(model.depth).toBe(25.4);
        expect(panel.canConfirm).toBe(false);
        panel.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        expect(confirm).not.toHaveBeenCalled();
        depth.value = "1.95";
        depth.dispatchEvent(new Event("input"));
        expect(model.depth).toBeCloseTo(49.53);
        expect(panel.canConfirm).toBe(true);
        panel.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(confirm).not.toHaveBeenCalled();
        model.depth = 0;
        panel.refresh();
        expect(panel.canConfirm).toBe(false);
    } finally {
        panel.dispose();
        doc.dispose();
    }
});
