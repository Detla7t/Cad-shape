// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DialogButton,
    type I18nKeys,
    type ICameraController,
    Plane,
    PubSub,
    Result,
    setDocumentUnits,
    XYZ,
} from "@chili3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import {
    AngleDimensionCommand,
    DistanceDimensionCommand,
    HorizontalDistanceCommand,
    PointLineDistanceCommand,
    RadiusDimensionCommand,
    VerticalDistanceCommand,
} from "../../src/sketch/commands/sketchDimensions";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import type { SketchEventHandler } from "../../src/sketch/editor/sketchEventHandler";
import { ConstraintKind, SKETCH_X_AXIS_ID } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import "./setup";

type DialogCapture = {
    title?: I18nKeys;
    content?: HTMLElement;
    buttons?: DialogButton[] | (() => void);
};

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

    const dialog: DialogCapture = {};
    const originalPub = PubSub.default.pub as unknown as (key: string, ...args: any[]) => void;
    PubSub.default.pub = ((key: string, ...args: any[]) => {
        if (key === "showDialog") {
            [dialog.title, dialog.content, dialog.buttons] = args as [
                I18nKeys,
                HTMLElement,
                DialogButton[] | (() => void),
            ];
            return;
        }
        originalPub.call(PubSub.default, key, ...args);
    }) as any;
    const restorePub = () => {
        PubSub.default.pub = originalPub as any;
    };

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
    return { app, doc, view, dialog, restorePub, restoreFactory };
}

function dialogInput(dialog: DialogCapture): HTMLInputElement {
    const el = dialog.content?.querySelector("input");
    expect(el).not.toBeNull();
    return el as HTMLInputElement;
}

/** Simulates confirming the dialog; returns whether the dialog would close. */
function confirmDialog(dialog: DialogCapture, text: string): boolean {
    const buttons = dialog.buttons as DialogButton[];
    const confirm = buttons.find((b) => b.content === "common.confirm");
    expect(confirm).toBeDefined();
    dialogInput(dialog).value = text;
    const shouldClose = confirm!.shouldClose?.() !== false;
    if (shouldClose) confirm!.onclick?.();
    return shouldClose;
}

function pointerEvent(x: number, y: number): PointerEvent {
    return { offsetX: x, offsetY: y, button: 0, shiftKey: false } as PointerEvent;
}

/** Lets the command's awaited picks advance between simulated clicks. */
async function tick() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Runs the distance command through its three picks (point, point, position). */
async function placeDistanceDimension(app: any, doc: any, view: any): Promise<void> {
    const handler = doc.visual.eventHandler as SketchEventHandler;
    const run = new DistanceDimensionCommand().execute(app);
    handler.pointerDown(view, pointerEvent(400, 300));
    await tick();
    handler.pointerDown(view, pointerEvent(500, 300));
    await tick();
    handler.pointerDown(view, pointerEvent(450, 250));
    await run;
}

function cancelDialog(dialog: DialogCapture): void {
    const buttons = dialog.buttons as DialogButton[];
    const cancel = buttons.find((b) => b.content === "common.cancel");
    expect(cancel).toBeDefined();
    cancel!.onclick?.();
}

