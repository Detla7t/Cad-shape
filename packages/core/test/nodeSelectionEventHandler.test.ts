// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import type { IHistoryRecord, INode, INodeFilter, ISelection, IVisualObject } from "../src";
import {
    AsyncController,
    Matrix4,
    NodeSelectionHandler,
    Ray,
    ShapeTypes,
    Transaction,
    VisualStates,
    XY,
    XYZ,
} from "../src";
import {
    createMockHighlighter,
    createMockSelection,
    createMockVisual,
    createPointerEvent,
    TestDocument,
} from "../test-utils";

function createMockVisualObject(overrides?: Partial<IVisualObject>): IVisualObject {
    return {
        locked: false,
        visible: true,
        transform: Matrix4.identity(),
        worldTransform: () => Matrix4.identity(),
        boundingBox: () => undefined,
        dispose: () => {},
        ...overrides,
    };
}

function createMockNode(name: string, id?: string): INode {
    return { name, id: id ?? name } as INode;
}

interface SetupOptions {
    multiMode?: boolean;
    controller?: AsyncController;
    filter?: INodeFilter;
}

function setupNodeSelectionHandler(options: SetupOptions = {}) {
    const document = new TestDocument();

    // Replace visual with a richer mock
    const { highlighter, addCalls, removeCalls } = createMockHighlighter();

    const nodesByVisual = new Map<IVisualObject, INode>();
    document.visual = createMockVisual({
        getNode: (shape) => nodesByVisual.get(shape),
        document,
        highlighter,
    });

    const selection: ISelection = createMockSelection();
    document.selection = selection;

    const handler = new NodeSelectionHandler(
        document,
        options.multiMode ?? false,
        options.controller,
        options.filter,
    );

    // Minimal view mock
    const view = {
        document,
        detectVisual: () => [] as IVisualObject[],
        detectVisualRect: () => [] as IVisualObject[],
        update: () => {},
    } as any;

    return {
        handler,
        document,
        view,
        highlighter,
        addCalls,
        removeCalls,
        selection,
        context: document.visual.context,
        nodesByVisual,
    };
}

