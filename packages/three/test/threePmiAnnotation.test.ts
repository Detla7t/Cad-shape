// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type INode,
    PmiDatum,
    PmiDimension,
    PmiFeatureControlFrame,
    PmiFlag,
    PmiNote,
    XYZ,
} from "@chili3d/core";
import { createMockSelection, TestDocument } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { OrthographicCamera } from "three";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { screenDelta, ThreePmiAnnotation } from "../src/threePmiAnnotation";
import { createThreeMockVisualContext } from "./mocks";

const p = (x: number, y: number, z: number) => new XYZ({ x, y, z });

/** Looks down −Z at the origin: world X is screen right, world Y is screen up. */
function topCamera() {
    const camera = new OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return camera;
}
const size = { width: 200, height: 100 };

describe("ThreePmiAnnotation", () => {
    test("a leader note draws its line on top and offers a frame plus a dot marker", () => {
        const context = createThreeMockVisualContext();
        const doc = new TestDocument();
        const note = new PmiNote({
            document: doc,
            anchor: p(0, 0, 0),
            position: p(10, 0, 0),
            text: "DEBURR",
        });
        const visual = new ThreePmiAnnotation(context, note);
        expect(context.pmiAnnotations.has(visual)).toBe(true);
        const lines = visual.wholeVisual();
        expect(lines).toHaveLength(1);
        const line = lines[0] as LineSegments2;
        expect(line.renderOrder).toBe(999);
        expect((line.material as { depthTest: boolean }).depthTest).toBe(false);
        const start = line.geometry.getAttribute("instanceStart");
        expect([start.getX(0), start.getY(0), start.getZ(0)]).toEqual([0, 0, 0]);

        const labels = visual.labels();
        expect(labels).toHaveLength(2);
        const [frame, marker] = labels;
        expect(frame.position.isEqualTo(p(10, 0, 0))).toBe(true);
        expect([frame.center.x, frame.center.y]).toEqual([0, 0.5]);
        const element = frame.build();
        expect(element.dataset["kind"]).toBe("note");
        expect(element.textContent).toBe("DEBURR");
        expect(element.style.getPropertyValue("--pmi-color")).toBe("#3b2f8f");
        expect(element.style.fontSize).toBe("15px");
        expect(element.dataset["locked"]).toBeUndefined();
        expect((line.material as { linewidth: number }).linewidth).toBe(1);
        const markerElement = marker.build();
        expect(markerElement.dataset["shape"]).toBe("dot");
        expect(markerElement.querySelector("circle")).not.toBeNull();
        expect(visual.boundingBox()!.max.x).toBe(10);
        visual.dispose();
        expect(context.pmiAnnotations.has(visual)).toBe(false);
    });

    test("the frame flips to the free side of its leader and markers turn with the line on screen", () => {
        const context = createThreeMockVisualContext();
        const doc = new TestDocument();
        const camera = topCamera();
        const flag = new PmiFlag({ document: doc, anchor: p(0, 0, 0), position: p(10, 0, 0), text: "2" });
        const visual = new ThreePmiAnnotation(context, flag);
        const [frame, arrow] = visual.labels();
        const frameObject = new CSS2DObject(frame.build());
        frame.beforeRender!(camera, frameObject, size);
        expect(frameObject.center.x).toBe(0);
        // the arrow tip sits at the anchor; its body points along the leader toward the frame
        expect(arrow.build().dataset["shape"]).toBe("arrow");
        const right = screenDelta(camera, size, p(0, 0, 0), p(10, 0, 0));
        expect(right.x).toBeGreaterThan(0);
        expect(Math.abs(right.y)).toBeLessThan(1e-9);
        const up = screenDelta(camera, size, p(0, 0, 0), p(0, 10, 0));
        expect(up.y).toBeLessThan(0);
        const rotation = (label: typeof arrow) => {
            const object = new CSS2DObject(label.build());
            label.beforeRender!(camera, object, size);
            const marker = object.element.firstElementChild as HTMLElement;
            return Number(/rotate\((.*)rad\)/.exec(marker.style.transform)![1]);
        };
        expect(Math.abs(rotation(arrow))).toBeLessThan(1e-9);

        flag.position = p(-10, 0, 0);
        const [flipped, flippedArrow] = visual.labels();
        flipped.beforeRender!(camera, frameObject, size);
        expect(frameObject.center.x).toBe(1);
        expect(Math.abs(Math.abs(rotation(flippedArrow)) - Math.PI)).toBeLessThan(1e-9);
        flag.position = p(0, 10, 0);
        expect(rotation(visual.labels()[1])).toBeCloseTo(-Math.PI / 2, 9);
        expect(frame.build().querySelector("polygon")).not.toBeNull();
        expect(frame.build().textContent).toBe("2");
    });

    test("a linear dimension has three lines, two arrowheads and its text above the dimension line", () => {
        const context = createThreeMockVisualContext();
        const doc = new TestDocument();
        const dimension = new PmiDimension({
            document: doc,
            anchor: p(0, 0, 0),
            anchor2: p(10, 0, 0),
            position: p(5, 5, 0),
            value: 10,
            tolerance: "±0.1",
        });
        const visual = new ThreePmiAnnotation(context, dimension);
        expect(visual.geometry.segments).toHaveLength(3);
        const line = visual.wholeVisual()[0] as LineSegments2;
        expect(line.geometry.getAttribute("instanceStart").count).toBe(3);
        const labels = visual.labels();
        expect(
            labels.map((label) => label.build().dataset["shape"] ?? label.build().dataset["kind"]),
        ).toEqual(["dimension", "arrow", "arrow"]);
        expect([labels[0].center.x, labels[0].center.y]).toEqual([0.5, 1]);
        expect(labels[0].build().textContent).toBe("10.00±0.1");
        expect(labels[0].beforeRender).toBeUndefined();
    });

    test("a feature control frame has one compartment per cell; a datum a boxed letter and a triangle", () => {
        const context = createThreeMockVisualContext();
        const doc = new TestDocument();
        const frame = new PmiFeatureControlFrame({
            document: doc,
            anchor: p(0, 0, 0),
            position: p(0, 10, 0),
            symbol: "⌖",
            tolerance: "⌀0.1",
            datums: "A B",
        });
        const cells = [...new ThreePmiAnnotation(context, frame).labels()[0].build().children].map(
            (x) => x.textContent,
        );
        expect(cells).toEqual(["⌖", "⌀0.1", "A", "B"]);
        const datum = new PmiDatum({ document: doc, anchor: p(0, 0, 0), position: p(0, 10, 0), label: "B" });
        const datumLabels = new ThreePmiAnnotation(context, datum).labels();
        expect(datumLabels[0].build().textContent).toBe("B");
        expect(datumLabels[1].build().dataset["shape"]).toBe("triangle");
    });

    test("a general note has no lines and hangs from its top-left corner; clicking any frame selects its node", () => {
        const context = createThreeMockVisualContext();
        const setSelectedNodes = rs.fn((_nodes: INode[], _toggle: boolean) => 1);
        const doc = new TestDocument({ selection: { ...createMockSelection(), setSelectedNodes } });
        const note = new PmiNote({
            document: doc,
            anchor: p(0, 0, 0),
            position: p(0, 0, 0),
            text: "A\\nB",
            leader: false,
        });
        const visual = new ThreePmiAnnotation(context, note);
        expect(visual.wholeVisual()).toEqual([]);
        const labels = visual.labels();
        expect(labels).toHaveLength(1);
        expect([labels[0].center.x, labels[0].center.y]).toEqual([0, 0]);
        const element = labels[0].build();
        expect([...element.children].map((x) => x.textContent)).toEqual(["A", "B"]);
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(setSelectedNodes).toHaveBeenCalledWith([note], false);
    });

    test("the style properties reach the frame and the lines: text size, line width, lock", () => {
        const context = createThreeMockVisualContext();
        const doc = new TestDocument();
        const note = new PmiNote({
            document: doc,
            anchor: p(0, 0, 0),
            position: p(10, 0, 0),
            text: "NOTE",
            textSize: 20,
            lineWidth: 2.5,
            locked: true,
        });
        const visual = new ThreePmiAnnotation(context, note);
        const element = visual.labels()[0].build();
        expect(element.style.fontSize).toBe("20px");
        expect(element.dataset["locked"]).toBe("true");
        expect(((visual.wholeVisual()[0] as LineSegments2).material as { linewidth: number }).linewidth).toBe(
            2.5,
        );
        note.lineWidth = 4;
        expect(((visual.wholeVisual()[0] as LineSegments2).material as { linewidth: number }).linewidth).toBe(
            4,
        );
        expect(visual.labels()[0].annotation).toBe(note);
        expect(visual.labels()[1].annotation).toBeUndefined();
    });

    test("editing the node rebuilds the lines, bumps the revision and highlighting swaps the material", () => {
        const context = createThreeMockVisualContext();
        const doc = new TestDocument();
        const note = new PmiNote({ document: doc, anchor: p(0, 0, 0), position: p(10, 0, 0), text: "NOTE" });
        const visual = new ThreePmiAnnotation(context, note);
        expect(visual.revision).toBe(0);
        const before = visual.wholeVisual()[0] as LineSegments2;
        note.position = p(0, 20, 0);
        expect(visual.revision).toBe(1);
        const after = visual.wholeVisual()[0] as LineSegments2;
        expect(after).not.toBe(before);
        const end = after.geometry.getAttribute("instanceEnd");
        expect([end.getX(0), end.getY(0), end.getZ(0)]).toEqual([0, 20, 0]);
        expect(visual.labels()[0].position.isEqualTo(p(0, 20, 0))).toBe(true);

        const normal = after.material;
        visual.highlight();
        expect(visual.highlighted).toBe(true);
        expect(after.material).not.toBe(normal);
        visual.unhighlight();
        expect(after.material).toBe(normal);

        visual.dispose();
        note.position = p(1, 1, 1);
        expect(visual.revision).toBe(1);
    });
});
