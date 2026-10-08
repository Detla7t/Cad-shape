// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ICameraController, Plane, Result, VisualConfig, XYZ } from "@chili3d/core";
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
import { trimOrSplit } from "../../src/sketch/sketchOperations";
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
    (app as any).activeView = view;

    const htmlTexts: string[] = [];
    (view as any).htmlText = rs.fn((text: string) => {
        htmlTexts.push(text);
        return { dispose: rs.fn() };
    });
    const displayed: { id: number; colors: number[]; positions: number[][] }[] = [];
    const activeMeshes = new Set<number>();
    let nextMeshId = 1;
    (doc.visual.context as any).displayMesh = rs.fn((datas: any[]) => {
        displayed.push({
            id: nextMeshId,
            colors: datas.map((d) => d.color),
            positions: datas.map((d) => Array.from(d.position ?? [])),
        });
        activeMeshes.add(nextMeshId);
        return nextMeshId++;
    });
    (doc.visual.context as any).removeMesh = rs.fn((id: number) => activeMeshes.delete(id));

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
        if (previous) {
            Object.defineProperty(globalThis, "shapeFactory", previous);
        } else {
            delete (globalThis as any).shapeFactory;
        }
    };
    return { app, doc, view, htmlTexts, displayed, activeMeshes, restoreFactory };
}

function pointerEvent(x: number, y: number, shiftKey = false): PointerEvent {
    return { offsetX: x, offsetY: y, button: 0, shiftKey } as PointerEvent;
}

