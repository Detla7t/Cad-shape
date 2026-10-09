// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type FaceMeshData, type INode, Result, type ShapeMeshData } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import {
    CamGenerator,
    CamStudioNode,
    CamStudioView,
    deviationColor,
    registerCamOperation,
    stockMeshToModel,
    type ToolpathMove,
} from "../src";

// A pass 1 deep along y = 10 that reaches the stock with a rapid (move 2 of the program).
registerCamOperation({
    type: "test.simRapid",
    label: "Rapid plunge (test)",
    category: "2d",
    machineKinds: ["mill"],
    defaults: () => ({ length: 30 }),
    parameters: () => [{ key: "length", label: "Length", kind: "length" }],
    generate(operation, context) {
        const length = Number(operation.params["length"]);
        const moves: ToolpathMove[] = [
            { kind: "rapid", to: [5, 10, 5] },
            { kind: "rapid", to: [5, 10, -1] },
            { kind: "linear", to: [5 + length, 10, -1], feed: 500 },
            { kind: "rapid", to: [5 + length, 10, 5] },
        ];
        return Result.ok({ toolId: context.tool.id, moves });
    },
});

function setup() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as unknown as typeof doc.visual;
    const displayMesh = rs.fn((_datas: ShapeMeshData[]) => 11);
    const removeMesh = rs.fn((_id: number) => {});
    const setVisible = rs.fn((_node: INode, _visible: boolean) => {});
    Object.assign(doc.visual.context, { displayMesh, removeMesh, setVisible });
    const studio = new CamStudioNode({ document: doc });
    doc.modelManager.addNode(studio);
    const generator = new CamGenerator(studio, { autoRegenerate: false });
    const view = new CamStudioView(studio, doc, { generator });
    document.body.append(view.element);
    view.activated();
    return { doc, studio, view, displayMesh, removeMesh };
}

function must<T extends Element>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector);
    expect(element).not.toBeNull();
    return element as T;
}

function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
    element.value = value;
    element.dispatchEvent(new Event("change"));
}

afterEach(() => {
    document.body.replaceChildren();
});

test("deviation colours: green on the part, red below it, blue for material left", () => {
    expect(deviationColor(0.005, 0.01)).toEqual(deviationColor(-0.01, 0.01));
    expect(deviationColor(-0.5, 0.01)[0]).toBeGreaterThan(0.8);
    const thin = deviationColor(0.05, 0.01);
    const thick = deviationColor(10, 0.01);
    expect(thick[2]).toBeGreaterThan(thick[0]);
    expect(thin[1]).toBeGreaterThan(thick[1]);
    expect(deviationColor(Number.NaN, 0.01)).not.toEqual(deviationColor(0, 0.01));
});

test("a stock mesh is moved out of the WCS with its normals", () => {
    const mesh = {
        positions: new Float32Array([1, 2, 3]),
        normals: new Float32Array([0, 0, 1]),
        indices: new Uint32Array([0, 0, 0]),
        deviation: new Float32Array([0]),
    };
    // WCS at (10, 0, 0) with its z along model -y and x along model x.
    const data = stockMeshToModel(mesh, { origin: [10, 0, 0], xAxis: [1, 0, 0], zAxis: [0, -1, 0] }, 0.01);
    expect([...data.position].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([11, -3, 2]);
    expect([...data.normal].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, -1, 0]);
    expect(data.color).toHaveLength(3);
    expect(data.uv).toHaveLength(2);
});

test("Simulate shows the stock, plays through the moves and lists warnings that select their operation", async () => {
    const { studio, view, displayMesh, removeMesh } = setup();
    must<HTMLElement>(view.element, '[data-action="add-setup"]').click();
    const [first] = studio.setups;
    studio.setSetups([{ ...first, stock: { kind: "sheet", width: 60, height: 40, thickness: 10 } }]);
    change(must<HTMLSelectElement>(view.element, 'select[data-action="add-operation"]'), "test.simRapid");
    const operation = studio.setups[0].operations[0];
    expect(view.simulation.element.hidden).toBe(true);

    await view.simulateSetup(studio.setups[0].id);
    const panel = view.simulation.element;
    expect(panel.hidden).toBe(false);
    const simulation = view.simulation.current;
    expect(simulation).not.toBeUndefined();
    expect(view.simulation.shownMove).toBe(simulation?.moveCount);
    // The stock is drawn as a surface mesh.
    const stock = displayMesh.mock.calls
        .map((call) => call[0][0])
        .find((data) => "index" in data) as FaceMeshData;
    expect(stock).not.toBeUndefined();
    expect(stock.index.length).toBeGreaterThan(0);

    const items = panel.querySelectorAll<HTMLElement>("[data-warning]");
    expect([...items].map((item) => item.dataset["kind"])).toEqual(["rapidInStock"]);
    expect(items[0].textContent).toContain(operation.name);
    view.select({ operationId: undefined, detail: "setup" });
    must<HTMLElement>(panel, "[data-warning]").click();
    expect(view.state.operationId).toBe(operation.id);
    expect(view.state.detail).toBe("operation");
    const warning = simulation?.warnings[0];
    expect(view.simulation.shownMove).toBe((warning?.firstMove ?? -2) + 1);
    expect(must<HTMLElement>(panel, "[data-warning]").dataset["selected"]).toBe("");

    // The slider steps through the moves.
    const slider = must<HTMLInputElement>(panel, '[data-field="simulation.move"]');
    change(slider, "1");
    expect(view.simulation.shownMove).toBe(1);
    must<HTMLElement>(panel, '[data-action="sim-next"]').click();
    expect(view.simulation.shownMove).toBe(2);
    expect(must<HTMLElement>(panel, '[class*="simReadout"]').textContent).toContain(`2`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(displayMesh.mock.calls.length).toBeGreaterThan(1);

    // Editing the operation leaves the simulation outdated until it is simulated again.
    expect(panel.querySelector("[data-sim-outdated]")).toBeNull();
    studio.setSetups([
        {
            ...studio.setups[0],
            operations: [{ ...operation, params: { length: 40 } }],
        },
    ]);
    await view.generator.generateSetup(studio.setups[0].id);
    expect(must<HTMLElement>(view.simulation.element, "[data-sim-outdated]").textContent).not.toBe("");

    removeMesh.mockClear();
    must<HTMLElement>(view.simulation.element, '[data-action="close-simulation"]').click();
    expect(view.simulation.element.hidden).toBe(true);
    expect(view.simulation.current).toBeUndefined();
    expect(removeMesh).toHaveBeenCalledWith(11);
    view.dispose();
});

test("a setup that cannot be simulated says why", async () => {
    const { studio, view } = setup();
    must<HTMLElement>(view.element, '[data-action="add-setup"]').click();
    await view.simulateSetup(studio.setups[0].id);
    expect(view.simulation.current).toBeUndefined();
    expect(must<HTMLElement>(view.simulation.element, '[class*="error"]').textContent).toContain(
        "no operations",
    );
    view.dispose();
});
