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
import {
    ConstraintKind,
    originRef,
    SKETCH_ORIGIN_ID,
    SKETCH_X_AXIS_ID,
    SKETCH_Y_AXIS_ID,
} from "../../src/sketch/sketchModel";
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
        if (previous) {
            Object.defineProperty(globalThis, "shapeFactory", previous);
        } else {
            delete (globalThis as any).shapeFactory;
        }
    };
    return { app, doc, view, restoreFactory };
}

function pointerEvent(x: number, y: number): PointerEvent {
    return { offsetX: x, offsetY: y, button: 0 } as PointerEvent;
}

test("plain clicks accumulate and toggle sketch constraint targets; Space clears without exiting", () => {
    const { doc, view, restoreFactory } = setup();
    try {
        const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
        const line = editor.solver.addLine(40, 20, 140, 20);
        const circle = editor.solver.addCircle(240, 20, 40);
        editor.solve(true);
        const handler = doc.visual.eventHandler as SketchEventHandler;
        const click = (x: number, y: number) => {
            handler.pointerDown(view, pointerEvent(x, y));
            handler.pointerUp(view, pointerEvent(x, y));
        };
        click(490, 280);
        click(680, 280);
        expect(handler.selectedEntityIds).toEqual([line, circle]);
        click(490, 280);
        expect(handler.selectedEntityIds).toEqual([circle]);
        // The shared mock's point projection uses +Y; curve ray picking uses -Y.
        expect(handler.hitTestPoint(view, pointerEvent(440, 320))).toEqual({ entityId: line, pointIndex: 0 });
        click(440, 320);
        expect(handler.selectedPoints).toEqual([{ entityId: line, pointIndex: 0 }]);
        click(400, 300);
        expect(handler.selectedPoints).toEqual([{ entityId: line, pointIndex: 0 }, originRef()]);
        expect(handler.selectedEntityIds).toEqual([circle]);
        click(440, 320);
        expect(handler.selectedPoints).toEqual([originRef()]);
        handler.keyDown(view, new KeyboardEvent("keydown", { key: " " }));
        expect(handler.selectedPoints).toEqual([]);
        expect(handler.selectedEntityIds).toEqual([]);
        expect(SketchEditor.getActive()).toBe(editor);
        click(490, 280);
        click(750, 500);
        expect(handler.selectedEntityIds).toEqual([]);
    } finally {
        SketchEditor.exit();
        restoreFactory();
    }
});

test.each(["line", "arc"] as const)("Alt-drag translates an unsolved %s and Escape restores it", (type) => {
    const { doc, view, restoreFactory } = setup();
    try {
        const node = new SketchNode({ document: doc, plane: Plane.XY });
        const editor = SketchEditor.enter(node);
        const id =
            type === "line"
                ? editor.solver.addLine(40, 20, 140, 20)
                : editor.solver.addArc(90, 20, 140, 20, 40, 20);
        editor.solve(true);
        const original = [...editor.solver.entity(id)!.params];
        const handler = doc.visual.eventHandler as SketchEventHandler;
        // Mid-curve positions stay clear of the point-picking tolerance.
        const start = type === "line" ? [490, 280] : [490, 230];
        const event = (x: number, y: number) =>
            ({ ...pointerEvent(x, y), altKey: true, preventDefault() {} }) as PointerEvent;
        handler.pointerDown(view, event(start[0], start[1]));
        handler.pointerMove(view, event(start[0] + 20, start[1] - 30));
        expect(editor.solver.entity(id)!.params[0]).toBeCloseTo(original[0] + 20);
        expect(editor.solver.entity(id)!.params[1]).toBeCloseTo(original[1] + 30);
        handler.keyDown(view, { key: "Escape" } as KeyboardEvent);
        expect(editor.solver.entity(id)!.params).toEqual(original);
        handler.pointerDown(view, event(start[0], start[1]));
        handler.pointerMove(view, event(start[0] + 20, start[1] - 30));
        handler.pointerUp(view, event(start[0] + 20, start[1] - 30));
        expect(node.data.entities[0].params[0]).toBeCloseTo(original[0] + 20);
        expect(node.data.entities[0].params[1]).toBeCloseTo(original[1] + 30);
        expect(editor.lastSolveOutcome.result).toMatch(/^Ok/);
        editor.exit();
    } finally {
        SketchEditor.exit();
        restoreFactory();
    }
});

