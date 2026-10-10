// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type EdgeMeshData,
    FolderNode,
    type INode,
    type MeasurementMode,
    type MeshOption,
    PubSub,
    Result,
    registerSelectionMeasurementProvider,
    type VisualShapeData,
} from "@chili3d/core";
import { createMockApplication, createMockDocument, createMockView } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { SelectionMeasurementControl } from "../src/review/selectionMeasurementControl";

test("the readout refines a measurement, creates that definition and clears its guide with selection", async () => {
    let selected: INode[] = [];
    // A picked sub-shape: the guide traces its extent. A node-only selection wears its own outline.
    const pickedShape = () =>
        ({ owner: { node: selected[0] }, shape: {}, indexes: [0] }) as unknown as VisualShapeData;
    let shapes: VisualShapeData[] = [];
    const doc = createMockDocument({
        application: createMockApplication(),
        selection: { getSelectedNodes: () => selected, getSelectedShapes: () => shapes },
        history: { onChanged: () => {}, removeChanged: () => {} },
        modelManager: { addNodeObserver: () => {}, removeNodeObserver: () => {} },
    });
    const create = rs.fn(async (_mode: MeasurementMode) => {});
    registerSelectionMeasurementProvider({
        evaluate: (_doc, mode = "diameter") =>
            !selected.length
                ? Result.err("Select geometry")
                : Result.ok({
                      key: "circle",
                      modes: ["diameter", "radius"],
                      createVariable: create,
                      measurement: {
                          mode,
                          label: mode === "radius" ? "Radius" : "Diameter",
                          value: mode === "radius" ? 25.4 : 50.8,
                          segments: [
                              [
                                  { x: mode === "radius" ? 0 : -25.4, y: 0, z: 0 },
                                  { x: 25.4, y: 0, z: 0 },
                              ],
                          ],
                      },
                  }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const view = createMockView({ document: doc, dom: host });
    // The guide is scene geometry plus a 3D label: track what is on display.
    const meshes = new Map<number, { data: EdgeMeshData; option?: MeshOption }>();
    let nextId = 1;
    doc.visual.context.displayMesh = (datas, option) => {
        meshes.set(nextId, { data: datas[0] as EdgeMeshData, option });
        return nextId++;
    };
    doc.visual.context.removeMesh = (id) => {
        meshes.delete(id);
    };
    const labels = new Set<string>();
    view.htmlText = (text) => {
        labels.add(text);
        return { dispose: () => labels.delete(text) };
    };
    const outline = () => [...meshes.values()].find((mesh) => mesh.data.lineType === "dash");
    const control = new SelectionMeasurementControl(view, () => control.close());
    host.append(control.element, control.popup);
    try {
        await Promise.resolve();
        expect(control.element.hidden).toBe(true);
        selected = [new FolderNode({ document: doc, name: "Cylinder" })];
        shapes = [pickedShape()];
        doc.selection.onNodeChanged.emit(selected);
        await Promise.resolve();
        expect(control.element.textContent).toContain("Diameter: 50.80 mm");
        const originalLine = outline();
        expect(originalLine).toBeDefined();
        expect(originalLine!.option?.onTop).toBe(true);
        expect([...originalLine!.data.position]).toEqual([-25.4, 0, 0, 25.4, 0, 0].map(Math.fround));
        // The whole node selected (no picked sub-shape): the label only, no dashes over its edges.
        shapes = [];
        doc.selection.onNodeChanged.emit(selected);
        await Promise.resolve();
        expect(outline()).toBeUndefined();
        expect([...labels].some((label) => label.includes("Diameter"))).toBe(true);
        shapes = [pickedShape()];
        doc.selection.onNodeChanged.emit(selected);
        await Promise.resolve();
        expect(outline()).toBeDefined();
        expect([...labels]).toEqual(["Diameter: 50.80 mm"]);
        const readout = control.element.querySelector<HTMLButtonElement>(
            '[aria-label="Refine selection measurement"]',
        );
        expect(readout).not.toBeNull();
        readout!.click();
        expect(control.popup.hidden).toBe(false);
        const method = control.popup.querySelector("select");
        expect(method).not.toBeNull();
        method!.value = "radius";
        method!.dispatchEvent(new Event("change"));
        expect(control.element.textContent).toContain("Radius: 25.40 mm");
        expect([...outline()!.data.position]).toEqual([0, 0, 0, 25.4, 0, 0].map(Math.fround));
        expect([...labels]).toEqual(["Radius: 25.40 mm"]);
        doc.userData = { displayUnits: { length: "in", lengthPrecision: 3 } };
        PubSub.default.pub("documentUnitsChanged", doc);
        await Promise.resolve();
        expect(control.element.textContent).toContain("Radius: 1.000 in");
        const variable = control.element.querySelector<HTMLButtonElement>(
            '[aria-label="Create measured variable"]',
        );
        expect(variable).not.toBeNull();
        variable!.click();
        await Promise.resolve();
        expect(create).toHaveBeenCalledWith("radius");
        expect(control.popup.hidden).toBe(true);
        selected = [];
        shapes = [];
        doc.selection.onNodeChanged.emit(selected);
        await Promise.resolve();
        expect(control.element.hidden).toBe(true);
        expect(meshes.size).toBe(0);
        expect(labels.size).toBe(0);
    } finally {
        control.dispose();
        host.remove();
    }
});

test("the card stacks a distance's ΔX/ΔY/ΔZ in axis colours; a lone point shows its coordinates", async () => {
    let selected: INode[] = [];
    let point = false;
    const create = rs.fn(async (_mode: MeasurementMode) => {});
    const doc = createMockDocument({
        application: createMockApplication(),
        selection: { getSelectedNodes: () => selected },
        history: { onChanged: () => {}, removeChanged: () => {} },
        modelManager: { addNodeObserver: () => {}, removeNodeObserver: () => {} },
    });
    registerSelectionMeasurementProvider({
        evaluate: (_doc, mode = "distance") =>
            !selected.length
                ? Result.err("Select geometry")
                : point
                  ? Result.ok({
                        key: "point",
                        modes: [],
                        createVariable: async () => {},
                        details: [
                            { label: "X", value: 1, quantity: "length", axis: "x" },
                            { label: "Y", value: 2, quantity: "length", axis: "y" },
                            { label: "Z", value: 3, quantity: "length", axis: "z" },
                        ],
                    })
                  : Result.ok({
                        key: "pair",
                        modes: ["distance", "maxDistance", "centerDistance"],
                        createVariable: create,
                        measurement: {
                            mode,
                            label:
                                mode === "maxDistance"
                                    ? "Maximum distance"
                                    : mode === "centerDistance"
                                      ? "Center distance"
                                      : "Minimum distance",
                            value: mode === "maxDistance" ? 21 : mode === "centerDistance" ? 17 : 13,
                            segments: [
                                [
                                    { x: 0, y: 0, z: 0 },
                                    { x: 3, y: 4, z: 12 },
                                ],
                            ],
                        },
                        details: [
                            { label: "ΔX", value: 3, quantity: "length", axis: "x", mode: "deltaX" },
                            { label: "ΔY", value: 4, quantity: "length", axis: "y", mode: "deltaY" },
                            { label: "ΔZ", value: 12, quantity: "length", axis: "z", mode: "deltaZ" },
                            { label: "Angle", value: 90, quantity: "angle", mode: "angle" },
                            { label: "Area", value: 645.16, quantity: "area" },
                        ],
                    }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const view = createMockView({ document: doc, dom: host });
    doc.visual.context.displayMesh = () => 1;
    doc.visual.context.removeMesh = () => {};
    view.htmlText = () => ({ dispose: () => {} });
    const control = new SelectionMeasurementControl(view, () => control.close());
    host.append(control.element, control.popup);
    try {
        selected = [new FolderNode({ document: doc, name: "Pair" })];
        doc.selection.onNodeChanged.emit(selected);
        await Promise.resolve();
        expect(control.card.hidden).toBe(false);
        const rows = [...control.card.querySelectorAll("dt")].map((dt) => [
            dt.textContent,
            dt.dataset["axis"] ?? null,
            dt.nextElementSibling?.querySelector("span")?.textContent,
            dt.nextElementSibling?.querySelector("button")?.getAttribute("aria-label") ?? null,
        ]);
        expect(rows).toEqual([
            ["Maximum distance", null, "21.00 mm", "Create variable from Maximum distance"],
            ["Center distance", null, "17.00 mm", "Create variable from Center distance"],
            ["ΔX", "x", "3.00 mm", "Create variable from ΔX"],
            ["ΔY", "y", "4.00 mm", "Create variable from ΔY"],
            ["ΔZ", "z", "12.00 mm", "Create variable from ΔZ"],
            ["Angle", null, "90.0°", "Create variable from Angle"],
            ["Area", null, "645.16 mm²", null],
        ]);
        // the row's (x) makes a variable of that one value
        control.card.querySelector<HTMLButtonElement>('[aria-label="Create variable from ΔZ"]')!.click();
        await Promise.resolve();
        expect(create).toHaveBeenCalledWith("deltaZ");
        const options = [...control.popup.querySelectorAll("option")].map((o) => o.textContent);
        expect(options).toEqual(["Minimum distance", "Maximum distance", "Center distance"]);

        point = true;
        doc.selection.onNodeChanged.emit([...selected]);
        selected = [new FolderNode({ document: doc, name: "Point" })];
        doc.selection.onNodeChanged.emit(selected);
        await Promise.resolve();
        expect(control.element.textContent).toContain("X 1.00 mm");
        expect(control.element.textContent).toContain("Z 3.00 mm");
        expect(control.card.hidden).toBe(true);
        expect(
            control.element.querySelector<HTMLButtonElement>('[aria-label="Create measured variable"]')!
                .disabled,
        ).toBe(true);
    } finally {
        control.dispose();
        host.remove();
    }
});

test("two curves list their other distances as rows; hovering a row traces it, leaving restores the main value", async () => {
    const selected: INode[] = [];
    let shapes: VisualShapeData[] = [];
    const doc = createMockDocument({
        application: createMockApplication(),
        selection: { getSelectedNodes: () => selected, getSelectedShapes: () => shapes },
        history: { onChanged: () => {}, removeChanged: () => {} },
        modelManager: { addNodeObserver: () => {}, removeNodeObserver: () => {} },
    });
    const segmentsOf: Record<string, [number, number, number][]> = {
        distance: [
            [0, 0, 0],
            [10, 0, 0],
        ],
        maxDistance: [
            [0, 0, 0],
            [40, 30, 0],
        ],
        centerDistance: [
            [5, 0, 0],
            [25, 15, 0],
        ],
    };
    const valueByMode: Record<string, number> = { distance: 10, maxDistance: 50, centerDistance: 25 };
    const labelOf: Record<string, string> = {
        distance: "Minimum distance",
        maxDistance: "Maximum distance",
        centerDistance: "Center distance",
    };
    registerSelectionMeasurementProvider({
        evaluate: (_doc, mode = "distance") =>
            !shapes.length
                ? Result.err("Select geometry")
                : Result.ok({
                      key: "two-curves",
                      modes: ["distance", "maxDistance", "centerDistance"],
                      createVariable: async () => {},
                      measurement: {
                          mode,
                          label: labelOf[mode],
                          value: valueByMode[mode],
                          segments: [
                              [
                                  { x: segmentsOf[mode][0][0], y: segmentsOf[mode][0][1], z: 0 },
                                  { x: segmentsOf[mode][1][0], y: segmentsOf[mode][1][1], z: 0 },
                              ],
                          ],
                      },
                  }),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const view = createMockView({ document: doc, dom: host });
    const meshes = new Map<number, { data: EdgeMeshData; option?: MeshOption }>();
    let nextId = 1;
    doc.visual.context.displayMesh = (datas, option) => {
        meshes.set(nextId, { data: datas[0] as EdgeMeshData, option });
        return nextId++;
    };
    doc.visual.context.removeMesh = (id) => {
        meshes.delete(id);
    };
    const labels = new Set<string>();
    view.htmlText = (text) => {
        labels.add(text);
        return { dispose: () => labels.delete(text) };
    };
    const outline = () => [...meshes.values()].find((mesh) => mesh.data.lineType === "dash");
    const control = new SelectionMeasurementControl(view, () => control.close());
    host.append(control.element, control.popup);
    try {
        const sketch = new FolderNode({ document: doc, name: "Sketch 1" });
        shapes = [
            { owner: { node: sketch }, shape: { shapeType: 64 }, indexes: [0] } as unknown as VisualShapeData,
            { owner: { node: sketch }, shape: { shapeType: 64 }, indexes: [1] } as unknown as VisualShapeData,
        ];
        doc.selection.onShapeChanged.emit(shapes);
        await Promise.resolve();
        expect(control.element.textContent).toContain("Minimum distance: 10.00 mm");
        // the card lists the other two distances, each with its (x)
        const terms = [...control.card.querySelectorAll("dt")].map((dt) => dt.textContent);
        expect(terms).toEqual(["Maximum distance", "Center distance"]);
        expect(control.card.textContent).toContain("50.00 mm");
        expect(control.card.textContent).toContain("25.00 mm");
        expect(
            control.card.querySelector('[aria-label="Create variable from Maximum distance"]'),
        ).not.toBeNull();
        expect([...outline()!.data.position]).toEqual([0, 0, 0, 10, 0, 0].map(Math.fround));
        // hovering the maximum traces it in the viewport
        const maxRow = control.card.querySelector("dt")!;
        maxRow.dispatchEvent(new PointerEvent("pointerenter"));
        expect([...outline()!.data.position]).toEqual([0, 0, 0, 40, 30, 0].map(Math.fround));
        expect([...labels]).toEqual(["Maximum distance: 50.00 mm"]);
        // the endpoints of the trace are marked
        expect([...meshes.values()].filter((mesh) => mesh.data.lineType === undefined).length).toBe(2);
        maxRow.dispatchEvent(new PointerEvent("pointerleave"));
        expect([...outline()!.data.position]).toEqual([0, 0, 0, 10, 0, 0].map(Math.fround));
        expect([...labels]).toEqual(["Minimum distance: 10.00 mm"]);
        // deselecting clears everything
        shapes = [];
        doc.selection.onShapeChanged.emit(shapes);
        await Promise.resolve();
        expect(meshes.size).toBe(0);
        expect(labels.size).toBe(0);
    } finally {
        control.dispose();
        host.remove();
    }
});