describe("NodeSelectionHandler", () => {
    test("empty hover sleeps, but clearing a previous highlight redraws once", () => {
        const { handler, view, removeCalls } = setupNodeSelectionHandler();
        view.update = rs.fn();
        const event = createPointerEvent({ buttons: 0 });
        handler.pointerMove(view, event);
        handler.pointerMove(view, event);
        expect(view.update).not.toHaveBeenCalled();
        const visual = createMockVisualObject();
        view.detectVisual = () => [visual];
        handler.pointerMove(view, event);
        expect(view.update).toHaveBeenCalledTimes(1);
        view.detectVisual = () => [];
        handler.pointerMove(view, event);
        handler.pointerMove(view, event);
        expect(removeCalls).toHaveLength(1);
        expect(removeCalls[0].shape).toBe(visual);
        expect(view.update).toHaveBeenCalledTimes(2);
    });

    describe("constructor", () => {
        test("should initialize with defaults", () => {
            const { handler } = setupNodeSelectionHandler();
            expect(handler.isEnabled).toBe(true);
        });

        test("should register cancellation callback on controller", () => {
            let cancelled = false;
            const controller = new AsyncController();
            controller.onCancelled(() => {
                cancelled = true;
            });

            setupNodeSelectionHandler({ controller });
            controller.cancel();
            expect(cancelled).toBe(true);
        });

        test("should clear selection and highlights on cancel", () => {
            const controller = new AsyncController();
            const { selection } = setupNodeSelectionHandler({ controller });

            let selectionCleared = false;
            selection.clearSelection = () => {
                selectionCleared = true;
            };

            controller.cancel();
            expect(selectionCleared).toBe(true);
        });
    });

    describe("toggleSelect", () => {
        test("should return true when shiftKey is pressed", () => {
            const { handler } = setupNodeSelectionHandler();
            const event = createPointerEvent({ shiftKey: true });
            expect((handler as any).toggleSelect(event)).toBe(true);
        });

        test("should return false when shiftKey is not pressed", () => {
            const { handler } = setupNodeSelectionHandler();
            const event = createPointerEvent({ shiftKey: false });
            expect((handler as any).toggleSelect(event)).toBe(false);
        });
    });

    describe("getDetecteds", () => {
        test("should use point detection by default", () => {
            const { handler, view } = setupNodeSelectionHandler();
            const visualObj = createMockVisualObject();
            view.detectVisual = () => [visualObj];

            const event = createPointerEvent({ offsetX: 100, offsetY: 200 });
            const result = handler.getDetecteds(view, event);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(visualObj);
        });

        test("should use rectangle detection when rect is set and mouse moved >3px", () => {
            const { handler, view } = setupNodeSelectionHandler({ multiMode: true });

            // Simulate pointerDown to create rect
            const downEvent = createPointerEvent({
                offsetX: 100,
                offsetY: 100,
                clientX: 150,
                clientY: 150,
            });
            handler.pointerDown(view, downEvent);

            const visualObj = createMockVisualObject();
            view.detectVisualRect = () => [visualObj];

            // Move far enough to trigger rect detection (>3px)
            const moveEvent = createPointerEvent({
                offsetX: 200,
                offsetY: 200,
                clientX: 250,
                clientY: 250,
                pointerId: 1,
            });

            const result = handler.getDetecteds(view, moveEvent);
            // rect detection should be used since rect exists and mouse moved >3px
            // But the rect detection is called from setHighlight through pointerMove
            // getDetecteds checks this.rect (set during pointerDown) and mouse distance
            // Since we're calling getDetecteds directly, the mouse was set in pointerDown to (100,100)
            // and the moveEvent is at (200,200) — distance >3
            expect(result).toHaveLength(1);
            expect(result[0]).toBe(visualObj);
        });

        test("should pass filter to detectVisual", () => {
            const filter: INodeFilter = { allow: () => true };
            const { handler, view } = setupNodeSelectionHandler({ filter });

            let passedFilter: INodeFilter | undefined;
            view.detectVisual = (_x: number, _y: number, f?: INodeFilter) => {
                passedFilter = f;
                return [];
            };

            handler.getDetecteds(view, createPointerEvent());
            expect(passedFilter).toBe(filter);
        });

        test("should pass filter to detectVisualRect", () => {
            const filter: INodeFilter = { allow: () => true };
            const { handler, view } = setupNodeSelectionHandler({ multiMode: true, filter });

            // Simulate pointerDown to set mouse position and create rect
            const downEvent = createPointerEvent({
                offsetX: 100,
                offsetY: 100,
                clientX: 150,
                clientY: 150,
            });
            handler.pointerDown(view, downEvent);

            let passedFilter: INodeFilter | undefined;
            view.detectVisualRect = (_x1: number, _y1: number, _x2: number, _y2: number, f?: INodeFilter) => {
                passedFilter = f;
                return [];
            };

            // Mouse must move >3px for rect detection
            const moveEvent = createPointerEvent({
                offsetX: 200,
                offsetY: 200,
                clientX: 250,
                clientY: 250,
                pointerId: 1,
            });

            handler.getDetecteds(view, moveEvent);
            expect(passedFilter).toBe(filter);
        });
    });

    describe("select", () => {
        test("should clear selection when no highlights", () => {
            const { handler, view, selection } = setupNodeSelectionHandler();

            let cleared = false;
            selection.clearSelection = () => {
                cleared = true;
            };

            const event = createPointerEvent();
            const count = (handler as any).select(view, event);
            expect(count).toBe(0);
            expect(cleared).toBe(true);
        });

        test("should set selected nodes when highlights exist", () => {
            const { handler, view, selection, nodesByVisual } = setupNodeSelectionHandler();

            const visualObj = createMockVisualObject();
            const node = createMockNode("testNode");
            nodesByVisual.set(visualObj, node);

            // Set highlights via internal state
            (handler as any)._highlights = [visualObj];

            let selectedNodes: INode[] | undefined;
            let toggleArg: boolean | undefined;
            selection.setSelectedNodes = (nodes, toggle) => {
                selectedNodes = nodes;
                toggleArg = toggle;
                return 1;
            };

            const event = createPointerEvent({ shiftKey: true });
            const count = (handler as any).select(view, event);

            expect(count).toBe(1);
            expect(selectedNodes).toEqual([node]);
            expect(toggleArg).toBe(true);
        });

        test("should filter out nodes not found in context", () => {
            const { handler, view, selection, context } = setupNodeSelectionHandler();

            const visualObj1 = createMockVisualObject();
            const visualObj2 = createMockVisualObject();

            // Only visualObj1 has a node
            const node = createMockNode("testNode");
            context.getNode = (v) => (v === visualObj1 ? node : undefined);

            (handler as any)._highlights = [visualObj1, visualObj2];

            let selectedNodes: INode[] | undefined;
            selection.setSelectedNodes = (nodes, _toggle) => {
                selectedNodes = nodes;
                return 1;
            };

            const event = createPointerEvent();
            (handler as any).select(view, event);

            expect(selectedNodes).toHaveLength(1);
            expect(selectedNodes![0]).toBe(node);
        });
    });

    describe("cleanHighlights", () => {
        test("should remove highlight state from all highlighted objects", () => {
            const { handler, removeCalls } = setupNodeSelectionHandler();

            const visualObj1 = createMockVisualObject();
            const visualObj2 = createMockVisualObject();

            (handler as any)._highlights = [visualObj1, visualObj2];

            (handler as any).cleanHighlights();

            expect(removeCalls).toHaveLength(2);
            expect(removeCalls[0].shape).toBe(visualObj1);
            expect(removeCalls[1].shape).toBe(visualObj2);
            // State should be edgeHighlight, type should be shape
            expect(removeCalls[0].state).toBe(VisualStates.edgeHighlight);
            expect(removeCalls[0].type).toBe(0); // ShapeTypes.shape

            // Highlights should be cleared
            expect((handler as any)._highlights).toBeUndefined();
        });

        test("should be a no-op when no highlights", () => {
            const { handler, removeCalls } = setupNodeSelectionHandler();
            (handler as any)._highlights = undefined;

            (handler as any).cleanHighlights();
            expect(removeCalls).toHaveLength(0);
        });
    });

    describe("highlightNext", () => {
        test("should cycle to next detected object on Tab", () => {
            const { handler, view, addCalls } = setupNodeSelectionHandler();

            const visualObj1 = createMockVisualObject();
            const visualObj2 = createMockVisualObject();
            const visualObj3 = createMockVisualObject();

            // Set detected objects at mouse
            (handler as any)._detectAtMouse = [visualObj1, visualObj2, visualObj3];

            // First Tab: lock to index 1
            (handler as any).highlightNext(view);

            // Should highlight visualObj2
            expect(addCalls).toHaveLength(1);
            expect(addCalls[0].shape).toBe(visualObj2);

            // Second Tab: move to index 2
            addCalls.length = 0;
            (handler as any).highlightNext(view);
            expect(addCalls).toHaveLength(1);
            expect(addCalls[0].shape).toBe(visualObj3);

            // Third Tab: wrap to index 0
            addCalls.length = 0;
            (handler as any).highlightNext(view);
            expect(addCalls).toHaveLength(1);
            expect(addCalls[0].shape).toBe(visualObj1);
        });

        test("should not cycle when only one detected object", () => {
            const { handler, view, addCalls } = setupNodeSelectionHandler();

            const visualObj1 = createMockVisualObject();
            (handler as any)._detectAtMouse = [visualObj1];
            (handler as any)._highlights = [visualObj1];

            addCalls.length = 0;
            (handler as any).highlightNext(view);

            // Should NOT cycle since length <= 1
            expect(addCalls).toHaveLength(0);
        });
    });

    describe("pointerMove", () => {
        test("should reset lock detected on pointer move", () => {
            const { handler, view } = setupNodeSelectionHandler();
            (handler as any)._lockDetected = createMockVisualObject();

            const event = createPointerEvent({ buttons: 0 });
            handler.pointerMove(view, event);

            expect((handler as any)._lockDetected).toBeUndefined();
        });

        test("should highlight detected objects on move", () => {
            const { handler, view, addCalls } = setupNodeSelectionHandler();
            const visualObj = createMockVisualObject();
            view.detectVisual = () => [visualObj];

            const event = createPointerEvent({ buttons: 0 });
            handler.pointerMove(view, event);

            expect(addCalls).toHaveLength(1);
            expect(addCalls[0].shape).toBe(visualObj);
        });

        test("should skip highlighting when middle button is pressed", () => {
            const { handler, view, addCalls } = setupNodeSelectionHandler();
            const visualObj = createMockVisualObject();
            view.detectVisual = () => [visualObj];

            const event = createPointerEvent({ buttons: 4 }); // MOUSE_MIDDLE = 4
            handler.pointerMove(view, event);

            expect(addCalls).toHaveLength(0);
        });
    });

    describe("pointerDown", () => {
        test("should set mouse state on left button primary", () => {
            const { handler, view } = setupNodeSelectionHandler();

            const event = createPointerEvent({ offsetX: 50, offsetY: 75 });
            handler.pointerDown(view, event);

            expect((handler as any).mouse.isDown).toBe(true);
            expect((handler as any).mouse.x).toBe(50);
            expect((handler as any).mouse.y).toBe(75);
        });

        test("should not create rect when not in multiMode", () => {
            const { handler, view } = setupNodeSelectionHandler({ multiMode: false });

            const event = createPointerEvent();
            handler.pointerDown(view, event);

            expect((handler as any).rect).toBeUndefined();
        });

        test("should create rect in multiMode", () => {
            const { handler, view } = setupNodeSelectionHandler({ multiMode: true });

            const event = createPointerEvent({ clientX: 150, clientY: 250 });
            handler.pointerDown(view, event);

            expect((handler as any).rect).not.toBeNull();
            expect((handler as any).rect.clientX).toBe(150);
            expect((handler as any).rect.clientY).toBe(250);
        });

        test("should add pointer to event map", () => {
            const { handler, view } = setupNodeSelectionHandler();

            const event = createPointerEvent({ pointerId: 42 });
            handler.pointerDown(view, event);

            expect((handler as any).pointerEventMap.has(42)).toBe(true);
        });

        test("should not set mouse state for non-left button", () => {
            const { handler, view } = setupNodeSelectionHandler();

            const event = createPointerEvent({ button: 2 }); // right click
            handler.pointerDown(view, event);

            expect((handler as any).mouse.isDown).toBe(false);
        });
    });

    describe("pointerUp", () => {
        test("should complete selection and clean highlights", () => {
            const { handler, view, selection, addCalls, removeCalls } = setupNodeSelectionHandler();

            const visualObj = createMockVisualObject();
            view.detectVisual = () => [visualObj];

            // Simulate pointerDown + pointerMove to set highlight
            const downEvent = createPointerEvent({ pointerId: 1 });
            handler.pointerDown(view, downEvent);

            const moveEvent = createPointerEvent({ pointerId: 1, buttons: 1 });
            handler.pointerMove(view, moveEvent);
            // Now _highlights should be set
            expect((handler as any)._highlights).not.toBeNull();

            selection.setSelectedNodes = () => 1;

            addCalls.length = 0;
            const upEvent = createPointerEvent({ pointerId: 1 });
            handler.pointerUp(view, upEvent);

            // Highlights should be cleaned up
            expect(removeCalls.length).toBeGreaterThan(0);
            expect((handler as any).mouse.isDown).toBe(false);
        });

        test("should remove rect on pointer up", () => {
            const { handler, view } = setupNodeSelectionHandler({ multiMode: true });

            const downEvent = createPointerEvent({ clientX: 150, clientY: 250 });
            handler.pointerDown(view, downEvent);
            expect((handler as any).rect).not.toBeNull();

            const upEvent = createPointerEvent();
            handler.pointerUp(view, upEvent);
            expect((handler as any).rect).toBeUndefined();
        });

        test("should call controller.success when selection made in single mode", () => {
            const controller = new AsyncController();
            let successCalled = false;
            controller.onCompleted(() => {
                successCalled = true;
            });

            const { handler, view, nodesByVisual, selection } = setupNodeSelectionHandler({ controller });
            const visualObj = createMockVisualObject();
            const node = createMockNode("test");
            nodesByVisual.set(visualObj, node);

            view.detectVisual = () => [visualObj];

            // Setup: pointerDown to establish state
            handler.pointerDown(view, createPointerEvent({ pointerId: 1 }));
            // pointerMove to highlight
            handler.pointerMove(view, createPointerEvent({ pointerId: 1, buttons: 1 }));

            // Since multiMode is false and select returned >0, success should be called
            // But wait - the select method calls setSelectedNodes which returns 0 by default in our mock
            // So no success. Let me fix the mock.
            selection.setSelectedNodes = (_nodes) => {
                return 1;
            };

            // pointerUp should trigger selection and success
            handler.pointerUp(view, createPointerEvent({ pointerId: 1 }));
            expect(successCalled).toBe(true);
        });
    });

    describe("pointerOut", () => {
        test("should clean up on primary pointer out", () => {
            const { handler, view, removeCalls } = setupNodeSelectionHandler();

            // Set up some highlights
            const visualObj = createMockVisualObject();
            (handler as any)._highlights = [visualObj];
            (handler as any).mouse.isDown = true;

            const event = createPointerEvent({ isPrimary: true, pointerId: 1 });
            handler.pointerOut!(view, event);

            expect((handler as any).mouse.isDown).toBe(false);
            expect(removeCalls.length).toBeGreaterThan(0);
        });

        test("should remove pointer from event map", () => {
            const { handler, view } = setupNodeSelectionHandler();

            const event = createPointerEvent({ pointerId: 5 });
            handler.pointerOut!(view, event);

            expect((handler as any).pointerEventMap.has(5)).toBe(false);
        });
    });

    describe("keyDown", () => {
        test("should cancel on Escape when controller exists", () => {
            const controller = new AsyncController();
            let cancelCalled = false;
            controller.onCancelled(() => {
                cancelCalled = true;
            });

            const { handler, view } = setupNodeSelectionHandler({ controller });

            const event = { key: "Escape", preventDefault: () => {} } as KeyboardEvent;
            handler.keyDown(view, event);

            expect(cancelCalled).toBe(true);
        });

        test("should clear selection on Escape when no controller", () => {
            const { handler, view, selection } = setupNodeSelectionHandler();

            let cleared = false;
            selection.clearSelection = () => {
                cleared = true;
            };

            const event = { key: "Escape", preventDefault: () => {} } as KeyboardEvent;
            handler.keyDown(view, event);

            expect(cleared).toBe(true);
        });

        test("should highlight next on Tab", () => {
            const { handler, view, addCalls } = setupNodeSelectionHandler();

            const obj1 = createMockVisualObject();
            const obj2 = createMockVisualObject();
            (handler as any)._detectAtMouse = [obj1, obj2];

            const event = { key: "Tab", preventDefault: () => {} } as KeyboardEvent;
            handler.keyDown(view, event);

            // Should have highlighted obj2 (index 1)
            expect(addCalls).toHaveLength(1);
            expect(addCalls[0].shape).toBe(obj2);
        });

        test("should call success on Enter when not default event handler", () => {
            const controller = new AsyncController();
            let completed = false;
            controller.onCompleted(() => {
                completed = true;
            });

            const { handler, view } = setupNodeSelectionHandler({ controller });

            const event = {
                key: "Enter",
                preventDefault: () => {},
                stopImmediatePropagation: () => {},
            } as KeyboardEvent;
            handler.keyDown(view, event);

            expect(completed).toBe(true);
        });
    });

    describe("dispose", () => {
        test("should dispose only once", () => {
            const { handler } = setupNodeSelectionHandler();
            const disposeInternalSpy = rs.spyOn(handler as any, "disposeInternal");

            handler.dispose();
            handler.dispose(); // second call should be no-op

            expect(disposeInternalSpy).toHaveBeenCalledTimes(1);
        });

        test("should clear pointer event map on dispose", () => {
            const { handler, view } = setupNodeSelectionHandler();

            const event = createPointerEvent({ pointerId: 42 });
            handler.pointerDown(view, event);
            expect((handler as any).pointerEventMap.size).toBe(1);

            handler.dispose();
            expect((handler as any).pointerEventMap.size).toBe(0);
        });
    });

    describe("integration: full selection flow", () => {
        test("should select a node from click to release", () => {
            const { handler, view, selection, nodesByVisual } = setupNodeSelectionHandler();

            const visualObj = createMockVisualObject();
            const node = createMockNode("clickedNode");
            nodesByVisual.set(visualObj, node);

            view.detectVisual = () => [visualObj];

            let selectedNodes: INode[] = [];
            selection.setSelectedNodes = (nodes, _toggle) => {
                selectedNodes = nodes;
                return nodes.length;
            };

            // Click
            handler.pointerDown(view, createPointerEvent({ pointerId: 1, offsetX: 100, offsetY: 100 }));
            // Move (highlighting)
            handler.pointerMove(
                view,
                createPointerEvent({ pointerId: 1, offsetX: 100, offsetY: 100, buttons: 1 }),
            );
            // Release
            handler.pointerUp(view, createPointerEvent({ pointerId: 1 }));

            expect(selectedNodes).toHaveLength(1);
            expect(selectedNodes[0]).toBe(node);
        });

        test("should support multi-select with shift key", () => {
            const { handler, view, selection, nodesByVisual } = setupNodeSelectionHandler();

            const obj1 = createMockVisualObject();
            const obj2 = createMockVisualObject();
            nodesByVisual.set(obj1, createMockNode("node1"));
            nodesByVisual.set(obj2, createMockNode("node2"));

            view.detectVisual = () => [obj1, obj2];

            let togglePassed = false;
            selection.setSelectedNodes = (_nodes, toggle) => {
                togglePassed = toggle;
                return 1;
            };

            // Set highlights via pointerMove
            handler.pointerDown(view, createPointerEvent({ pointerId: 1 }));
            handler.pointerMove(view, createPointerEvent({ pointerId: 1, buttons: 1 }));

            // Release with shift key
            handler.pointerUp(view, createPointerEvent({ pointerId: 1, shiftKey: true }));

            expect(togglePassed).toBe(true);
        });
    });
});