test("Alt-drag resizes a circle from its edge and moves it from its center", () => {
    const { doc, view, restoreFactory } = setup();
    try {
        const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
        const id = editor.solver.addCircle(90, 0, 50);
        editor.solve(true);
        const handler = doc.visual.eventHandler as SketchEventHandler;
        const event = (x: number, y: number) =>
            ({ ...pointerEvent(x, y), altKey: true, preventDefault() {} }) as PointerEvent;
        handler.pointerDown(view, event(540, 300));
        handler.pointerMove(view, event(570, 300));
        expect(editor.solver.entity(id)!.params).toEqual([90, 0, 80]);
        handler.keyDown(view, { key: "Escape" } as KeyboardEvent);
        expect(editor.solver.entity(id)!.params).toEqual([90, 0, 50]);
        handler.pointerDown(view, event(540, 300));
        handler.pointerMove(view, event(570, 300));
        handler.pointerUp(view, event(570, 300));
        expect(editor.node.data.entities[0].params).toEqual([90, 0, 80]);
        handler.pointerDown(view, event(490, 300));
        handler.pointerMove(view, event(510, 270));
        handler.pointerUp(view, event(510, 270));
        expect(editor.node.data.entities[0].params).toEqual([110, 30, 80]);
        expect(editor.solver.toData().constraints).toEqual([]);
    } finally {
        SketchEditor.exit();
        restoreFactory();
    }
});

test("Alt-drag leaves solved lines fixed beside movable geometry", () => {
    const { doc, view, restoreFactory } = setup();
    try {
        const node = new SketchNode({ document: doc, plane: Plane.XY });
        const editor = SketchEditor.enter(node);
        const fixed = editor.solver.addLine(40, 20, 140, 20);
        editor.solver.addCircle(250, 100, 30);
        for (const pointIndex of [0, 1]) {
            const ref = { entityId: fixed, pointIndex };
            editor.solver.addConstraint({
                kind: ConstraintKind.Fix,
                refs: [ref],
                datums: editor.solver.pointOf(ref),
            });
        }
        editor.solve(true);
        const original = editor.solver.entity(fixed)!.params;
        const handler = doc.visual.eventHandler as SketchEventHandler;
        handler.pointerDown(view, { ...pointerEvent(490, 280), altKey: true } as PointerEvent);
        handler.pointerMove(view, pointerEvent(510, 250));
        handler.pointerUp(view, pointerEvent(510, 250));
        expect(editor.solver.entity(fixed)!.params).toEqual(original);
        expect(editor.lastSolveOutcome.dofs).toBe(3);
        editor.exit();
    } finally {
        SketchEditor.exit();
        restoreFactory();
    }
});

