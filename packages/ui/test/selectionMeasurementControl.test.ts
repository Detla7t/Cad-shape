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
} from "@chili3d/core";
import { createMockApplication, createMockDocument, createMockView } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { SelectionMeasurementControl } from "../src/review/selectionMeasurementControl";

test("the readout refines a measurement, creates that definition and clears its guide with selection", async () => {
    let selected: INode[] = [];
    const doc = createMockDocument({
        application: createMockApplication(),
        selection: { getSelectedNodes: () => selected },
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
        doc.selection.onNodeChanged.emit(selected);
        await Promise.resolve();
        expect(control.element.textContent).toContain("Diameter: 50.80 mm");
        const originalLine = outline();
        expect(originalLine).toBeDefined();
        expect(originalLine!.option?.onTop).toBe(true);
        expect([...originalLine!.data.position]).toEqual([-25.4, 0, 0, 25.4, 0, 0].map(Math.fround));
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