// mock view maps world (x, y, 0) -> screen (400 + x, 300 - y): a line (0,0)-(100,0)
// spans screen x 400..500 at y 300; clicking (450, 300) hits the line 50px from both ends
describe("SketchEditor entity selection", () => {
    test.each([
        "constraint",
        "pick",
    ] as const)("%s highlights follow a circle and chord after adding Horizontal", (kind) => {
        const { doc, view, displayed, activeMeshes, restoreFactory } = setup();
        const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
        try {
            const circle = editor.solver.addCircle(0, 0, 100);
            const line = editor.solver.addLine(-100, 0, 80, 60);
            for (const pointIndex of [0, 1])
                editor.solver.addConstraint({
                    kind: ConstraintKind.PointOnCircle,
                    refs: [
                        { entityId: line, pointIndex },
                        { entityId: circle, pointIndex: 0 },
                    ],
                });
            editor.solve(true);
            const before = [...editor.solver.entity(circle)!.params];
            const handler = doc.visual.eventHandler as SketchEventHandler;
            if (kind === "constraint") handler.highlightConstraintEntities([circle, line]);
            else handler.highlightPicks([circle, line]);
            const color = kind === "constraint" ? VisualConfig.highlightEdgeColor : 0xffb020;
            const old = displayed.findLast(
                (mesh) => mesh.colors.length === 2 && mesh.colors.every((c) => c === color),
            )!;
            expect(old).not.toBeUndefined();
            editor.solver.addConstraint({
                kind: ConstraintKind.Horizontal,
                refs: [
                    { entityId: line, pointIndex: 0 },
                    { entityId: line, pointIndex: 1 },
                ],
            });
            expect(editor.solve(true).result).toMatch(/^Ok/);
            editor.commit();
            const [cx, cy, radius] = editor.solver.entity(circle)!.params;
            expect([cx, cy, radius]).not.toEqual(before);
            expect(activeMeshes.has(old.id)).toBe(false);
            const highlights = displayed.filter(
                (mesh) => activeMeshes.has(mesh.id) && mesh.colors.includes(color),
            );
            expect(highlights).toHaveLength(1);
            const [circlePositions, linePositions] = highlights[0].positions;
            expect(circlePositions.length).toBeGreaterThan(6);
            for (let i = 0; i < circlePositions.length; i += 3)
                expect(Math.hypot(circlePositions[i] - cx, circlePositions[i + 1] - cy)).toBeCloseTo(
                    radius,
                    3,
                );
            expect(linePositions[1]).toBeCloseTo(linePositions[4], 5);
            expect(linePositions[1]).toBeCloseTo(editor.solver.entity(line)!.params[1], 5);
            editor.deleteEntities([circle, line]);
            expect(
                displayed.filter((mesh) => activeMeshes.has(mesh.id) && mesh.colors.includes(color)),
            ).toHaveLength(0);
        } finally {
            editor.exit();
            restoreFactory();
        }
    });
    test.each([
        [400, 400, 1],
        [300, 300, 2],
    ])("selecting a trimmed arc at %j keeps its geometry", (x, y, selected) => {
        const { doc, view, displayed, activeMeshes, restoreFactory } = setup();
        const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
        try {
            const circle = editor.solver.addCircle(0, 0, 100);
            editor.solver.addLine(-100, 0, 100, 0);
            const data = editor.solver.toData();
            trimOrSplit(data, circle, [0, 100], "trim");
            editor.solver.reset(data);
            editor.solve(true);
            const before = editor.solver.toData();
            const handler = doc.visual.eventHandler as SketchEventHandler;
            const geometry = displayed.findLast(
                (mesh) => mesh.colors.length === 2 && activeMeshes.has(mesh.id),
            )!;
            expect(geometry).not.toBeUndefined();
            handler.pointerDown(view, pointerEvent(x, y));
            expect(activeMeshes.has(geometry.id)).toBe(true);
            expect(editor.solver.toData()).toEqual(before);
            handler.pointerUp(view, pointerEvent(x, y));
            expect(editor.solver.toData()).toEqual(before);
            expect(editor.selectedEntityIds).toEqual([selected]);
        } finally {
            editor.exit();
            restoreFactory();
        }
    });

    test("power trim waits for the pointer to leave a surviving arc before trimming it again", async () => {
        const { doc, view, restoreFactory } = setup();
        const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
        try {
            const circle = editor.solver.addCircle(0, 0, 100);
            editor.solver.addLine(-100, 0, 100, 0);
            editor.solve(true);
            editor.powerTrim = true;
            const handler = doc.visual.eventHandler as SketchEventHandler;
            const picked = editor.pickEntity("prompt.pickSketchEntity");
            // A trim near the left intersection leaves the other arc within the
            // same pick aperture; subpixel pointer motion must not cut it again.
            handler.pointerDown(view, pointerEvent(300, 295));
            expect(await picked).toBe(circle);
            const data = editor.solver.toData();
            trimOrSplit(data, circle, editor.lastPickPosition!, "trim");
            editor.solver.reset(data);
            editor.solve(true);
            const next = editor.pickEntity("prompt.pickSketchEntity");
            handler.pointerMove(view, { ...pointerEvent(300, 296), buttons: 1 } as PointerEvent);
            expect(editor.isPicking).toBe(true);
            expect(editor.solver.entity(circle)!.type).toBe("arc");
            handler.pointerUp(view, pointerEvent(300, 296));
            // A deliberate new click is still a valid trim action.
            handler.pointerDown(view, pointerEvent(400, 400));
            expect(await next).toBe(circle);
        } finally {
            editor.cancelPick();
            editor.powerTrim = false;
            editor.exit();
            restoreFactory();
        }
    });
    test("clicking the same line twice deselects it without moving the pointer", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            handler.pointerDown(view, pointerEvent(450, 300));
            handler.pointerUp(view, pointerEvent(450, 300));
            expect(handler.selectedEntityIds).toEqual([1]);
            handler.pointerDown(view, pointerEvent(450, 300));
            handler.pointerUp(view, pointerEvent(450, 300));
            expect(handler.selectedEntityIds).toEqual([]);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test.each([
        { start: 475, end: 425, expected: [1, 2] },
        { start: 425, end: 475, expected: [2] },
    ])("box direction $start → $end selects crossed or fully enclosed entities", ({
        start,
        end,
        expected,
    }) => {
        const { doc, view, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addCircle(50, 0, 10);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            handler.pointerDown(view, pointerEvent(start, 280));
            handler.pointerMove(view, pointerEvent(end, 320));
            handler.pointerUp(view, pointerEvent(end, 320));
            expect(handler.selectedEntityIds).toEqual(expected);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("clicking an entity selects it and shows its constraints without hover", () => {
        const { doc, view, htmlTexts, displayed, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addConstraint({
                kind: ConstraintKind.Horizontal,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
            });
            editor.solve(true);
            expect(htmlTexts).not.toContain("H");

            const handler = doc.visual.eventHandler as SketchEventHandler;
            handler.pointerDown(view, pointerEvent(450, 300));
            handler.pointerUp(view, pointerEvent(450, 300));

            // a selection highlight mesh with the selected color was displayed
            expect(displayed.some((d) => d.colors.includes(VisualConfig.selectedEdgeColor))).toBe(true);
            // the constraint badge shows even after the mouse is gone (selected state)
            expect(htmlTexts).toContain("H");
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("clicking empty space clears the selection and hides its constraints", () => {
        const { doc, view, htmlTexts, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addConstraint({
                kind: ConstraintKind.Horizontal,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
            });
            editor.solve(true);

            const handler = doc.visual.eventHandler as SketchEventHandler;
            handler.pointerDown(view, pointerEvent(450, 300));
            handler.pointerUp(view, pointerEvent(450, 300));
            expect(htmlTexts).toContain("H");

            htmlTexts.length = 0;
            handler.pointerDown(view, pointerEvent(100, 100));
            handler.pointerUp(view, pointerEvent(100, 100));
            expect(htmlTexts).not.toContain("H");
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("shift-click accumulates the selection", () => {
        const { doc, view, displayed, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(0, 100, 100, 100);
            editor.solve(true);

            const handler = doc.visual.eventHandler as SketchEventHandler;
            // line 2 spans screen x 400..500 at y 200
            handler.pointerDown(view, pointerEvent(450, 300));
            handler.pointerUp(view, pointerEvent(450, 300));
            handler.pointerDown(view, pointerEvent(450, 200, true));
            handler.pointerUp(view, pointerEvent(450, 200, true));

            const selectionMesh = displayed.findLast((d) =>
                d.colors.includes(VisualConfig.selectedEdgeColor),
            );
            expect(selectionMesh?.colors.length).toBe(2);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("Delete removes the selected entities when nothing is hovered", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);

            const handler = doc.visual.eventHandler as SketchEventHandler;
            handler.pointerDown(view, pointerEvent(450, 300));
            handler.pointerUp(view, pointerEvent(450, 300));
            handler.keyDown(view, new KeyboardEvent("keydown", { key: "Delete" }));

            expect(editor.solver.entities()).toEqual([]);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("Escape clears the selection and keeps the session open on repeated presses", () => {
        const { app, doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);

            const handler = doc.visual.eventHandler as SketchEventHandler;
            handler.pointerDown(view, pointerEvent(450, 300));
            handler.pointerUp(view, pointerEvent(450, 300));

            handler.keyDown(view, new KeyboardEvent("keydown", { key: "Escape" }));
            expect(SketchEditor.getActive()).toBe(editor);

            handler.keyDown(view, new KeyboardEvent("keydown", { key: "Escape" }));
            expect(SketchEditor.getActive()).toBe(editor);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });
});
