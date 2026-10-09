// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, type ICameraController, Plane, Result, XYZ } from "@chili3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import {
    SketchPointSnapEventHandler,
    type SketchPointSnapResult,
} from "../../src/sketch/commands/sketchPointSnapEventHandler";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { SketchNode } from "../../src/sketch/sketchNode";
import "./setup";

function setup() {
    const camera = {
        cameraPosition: new XYZ({ x: 0, y: 0, z: 500 }),
        cameraTarget: XYZ.zero,
        cameraUp: XYZ.unitY,
        cameraType: "perspective" as "perspective" | "orthographic",
        lookAt: rs.fn(),
        fitContent: rs.fn(),
    };
    const app = createMockApplication();
    const doc = new TestDocument({ application: app, selection: { clearSelection: rs.fn() } as any });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const view = createMockView({ document: doc, cameraController: camera as unknown as ICameraController });
    view.worldToScreen = (p) => ({ x: p.x + 400, y: 300 - p.y }) as never;
    (app as any).activeView = view;
    const previous = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
    Object.defineProperty(globalThis, "shapeFactory", {
        value: {
            line: () => Result.ok({ isEqual: () => false }),
            circle: () => Result.ok({ isEqual: () => false }),
            arc: () => Result.ok({ isEqual: () => false }),
            wire: () => Result.ok({ isEqual: () => false }),
            combine: () => Result.ok({ isEqual: () => false }),
        },
        writable: true,
        configurable: true,
    });
    const restoreFactory = () => {
        if (previous) Object.defineProperty(globalThis, "shapeFactory", previous);
        else delete (globalThis as any).shapeFactory;
    };
    return { doc, view, restoreFactory };
}

const mouse = (x: number, y: number, extra: Partial<PointerEvent>): PointerEvent =>
    ({ offsetX: x, offsetY: y, pointerType: "mouse", ...extra }) as PointerEvent;

/** A second-point step of a line from the origin, the way the line tool creates it. */
function secondPointHandler(doc: TestDocument) {
    const controller = new AsyncController();
    const handler = new SketchPointSnapEventHandler(doc, controller, {
        refPoint: () => XYZ.zero,
        tentative: (probe) => ({ type: "line", params: [0, 0, probe[0], probe[1]] }),
    });
    return { controller, handler };
}

describe("press-and-drag drawing", () => {
    test("releasing after a held move completes the step at the release point, flagged as dragged", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const { controller, handler } = secondPointHandler(doc);
            handler.pointerMove(view, mouse(452, 300, { buttons: 1 }));
            handler.pointerMove(view, mouse(470, 300, { buttons: 1 }));
            expect(controller.result).toBeUndefined();
            handler.pointerUp(view, mouse(470, 300, { button: 0, buttons: 0 }));
            expect(controller.result?.status).toBe("success");
            const snaped = handler.snaped as SketchPointSnapResult;
            expect(snaped.dragged).toBe(true);
            expect([snaped.point!.x, snaped.point!.y]).toEqual([70, 0]);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test.each([
        { name: "no held move", moves: [] as [number, number][] },
        { name: "a held move under the threshold", moves: [[452, 300]] as [number, number][] },
    ])("the release of the click that started the step ($name) is not a pick", ({ moves }) => {
        const { doc, view, restoreFactory } = setup();
        try {
            SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const { controller, handler } = secondPointHandler(doc);
            handler.pointerMove(view, mouse(450, 300, { buttons: 1 }));
            for (const [x, y] of moves) handler.pointerMove(view, mouse(x, y, { buttons: 1 }));
            handler.pointerUp(view, mouse(452, 300, { button: 0, buttons: 0 }));
            expect(controller.result).toBeUndefined();
            // the tool continues as click-click: the next press completes the step
            handler.pointerMove(view, mouse(480, 300, { buttons: 0 }));
            handler.pointerDown(view, mouse(480, 300, { button: 0, buttons: 1 }));
            expect(controller.result?.status).toBe("success");
            expect((handler.snaped as SketchPointSnapResult).dragged).toBeUndefined();
            expect(handler.snaped!.point!.x).toBe(80);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("a move without the button held never counts as a drag", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const { controller, handler } = secondPointHandler(doc);
            handler.pointerMove(view, mouse(450, 300, { buttons: 0 }));
            handler.pointerMove(view, mouse(490, 300, { buttons: 0 }));
            handler.pointerUp(view, mouse(490, 300, { button: 0, buttons: 0 }));
            expect(controller.result).toBeUndefined();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });
});