describe("SketchEditor picking", () => {
    test("pickPoint resolves with the hit point on pointerDown", async () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor: SketchEditor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 10, 0);
            editor.solve(true);

            const promise = editor.pickPoint("prompt.pickSketchPoint");
            expect(editor.isPicking).toBe(true);
            // mock view: worldToScreen maps (0,0,0) -> (400, 300)
            (doc.visual.eventHandler as SketchEventHandler).pointerDown(view, pointerEvent(402, 298));

            await expect(promise).resolves.toEqual({ entityId: 1, pointIndex: 0 });
            expect(editor.isPicking).toBe(false);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("Escape cancels an active pick", async () => {
        const { app, doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 10, 0);

            const promise = editor.pickPoint("prompt.pickSketchPoint");
            (doc.visual.eventHandler as SketchEventHandler).keyDown(view, { key: "Escape" } as KeyboardEvent);

            await expect(promise).resolves.toBeUndefined();
            expect(SketchEditor.getActive()).toBe(editor);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("Escape without a pick keeps the sketch open for another tool", () => {
        const { app, doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            (doc.visual.eventHandler as SketchEventHandler).keyDown(view, { key: "Escape" } as KeyboardEvent);
            expect(SketchEditor.getActive()).toBe(editor);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("pickEntity resolves with the hit line entity", async () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 10, 0);
            editor.solve(true);

            const promise = editor.pickEntity("prompt.pickSketchEntity", "line");
            // mock view: screen (405, 300) -> ray hits plane at uv (5, 0), on the line
            (doc.visual.eventHandler as SketchEventHandler).pointerDown(view, pointerEvent(405, 300));

            await expect(promise).resolves.toBe(1);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("pickEntity with a multi-type filter accepts either type but not an arc", async () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 10, 0);
            editor.solver.addCircle(30, 0, 5);
            editor.solver.addArc(0, 30, 10, 30, 0, 40);
            editor.solve(true);

            const promise = editor.pickEntity("prompt.pickSketchEntity", ["line", "circle"]);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            // arc start at uv (10, 30) -> screen (410, 270): filtered out, pick stays active
            handler.pointerDown(view, pointerEvent(410, 270));
            expect(editor.isPicking).toBe(true);

            // circle outline at uv (35, 0) -> screen (435, 300): accepted
            handler.pointerDown(view, pointerEvent(435, 300));
            await expect(promise).resolves.toBe(2);
            expect(editor.isPicking).toBe(false);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("right-click cancels an active pick", async () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 10, 0);

            const promise = editor.pickEntity("prompt.pickSketchEntity", "line");
            (doc.visual.eventHandler as SketchEventHandler).pointerDown(view, {
                offsetX: 405,
                offsetY: 300,
                button: 2,
            } as PointerEvent);

            await expect(promise).resolves.toBeUndefined();
            expect(editor.isPicking).toBe(false);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("highlights the hovered line while an entity pick is active", async () => {
        const { doc, view, restoreFactory } = setup();
        const displayMesh = rs.fn(() => 1);
        const removeMesh = rs.fn();
        (doc.visual.context as any).displayMesh = displayMesh;
        (doc.visual.context as any).removeMesh = removeMesh;
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            // entering the session draws the datum origin/axes mesh; ignore it here
            displayMesh.mockClear();
            editor.solver.addLine(0, 0, 10, 0);
            editor.solve(true);
            displayMesh.mockClear();
            removeMesh.mockClear();

            const promise = editor.pickEntity("prompt.pickSketchEntity", "line");
            const handler = doc.visual.eventHandler as SketchEventHandler;
            // mock view: screen (405, 300) -> uv (5, 0), on the line
            handler.pointerMove(view, pointerEvent(405, 300));
            expect(displayMesh).toHaveBeenCalledTimes(1);

            // same position again: no redundant redraw
            handler.pointerMove(view, pointerEvent(405, 300));
            expect(displayMesh).toHaveBeenCalledTimes(1);

            // move away from the line: hover cleared
            handler.pointerMove(view, pointerEvent(100, 100));
            expect(removeMesh).toHaveBeenCalledTimes(1);

            editor.cancelPick();
            await expect(promise).resolves.toBeUndefined();
        } finally {
            restoreFactory();
        }
    });

    test("clicking a hovered entity clears the hover highlight", async () => {
        const { doc, view, restoreFactory } = setup();
        const displayMesh = rs.fn(() => 1);
        const removeMesh = rs.fn();
        (doc.visual.context as any).displayMesh = displayMesh;
        (doc.visual.context as any).removeMesh = removeMesh;
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            // entering the session draws the datum origin/axes mesh; ignore it here
            displayMesh.mockClear();
            editor.solver.addLine(0, 0, 10, 0);
            editor.solve(true);
            displayMesh.mockClear();
            removeMesh.mockClear();

            const promise = editor.pickEntity("prompt.pickSketchEntity", "line");
            const handler = doc.visual.eventHandler as SketchEventHandler;
            // hover over the line, then click it without moving the mouse
            handler.pointerMove(view, pointerEvent(405, 300));
            expect(displayMesh).toHaveBeenCalledTimes(1);
            handler.pointerDown(view, pointerEvent(405, 300));

            await expect(promise).resolves.toBe(1);
            expect(removeMesh).toHaveBeenCalledTimes(1);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("highlights entities on hover without an active pick", () => {
        const { doc, view, restoreFactory } = setup();
        const displayMesh = rs.fn(() => 1);
        (doc.visual.context as any).displayMesh = displayMesh;
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            // entering the session draws the datum origin/axes mesh; ignore it here
            displayMesh.mockClear();
            editor.solver.addLine(0, 0, 10, 0);
            editor.solve(true);
            displayMesh.mockClear();

            expect(editor.isPicking).toBe(false);
            (doc.visual.eventHandler as SketchEventHandler).pointerMove(view, pointerEvent(405, 300));
            expect(displayMesh).toHaveBeenCalledTimes(1);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });
});

describe("datum picking (origin and axes)", () => {
    test("hitTestPoint hits the origin datum when no real point is nearer", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // screen (402, 299) -> near world (0, 0); the sketch is empty
            expect(handler.hitTestPoint(view, pointerEvent(402, 299))).toEqual({
                entityId: SKETCH_ORIGIN_ID,
                pointIndex: 0,
            });
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("hitTestPoint prefers a real point over the origin on a tie", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 10, 0);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // exactly on the line start (0, 0), which sits on the origin
            expect(handler.hitTestPoint(view, pointerEvent(400, 300))).toEqual({
                entityId: 1,
                pointIndex: 0,
            });
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("hitTestEntity hits the datum axes only when the pick opts in", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(100, 100, 200, 100);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // screen (450, 300) -> uv (50, 0): on the X axis, far from the line
            expect(handler.hitTestEntity(view, pointerEvent(450, 300), "line")).toBeUndefined();
            expect(handler.hitTestEntity(view, pointerEvent(450, 300), "line", true)).toBe(SKETCH_X_AXIS_ID);
            // a circle filter excludes the axes even with datum enabled
            expect(handler.hitTestEntity(view, pointerEvent(450, 300), "circle", true)).toBeUndefined();
            // screen (400, 250) -> uv (0, 50): on the Y axis
            expect(handler.hitTestEntity(view, pointerEvent(400, 250), "line", true)).toBe(SKETCH_Y_AXIS_ID);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("clicking the origin datum does not start a drag", () => {
        const { doc, view, restoreFactory } = setup();
        const displayMesh = rs.fn(() => 1);
        (doc.visual.context as any).displayMesh = displayMesh;
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            // entering the session draws the datum origin/axes mesh; ignore it here
            displayMesh.mockClear();
            const handler = doc.visual.eventHandler as SketchEventHandler;

            handler.pointerDown(view, pointerEvent(400, 300));
            handler.pointerMove(view, pointerEvent(500, 350));
            handler.pointerUp(view, pointerEvent(500, 350));

            // The origin can be selected for constraints, but never dragged.
            expect(handler.selectedPoints).toEqual([{ entityId: -1, pointIndex: 0 }]);
            expect(editor.solver.entities()).toEqual([]);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });
});

describe("arc entity hit testing", () => {
    test("distances follow the ccw sweep: radial inside, endpoint-anchored outside", () => {
        const { doc, view, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            // center (0,0), start (10,0), end (0,10): a first-quadrant (0°..90°) sweep
            editor.solver.addArc(0, 0, 10, 0, 0, 10);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // screen (407, 293) -> uv (7, 7): on the rim inside the sweep
            expect(handler.hitTestEntity(view, pointerEvent(407, 293))).toBe(1);
            // screen (415, 300) -> uv (15, 0): on the start ray, 5 past the start point
            expect(handler.hitTestEntity(view, pointerEvent(415, 300))).toBe(1);
            // screen (392, 285) -> uv (-8, 15): past the end ray; 7 from the rim circle but
            // ~9.4 from the nearer endpoint, so the sweep-aware distance misses
            expect(handler.hitTestEntity(view, pointerEvent(392, 285))).toBeUndefined();
            editor.exit();
        } finally {
            restoreFactory();
        }
    });
});

test("Coincident can pick the origin beneath a previously picked endpoint", async () => {
    const { doc, view, restoreFactory } = setup();
    try {
        const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
        const id = editor.solver.addLine(0, 0, 40, 60);
        editor.solve(true);
        const selected = { kind: "point" as const, ref: { entityId: id, pointIndex: 0 } };
        const pick = editor.pickPointOrEntity("prompt.pickSketchPointOrEntity", undefined, selected);
        const handler = doc.visual.eventHandler as SketchEventHandler;
        handler.pointerDown(view, pointerEvent(400, 300));
        await expect(pick).resolves.toEqual({ kind: "point", ref: originRef() });
        editor.exit();
    } finally {
        SketchEditor.exit();
        restoreFactory();
    }
});

test("Alt-drag preserves a vertical line's origin attachment without adding snap constraints", () => {
    const { doc, view, restoreFactory } = setup();
    view.worldToScreen = (p) => ({ x: p.x + 400, y: 300 - p.y }) as never;
    try {
        const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
        const id = editor.solver.addLine(0, 0, 0, 150);
        const ref = { entityId: id, pointIndex: 0 };
        editor.solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [ref, originRef()] });
        editor.solver.addConstraint({
            kind: ConstraintKind.VerticalAlign,
            refs: [ref, { entityId: id, pointIndex: 1 }],
        });
        editor.solve(true);
        const handler = doc.visual.eventHandler as SketchEventHandler;
        handler.pointerDown(view, { ...pointerEvent(400, 150), altKey: true } as PointerEvent);
        handler.pointerMove(view, pointerEvent(430, 110));
        handler.pointerUp(view, pointerEvent(430, 110));
        const line = editor.solver.entity(id)!.params;
        expect(line.slice(0, 3)).toEqual([0, 0, 0]);
        expect(line[3]).toBeCloseTo(190);
        expect(editor.lastSolveOutcome.dofs).toBe(1);
        expect(editor.solver.toData().constraints).toHaveLength(2);
        editor.exit();
    } finally {
        SketchEditor.exit();
        restoreFactory();
    }
});
