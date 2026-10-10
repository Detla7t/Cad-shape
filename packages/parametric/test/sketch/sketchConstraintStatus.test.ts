// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, type ICameraController, Plane, Result, VisualConfig, XYZ } from "@chili3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import {
    type SketchEventHandler,
    sketchEntityColor,
    sketchPointColor,
} from "../../src/sketch/editor/sketchEventHandler";
import {
    ConstraintKind,
    pointRefKey,
    SKETCH_ORIGIN_ID,
    SKETCH_X_AXIS_ID,
    type SketchPointRef,
} from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

const ORIGIN: SketchPointRef = { entityId: SKETCH_ORIGIN_ID, pointIndex: 0 };
const start = (entityId: number): SketchPointRef => ({ entityId, pointIndex: 0 });
const end = (entityId: number): SketchPointRef => ({ entityId, pointIndex: 1 });

function withSolver(body: (solver: SketchSolver) => void): void {
    const solver = new SketchSolver(Plane.XY);
    try {
        body(solver);
    } finally {
        solver.dispose();
    }
}

function fix(solver: SketchSolver, ref: SketchPointRef): void {
    solver.addConstraint({ kind: ConstraintKind.Fix, refs: [ref], datums: solver.pointOf(ref) });
}

describe("per-point and per-curve constraint status", () => {
    test("an origin-attached vertical line: solved stroke and origin end, free far end", () => {
        withSolver((solver) => {
            const line = solver.addLine(0, 0, 0, 40);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [start(line), ORIGIN] });
            solver.addConstraint({ kind: ConstraintKind.Vertical, refs: [start(line), end(line)] });
            expect(solver.solve(true)).toEqual({ result: "OkUnderconstrained", dofs: 1 });
            const status = solver.constraintStatus();
            expect(status.points.has(pointRefKey(start(line)))).toBe(true);
            expect(status.points.has(pointRefKey(end(line)))).toBe(false);
            expect(status.curves.has(line)).toBe(true);
            expect(status.entities.has(line)).toBe(false);
        });
    });

    test("a fixed endpoint with free direction and length: only that endpoint is solved", () => {
        withSolver((solver) => {
            const line = solver.addLine(10, 10, 50, 30);
            fix(solver, start(line));
            solver.solve(true);
            const status = solver.constraintStatus();
            expect([...status.points]).toEqual([pointRefKey(start(line))]);
            expect(status.curves.has(line)).toBe(false);
            expect(status.entities.has(line)).toBe(false);
        });
    });

    test("ends riding on the X axis with a free length: solved stroke, both ends free", () => {
        withSolver((solver) => {
            const line = solver.addLine(-20, 0, 30, 0);
            for (const ref of [start(line), end(line)])
                solver.addConstraint({
                    kind: ConstraintKind.PointOnLine,
                    refs: [
                        ref,
                        { entityId: SKETCH_X_AXIS_ID, pointIndex: 0 },
                        { entityId: SKETCH_X_AXIS_ID, pointIndex: 1 },
                    ],
                });
            expect(solver.solve(true).dofs).toBe(2);
            const status = solver.constraintStatus();
            expect(status.points.size).toBe(0);
            expect(status.curves.has(line)).toBe(true);
            expect(status.entities.has(line)).toBe(false);
        });
    });

    test("both endpoints fixed: the line and its endpoints are solved beside free geometry", () => {
        withSolver((solver) => {
            const line = solver.addLine(0, 0, 25, 5);
            const free = solver.addLine(0, 20, 30, 20);
            fix(solver, start(line));
            fix(solver, end(line));
            solver.addConstraint({ kind: ConstraintKind.Horizontal, refs: [start(free), end(free)] });
            solver.solve(true);
            const status = solver.constraintStatus();
            expect(status.points).toEqual(new Set([pointRefKey(start(line)), pointRefKey(end(line))]));
            expect(status.curves).toEqual(new Set([line]));
            expect(status.entities).toEqual(new Set([line]));
        });
    });

    test("a circle on a fixed center with a free radius keeps a solved center only", () => {
        withSolver((solver) => {
            const circle = solver.addCircle(0, 0, 10);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [start(circle), ORIGIN] });
            solver.solve(true);
            let status = solver.constraintStatus();
            expect(status.points.has(pointRefKey(start(circle)))).toBe(true);
            expect(status.curves.has(circle)).toBe(false);
            solver.addConstraint({ kind: ConstraintKind.Radius, refs: [start(circle)], datum: 10 });
            solver.solve(true);
            status = solver.constraintStatus();
            expect(status.curves.has(circle)).toBe(true);
            expect(status.entities.has(circle)).toBe(true);
        });
    });

    test("an arc on a solved circle with free ends: solved stroke and center, free ends", () => {
        withSolver((solver) => {
            const arc = solver.addArc(0, 0, 10, 0, 0, 10);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [start(arc), ORIGIN] });
            solver.addConstraint({ kind: ConstraintKind.Radius, refs: [start(arc)], datum: 10 });
            solver.solve(true);
            const status = solver.constraintStatus();
            expect(status.points.has(pointRefKey({ entityId: arc, pointIndex: 0 }))).toBe(true);
            expect(status.points.has(pointRefKey({ entityId: arc, pointIndex: 1 }))).toBe(false);
            expect(status.points.has(pointRefKey({ entityId: arc, pointIndex: 2 }))).toBe(false);
            expect(status.curves.has(arc)).toBe(true);
            expect(status.entities.has(arc)).toBe(false);
        });
    });

    test("a redundant pin neither hides a solved point nor inflates the remaining DOF", () => {
        withSolver((solver) => {
            const line = solver.addLine(0, 0, 0, 40);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [start(line), ORIGIN] });
            solver.addConstraint({ kind: ConstraintKind.Vertical, refs: [start(line), end(line)] });
            fix(solver, start(line));
            // garlic's dofs() reads 3 here; the solve reports the rank diagnosis
            expect(solver.solve(true)).toEqual({ result: "OkUnderconstrained", dofs: 1 });
            const status = solver.constraintStatus();
            expect(status.points.has(pointRefKey(start(line)))).toBe(true);
            expect(status.points.has(pointRefKey(end(line)))).toBe(false);
            expect(status.curves.has(line)).toBe(true);
        });
    });

    test("coincident chain ends share their status and the probe leaves the sketch untouched", () => {
        withSolver((solver) => {
            const a = solver.addLine(0, 0, 20, 0);
            const b = solver.addLine(20, 0, 20, 15);
            solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [end(a), start(b)] });
            fix(solver, start(a));
            fix(solver, end(a));
            solver.solve(true);
            const before = solver.toData();
            const status = solver.constraintStatus();
            expect(status.points.has(pointRefKey(start(b)))).toBe(true);
            expect(status.points.has(pointRefKey(end(b)))).toBe(false);
            expect(status.entities).toEqual(new Set([a]));
            expect(solver.toData()).toEqual(before);
        });
    });
});

