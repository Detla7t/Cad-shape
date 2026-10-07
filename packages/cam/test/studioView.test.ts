// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentElements, type EdgeMeshData, Result, type ShapeMeshData } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import {
    CAM_STUDIO_KIND,
    CamGenerator,
    CamStudioNode,
    CamStudioView,
    machineProfile,
    registerCamOperation,
    registerMachineProfile,
    type ToolpathMove,
} from "../src";

registerCamOperation({
    type: "test.square",
    label: "Square (test)",
    category: "2d",
    machineKinds: ["mill"],
    defaults: () => ({ size: 20, depth: 1 }),
    parameters: () => [
        { key: "size", label: "Size", kind: "length", min: 1 },
        { key: "depth", label: "Depth", kind: "length" },
    ],
    generate(operation, context) {
        const size = Number(operation.params["size"]);
        const depth = Number(operation.params["depth"]);
        const moves: ToolpathMove[] = [
            { kind: "rapid", to: [0, 0, 5] },
            { kind: "linear", to: [0, 0, -depth], feed: 200 },
            { kind: "linear", to: [size, 0, -depth], feed: context.tool.cutting.feed },
            { kind: "linear", to: [size, size, -depth], feed: context.tool.cutting.feed },
            { kind: "rapid", to: [size, size, 5] },
        ];
        return Result.ok({ toolId: context.tool.id, moves });
    },
});

function setup() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    const displayMesh = rs.fn((_datas: ShapeMeshData[]) => 7);
    doc.visual.context.displayMesh = displayMesh;
    const studio = new CamStudioNode({ document: doc });
    doc.modelManager.addNode(studio);
    const download = rs.fn((_text: string, _fileName: string) => {});
    const generator = new CamGenerator(studio, { autoRegenerate: false });
    const view = new CamStudioView(studio, doc, { download, generator });
    document.body.append(view.element);
    return { doc, studio, view, download, displayMesh, generator };
}

function must<T extends Element>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector);
    expect(element).not.toBeNull();
    return element!;
}

const click = (root: ParentNode, selector: string) => must<HTMLElement>(root, selector).click();

function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
    element.value = value;
    element.dispatchEvent(new Event("change"));
}

