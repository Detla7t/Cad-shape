// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PmiNote, XYZ } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { ThreePmiAnnotation } from "../src/threePmiAnnotation";
import { createThreeMockVisualContext } from "./mocks";
import { TestView } from "./testView";

const p = (x: number, y: number, z: number) => new XYZ({ x, y, z });

describe("ThreeView PMI labels", () => {
    test("each view hosts a frame and marker per annotation, following its revision, visibility and highlight", () => {
        const context = createThreeMockVisualContext();
        const doc = new TestDocument();
        const view = new TestView(doc, context);
        try {
            const labelScene = view["labelScene"];
            const sync = () => view["syncPmiLabels"]();
            const labels = () => labelScene.children.filter((x) => x instanceof CSS2DObject) as CSS2DObject[];
            sync();
            expect(labels()).toHaveLength(0);

            const note = new PmiNote({
                document: doc,
                anchor: p(0, 0, 0),
                position: p(10, 0, 0),
                text: "NOTE",
            });
            const visual = new ThreePmiAnnotation(context, note);
            context.visualShapes.add(visual);
            sync();
            const first = labels();
            expect(first).toHaveLength(2);
            expect(first[0].element.textContent).toBe("NOTE");
            expect(first[0].position.x).toBe(10);
            expect(first[1].element.dataset["shape"]).toBe("dot");
            expect(first.every((x) => x.visible)).toBe(true);
            // unchanged: the same objects stay
            sync();
            expect(labels()).toEqual(first);

            note.content = "DEBURR";
            sync();
            const second = labels();
            expect(second).toHaveLength(2);
            expect(second[0]).not.toBe(first[0]);
            expect(second[0].element.textContent).toBe("DEBURR");
            expect(first[0].element.isConnected).toBe(false);

            visual.visible = false;
            sync();
            expect(labels().every((x) => !x.visible)).toBe(true);
            visual.visible = true;
            context.visualShapes.visible = false;
            sync();
            expect(labels().every((x) => !x.visible)).toBe(true);
            context.visualShapes.visible = true;

            visual.highlight();
            sync();
            expect(second[0].element.className).toContain("selected");
            visual.unhighlight();
            sync();
            expect(second[0].element.className).not.toContain("selected");

            visual.dispose();
            sync();
            expect(labels()).toHaveLength(0);
        } finally {
            view.dispose();
        }
    });

    test("a frame's leader side and a marker's turn are evaluated by the view's camera before each render", () => {
        const context = createThreeMockVisualContext();
        const doc = new TestDocument();
        const view = new TestView(doc, context);
        try {
            const note = new PmiNote({
                document: doc,
                anchor: p(0, 0, 0),
                position: p(-10, 0, 0),
                text: "LEFT",
            });
            const visual = new ThreePmiAnnotation(context, note);
            context.visualShapes.add(visual);
            view["syncPmiLabels"]();
            const objects = view["labelScene"].children.filter(
                (x) => x instanceof CSS2DObject,
            ) as CSS2DObject[];
            const renderer = { getSize: () => ({ width: 100, height: 100 }) };
            objects[0].onBeforeRender(renderer as never, view["labelScene"], view.camera);
            // the frame sits to the left of its leader end: its right edge is anchored
            expect(objects[0].center.x).toBe(1);
            objects[1].onBeforeRender(renderer as never, view["labelScene"], view.camera);
            const marker = objects[1].element.firstElementChild as HTMLElement;
            expect(marker.style.transform).toMatch(/^rotate\(.*rad\)$/);
        } finally {
            view.dispose();
        }
    });
});

describe("ThreeView PMI dragging", () => {
    const pointer = (type: string, x: number, y: number) =>
        new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 });

    test("dragging a frame moves the annotation's frame point in the view plane as one undo step", () => {
        const context = createThreeMockVisualContext();
        const doc = new TestDocument();
        const view = new TestView(doc, context);
        try {
            const note = new PmiNote({
                document: doc,
                anchor: p(0, 0, 0),
                position: p(10, 0, 0),
                text: "NOTE",
            });
            const visual = new ThreePmiAnnotation(context, note);
            context.visualShapes.add(visual);
            view["syncPmiLabels"]();
            const frame = (
                view["labelScene"].children.filter((x) => x instanceof CSS2DObject) as CSS2DObject[]
            )[0].element;
            const undos = doc.history.undoCount();
            frame.dispatchEvent(pointer("pointerdown", 50, 50));
            frame.dispatchEvent(pointer("pointermove", 51, 50)); // under the drag threshold
            expect(note.position.isEqualTo(p(10, 0, 0))).toBe(true);
            frame.dispatchEvent(pointer("pointermove", 70, 40));
            expect(frame.dataset["dragging"]).toBe("true");
            const during = note.position;
            // the camera looks down -Z: right on screen is +X, up on screen is +Y
            expect(during.x).toBeGreaterThan(10);
            expect(during.y).toBeGreaterThan(0);
            expect(Math.abs(during.z)).toBeLessThan(1e-9);
            expect(note.anchor.isEqualTo(p(0, 0, 0))).toBe(true);
            // no history while dragging
            expect(doc.history.undoCount()).toBe(undos);
            frame.dispatchEvent(pointer("pointerup", 70, 40));
            expect(frame.dataset["dragging"]).toBeUndefined();
            expect(note.position.isEqualTo(during)).toBe(true);
            expect(doc.history.undoCount()).toBe(undos + 1);
            doc.history.undo();
            expect(note.position.isEqualTo(p(10, 0, 0))).toBe(true);
        } finally {
            view.dispose();
        }
    });

    test("a general note moves whole and a locked annotation does not move", () => {
        const context = createThreeMockVisualContext();
        const doc = new TestDocument();
        const view = new TestView(doc, context);
        try {
            const general = new PmiNote({
                document: doc,
                anchor: p(5, 5, 0),
                position: p(5, 5, 0),
                text: "GENERAL",
                leader: false,
            });
            const locked = new PmiNote({
                document: doc,
                anchor: p(0, 0, 0),
                position: p(10, 0, 0),
                text: "LOCKED",
                locked: true,
            });
            context.visualShapes.add(new ThreePmiAnnotation(context, general));
            context.visualShapes.add(new ThreePmiAnnotation(context, locked));
            view["syncPmiLabels"]();
            const frames = (
                view["labelScene"].children.filter((x) => x instanceof CSS2DObject) as CSS2DObject[]
            )
                .map((x) => x.element)
                .filter((e) => e.dataset["kind"] === "note");
            const generalFrame = frames.find((e) => e.textContent === "GENERAL")!;
            const lockedFrame = frames.find((e) => e.textContent === "LOCKED")!;
            generalFrame.dispatchEvent(pointer("pointerdown", 50, 50));
            generalFrame.dispatchEvent(pointer("pointermove", 80, 50));
            generalFrame.dispatchEvent(pointer("pointerup", 80, 50));
            expect(general.position.x).toBeGreaterThan(5);
            expect(general.anchor.isEqualTo(general.position)).toBe(true);
            lockedFrame.dispatchEvent(pointer("pointerdown", 50, 50));
            lockedFrame.dispatchEvent(pointer("pointermove", 80, 50));
            lockedFrame.dispatchEvent(pointer("pointerup", 80, 50));
            expect(locked.position.isEqualTo(p(10, 0, 0))).toBe(true);
            expect(lockedFrame.dataset["dragging"]).toBeUndefined();
        } finally {
            view.dispose();
        }
    });
});