function withEditor(body: (editor: SketchEditor, view: any) => void): void {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app, selection: { clearSelection: rs.fn() } as any });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const camera = {
        cameraPosition: new XYZ({ x: 0, y: 0, z: 500 }),
        cameraTarget: XYZ.zero,
        cameraUp: XYZ.unitY,
        cameraType: "perspective",
        lookAt: rs.fn(),
        fitContent: rs.fn(),
    };
    const view = createMockView({ document: doc, cameraController: camera as unknown as ICameraController });
    // world (x, y) -> screen (400 + x, 300 - y)
    view.worldToScreen = (p) => ({ x: p.x + 400, y: 300 - p.y }) as never;
    (app as any).activeView = view;
    const previous = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
    Object.defineProperty(globalThis, "shapeFactory", {
        value: {
            line: () => Result.ok({ isEqual: () => false }),
            wire: () => Result.ok({ isEqual: () => false }),
            combine: () => Result.ok({ isEqual: () => false }),
        },
        writable: true,
        configurable: true,
    });
    const graphics = Config.instance.graphics;
    const edgeColor = VisualConfig.defaultEdgeColor;
    try {
        body(SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY })), view);
    } finally {
        SketchEditor.exit();
        Config.instance.graphics = graphics;
        VisualConfig.defaultEdgeColor = edgeColor;
        if (previous) Object.defineProperty(globalThis, "shapeFactory", previous);
        else delete (globalThis as any).shapeFactory;
    }
}

const hex = (color: string) => Number.parseInt(color.slice(1), 16);

