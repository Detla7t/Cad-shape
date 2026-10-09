// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IView } from "@chili3d/core";
import { afterEach, describe, expect, rs, test } from "@rstest/core";

rs.mock("../src/viewport/viewport.module.css", () => ({
    root: "vp-root",
    actsContainer: "vp-acts-container",
    border: "vp-border",
    acts: "vp-acts",
    tools: "vp-tools",
    viewControls: "vp-view-controls",
    visible: "vp-visible",
    actived: "vp-actived",
}));

// Track PubSub publications via the shared recorder
const pubSubRecorder = rs.hoisted(() => {
    const { createPubSubRecorder } = require("./_helpers/coreMocks");
    return createPubSubRecorder();
});

// Mock core — the hoisted `actual` snapshots core mid-initialization, so every
// runtime value the Viewport touches (PubSub, Binding, ViewModes, ...) is stubbed.
rs.mock("@chili3d/core", () => {
    const actual = rs.hoisted(() => require("@chili3d/core"));
    const { BindingMock, LocalizeMock } = rs.hoisted(() => require("./_helpers/coreMocks"));
    return {
        ...actual,
        Binding: BindingMock,
        Localize: LocalizeMock,
        I18n: { set: () => {} },
        PubSub: pubSubRecorder.stub,
        ViewModes: [],
        ViewModeI18nKeys: {},
    };
});

// Mock element helpers
import "./_helpers/mockElement";

// The real Flyout drags in the Input/Tip chain; a detached div is enough here.
rs.mock("../src/viewport/flyout", () => ({
    Flyout: function Flyout() {
        return document.createElement("div");
    },
}));

// Inspection behavior is exercised in selectionMeasurementControl.test.ts; these
// fixtures intentionally model only pointer dispatch and command arbitration.
rs.mock("../src/review/viewportUtilities", () => ({
    ViewportUtilities: class {
        element = document.createElement("div");
        selection = { guide: { element: document.createElement("div") } };
        close() {}
        dispose() {}
    },
}));

import { Viewport } from "../src/viewport/viewport";

function createMockView(detected: unknown[], node: unknown) {
    const doc = {
        acts: {
            length: 0,
            forEach: () => {},
            onCollectionChanged: rs.fn(),
            removeCollectionChanged: rs.fn(),
        },
        visual: { context: { getNode: rs.fn(() => node) } },
        application: { activeView: undefined },
    };
    const view = {
        document: doc,
        mode: "perspective",
        cameraController: {},
        setDom: rs.fn(),
        update: rs.fn(),
        detectVisual: rs.fn(() => detected),
    };
    return { doc, view };
}

function dispatchDoubleClick(target: HTMLElement, offsetX: number, offsetY: number) {
    const event = new MouseEvent("dblclick", { bubbles: true });
    Object.defineProperties(event, { offsetX: { value: offsetX }, offsetY: { value: offsetY } });
    target.dispatchEvent(event);
}

describe("Viewport double-click", () => {
    let viewport: Viewport | undefined;

    afterEach(() => {
        viewport?.remove();
        viewport = undefined;
        pubSubRecorder.reset();
    });

    test("should publish nodeDoubleClicked for the node under the cursor", () => {
        const visual = { id: "visual-1" };
        const node = { name: "node-1" };
        const { doc, view } = createMockView([visual], node);
        viewport = new Viewport(view as unknown as IView, false);
        document.body.appendChild(viewport);

        dispatchDoubleClick(viewport, 12, 34);

        expect(view.detectVisual).toHaveBeenCalledWith(12, 34);
        expect(doc.visual.context.getNode).toHaveBeenCalledWith(visual);
        expect(pubSubRecorder.pubs).toEqual([{ topic: "nodeDoubleClicked", args: [node] }]);
    });

    test("should not publish when double-clicking empty space", () => {
        const { view } = createMockView([], undefined);
        viewport = new Viewport(view as unknown as IView, false);
        document.body.appendChild(viewport);

        dispatchDoubleClick(viewport, 5, 6);

        expect(pubSubRecorder.pubs).toEqual([]);
    });
});

describe("Viewport right-drag arbitration", () => {
    function setup() {
        const { view, doc } = createMockView([], undefined);
        const handler = () => ({
            isEnabled: true,
            pointerDown: rs.fn(),
            pointerMove: rs.fn(),
            pointerUp: rs.fn(),
            pointerOut: rs.fn(),
        });
        const eventHandler = handler();
        const viewHandler = handler();
        Object.assign(doc.visual, { eventHandler, viewHandler });
        const viewport = new Viewport(view as unknown as IView, false);
        document.body.append(viewport);
        const send = (type: string, x = 30, y = 30) =>
            viewport.dispatchEvent(
                new PointerEvent(type, {
                    bubbles: true,
                    pointerType: "mouse",
                    pointerId: 1,
                    button: 2,
                    buttons: type === "pointerup" ? 0 : 2,
                    clientX: x,
                    clientY: y,
                }),
            );
        return { viewport, send, eventHandler, viewHandler };
    }

    afterEach(() => {
        document.body.replaceChildren();
    });

    test("right-drag orbits without cancelling a pending modeling pick", () => {
        const { send, eventHandler, viewHandler } = setup();
        send("pointerdown");
        send("pointermove", 80, 30);
        send("pointerout", 100, 30);
        send("pointerup", 100, 30);
        expect(viewHandler.pointerMove).toHaveBeenCalledTimes(1);
        expect(viewHandler.pointerUp).toHaveBeenCalledTimes(1);
        expect(viewHandler.pointerOut).not.toHaveBeenCalled();
        expect(eventHandler.pointerDown).not.toHaveBeenCalled();
        expect(eventHandler.pointerMove).not.toHaveBeenCalled();
        expect(eventHandler.pointerUp).not.toHaveBeenCalled();
    });

    test("a stationary right-click still reaches the tool on release", () => {
        const { send, eventHandler } = setup();
        send("pointerdown");
        expect(eventHandler.pointerDown).not.toHaveBeenCalled();
        send("pointermove", 31, 30);
        send("pointerup", 31, 30);
        expect(eventHandler.pointerDown).toHaveBeenCalledTimes(1);
        expect(eventHandler.pointerUp).toHaveBeenCalledTimes(1);
    });

    test("pointer cancellation clears a drag and never fires the click action", () => {
        const { send, eventHandler, viewHandler } = setup();
        send("pointerdown");
        send("pointermove", 80, 40);
        send("pointercancel", 80, 40);
        expect(viewHandler.pointerUp).toHaveBeenCalledTimes(1);
        expect(eventHandler.pointerDown).not.toHaveBeenCalled();
        send("pointermove", 90, 40);
        expect(eventHandler.pointerMove).toHaveBeenCalledTimes(1);
    });

    test("left-button selection keeps receiving a drag and release beyond the viewport", () => {
        const { viewport, eventHandler } = setup();
        const send = (type: string, x: number) =>
            viewport.dispatchEvent(
                new PointerEvent(type, {
                    bubbles: true,
                    isPrimary: true,
                    pointerId: 2,
                    pointerType: "mouse",
                    button: 0,
                    buttons: type === "pointerup" ? 0 : 1,
                    clientX: x,
                    clientY: 30,
                }),
            );
        send("pointerdown", 100);
        send("pointerout", -20);
        send("pointermove", -20);
        expect(eventHandler.pointerOut).not.toHaveBeenCalled();
        send("pointerup", -20);
        expect(eventHandler.pointerUp).toHaveBeenCalledTimes(1);
        send("pointerout", -30);
        expect(eventHandler.pointerOut).toHaveBeenCalledTimes(1);
    });
});