// mock view maps screen (x, y) -> world (x - 400, 300 - y, 0) on the XY plane:
// a line (0,0)-(100,0) spans screen x 400..500 at y 300
describe("dimension commands", () => {
    test("dimension entry uses document units, preserves the exact current size on Enter, and converts replacement input", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            setDocumentUnits(doc, { length: "in", angle: "deg", lengthPrecision: 3, anglePrecision: 1 });
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            await placeDistanceDimension(app, doc, view);
            expect(dialogInput(dialog).value).toBe("3.937");
            expect(confirmDialog(dialog, "3.937")).toBe(true);
            const constraint = editor.solver.toData().constraints[0];
            expect(constraint.datum).toBe(100);
            editor.editDatum(constraint.id);
            expect(confirmDialog(dialog, "2")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(50.8);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });
    test("distance constraint is created at placement, before the dialog is confirmed", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(400, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(500, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 250));
            await run;

            // the dimension exists and the dialog is open — before any confirm
            expect(dialogInput(dialog).value).toBe("100.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.P2PDistance);
            expect(constraints[0].datum).toBeCloseTo(100);
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);
            // not committed to the node (and history) until the dialog is confirmed
            expect(node.data.constraints.length).toBe(0);

            // confirming the dialog only updates the datum
            expect(confirmDialog(dialog, "80")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(80);

            // invalid input keeps the dialog open and the current value
            expect(confirmDialog(dialog, "abc")).toBe(false);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(80);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("editDatum re-opens the dialog with the current value and updates it", () => {
        const { doc, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            const id = editor.solver.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
                datum: 100,
            });
            editor.solve(true);

            editor.editDatum(id);
            expect(dialogInput(dialog).value).toBe("100.00");
            expect(confirmDialog(dialog, "75")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(75);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("radius constraint is created at placement, before the dialog is confirmed", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addCircle(0, 0, 30);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new RadiusDimensionCommand().execute(app);
            // circle rim at world (30, 0) -> screen (430, 300)
            handler.pointerDown(view, pointerEvent(430, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(500, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("30.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.Radius);
            expect(constraints[0].datum).toBeCloseTo(30);
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);

            expect(confirmDialog(dialog, "45")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(45);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("radius dimension also applies to arcs", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            const arc = editor.solver.addArc(0, 0, 30, 0, 0, 30);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new RadiusDimensionCommand().execute(app);
            // arc rim at world (30, 0) -> screen (430, 300)
            handler.pointerDown(view, pointerEvent(430, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(500, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("30.00");
            // addArc adds a structural PointOnArc; the radius dimension is the other one
            const constraints = editor.solver.toData().constraints;
            const radiusConstraint = constraints.find((c) => c.kind === ConstraintKind.Radius);
            expect(radiusConstraint).toBeDefined();
            expect(radiusConstraint!.datum).toBeCloseTo(30);
            expect(editor.dimensionAnchors.has(radiusConstraint!.id)).toBe(true);

            expect(confirmDialog(dialog, "45")).toBe(true);
            expect(
                editor.solver.toData().constraints.find((c) => c.id === radiusConstraint!.id)!.datum,
            ).toBeCloseTo(45);
            const params = editor.solver.entity(arc)!.params;
            expect(Math.hypot(params[2] - params[0], params[3] - params[1])).toBeCloseTo(45);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("confirming the dialog creates a single undo step", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            editor.commit();
            const undosBefore = doc.history.undoCount();

            await placeDistanceDimension(app, doc, view);
            expect(confirmDialog(dialog, "80")).toBe(true);
            expect(doc.history.undoCount()).toBe(undosBefore + 1);

            doc.history.undo();
            expect(editor.solver.toData().constraints.length).toBe(0);
            expect(editor.solver.toData().entities.length).toBe(1);
            expect(node.data.constraints.length).toBe(0);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("cancelling the dialog rolls the constraint back without a history record", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            editor.commit();
            const undosBefore = doc.history.undoCount();

            await placeDistanceDimension(app, doc, view);
            cancelDialog(dialog);

            expect(editor.solver.toData().constraints.length).toBe(0);
            expect(editor.dimensionAnchors.size).toBe(0);
            expect(doc.history.undoCount()).toBe(undosBefore);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("dimension between coincident-shared endpoints belongs to the single line", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            // three lines chained end-to-end: (0,0)-(100,0)-(200,0)-(300,0)
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(100, 0, 200, 0);
            editor.solver.addLine(200, 0, 300, 0);
            editor.solver.addConstraint({
                kind: ConstraintKind.P2PCoincident,
                refs: [
                    { entityId: 1, pointIndex: 1 },
                    { entityId: 2, pointIndex: 0 },
                ],
            });
            editor.solver.addConstraint({
                kind: ConstraintKind.P2PCoincident,
                refs: [
                    { entityId: 2, pointIndex: 1 },
                    { entityId: 3, pointIndex: 0 },
                ],
            });
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // dimension the middle line by its endpoints: world (100,0)/(200,0)
            // -> screen (500,300)/(600,300), position at screen (550,250)
            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(500, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(600, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(550, 250));
            await run;

            const distance = editor.solver
                .toData()
                .constraints.find((c) => c.kind === ConstraintKind.P2PDistance);
            expect(distance).toBeDefined();
            expect(distance!.refs).toEqual([
                { entityId: 2, pointIndex: 0 },
                { entityId: 2, pointIndex: 1 },
            ]);
            cancelDialog(dialog);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("angle constraint stores radians, displays and edits degrees", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(0, 0, 0, 100);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // line 1 midpoint (world (50,0)), line 2 midpoint (world (0,50)), then a label position
            const run = new AngleDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 250));
            await tick();
            handler.pointerDown(view, pointerEvent(440, 280));
            await run;

            // the dialog shows degrees; the solver datum is stored in radians
            expect(dialogInput(dialog).value).toBe("90.0");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.Angle);
            expect(constraints[0].refs).toEqual([
                { entityId: 1, pointIndex: 0 },
                { entityId: 1, pointIndex: 1 },
                { entityId: 2, pointIndex: 0 },
                { entityId: 2, pointIndex: 1 },
            ]);
            expect(constraints[0].datum).toBeCloseTo(Math.PI / 2);
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);
            expect(node.data.constraints.length).toBe(0);

            // confirming converts the entered degrees back to radians
            expect(confirmDialog(dialog, "45")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(Math.PI / 4);

            // re-editing shows the current value in degrees again
            editor.editDatum(constraints[0].id);
            expect(dialogInput(dialog).value).toBe("45.0");
            expect(confirmDialog(dialog, "60")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(Math.PI / 3);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("horizontal distance accepts a negative datum and drives the signed span", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new HorizontalDistanceCommand().execute(app);
            handler.pointerDown(view, pointerEvent(400, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(500, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("100.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.HorizontalDistance);
            expect(constraints[0].datum).toBeCloseTo(100);
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);

            // signed distances accept negative input (positiveOnly: false)
            expect(confirmDialog(dialog, "-50")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(-50);
            editor.solver.solve(true);
            const [x1] = editor.solver.pointOf({ entityId: 1, pointIndex: 0 });
            const [x2] = editor.solver.pointOf({ entityId: 1, pointIndex: 1 });
            expect(x2 - x1).toBeCloseTo(-50);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("vertical distance constraint is created at placement", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 0, 100);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // worldToScreen maps (x, y) -> (x + 400, y + 300): endpoints at (400,300)/(400,400)
            const run = new VerticalDistanceCommand().execute(app);
            handler.pointerDown(view, pointerEvent(400, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 400));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 250));
            await run;

            expect(dialogInput(dialog).value).toBe("100.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.VerticalDistance);
            expect(constraints[0].datum).toBeCloseTo(100);
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);
            cancelDialog(dialog);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("point-line distance references the point and both line endpoints", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addCircle(50, 30, 10);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // circle center worldToScreen: (50,30) -> screen (450,330); then the line, then a label position
            const run = new PointLineDistanceCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 330));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(470, 280));
            await run;

            expect(dialogInput(dialog).value).toBe("30.00");
            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.P2LDistance);
            expect(constraints[0].refs).toEqual([
                { entityId: 2, pointIndex: 0 },
                { entityId: 1, pointIndex: 0 },
                { entityId: 1, pointIndex: 1 },
            ]);
            // the point is left of the line direction: display +30, garlic stores the negation
            expect(constraints[0].datum).toBeCloseTo(-30);
            expect(editor.dimensionAnchors.get(constraints[0].id)?.kind).toBe("offset");

            // signed distance (display convention) between the circle center and the line
            const signedDist = () => {
                const [px, py] = editor.solver.pointOf({ entityId: 2, pointIndex: 0 });
                const [x1, y1] = editor.solver.pointOf({ entityId: 1, pointIndex: 0 });
                const [x2, y2] = editor.solver.pointOf({ entityId: 1, pointIndex: 1 });
                return ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)) / Math.hypot(x2 - x1, y2 - y1);
            };
            // accepting the displayed value keeps the point on its side (no mirroring)
            expect(signedDist()).toBeCloseTo(30);

            expect(confirmDialog(dialog, "20")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(-20);
            editor.solver.solve(true);
            expect(signedDist()).toBeCloseTo(20);

            // a negative display value moves the point to the other side
            expect(confirmDialog(dialog, "-15")).toBe(true);
            expect(editor.solver.toData().constraints[0].datum).toBeCloseTo(15);
            editor.solver.solve(true);
            expect(signedDist()).toBeCloseTo(-15);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("cancelling the angle dialog rolls the constraint back without a history record", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(0, 0, 0, 100);
            editor.solve(true);
            editor.commit();
            const undosBefore = doc.history.undoCount();
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const run = new AngleDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 250));
            await tick();
            handler.pointerDown(view, pointerEvent(440, 280));
            await run;
            cancelDialog(dialog);

            expect(editor.solver.toData().constraints.length).toBe(0);
            expect(editor.dimensionAnchors.size).toBe(0);
            expect(doc.history.undoCount()).toBe(undosBefore);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("angle dimension accepts the datum X axis as a reference", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(10, 20, 60, 80);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // line midpoint uv (35, 50) -> screen (435, 250); the X axis sits at v = 0
            const run = new AngleDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(435, 250));
            await tick();
            handler.pointerDown(view, pointerEvent(500, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 280));
            await run;

            const constraints = editor.solver.toData().constraints;
            expect(constraints.length).toBe(1);
            expect(constraints[0].kind).toBe(ConstraintKind.Angle);
            expect(constraints[0].refs).toEqual([
                { entityId: 1, pointIndex: 0 },
                { entityId: 1, pointIndex: 1 },
                { entityId: SKETCH_X_AXIS_ID, pointIndex: 0 },
                { entityId: SKETCH_X_AXIS_ID, pointIndex: 1 },
            ]);
            // direction (50, 60) against the X axis: the signed sweep from the
            // line to the axis is -atan2(60, 50) — the sign records the side
            expect(constraints[0].datum).toBeCloseTo(-Math.atan2(60, 50));
            expect(editor.dimensionAnchors.has(constraints[0].id)).toBe(true);
            cancelDialog(dialog);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    test("editing an angle below the reference line keeps it on that side", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(0, 0, 0, -100); // points down: sweep -90° from line 1
            editor.solver.addConstraint({
                kind: ConstraintKind.Fix,
                refs: [{ entityId: 1, pointIndex: 0 }],
                datums: [0, 0],
            });
            editor.solver.addConstraint({
                kind: ConstraintKind.Horizontal,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
            });
            editor.solver.addConstraint({
                kind: ConstraintKind.P2PCoincident,
                refs: [
                    { entityId: 1, pointIndex: 0 },
                    { entityId: 2, pointIndex: 0 },
                ],
            });
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            // line 1 at (450, 300); line 2 midpoint uv (0, -50) -> screen (400, 350)
            const run = new AngleDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 350));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 330));
            await run;

            expect(dialogInput(dialog).value).toBe("90.0");
            expect(confirmDialog(dialog, "45")).toBe(true);

            // the line rotates to -45° on the SAME side instead of flipping to +45°
            // (which would read as 135° from the side the user is looking at)
            const [x1, y1] = editor.solver.pointOf({ entityId: 2, pointIndex: 0 });
            const [x2, y2] = editor.solver.pointOf({ entityId: 2, pointIndex: 1 });
            expect(Math.atan2(y2 - y1, x2 - x1)).toBeCloseTo(-Math.PI / 4, 6);
            expect(editor.solver.toData().constraints.at(-1)?.datum).toBeCloseTo(-Math.PI / 4);
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });

    // Every placement step hands its pick a fresh controller, so the command panel's Cancel
    // button reaches the pick that is up and not the one before it.
    test("cancelling the command during the position pick abandons the dimension", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            const editor = SketchEditor.enter(node);
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(0, 0, 0, 100);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;

            const command = new AngleDimensionCommand();
            const run = command.execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 250));
            await tick();
            expect(editor.isPicking).toBe(true);

            command.cancel();
            await tick();

            expect(editor.isPicking).toBe(false);
            // A click after the cancel must not revive the placement and settle the dimension.
            handler.pointerDown(view, pointerEvent(440, 280));
            await run;

            expect(editor.solver.toData().constraints.length).toBe(0);
            expect(dialog.content).toBeUndefined();
            editor.exit();
        } finally {
            restorePub();
            restoreFactory();
        }
    });
});

test("a conflicting dimension edit keeps the dialog open and restores the drawing", () => {
    const { doc, dialog, restorePub, restoreFactory } = setup();
    try {
        const node = new SketchNode({ document: doc, plane: Plane.XY });
        const editor = SketchEditor.enter(node);
        const id = editor.solver.addLine(10, 10, 110, 10);
        const refs = [
            { entityId: id, pointIndex: 0 },
            { entityId: id, pointIndex: 1 },
        ];
        for (const ref of refs)
            editor.solver.addConstraint({
                kind: ConstraintKind.Fix,
                refs: [ref],
                datums: editor.solver.pointOf(ref),
            });
        const dimension = editor.solver.addConstraint({ kind: ConstraintKind.P2PDistance, refs, datum: 100 });
        editor.solve(true);
        editor.commit();
        const before = editor.solver.toData();
        const history = doc.history.undoCount();
        editor.editDatum(dimension);
        expect(confirmDialog(dialog, "75")).toBe(false);
        expect(editor.solver.toData()).toEqual(before);
        expect(doc.history.undoCount()).toBe(history);
        expect(dialog.content!.textContent).toContain("conflicts with the sketch");
        expect(confirmDialog(dialog, "100")).toBe(true);
        editor.exit();
    } finally {
        SketchEditor.exit();
        restorePub();
        restoreFactory();
    }
});

test("distance dimensions accept a whole line followed by label placement", async () => {
    const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
    try {
        const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
        const line = editor.solver.addLine(0, 0, 100, 0);
        editor.solve(true);
        const handler = doc.visual.eventHandler as SketchEventHandler;
        const run = new DistanceDimensionCommand().execute(app);
        handler.pointerDown(view, pointerEvent(450, 300));
        await tick();
        expect(editor.activePick?.kind).toBe("dimension");
        handler.pointerDown(view, pointerEvent(450, 250));
        await run;
        expect(confirmDialog(dialog, "80")).toBe(true);
        const entity = editor.solver.entity(line)!;
        expect(
            Math.hypot(entity.params[2] - entity.params[0], entity.params[3] - entity.params[1]),
        ).toBeCloseTo(80);
        expect(editor.node.data.constraints[0].kind).toBe(ConstraintKind.P2PDistance);
    } finally {
        SketchEditor.exit();
        restorePub();
        restoreFactory();
    }
});

test("D on an unsized circle starts sizing it and selects the current diameter", async () => {
    const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
    try {
        const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
        const circle = editor.solver.addCircle(0, 0, 50);
        editor.solve(true);
        const handler = doc.visual.eventHandler as SketchEventHandler,
            run = new DistanceDimensionCommand().execute(app);
        handler.pointerDown(view, pointerEvent(450, 300));
        await tick();
        expect(editor.activePick?.kind).toBe("dimension");
        handler.pointerDown(view, pointerEvent(470, 250));
        await run;
        expect(Number(dialogInput(dialog).value)).toBe(100);
        expect(confirmDialog(dialog, "30")).toBe(true);
        expect(editor.solver.entity(circle)?.params[2]).toBeCloseTo(15);
    } finally {
        SketchEditor.exit();
        restorePub();
        restoreFactory();
    }
});

test("D distinguishes a sized circle edge from its center and cancels helper geometry cleanly", async () => {
    const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
    try {
        const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
        const circle = editor.solver.addCircle(0, 0, 50);
        editor.solver.addConstraint({
            kind: ConstraintKind.Radius,
            refs: [{ entityId: circle, pointIndex: 0 }],
            datum: 50,
        });
        editor.solver.addLine(100, -40, 100, 40);
        editor.solve(true);
        const before = editor.solver.toData();
        const handler = doc.visual.eventHandler as SketchEventHandler,
            run = new DistanceDimensionCommand().execute(app);
        handler.pointerDown(view, pointerEvent(450, 300));
        await tick();
        expect(editor.activePick?.kind).toBe("pointOrEntity");
        handler.pointerDown(view, pointerEvent(500, 300));
        await tick();
        expect(editor.activePick?.kind).toBe("position");
        handler.pointerDown(view, pointerEvent(475, 245));
        await run;
        expect(Math.abs(Number(dialogInput(dialog).value))).toBeCloseTo(50);
        cancelDialog(dialog);
        expect(editor.solver.toData()).toEqual(before);
    } finally {
        SketchEditor.exit();
        restorePub();
        restoreFactory();
    }
});

// These use the actual pointer picker and solver, not a mocked choice of dimension kind.
describe("combined Dimension tool", () => {
    test.each([
        { label: "horizontal", cursor: [440, 190], kind: ConstraintKind.HorizontalDistance, value: 80 },
        { label: "vertical", cursor: [540, 270], kind: ConstraintKind.VerticalDistance, value: 60 },
        { label: "aligned", cursor: [530, 160], kind: ConstraintKind.P2PDistance, value: 100 },
    ])("infers $label from cursor placement and commits that preview", async ({ cursor, kind, value }) => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            editor.solver.addLine(0, 0, 80, 60);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            const preview = rs.spyOn(editor.annotations, "setDimensionPreview");
            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(440, 270));
            await tick();
            handler.pointerMove(view, pointerEvent(cursor[0], cursor[1]));
            expect(preview.mock.calls.at(-1)?.[0]?.kind).toBe(
                kind === ConstraintKind.P2PDistance ? "distance" : "axisDistance",
            );
            handler.pointerDown(view, pointerEvent(cursor[0], cursor[1]));
            await run;
            expect(Number(dialogInput(dialog).value)).toBe(value);
            expect(confirmDialog(dialog, String(value / 2))).toBe(true);
            const constraint = editor.node.data.constraints[0];
            expect(constraint.kind).toBe(kind);
            expect(constraint.datum).toBeCloseTo(value / 2);
            expect(editor.solve(true).result).toMatch(/^Ok/);
        } finally {
            SketchEditor.exit();
            restorePub();
            restoreFactory();
        }
    });

    test.each([
        { cursor: [475, 280], value: 45 },
        { cursor: [390, 235], value: 135 },
        { cursor: [335, 325], value: 45 },
        { cursor: [410, 365], value: 135 },
    ])("second line makes the angle in the chosen quadrant ($value degrees)", async ({ cursor, value }) => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            editor.solver.addLine(0, 0, 100, 0);
            editor.solver.addLine(0, 0, 100, 100);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(470, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 250));
            await tick();
            expect(editor.activePick?.kind).toBe("position");
            handler.pointerDown(view, pointerEvent(cursor[0], cursor[1]));
            await run;
            expect(Number(dialogInput(dialog).value)).toBe(value);
            expect(confirmDialog(dialog, String(value - 5))).toBe(true);
            const constraint = editor.node.data.constraints[0];
            expect(constraint.kind).toBe(ConstraintKind.Angle);
            expect((Math.abs(Number(constraint.datum)) * 180) / Math.PI).toBeCloseTo(value - 5);
            expect(editor.solve(true).result).toMatch(/^Ok/);
        } finally {
            SketchEditor.exit();
            restorePub();
            restoreFactory();
        }
    });

    test("second parallel line creates a separation that preserves parallelism", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const a = editor.solver.addLine(0, 0, 100, 0),
                b = editor.solver.addLine(0, 40, 100, 40);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(450, 260));
            await tick();
            handler.pointerDown(view, pointerEvent(520, 280));
            await run;
            expect(Math.abs(Number(dialogInput(dialog).value))).toBe(40);
            const sign = Math.sign(Number(dialogInput(dialog).value));
            expect(confirmDialog(dialog, String(sign * 60))).toBe(true);
            const pa = editor.solver.entity(a)!.params,
                pb = editor.solver.entity(b)!.params;
            const cross = (pa[2] - pa[0]) * (pb[3] - pb[1]) - (pa[3] - pa[1]) * (pb[2] - pb[0]);
            expect(cross).toBeCloseTo(0, 4);
            expect(editor.node.data.constraints.some((c) => c.kind === ConstraintKind.P2LDistance)).toBe(
                true,
            );
            expect(editor.solve(true).result).toMatch(/^Ok/);
        } finally {
            SketchEditor.exit();
            restorePub();
            restoreFactory();
        }
    });

    test("circle diameter persists, edits in document units, accepts expressions, and cancels cleanly", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            setDocumentUnits(doc, { length: "in", lengthPrecision: 3, angle: "deg", anglePrecision: 1 });
            const node = new SketchNode({ document: doc, plane: Plane.XY });
            let editor = SketchEditor.enter(node);
            const circle = editor.solver.addCircle(0, 0, 50.8);
            editor.solve(true);
            expect(editor.solver.entity(circle)!.params[2]).toBeCloseTo(50.8);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            const run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(450.8, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(475, 245));
            await run;
            expect(Number(dialogInput(dialog).value)).toBe(4);
            expect(confirmDialog(dialog, "2 in + 2 in")).toBe(true);
            expect(editor.solver.entity(circle)!.params[2]).toBeCloseTo(50.8);
            const id = node.data.constraints[0].id;
            editor.exit();
            editor = SketchEditor.enter(node);
            editor.editDatum(id);
            expect(dialogInput(dialog).value).toBe("2 in + 2 in");
            expect(confirmDialog(dialog, "3")).toBe(true);
            expect(editor.solver.entity(circle)!.params[2]).toBeCloseTo(38.1);
            editor.editDatum(id);
            expect(Number(dialogInput(dialog).value)).toBe(3);
            cancelDialog(dialog);
            expect(editor.solver.entity(circle)!.params[2]).toBeCloseTo(38.1);
            expect(editor.setDimension(id, 101.6).isOk).toBe(true);
            expect(editor.solver.entity(circle)!.params[2]).toBeCloseTo(50.8);
        } finally {
            SketchEditor.exit();
            restorePub();
            restoreFactory();
        }
    });

    test("clicking an arc uses radius, while clicking a circle center measures position", async () => {
        const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
        try {
            const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
            const arc = editor.solver.addArc(0, 0, 50, 0, 0, 50);
            const circle = editor.solver.addCircle(120, 0, 20);
            editor.solve(true);
            const handler = doc.visual.eventHandler as SketchEventHandler;
            let run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(435, 265));
            await tick();
            handler.pointerDown(view, pointerEvent(470, 230));
            await run;
            expect(Number(dialogInput(dialog).value)).toBe(50);
            expect(confirmDialog(dialog, "60")).toBe(true);
            expect(
                editor.node.data.constraints.find((c) => c.kind === ConstraintKind.Radius)?.refs[0].entityId,
            ).toBe(arc);
            run = new DistanceDimensionCommand().execute(app);
            handler.pointerDown(view, pointerEvent(520, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(400, 300));
            await tick();
            handler.pointerDown(view, pointerEvent(460, 200));
            await run;
            expect(Number(dialogInput(dialog).value)).toBeCloseTo(120);
            expect(confirmDialog(dialog, "120")).toBe(true);
            expect(editor.node.data.constraints.filter((c) => c.kind === ConstraintKind.Radius)).toHaveLength(
                1,
            );
            expect(editor.solver.entity(circle)!.params[2]).toBeCloseTo(20);
        } finally {
            SketchEditor.exit();
            restorePub();
            restoreFactory();
        }
    });
});

