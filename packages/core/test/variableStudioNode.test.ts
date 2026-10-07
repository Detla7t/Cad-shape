// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    isNodeSceneless,
    isVariableStudioNode,
    NodeUtils,
    Serializer,
    Transaction,
    type VariableData,
    VariableStudioNode,
} from "../src";
import { TestDocument } from "../test-utils";

function variable(id: string, name: string, expression: string): VariableData {
    return { id, name, expression, type: "length" };
}

const ROWS = [
    variable("v1", "width", "120"),
    { ...variable("v2", "half", "width / 2"), description: "半宽" },
];

describe("VariableStudioNode", () => {
    test("is a sceneless, tagged node", () => {
        const studio = new VariableStudioNode({ document: new TestDocument(), name: "Variable Studio 1" });
        expect(isVariableStudioNode(studio)).toBe(true);
        expect(isNodeSceneless(studio)).toBe(true);
        expect(studio.icon).toBe("icon-tag");
        expect(studio.items).toEqual([]);
    });

    test("serializes and deserializes with its id, name and rows", () => {
        const document = new TestDocument();
        const studio = new VariableStudioNode({ document, name: "Sizes", items: ROWS });

        const data = Serializer.serializeObject(studio);
        expect(data["__cla$$__"]).toBe("VariableStudioNode");
        const loaded = Serializer.deserializeObject(new TestDocument(), data) as VariableStudioNode;

        expect(loaded).toBeInstanceOf(VariableStudioNode);
        expect(loaded.id).toBe(studio.id);
        expect(loaded.name).toBe("Sizes");
        expect(loaded.items).toEqual(ROWS);
    });

    test("a document loaded with a studio resolves its variables", async () => {
        const source = new TestDocument();
        Transaction.execute(source, "add", () =>
            source.modelManager.addNode(
                new VariableStudioNode({ document: source, name: "Sizes", items: ROWS }),
            ),
        );
        const saved = source.modelManager.serialize();

        const target = new TestDocument();
        target.history.disabled = true;
        await target.modelManager.deserialize(JSON.parse(JSON.stringify(saved)));
        target.history.disabled = false;

        const [loaded] = target.modelManager.findNodes(isVariableStudioNode);
        expect(loaded).toBeInstanceOf(VariableStudioNode);
        expect(target.variables.evaluate().scope.get("half")?.value).toBe(60);
        expect(NodeUtils.serializeNode(target.modelManager.rootNode)).toEqual(saved.nodes);
    });

    test("an edit is one undo step", async () => {
        const document = new TestDocument();
        const studio = new VariableStudioNode({ document, items: ROWS });
        Transaction.execute(document, "add", () => document.modelManager.addNode(studio));

        Transaction.execute(document, "edit", () => studio.setItems([variable("v1", "width", "80")]));
        expect(studio.items).toHaveLength(1);

        await document.history.undo();
        expect(studio.items).toEqual(ROWS);
    });

    test("an unreadable stored list reads as empty", () => {
        const studio = new VariableStudioNode({ document: new TestDocument(), variablesJson: "{ nope" });
        expect(studio.items).toEqual([]);
    });

    test("a clone gets fresh row ids — rows of every layer report by id", () => {
        const document = new TestDocument();
        const studio = new VariableStudioNode({ document, name: "Sizes", items: ROWS });
        const copy = studio.clone();
        expect(copy.id).not.toBe(studio.id);
        expect(copy.items.map((item) => item.name)).toEqual(["width", "half"]);
        expect(copy.items.map((item) => item.expression)).toEqual(["120", "width / 2"]);
        for (const item of copy.items) expect(["v1", "v2"]).not.toContain(item.id);
    });
});