async function until(condition: () => boolean) {
    for (let i = 0; i < 50 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(condition()).toBe(true);
}

afterEach(() => {
    document.body.replaceChildren();
});

test("the CAM Studio is a document element shown beside the viewport", () => {
    const kind = DocumentElements.kinds.find((x) => x.kind === CAM_STUDIO_KIND);
    expect(kind?.besideViewport).toBe(true);
    expect(kind?.newCommand).toBe("cam.newStudio");
    const { doc, studio } = setup();
    const view = DocumentElements.createView(studio, doc);
    expect(view).toBeInstanceOf(CamStudioView);
    view?.dispose();
});

test("adds a setup and an operation, edits a parameter, undoes and redoes", () => {
    const { doc, studio, view } = setup();
    click(view.element, '[data-action="add-setup"]');
    expect(studio.setups).toHaveLength(1);
    expect(studio.setups[0].machineId).toBe("generic-3-axis");
    expect(must(view.element, '[data-setup] [class*="itemName"]').textContent).toBe("Setup 1");

    const add = must<HTMLSelectElement>(view.element, 'select[data-action="add-operation"]');
    expect([...add.querySelectorAll("option")].map((x) => x.value)).toContain("test.square");
    change(add, "test.square");
    const [operation] = studio.setups[0].operations;
    expect(operation.name).toBe("Square (test) 1");
    expect(operation.params).toEqual({ size: 20, depth: 1 });
    expect(operation.toolId).toBe("t1");
    expect(must(view.element, "[data-operation]").textContent).toContain("Square (test) 1");

    change(must<HTMLInputElement>(view.element, '[data-field="param.size"]'), "30");
    expect(studio.setups[0].operations[0].params["size"]).toBe(30);

    doc.history.undo();
    expect(studio.setups[0].operations[0].params["size"]).toBe(20);
    expect(must<HTMLInputElement>(view.element, '[data-field="param.size"]').value).toBe("20");
    doc.history.undo();
    expect(studio.setups[0].operations).toHaveLength(0);
    expect(view.element.querySelector("[data-operation]")).toBeNull();
    doc.history.redo();
    doc.history.redo();
    expect(studio.setups[0].operations[0].params["size"]).toBe(30);
});

test("posts a program: generates what is missing, downloads it, previews the toolpath", async () => {
    const { studio, view, download, displayMesh } = setup();
    view.activated();
    click(view.element, '[data-action="add-setup"]');
    change(must<HTMLSelectElement>(view.element, 'select[data-action="add-operation"]'), "test.square");
    click(view.element, '[data-action="tab-post"]');
    expect(must<HTMLSelectElement>(view.element, '[data-field="post.id"]').value).toBe("fanuc");
    click(view.element, '[data-action="post"]');
    await until(() => download.mock.calls.length === 1);

    const [text, fileName] = download.mock.calls[0];
    expect(fileName).toBe("Setup 1.nc");
    expect(text).toContain(
        [
            "(SQUARE TEST 1)",
            "T1 M6",
            "S8000 M3",
            "G54",
            "M8",
            "G0 X0. Y0.",
            "G43 Z5. H1",
            "G1 Z-1. F200.",
            "X20. F1200.",
            "Y20.",
            "G0 Z5.",
        ].join("\n"),
    );
    expect(must(view.element, "pre").textContent).toContain("O1001 (SETUP 1)");
    const operationId = studio.setups[0].operations[0].id;
    expect(view.generator.status(operationId).state).toBe("ok");
    expect(
        must(view.element, `[data-operation="${operationId}"] [data-state]`).getAttribute("data-state"),
    ).toBe("ok");

    // The preview draws the toolpath: dashed rapids, plunges, cuts.
    expect(displayMesh.mock.calls.length).toBeGreaterThan(0);
    const meshes = displayMesh.mock.calls.at(-1)![0] as EdgeMeshData[];
    expect(meshes.map((mesh) => mesh.lineType)).toEqual(["dash", "solid", "solid"]);
    expect(meshes[1].position.length).toBe(2 * 6);

    // Hiding the operation clears it from the preview.
    const removeMesh = rs.fn((_id: number) => {});
    view.document.visual.context.removeMesh = removeMesh;
    click(view.element, `[data-operation="${operationId}"] [data-action="toggle-visibility"]`);
    expect(removeMesh).toHaveBeenCalledWith(7);
    view.dispose();
});

test("the preview shows while the studio's tab is active, or when kept in the Part Studio", async () => {
    const { view, displayMesh } = setup();
    const removeMesh = rs.fn((_id: number) => {});
    view.document.visual.context.removeMesh = removeMesh;
    click(view.element, '[data-action="add-setup"]');
    change(must<HTMLSelectElement>(view.element, 'select[data-action="add-operation"]'), "test.square");
    await view.generator.generateAll();
    expect(displayMesh).not.toHaveBeenCalled();
    view.activated();
    expect(displayMesh).toHaveBeenCalledTimes(1);
    view.deactivated();
    expect(removeMesh).toHaveBeenCalledTimes(1);
    const pin = must<HTMLInputElement>(view.element, '[data-field="pinned"]');
    pin.checked = true;
    pin.dispatchEvent(new Event("change"));
    expect(displayMesh).toHaveBeenCalledTimes(2);
    view.dispose();
    expect(removeMesh).toHaveBeenCalledTimes(2);
});

test("a machine whose post is not loaded says so instead of posting with another", () => {
    const base = machineProfile("generic-3-axis");
    if (base === undefined) throw new Error("the generic 3-axis profile is missing");
    registerMachineProfile({
        ...base,
        id: "test-missing-post",
        name: "Test machine with a missing post",
        post: { id: "not-installed-post" },
    });
    const { studio, view } = setup();
    click(view.element, '[data-action="add-setup"]');
    change(must<HTMLSelectElement>(view.element, '[data-field="setup.machine"]'), "test-missing-post");
    expect(studio.setups[0].machineId).toBe("test-missing-post");
    click(view.element, '[data-action="tab-post"]');
    const select = must<HTMLSelectElement>(view.element, '[data-field="post.id"]');
    expect(select.value).toBe("not-installed-post");
    expect(select.selectedOptions[0].textContent).toContain("not-installed-post");
    expect(view.element.querySelector('[data-action="post"]')).toBeNull();
    change(select, "fanuc");
    expect(studio.setups[0].postId).toBe("fanuc");
    expect(view.element.querySelector('[data-action="post"]')).not.toBeNull();
});

test("a 5-axis machine posts with its 5-axis post", () => {
    const { view } = setup();
    click(view.element, '[data-action="add-setup"]');
    change(must<HTMLSelectElement>(view.element, '[data-field="setup.machine"]'), "haas-umc500");
    click(view.element, '[data-action="tab-post"]');
    expect(must<HTMLSelectElement>(view.element, '[data-field="post.id"]').value).toBe("haas-umc-5axis");
    expect(view.element.querySelector('[data-action="post"]')).not.toBeNull();
});

test("changing the machine moves its operations to the new machine's defaults and keeps the user's values", () => {
    const { doc, studio, view } = setup();
    click(view.element, '[data-action="add-setup"]');
    const machineSelect = () => must<HTMLSelectElement>(view.element, '[data-field="setup.machine"]');
    change(machineSelect(), "generic-plasma");
    change(must<HTMLSelectElement>(view.element, 'select[data-action="add-operation"]'), "profileCut");
    const plasma = studio.setups[0].operations[0];
    expect([
        plasma.toolId,
        plasma.params["kerf"],
        plasma.params["feed"],
        plasma.params["pierceDelay"],
    ]).toEqual(["torch", 1.5, 3000, 0.5]);
    change(must<HTMLInputElement>(view.element, '[data-field="param.leadIn"]'), "7");

    click(view.element, '[data-action="tab-setup"]');
    change(machineSelect(), "generic-waterjet");
    const moved = studio.setups[0].operations[0];
    expect(moved.id).toBe(plasma.id);
    expect(moved.toolId).toBe("jet");
    expect(moved.params["kerf"]).toBe(0.8);
    expect(moved.params["feed"]).toBe(400);
    expect(moved.params["pierceDelay"]).toBe(1.5);
    expect(moved.params["marks"]).toBe("skip");
    expect(moved.params["leadIn"]).toBe(7);

    // One undo step brings back the plasma machine with the operation as it was.
    doc.history.undo();
    expect(studio.setups[0].machineId).toBe("generic-plasma");
    expect(studio.setups[0].operations[0].params["kerf"]).toBe(1.5);
    expect(studio.setups[0].operations[0].toolId).toBe("torch");
});

test("suppressing, reordering and deleting operations are undoable edits", () => {
    const { doc, studio, view } = setup();
    click(view.element, '[data-action="add-setup"]');
    change(must<HTMLSelectElement>(view.element, 'select[data-action="add-operation"]'), "test.square");
    change(must<HTMLSelectElement>(view.element, 'select[data-action="add-operation"]'), "test.square");
    const [first, second] = studio.setups[0].operations;
    click(view.element, `[data-operation="${second.id}"] [data-action="move-up"]`);
    expect(studio.setups[0].operations.map((x) => x.id)).toEqual([second.id, first.id]);
    click(view.element, `[data-operation="${first.id}"] [data-action="suppress-operation"]`);
    expect(studio.setups[0].operations[1].suppressed).toBe(true);
    click(view.element, `[data-operation="${second.id}"] [data-action="delete-operation"]`);
    expect(studio.setups[0].operations.map((x) => x.id)).toEqual([first.id]);
    doc.history.undo();
    doc.history.undo();
    doc.history.undo();
    expect(studio.setups[0].operations.map((x) => [x.id, x.suppressed ?? false])).toEqual([
        [first.id, false],
        [second.id, false],
    ]);
});

test("the tool library adds a setup tool and overrides a machine tool for the setup only", () => {
    const { studio, view } = setup();
    click(view.element, '[data-action="add-setup"]');
    click(view.element, '[data-action="tab-tools"]');
    expect(view.element.querySelectorAll("tbody tr")).toHaveLength(6);
    change(must<HTMLInputElement>(view.element, '[data-field="tool.diameter"]'), "9.5");
    expect(studio.setups[0].tools).toEqual([expect.objectContaining({ id: "t1", diameter: 9.5 })]);
    click(view.element, '[data-action="add-tool"]');
    expect(studio.setups[0].tools?.map((tool) => tool.id)).toEqual(["t1", "t7"]);
    expect(view.element.querySelectorAll("tbody tr")).toHaveLength(7);
});