test("D treats a datum axis as a reference, never a one-unit line to size", async () => {
    const { app, doc, view, dialog, restorePub, restoreFactory } = setup();
    try {
        const editor = SketchEditor.enter(new SketchNode({ document: doc, plane: Plane.XY }));
        editor.solver.addLine(20, 20, 100, 100);
        editor.solve(true);
        const handler = doc.visual.eventHandler as SketchEventHandler;
        const run = new DistanceDimensionCommand().execute(app);
        handler.pointerDown(view, pointerEvent(470, 300));
        await tick();
        expect(editor.activePick?.kind).toBe("pointOrEntity");
        handler.pointerDown(view, pointerEvent(450, 250));
        await tick();
        handler.pointerDown(view, pointerEvent(470, 275));
        await run;
        expect(Number(dialogInput(dialog).value)).toBe(45);
        expect(confirmDialog(dialog, "30")).toBe(true);
        const dimension = editor.node.data.constraints[0];
        expect(dimension.kind).toBe(ConstraintKind.Angle);
        expect(dimension.refs.some((ref) => ref.entityId === SKETCH_X_AXIS_ID)).toBe(true);
        expect((Number(dimension.datum) * 180) / Math.PI).toBeCloseTo(30);
    } finally {
        SketchEditor.exit();
        restorePub();
        restoreFactory();
    }
});
