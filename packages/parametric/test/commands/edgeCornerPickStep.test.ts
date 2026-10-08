// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, type IPicker, ShapeTypes, type VisualShapeData } from "@chili3d/core";
import {
    createMockPicker,
    createMockSelection,
    createMockVisualShapeData,
    TestDocument,
} from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { type EdgeCornerPickHandler, EdgeCornerSelectStep } from "../../src/commands/edgeCornerPickStep";

test.each([
    "apply",
    "cancel",
] as const)("preselected fillet/chamfer edges wait for the user to %s", async (action) => {
    const edge = createMockVisualShapeData();
    let selected = [edge, createMockVisualShapeData({ shapeType: ShapeTypes.face })];
    const selection = createMockSelection();
    selection.getSelectedShapes = () => selected;
    selection.clearSelection = () => {
        selected = [];
    };
    selection.setSelectedShapes = (shapes: VisualShapeData[]) => {
        selected = shapes;
        return shapes.length;
    };
    const picker = createMockPicker();
    picker.pickAsync = rs.fn<IPicker["pickAsync"]>(
        (_handler, _prompt, controller) =>
            new Promise<void>((resolve) => {
                controller.onCompleted(() => resolve());
                controller.onCancelled(() => resolve());
            }),
    );
    const model = new TestDocument({ selection, picker });
    const controller = new AsyncController();
    const handlers: (EdgeCornerPickHandler | undefined)[] = [];
    const step = new EdgeCornerSelectStep(
        { allow: () => true },
        { arrowData: () => undefined, setValue: () => {} },
        (handler) => handlers.push(handler),
    );
    try {
        const pending = step.execute(model, controller);
        expect(picker.pickAsync).toHaveBeenCalledTimes(1);
        expect(controller.result).toBeUndefined();
        expect(selected).toEqual([edge]);
        expect(handlers).toHaveLength(1);
        if (action === "apply") {
            controller.success();
            const result = await pending;
            expect(result?.shapes).toEqual([edge]);
            expect(result?.type).toBe("shape");
        } else {
            controller.cancel();
            expect(await pending).toBeUndefined();
            expect(selected).toEqual([]);
        }
        expect(handlers).toHaveLength(2);
        expect(handlers[1]).toBeUndefined();
    } finally {
        controller.dispose();
    }
});