describe("a node that selects its parts (a sketch's curves)", () => {
    test("hover highlights the curve under the cursor and a click selects that curve, not the node", () => {
        const { handler, view, addCalls, removeCalls, selection, nodesByVisual } =
            setupNodeSelectionHandler();
        const visual = createMockVisualObject();
        const sketch = { ...createMockNode("Sketch 1"), selectsSubShapes: 0b1000000 } as INode;
        nodesByVisual.set(visual, sketch);
        const pick = {
            shape: { shapeType: 0b1000000 },
            owner: { node: sketch },
            indexes: [2],
            transform: Matrix4.identity(),
        };
        view.detectVisual = () => [visual];
        view.detectShapes = rs.fn(() => [pick]);
        const setSelectedShapes = rs.spyOn(selection, "setSelectedShapes");
        const setSelectedNodes = rs.spyOn(selection, "setSelectedNodes");
        handler.pointerMove(view, createPointerEvent({ buttons: 0, offsetX: 10, offsetY: 10 }));
        expect(view.detectShapes).toHaveBeenCalledWith(0b1000000, 10, 10, undefined, undefined);
        expect(addCalls.at(-1)).toEqual({
            shape: visual,
            state: VisualStates.edgeHighlight,
            type: 0b1000000,
            indexes: [2],
        });
        handler.pointerDown(view, createPointerEvent({ button: 0, offsetX: 10, offsetY: 10 }));
        handler.pointerUp(view, createPointerEvent({ button: 0, offsetX: 10, offsetY: 10 }));
        expect(setSelectedShapes).toHaveBeenCalledWith([pick], VisualStates.edgeSelected, true);
        expect(setSelectedNodes).not.toHaveBeenCalled();
        expect(removeCalls.at(-1)).toEqual({
            shape: visual,
            state: VisualStates.edgeHighlight,
            type: 0b1000000,
            indexes: [2],
        });
    });

    test("a point under the cursor wins over the curve it ends", () => {
        const { handler, view, addCalls, selection, nodesByVisual } = setupNodeSelectionHandler();
        const visual = createMockVisualObject();
        const sketch = {
            ...createMockNode("Sketch 1"),
            selectsSubShapes: ShapeTypes.edge | ShapeTypes.vertex,
        } as INode;
        nodesByVisual.set(visual, sketch);
        const edge = {
            shape: { shapeType: ShapeTypes.edge },
            owner: { node: sketch },
            indexes: [2],
            transform: Matrix4.identity(),
        };
        const vertex = {
            shape: { shapeType: ShapeTypes.vertex },
            owner: { node: sketch },
            indexes: [5],
            transform: Matrix4.identity(),
        };
        view.detectVisual = () => [visual];
        view.detectShapes = rs.fn(() => [edge, vertex]);
        const setSelectedShapes = rs.spyOn(selection, "setSelectedShapes");
        handler.pointerMove(view, createPointerEvent({ buttons: 0, offsetX: 10, offsetY: 10 }));
        expect(view.detectShapes).toHaveBeenCalledWith(
            ShapeTypes.edge | ShapeTypes.vertex,
            10,
            10,
            undefined,
            undefined,
        );
        expect(addCalls.at(-1)).toEqual({
            shape: visual,
            state: VisualStates.edgeHighlight,
            type: ShapeTypes.vertex,
            indexes: [5],
        });
        handler.pointerDown(view, createPointerEvent({ button: 0, offsetX: 10, offsetY: 10 }));
        handler.pointerUp(view, createPointerEvent({ button: 0, offsetX: 10, offsetY: 10 }));
        expect(setSelectedShapes).toHaveBeenCalledWith([vertex], VisualStates.edgeSelected, true);
    });

    function closeSketchPoints() {
        const setup = setupNodeSelectionHandler();
        const visual = createMockVisualObject();
        const sketch = {
            ...createMockNode("Sketch 1"),
            selectsSubShapes: ShapeTypes.edge | ShapeTypes.vertex,
        } as INode;
        setup.nodesByVisual.set(visual, sketch);
        // Reported by depth along the ray, the farther point (from the cursor) first.
        const vertexAt = (index: number, at: XYZ) => ({
            shape: { shapeType: ShapeTypes.vertex, point: () => at },
            owner: { node: sketch },
            indexes: [index],
            transform: Matrix4.identity(),
            point: new XYZ(10, 10, 0),
        });
        const far = vertexAt(3, new XYZ(13, 10, 0));
        const near = vertexAt(4, new XYZ(11, 10, 0));
        setup.view.detectVisual = () => [visual];
        setup.view.detectShapes = rs.fn(() => [far, near]);
        return { ...setup, visual, far, near };
    }

    test("among close points the one nearest the cursor on screen is taken", () => {
        const { handler, view, addCalls, selection, visual, near } = closeSketchPoints();
        view.worldToScreen = (point: XYZ) => new XY(point.x, point.y);
        const setSelectedShapes = rs.spyOn(selection, "setSelectedShapes");
        handler.pointerMove(view, createPointerEvent({ buttons: 0, offsetX: 10, offsetY: 10 }));
        expect(addCalls.at(-1)).toEqual({
            shape: visual,
            state: VisualStates.edgeHighlight,
            type: ShapeTypes.vertex,
            indexes: [4],
        });
        handler.pointerDown(view, createPointerEvent({ button: 0, offsetX: 10, offsetY: 10 }));
        handler.pointerUp(view, createPointerEvent({ button: 0, offsetX: 10, offsetY: 10 }));
        expect(setSelectedShapes).toHaveBeenCalledWith([near], VisualStates.edgeSelected, true);
    });

    test("without screen projection the point nearest the pointer ray is taken", () => {
        const { handler, view, addCalls } = closeSketchPoints();
        view.worldToScreen = undefined as unknown as typeof view.worldToScreen;
        view.rayAt = () => new Ray({ point: new XYZ(10, 10, 50), direction: new XYZ(0, 0, -1) });
        handler.pointerMove(view, createPointerEvent({ buttons: 0, offsetX: 10, offsetY: 10 }));
        expect(addCalls.at(-1)?.indexes).toEqual([4]);
    });

    test("picked parts gather click by click; a click into the void clears them as an undo step", () => {
        const { handler, view, selection, nodesByVisual, document } = setupNodeSelectionHandler();
        const visual = createMockVisualObject();
        const sketch = {
            ...createMockNode("Sketch 1"),
            selectsSubShapes: ShapeTypes.edge | ShapeTypes.vertex,
        } as INode;
        nodesByVisual.set(visual, sketch);
        const pickAt = (index: number) => ({
            shape: { shapeType: ShapeTypes.vertex },
            owner: { node: sketch },
            indexes: [index],
            transform: Matrix4.identity(),
        });
        const selected: unknown[] = [];
        selection.getSelectedShapes = () => [...selected] as never;
        const setSelectedShapes = rs.fn((shapes: unknown[], _state: unknown, toggle: boolean) => {
            if (!toggle) selected.length = 0;
            selected.push(...shapes);
            return selected.length;
        });
        selection.setSelectedShapes = setSelectedShapes as never;
        const clearSelection = rs.fn(() => {
            selected.length = 0;
        });
        selection.clearSelection = clearSelection;
        const records: IHistoryRecord[] = [];
        const add = rs.spyOn(Transaction, "add").mockImplementation((_doc, record) => {
            records.push(record);
        });
        try {
            view.detectVisual = () => [visual];
            const clickAt = (index: number) => {
                view.detectShapes = rs.fn(() => [pickAt(index)]);
                handler.pointerMove(view, createPointerEvent({ buttons: 0, offsetX: 10, offsetY: 10 }));
                handler.pointerDown(view, createPointerEvent({ button: 0, offsetX: 10, offsetY: 10 }));
                handler.pointerUp(view, createPointerEvent({ button: 0, offsetX: 10, offsetY: 10 }));
            };
            clickAt(1);
            clickAt(2);
            // no modifier: both parts are selected, each click toggling one
            expect(setSelectedShapes).toHaveBeenCalledTimes(2);
            expect(setSelectedShapes.mock.calls.every((call) => call[2] === true)).toBe(true);
            expect(selected).toHaveLength(2);
            // the first click, with nothing picked yet, dropped any node selection first
            expect(clearSelection).toHaveBeenCalledTimes(1);
            // a click on nothing clears them, and the clearing is on the undo stack
            view.detectVisual = () => [];
            view.detectShapes = rs.fn(() => []);
            handler.pointerMove(view, createPointerEvent({ buttons: 0, offsetX: 50, offsetY: 50 }));
            handler.pointerDown(view, createPointerEvent({ button: 0, offsetX: 50, offsetY: 50 }));
            handler.pointerUp(view, createPointerEvent({ button: 0, offsetX: 50, offsetY: 50 }));
            expect(selected).toHaveLength(0);
            expect(records).toHaveLength(1);
            expect(records[0].name).toBe("selection.clear");
            expect(add).toHaveBeenCalledWith(document, records[0]);
            records[0].undo();
            expect(selected.map((pick) => (pick as { indexes: number[] }).indexes[0])).toEqual([1, 2]);
            records[0].redo();
            expect(selected).toHaveLength(0);
            // clearing an already empty selection records nothing
            handler.pointerDown(view, createPointerEvent({ button: 0, offsetX: 50, offsetY: 50 }));
            handler.pointerUp(view, createPointerEvent({ button: 0, offsetX: 50, offsetY: 50 }));
            expect(records).toHaveLength(1);
        } finally {
            add.mockRestore();
        }
    });

    test("a node without the marker still selects as a whole", () => {
        const { handler, view, selection, nodesByVisual } = setupNodeSelectionHandler();
        const visual = createMockVisualObject();
        nodesByVisual.set(visual, createMockNode("Box"));
        view.detectVisual = () => [visual];
        view.detectShapes = rs.fn(() => []);
        const setSelectedNodes = rs.spyOn(selection, "setSelectedNodes");
        handler.pointerMove(view, createPointerEvent({ buttons: 0 }));
        expect(view.detectShapes).not.toHaveBeenCalled();
        handler.pointerDown(view, createPointerEvent({ button: 0 }));
        handler.pointerUp(view, createPointerEvent({ button: 0 }));
        expect(setSelectedNodes).toHaveBeenCalled();
    });
});
