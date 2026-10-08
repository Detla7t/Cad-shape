// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { createThreeMockVisualContext } from "./mocks";
import { container, TestView } from "./testView";

describe("viewport render scheduling", () => {
    let view: TestView;
    let frames: Map<number, FrameRequestCallback>;
    let visibility: DocumentVisibilityState;
    let intersectionChanged: IntersectionObserverCallback;
    let visibilityDescriptor: PropertyDescriptor | undefined;
    const disconnect = rs.fn();

    function frame() {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(performance.now()));
    }

    function intersect(isIntersecting: boolean) {
        intersectionChanged(
            [
                {
                    target: container,
                    isIntersecting,
                    boundingClientRect: new DOMRect(),
                    intersectionRect: new DOMRect(),
                    intersectionRatio: isIntersecting ? 1 : 0,
                    rootBounds: null,
                    time: 0,
                },
            ],
            {} as IntersectionObserver,
        );
    }

    beforeEach(() => {
        frames = new Map();
        let nextId = 0;
        rs.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            frames.set(++nextId, callback);
            return nextId;
        });
        rs.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
        rs.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
        );
        disconnect.mockClear();
        rs.stubGlobal(
            "IntersectionObserver",
            class {
                constructor(callback: IntersectionObserverCallback) {
                    intersectionChanged = callback;
                }
                observe() {}
                unobserve() {}
                disconnect = disconnect;
            },
        );
        visibility = "visible";
        visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => visibility,
        });
        document.body.append(container);
        view = new TestView(new TestDocument(), createThreeMockVisualContext());
    });

    afterEach(() => {
        view.dispose();
        container.remove();
        rs.restoreAllMocks();
        rs.unstubAllGlobals();
        if (visibilityDescriptor) Object.defineProperty(document, "visibilityState", visibilityDescriptor);
        else Reflect.deleteProperty(document, "visibilityState");
    });

    test("draws the initial view once and schedules nothing while idle", () => {
        const render = rs.spyOn(view.renderer, "render");
        expect(frames.size).toBe(1);
        frame();
        expect(render).toHaveBeenCalledTimes(1);
        expect(frames.size).toBe(0);
        frame();
        expect(render).toHaveBeenCalledTimes(1);
    });

    test("coalesces a burst of changes and preserves an invalidation during rendering", () => {
        frame();
        const render = rs.spyOn(view.renderer, "render").mockImplementationOnce(() => view.update());
        for (let i = 0; i < 100; i++) view.update();
        expect(frames.size).toBe(1);
        frame();
        expect(render).toHaveBeenCalledTimes(1);
        expect(frames.size).toBe(1);
        frame();
        expect(render).toHaveBeenCalledTimes(2);
        expect(frames.size).toBe(0);
    });

    test("camera and display changes wake a sleeping viewport", () => {
        frame();
        const render = rs.spyOn(view.renderer, "render");
        view.cameraController.pan(10, 5);
        expect(frames.size).toBe(1);
        frame();
        view.mode = "wireframe";
        expect(frames.size).toBe(1);
        frame();
        expect(render).toHaveBeenCalledTimes(2);
    });

    test("hidden viewports retain changes and render once when visible again", () => {
        const render = rs.spyOn(view.renderer, "render");
        intersect(false);
        view.update();
        expect(frames.size).toBe(0);
        frame();
        expect(render).not.toHaveBeenCalled();
        intersect(true);
        expect(frames.size).toBe(1);
        frame();
        expect(render).toHaveBeenCalledTimes(1);
    });

    test("background tabs cancel pending work and resume on visibilitychange", () => {
        const render = rs.spyOn(view.renderer, "render");
        visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
        view.update();
        expect(frames.size).toBe(0);
        visibility = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
        frame();
        expect(render).toHaveBeenCalledTimes(1);
        expect(frames.size).toBe(0);
    });

    test("detached tabs do not render, and can resume when reattached", () => {
        const render = rs.spyOn(view.renderer, "render");
        container.remove();
        frame();
        expect(render).not.toHaveBeenCalled();
        view.update();
        expect(frames.size).toBe(0);
        document.body.append(container);
        view.update();
        frame();
        expect(render).toHaveBeenCalledTimes(1);
    });

    test("unchanged sizes do not reset the drawing buffer, zero sizes suspend rendering", () => {
        frame();
        const resize = rs.spyOn(view.renderer, "setSize");
        const render = rs.spyOn(view.renderer, "render");
        view.resize(100, 100);
        expect(resize).not.toHaveBeenCalled();
        expect(frames.size).toBe(0);
        view.update();
        view.resize(0, 0);
        view.update();
        expect(frames.size).toBe(0);
        view.resize(100, 100);
        frame();
        expect(resize).toHaveBeenCalledExactlyOnceWith(100, 100);
        expect(render).toHaveBeenCalledTimes(1);
    });

    test("unrelated preference changes do not reallocate the drawing buffer", () => {
        frame();
        const resize = rs.spyOn(view.renderer, "setPixelRatio");
        const previous = Config.instance.preferences;
        try {
            Config.instance.preferences = { ...previous, pixelDensity: "standard" };
            expect(resize).not.toHaveBeenCalled();
            expect(frames.size).toBe(1);
        } finally {
            Config.instance.preferences = previous;
        }
    });

    test("disposing cancels queued frames and unregisters observers", () => {
        const render = rs.spyOn(view.renderer, "render");
        expect(frames.size).toBe(1);
        view.dispose();
        view.update();
        document.dispatchEvent(new Event("visibilitychange"));
        expect(frames.size).toBe(0);
        expect(disconnect).toHaveBeenCalledTimes(1);
        frame();
        expect(render).not.toHaveBeenCalled();
    });
});
