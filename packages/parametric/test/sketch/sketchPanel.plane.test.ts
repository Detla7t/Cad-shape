// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ICameraController,
    type IDocument,
    type IEventHandler,
    type IView,
    Plane,
    ReferencePlaneNode,
    Result,
    XYZ,
} from "@chili3d/core";
import {
    createMockApplication,
    createMockView,
    createMockVisualWithDocument,
    TestDocument,
} from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { PlanePickHandler } from "../../src/sketch/commands/planePickHandler";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { SketchEventHandler } from "../../src/sketch/editor/sketchEventHandler";
import type { SketchData } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import "./setup";

const DATA: SketchData = {
    entities: [{ id: 1, type: "line", params: [0, 0, 10, 0] }],
    constraints: [],
};

function mockShapeFactory() {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
    Object.defineProperty(globalThis, "shapeFactory", {
        value: {
            line: () => Result.ok({ isEqual: () => false }),
            circle: () => Result.ok({ isEqual: () => false }),
            wire: () => Result.ok({ isEqual: () => false }),
            combine: () => Result.ok({ isEqual: () => false }),
        },
        writable: true,
        configurable: true,
    });
    return () => {
        if (previous) Object.defineProperty(globalThis, "shapeFactory", previous);
        else delete (globalThis as any).shapeFactory;
    };
}

function setup() {
    const camera = {
        cameraPosition: new XYZ({ x: 0, y: -200, z: 200 }),
        cameraTarget: XYZ.zero,
        cameraUp: XYZ.unitZ,
        cameraType: "perspective" as "perspective" | "orthographic",
        lookAt: rs.fn(),
        fitContent: rs.fn(),
    };
    const app = createMockApplication();
    const doc = new TestDocument({ application: app, selection: { clearSelection: rs.fn() } as any });
    doc.visual = createMockVisualWithDocument(doc, {
        viewHandler: { canRotate: true } as any,
        context: { setNodeOnTop: rs.fn() },
    }) as any;
    const host = document.createElement("div");
    const view = createMockView({ document: doc, cameraController: camera as unknown as ICameraController });
    Object.defineProperty(view, "dom", { value: host, configurable: true });
    (app as any).activeView = view;
    const right = new ReferencePlaneNode({ document: doc, basePlane: Plane.YZ, name: "Right plane" });
    doc.modelManager.addNode(right);
    return {
        doc: doc as IDocument,
        view: view as IView,
        host,
        camera,
        right,
        restoreFactory: mockShapeFactory(),
    };
}

function planeBox(host: HTMLElement) {
    const box = host.querySelector<HTMLElement>('[aria-label="Sketch plane"]');
    expect(box).not.toBeNull();
    return box!;
}

describe("sketch panel plane box", () => {
    afterEach(() => {
        SketchEditor.exit();
        rs.restoreAllMocks();
    });

    test("shows the plane with an × and, lit, picks another plane in the open sketch", () => {
        const { doc, host, camera, right, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            const editor = SketchEditor.enter(node);
            const sketchHandler = doc.visual.eventHandler;
            expect(sketchHandler).toBeInstanceOf(SketchEventHandler);
            const undos = doc.history.undoCount();
            const box = planeBox(host);
            expect(box.querySelector("select")).toBeNull();
            expect(box.textContent).toContain("Top (XY)");
            const clear = box.querySelector<HTMLButtonElement>("button");
            expect(clear).not.toBeNull();
            expect(clear!.getAttribute("aria-label")).toBe("Delete Top (XY)");
            expect(box.dataset["picking"]).toBeUndefined();

            // a click lights the box and the viewport is now a plane pick; the name stays
            box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(box.dataset["picking"]).toBe("true");
            expect(box.dataset["empty"]).toBeUndefined();
            const pick = doc.visual.eventHandler as PlanePickHandler;
            expect(pick).toBeInstanceOf(PlanePickHandler);

            // picking the Right plane moves the sketch onto it, one undo step, and the view turns to it
            const lookAts = camera.lookAt.mock.calls.length;
            pick.result = { kind: "reference", node: right };
            pick.controller!.success();
            expect(doc.visual.eventHandler).toBe(sketchHandler);
            expect(node.plane.normal.isEqualTo(Plane.YZ.normal)).toBe(true);
            expect(node.planeRef).toEqual({
                kind: "plane",
                nodeId: right.id,
                normal: Plane.YZ.normal,
                offset: 0,
            });
            expect(box.dataset["picking"]).toBeUndefined();
            expect(box.textContent).toContain("Right plane");
            expect(box.querySelector("button")!.getAttribute("aria-label")).toBe("Delete Right plane");
            expect(camera.lookAt.mock.calls.length).toBeGreaterThan(lookAts);
            expect(doc.history.undoCount()).toBe(undos + 1);
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("× empties the box for a pick; cancelling keeps the sketch's plane; a second click ends the pick", () => {
        const { doc, host, restoreFactory } = setup();
        try {
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            const editor = SketchEditor.enter(node);
            const sketchHandler = doc.visual.eventHandler;
            const undos = doc.history.undoCount();
            const box = planeBox(host);
            box.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(box.dataset["picking"]).toBe("true");
            expect(box.dataset["empty"]).toBe("true");
            expect(box.textContent).toContain("Select a plane or planar face");
            expect(box.querySelector<HTMLButtonElement>("button")!.hidden).toBe(true);
            expect(doc.visual.eventHandler).toBeInstanceOf(PlanePickHandler);

            // Escape in the viewport cancels: the sketch keeps Top, the box shows it again
            doc.visual.eventHandler.keyDown(null as never, new KeyboardEvent("keydown", { key: "Escape" }));
            expect(doc.visual.eventHandler).toBe(sketchHandler);
            expect(box.dataset["picking"]).toBeUndefined();
            expect(box.dataset["empty"]).toBeUndefined();
            expect(box.textContent).toContain("Top (XY)");
            expect(node.plane.normal.isEqualTo(XYZ.unitZ)).toBe(true);
            expect(doc.history.undoCount()).toBe(undos);

            // a click starts a pick, a second click ends it
            box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(doc.visual.eventHandler).toBeInstanceOf(PlanePickHandler);
            box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(doc.visual.eventHandler).toBe(sketchHandler);
            expect(box.dataset["picking"]).toBeUndefined();
            editor.exit();
        } finally {
            restoreFactory();
        }
    });

    test("finishing the sketch mid-pick restores the handler from before the sketch", () => {
        const { doc, host, restoreFactory } = setup();
        try {
            const before: IEventHandler = doc.visual.eventHandler;
            const node = new SketchNode({ document: doc, plane: Plane.XY, data: DATA });
            const editor = SketchEditor.enter(node);
            planeBox(host).dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(doc.visual.eventHandler).toBeInstanceOf(PlanePickHandler);
            editor.exit();
            expect(doc.visual.eventHandler).toBe(before);
            expect(host.querySelector('[aria-label="Sketch plane"]')).toBeNull();
        } finally {
            restoreFactory();
        }
    });
});
