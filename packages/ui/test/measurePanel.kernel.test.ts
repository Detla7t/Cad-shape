// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { EditableShapeNode, type IShape, Plane, type Result, type ShapeNode, XYZ } from "@chili3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockView,
    TestDocument,
} from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import "../../parametric/src/measurement/selectionMeasurement";
import { MeasurePanel } from "../src/review/measurePanel";

let factory: ShapeFactory;
beforeAll(async () => {
    await initWasm({ wasmBinary: readFileSync("packages/wasm/lib/chili-wasm.wasm") });
    factory = new ShapeFactory();
    rs.stubGlobal("shapeFactory", factory);
});
afterAll(() => {
    rs.unstubAllGlobals();
});
const panels: MeasurePanel[] = [];
afterEach(() => {
    for (const panel of panels.splice(0)) panel.dispose();
});

/** A Part Studio whose selected model items are the given shapes. */
function studio(shapes: Result<IShape>[]) {
    const model = new TestDocument({
        application: createMockApplication({ shapeProvider: { factory } }),
        selection: createMockSelection(),
    });
    const nodes: ShapeNode[] = shapes.map((shape, index) => {
        expect(shape.isOk).toBe(true);
        const node = new EditableShapeNode({ document: model, name: `Item ${index + 1}`, shape });
        model.modelManager.addNode(node);
        return node;
    });
    model.selection.getSelectedNodes = () => nodes;
    const panel = new MeasurePanel(createMockView({ document: model }));
    panels.push(panel);
    return { model, panel, root: panel.element };
}
const option = (root: HTMLElement, label: string, value: string) => {
    const select = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    expect(select).not.toBeNull();
    select!.value = value;
    select!.dispatchEvent(new Event("change"));
};
const rows = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>("[data-mode]")].map(
        (row) =>
            `${row.querySelector("span")?.textContent} ${row.querySelector("span:nth-child(2)")?.textContent} ${row.querySelector("span:nth-child(3)")?.textContent}`,
    );

test("a box lists its edge length and surface area, converted by the chosen unit", () => {
    const { root } = studio([factory.box(Plane.XY, 25.4, 10, 10)]);
    expect([...root.querySelectorAll('[role="option"]')].map((row) => row.textContent)).toEqual(["Item 1×"]);
    expect(rows(root)).toEqual(["Length: 181.60 mm", "Area: 1216.00 mm²"]);
    option(root, "Length unit", "in");
    expect(rows(root)).toEqual(["Length: 7.15 in", "Area: 1.88 in²"]);
    option(root, "Measure type", "area");
    expect(rows(root)).toEqual(["Area: 1.88 in²"]);
    option(root, "Measure type", "radius");
    expect(root.textContent).toContain("does not apply");
});

test("two straight edges measure their distance, components and angle, in degrees or radians", () => {
    const { root } = studio([
        factory.line(new XYZ(0, 0, 0), new XYZ(10, 0, 0)),
        factory.line(new XYZ(0, 5, 3), new XYZ(0, 15, 3)),
    ]);
    expect(rows(root)).toEqual([
        "Min dist: 5.83 mm",
        "X ≑ 0.00 mm",
        "Y ≑ 5.00 mm",
        "Z ≑ 3.00 mm",
        "Max dist: 18.28 mm",
        "Length: 20.00 mm",
        "Angle: 90.000 °",
    ]);
    option(root, "Angle unit", "rad");
    expect(rows(root).at(-1)).toBe("Angle: 1.570796 rad");
    option(root, "Measure type", "distance");
    expect(rows(root)).toEqual(["Min dist: 5.83 mm", "X ≑ 0.00 mm", "Y ≑ 5.00 mm", "Z ≑ 3.00 mm"]);
});

test("a circle lists its length, radius, diameter and center; a point its position", () => {
    const { root } = studio([factory.circle(XYZ.unitZ, new XYZ(30, 40, 0), 5)]);
    expect(rows(root)).toEqual([
        "Length: 31.42 mm",
        "Radius: 5.00 mm",
        "Diameter: 10.00 mm",
        "Center X ≑ 30.00 mm",
        "Center Y ≑ 40.00 mm",
        "Center Z ≑ 0.00 mm",
    ]);
    option(root, "Measure type", "centerPosition");
    expect(rows(root)).toEqual(["Center X ≑ 30.00 mm", "Center Y ≑ 40.00 mm", "Center Z ≑ 0.00 mm"]);
    option(root, "Measure type", "position");
    expect(root.textContent).toContain("does not apply");

    const point = studio([factory.point(new XYZ(-1, 2, 3))]);
    expect(rows(point.root)).toEqual(["X ≑ -1.00 mm", "Y ≑ 2.00 mm", "Z ≑ 3.00 mm"]);
    option(point.root, "Measure type", "position");
    expect(rows(point.root)).toHaveLength(3);
    // the (x) of a coordinate makes a variable of it
    expect(point.root.querySelector('[aria-label="Create variable from X"]')).not.toBeNull();
});
