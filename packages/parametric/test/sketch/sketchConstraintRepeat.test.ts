// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ICameraController, Plane, Result, XYZ } from "@chili3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import {
    CoincidentConstraintCommand,
    HorizontalConstraintCommand,
} from "../../src/sketch/commands/sketchConstraints";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import type { SketchEventHandler } from "../../src/sketch/editor/sketchEventHandler";
import { ConstraintKind } from "../../src/sketch/sketchModel";
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
    return { app, doc, view, restoreFactory };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const pointerEvent = (x: number, y: number): PointerEvent =>
    ({ offsetX: x, offsetY: y, button: 0 }) as PointerEvent;

describe("constraint tools stay armed until Escape", () => {
    test("Horizontal keeps asking for lines after each application; Escape ends it", async () => {
        const { app, doc, view, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const a = editor.solver.addLine(40, 20, 140, 30);
            const b = editor.solver.addLine(40, -40, 140, -30);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            const command = new HorizontalConstraintCommand();
            const run = command.execute(app as any);
            await tick();
            expect(editor.isPicking).toBe(true);
            handler.pointerDown(view, pointerEvent(490, 275));
            await tick();
            expect(editor.solver.toData().constraints.map((c) => [c.kind, c.refs[0].entityId])).toEqual([
                [ConstraintKind.Horizontal, a],
            ]);
            expect(editor.isPicking).toBe(true);
            handler.pointerDown(view, pointerEvent(490, 335));
            await tick();
            expect(editor.solver.toData().constraints.map((c) => [c.kind, c.refs[0].entityId])).toEqual([
                [ConstraintKind.Horizontal, a],
                [ConstraintKind.Horizontal, b],
            ]);
            expect(editor.isPicking).toBe(true);
            handler.keyDown(view, { key: "Escape" } as KeyboardEvent);
            await run;
            expect(editor.isPicking).toBe(false);
            expect(command.isCompleted).toBe(true);
            expect(SketchEditor.getActive()).toBe(editor);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("Escape in the middle of a pair cancels the tool", async () => {
        const { app, doc, view, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            editor.solver.addLine(40, 20, 140, 20);
            editor.solver.addLine(40, -40, 140, -40);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            const command = new CoincidentConstraintCommand();
            const run = command.execute(app as any);
            await tick();
            handler.pointerDown(view, pointerEvent(440, 280));
            await tick();
            expect(editor.isPicking).toBe(true);
            handler.keyDown(view, { key: "Escape" } as KeyboardEvent);
            await run;
            expect(editor.isPicking).toBe(false);
            expect(editor.solver.toData().constraints).toEqual([]);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("a pre-selected line gets its constraint at once and the tool ends", async () => {
        const { app, doc, view, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const a = editor.solver.addLine(40, 20, 140, 30);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            handler.pointerDown(view, pointerEvent(490, 275));
            handler.pointerUp(view, pointerEvent(490, 275));
            expect(handler.selectedEntityIds).toEqual([a]);
            await new HorizontalConstraintCommand().execute(app as any);
            expect(editor.solver.toData().constraints.map((c) => c.kind)).toEqual([
                ConstraintKind.Horizontal,
            ]);
            expect(editor.isPicking).toBe(false);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("leaving the sketch cancels an armed tool", async () => {
        const { app, doc, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            editor.solver.addLine(40, 20, 140, 30);
            editor.solve(true);
            const command = new HorizontalConstraintCommand();
            const run = command.execute(app as any);
            await tick();
            expect(editor.isPicking).toBe(true);
            editor.exit();
            await run;
            expect(command.isCanceled).toBe(true);
            expect(command.isCompleted).toBe(true);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });
});