describe("sketch colors follow the per-point and per-curve status", () => {
    test("origin-attached vertical line: solved stroke and origin end, free far end in the free color", () => {
        withEditor((editor) => {
            Config.instance.graphics = { ...Config.instance.graphics, constrainedColor: "#101010" };
            const line = editor.solver.addLine(0, 0, 0, 40);
            editor.solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [start(line), ORIGIN] });
            editor.solver.addConstraint({ kind: ConstraintKind.Vertical, refs: [start(line), end(line)] });
            editor.solve(true);
            const entity = editor.solver.entity(line)!;
            const free = hex(Config.instance.graphics.underconstrainedColor);
            expect(sketchEntityColor(editor, entity)).toBe(0x101010);
            expect(sketchPointColor(editor, entity, start(line))).toBe(0x101010);
            expect(sketchPointColor(editor, entity, end(line))).toBe(free);
            expect(free).not.toBe(0x101010);
        });
    });

    test("a fixed endpoint with a free length: the stroke and the far end keep the free color", () => {
        withEditor((editor) => {
            Config.instance.graphics = { ...Config.instance.graphics, constrainedColor: null };
            VisualConfig.applyTheme("dark");
            const line = editor.solver.addLine(10, 10, 50, 30);
            fix(editor.solver, start(line));
            editor.solve(true);
            const entity = editor.solver.entity(line)!;
            const free = hex(Config.instance.graphics.underconstrainedColor);
            expect(sketchEntityColor(editor, entity)).toBe(free);
            // no configured constrained color: solved geometry takes the theme's edge color
            expect(sketchPointColor(editor, entity, start(line))).toBe(VisualConfig.defaultEdgeColor);
            expect(sketchPointColor(editor, entity, end(line))).toBe(free);
            VisualConfig.applyTheme("light");
            expect(sketchPointColor(editor, entity, start(line))).toBe(VisualConfig.defaultEdgeColor);
        });
    });

    test("a free point keeps its layer color while a solved one switches to the constrained color", () => {
        withEditor((editor) => {
            Config.instance.graphics = { ...Config.instance.graphics, constrainedColor: "#202020" };
            editor.solver.setLayers([
                { id: "0", name: "0", color: "#4a9eff" },
                { id: "red", name: "Red", color: "#ff0000" },
            ]);
            const line = editor.solver.addLine(0, 0, 30, 0);
            editor.solver.setEntityStyle(line, { layer: "red" });
            editor.solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [start(line), ORIGIN] });
            editor.solve(true);
            const entity = editor.solver.entity(line)!;
            expect(sketchEntityColor(editor, entity)).toBe(0xff0000);
            expect(sketchPointColor(editor, entity, start(line))).toBe(0x202020);
            expect(sketchPointColor(editor, entity, end(line))).toBe(0xff0000);
        });
    });

    test("a press on a solved endpoint selects it; the free end of the same line still drags", () => {
        withEditor((editor, view) => {
            const line = editor.solver.addLine(20, 0, 20, 40);
            fix(editor.solver, start(line));
            editor.solver.addConstraint({ kind: ConstraintKind.Vertical, refs: [start(line), end(line)] });
            editor.solve(true);
            expect(editor.fullyConstrainedEntities.has(line)).toBe(false);
            const handler = editor.document.visual.eventHandler as SketchEventHandler;
            const press = (x: number, y: number) => ({ offsetX: x, offsetY: y, button: 0 }) as PointerEvent;
            // the fixed end at (20, 0) is screen (420, 300): the gesture selects it, nothing moves
            handler.pointerDown(view, press(420, 300));
            handler.pointerMove(view, press(450, 270));
            handler.pointerUp(view, press(450, 270));
            expect(editor.solver.entity(line)!.params).toEqual([20, 0, 20, 40]);
            expect(handler.selectedPoints).toEqual([start(line)]);
            handler.clearSelection(view);
            // the free end at (20, 40) is screen (420, 260): dragging it lengthens the line
            handler.pointerDown(view, press(420, 260));
            handler.pointerMove(view, press(420, 230));
            handler.pointerUp(view, press(420, 230));
            expect(editor.solver.entity(line)!.params.map(Math.round)).toEqual([20, 0, 20, 70]);
        });
    });
});
