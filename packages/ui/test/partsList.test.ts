// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    EditableShapeNode,
    FolderNode,
    type INode,
    NodeSelectionHandler,
    Result,
    ShapeTypes,
    Transaction,
} from "@chili3d/core";
import { createMockDocument, MockShape, TestDocument } from "@chili3d/core/test-utils";
import { ParametricBodyNode } from "@chili3d/parametric";
import { isPartNode, PartsList } from "../src/project/partsList";

const menu = rs.fn((_node: INode, _x: number, _y: number) => {});
rs.mock("../src/project/nodeContextMenu", () => ({
    showNodeContextMenu: (...args: Parameters<typeof menu>) => menu(...args),
}));

beforeEach(() => {
    rs.stubGlobal("shapeFactory", { combine: () => Result.ok(new MockShape()) });
});
afterEach(() => {
    rs.unstubAllGlobals();
});

function setup() {
    let selected: INode[] = [];
    const selection = createMockDocument().selection;
    selection.getSelectedNodes = () => selected;
    selection.setSelectedNodes = (nodes, toggle) => {
        selected = toggle ? [...selected, ...nodes.filter((n) => !selected.includes(n))] : nodes;
        selection.onNodeChanged.emit(selected);
        return selected.length;
    };
    const doc = new TestDocument({ selection });
    doc.visual.eventHandler = new NodeSelectionHandler(doc, true);
    const list = new PartsList();
    document.body.append(list);
    list.setDocument(doc);
    const part = (name: string) =>
        new EditableShapeNode({ document: doc, name, shape: new MockShape({ shapeType: ShapeTypes.solid }) });
    return {
        doc,
        list,
        part,
        dispose: () => {
            list.dispose();
            list.remove();
            doc.dispose();
        },
    };
}

test("Parts contains hidden and nested solid results, excluding curves, surfaces and consumed tools", async () => {
    const { doc, list, part, dispose } = setup();
    const folder = new FolderNode({ document: doc, name: "Folder" });
    const hidden = part("Hidden part");
    hidden.visible = false;
    folder.add(hidden);
    const owner = new ParametricBodyNode({ document: doc, features: [] });
    owner.name = "Boolean result";
    const consumed = part("Consumed tool");
    owner.add(consumed);
    const wire = new EditableShapeNode({
        document: doc,
        name: "Sketch wire",
        shape: new MockShape({ shapeType: ShapeTypes.wire }),
    });
    const surface = new EditableShapeNode({
        document: doc,
        name: "Surface",
        shape: new MockShape({ shapeType: ShapeTypes.face }),
    });
    const count = rs.fn((_count: number) => {});
    list.onCountChanged = count;
    try {
        doc.modelManager.addNode(folder, owner, wire, surface);
        await Promise.resolve();
        expect([...list.querySelectorAll("[data-part-id]")].map((e) => e.getAttribute("aria-label"))).toEqual(
            ["Hidden part"],
        );
        expect(isPartNode(consumed)).toBe(false);
        expect(count).toHaveBeenLastCalledWith(1);
        const row = list.querySelector<HTMLElement>("[data-part-id]");
        expect(row).not.toBeNull();
        expect(row!.dataset["hidden"]).toBe("true");
    } finally {
        dispose();
    }
});

test("Parts tracks changed topology, deletion and undo without creating extra model nodes", async () => {
    const { doc, list, part, dispose } = setup();
    const solid = part("Part 1");
    try {
        Transaction.execute(doc, "Create solid", () => doc.modelManager.addNode(solid));
        await Promise.resolve();
        expect(list.querySelectorAll("[data-part-id]")).toHaveLength(1);
        expect(doc.modelManager.findNodes()).toEqual([solid]);
        Transaction.execute(doc, "Replace with face", () => {
            solid.shape = Result.ok(new MockShape({ shapeType: ShapeTypes.face }));
        });
        await Promise.resolve();
        expect(list.querySelectorAll("[data-part-id]")).toHaveLength(0);
        doc.history.undo();
        await Promise.resolve();
        expect(list.querySelectorAll("[data-part-id]")).toHaveLength(1);
        Transaction.execute(doc, "Delete part", () => solid.parent?.remove(solid));
        await Promise.resolve();
        expect(list.querySelectorAll("[data-part-id]")).toHaveLength(0);
        doc.history.undo();
        await Promise.resolve();
        expect(list.querySelectorAll("[data-part-id]")).toHaveLength(1);
    } finally {
        dispose();
    }
});

test("Parts selection, visibility and context actions address the original node", async () => {
    const { doc, list, part, dispose } = setup();
    const a = part("A"),
        b = part("B");
    try {
        doc.modelManager.addNode(a, b);
        await Promise.resolve();
        const rows = [...list.querySelectorAll<HTMLElement>("[data-part-id]")];
        expect(rows).toHaveLength(2);
        rows[0].click();
        expect(doc.selection.getSelectedNodes()).toEqual([a]);
        rows[1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
        expect(doc.selection.getSelectedNodes()).toEqual([a, b]);
        doc.selection.setSelectedNodes([b], false);
        expect(rows.map((row) => row.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
        rows[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 30 }));
        expect(menu).toHaveBeenLastCalledWith(b, 20, 30);
        const eyes = rows[1].querySelectorAll("svg");
        expect(eyes).toHaveLength(2);
        eyes[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(b.visible).toBe(false);
        doc.history.undo();
        expect(b.visible).toBe(true);
    } finally {
        dispose();
    }
});

test("switching documents detaches old observers and updates the part count", async () => {
    const { doc, list, part, dispose } = setup();
    const other = new TestDocument({ selection: createMockDocument().selection });
    try {
        doc.modelManager.addNode(part("Old part"));
        await Promise.resolve();
        list.setDocument(other);
        doc.modelManager.addNode(part("Another old part"));
        await Promise.resolve();
        expect(list.querySelectorAll("[data-part-id]")).toHaveLength(0);
        const next = new EditableShapeNode({
            document: other,
            name: "New part",
            shape: new MockShape({ shapeType: ShapeTypes.solid }),
        });
        other.modelManager.addNode(next);
        await Promise.resolve();
        expect(list.querySelector("[data-part-id]")?.getAttribute("aria-label")).toBe("New part");
    } finally {
        dispose();
        other.dispose();
    }
});
