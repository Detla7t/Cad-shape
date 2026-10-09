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
    // one consistent mapping for points and curves: world (x, y) -> screen (400 + x, 300 - y)
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

function pointerEvent(x: number, y: number, extra: Partial<PointerEvent> = {}): PointerEvent {
    return { offsetX: x, offsetY: y, button: 0, ...extra } as PointerEvent;
}

function click(handler: SketchEventHandler, view: any, x: number, y: number) {
    handler.pointerDown(view, pointerEvent(x, y));
    handler.pointerUp(view, pointerEvent(x, y));
}

function drag(handler: SketchEventHandler, view: any, from: [number, number], to: [number, number]) {
    handler.pointerDown(view, pointerEvent(from[0], from[1]));
    handler.pointerMove(view, pointerEvent(to[0], to[1]));
    handler.pointerUp(view, pointerEvent(to[0], to[1]));
}

describe("direct manipulation of sketch curves", () => {
    test("a plain left-drag on a line body translates it and commits", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            const id = editor.solver.addLine(40, 20, 140, 20);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            // the line body at (90, 20) is screen (490, 280), 50 px from either endpoint
            drag(handler, view, [490, 280], [510, 250]);
            expect(editor.solver.entity(id)!.params.map((v) => Math.round(v))).toEqual([60, 50, 160, 50]);
            expect(node.data.entities[0].params.map((v) => Math.round(v))).toEqual([60, 50, 160, 50]);
            expect(handler.selectedEntityIds).toEqual([id]);
            expect(editor.lastSolveOutcome.result).toMatch(/^Ok/);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("a press and release without movement is a click: selection toggles, geometry untouched", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const id = editor.solver.addLine(40, 20, 140, 20);
            editor.solve(true);
            const before = editor.solver.toData();
            const commit = rs.spyOn(editor, "commit");
            const handler = doc.visual.eventHandler as SketchEventHandler;
            handler.pointerDown(view, pointerEvent(490, 280));
            // still under the drag threshold: no drag has started
            handler.pointerMove(view, pointerEvent(491, 281));
            expect(handler.selectedEntityIds).toEqual([]);
            handler.pointerUp(view, pointerEvent(491, 281));
            expect(handler.selectedEntityIds).toEqual([id]);
            click(handler, view, 490, 280);
            expect(handler.selectedEntityIds).toEqual([]);
            expect(editor.solver.toData()).toEqual(before);
            expect(commit).not.toHaveBeenCalled();
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("dragging one curve of a multi-selection moves the whole selection", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const a = editor.solver.addLine(40, 20, 140, 20);
            const b = editor.solver.addLine(40, -40, 140, -40);
            const c = editor.solver.addCircle(250, 0, 20);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            click(handler, view, 490, 280);
            click(handler, view, 490, 340);
            expect(handler.selectedEntityIds).toEqual([a, b]);
            drag(handler, view, [490, 340], [510, 310]);
            expect(editor.solver.entity(a)!.params.map((v) => Math.round(v))).toEqual([60, 50, 160, 50]);
            expect(editor.solver.entity(b)!.params.map((v) => Math.round(v))).toEqual([60, -10, 160, -10]);
            expect(editor.solver.entity(c)!.params).toEqual([250, 0, 20]);
            expect(handler.selectedEntityIds).toEqual([a, b]);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("dragging an unselected curve beside a selection moves only that curve", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const a = editor.solver.addLine(40, 20, 140, 20);
            const b = editor.solver.addLine(40, -40, 140, -40);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            click(handler, view, 490, 280);
            drag(handler, view, [490, 340], [510, 310]);
            expect(editor.solver.entity(a)!.params).toEqual([40, 20, 140, 20]);
            expect(editor.solver.entity(b)!.params.map((v) => Math.round(v))).toEqual([60, -10, 160, -10]);
            expect(handler.selectedEntityIds).toEqual([a, b]);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("a plain drag on a circle rim changes its radius without a modifier", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const id = editor.solver.addCircle(90, 0, 50);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            drag(handler, view, [540, 300], [570, 300]);
            expect(editor.node.data.entities[0].params).toEqual([90, 0, 80]);
            expect(editor.solver.toData().constraints).toEqual([]);
            expect(handler.selectedEntityIds).toEqual([id]);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("Escape during a drag restores the geometry; Escape on a pressed curve cancels the press", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const id = editor.solver.addLine(40, 20, 140, 20);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            handler.pointerDown(view, pointerEvent(490, 280));
            handler.pointerMove(view, pointerEvent(510, 250));
            expect(editor.solver.entity(id)!.params[0]).toBeCloseTo(60);
            handler.keyDown(view, { key: "Escape" } as KeyboardEvent);
            expect(editor.solver.entity(id)!.params).toEqual([40, 20, 140, 20]);
            handler.pointerUp(view, pointerEvent(510, 250));
            expect(editor.solver.entity(id)!.params).toEqual([40, 20, 140, 20]);

            handler.pointerDown(view, pointerEvent(490, 280));
            handler.keyDown(view, { key: "Escape" } as KeyboardEvent);
            handler.pointerUp(view, pointerEvent(490, 280));
            expect(handler.selectedEntityIds).toEqual([]);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });

    test("fully constrained and external geometry is selected by a drag gesture, not moved", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const fixed = editor.solver.addLine(40, 20, 140, 20);
            for (const pointIndex of [0, 1]) {
                const ref = { entityId: fixed, pointIndex };
                editor.solver.addConstraint({
                    kind: ConstraintKind.Fix,
                    refs: [ref],
                    datums: editor.solver.pointOf(ref),
                });
            }
            editor.solve(true);
            expect(editor.fullyConstrainedEntities.has(fixed)).toBe(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            drag(handler, view, [490, 280], [510, 250]);
            expect(editor.solver.entity(fixed)!.params).toEqual([40, 20, 140, 20]);
            expect(handler.selectedEntityIds).toEqual([fixed]);
        } finally {
            SketchEditor.exit();
            restoreFactory();
        }
    });
});
