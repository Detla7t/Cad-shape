// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    evaluateVariableLayers,
    evaluateVariables,
    FolderNode,
    LENGTH_UNITS,
    Transaction,
    UNITLESS,
    type VariableData,
    VariableStudioNode,
    type VariableTable,
} from "../src";
import { TestDocument } from "../test-utils";

function variable(id: string, name: string, expression: string, overrides: Partial<VariableData> = {}) {
    return { id, name, expression, type: "length" as const, ...overrides };
}

function tableWith(...items: VariableData[]): { document: TestDocument; table: VariableTable } {
    const document = new TestDocument();
    // Seeding is setup, not an edit — keep it out of the undo stack.
    document.history.disabled = true;
    document.variables.setItems(items);
    document.history.disabled = false;
    return { document, table: document.variables as VariableTable };
}

describe("evaluateVariables", () => {
    test("resolves in order, so a variable may reference the ones above it", () => {
        const { document } = tableWith(
            variable("v1", "w", "50"),
            variable("v2", "h", "w / 2"),
            variable("v3", "third", "h + w"),
        );
        const { scope, errors } = document.variables.evaluate();
        expect(errors.size).toBe(0);
        expect(scope.get("w")?.value).toBe(50);
        expect(scope.get("h")?.value).toBe(25);
        expect(scope.get("third")?.value).toBe(75);
    });

    test("a variable carries its DECLARED unit, not the expression's", () => {
        // `5` on its own is unitless; declaring it a length is what makes it usable
        // as one (and what makes `sin(...)` reject it).
        const { document } = tableWith(variable("v1", "w", "5"), variable("v2", "r", "w / w"));
        const { scope } = document.variables.evaluate();
        expect(scope.get("w")?.unit).toEqual(LENGTH_UNITS);
        expect(scope.get("r")?.unit).toEqual(LENGTH_UNITS);
    });

    test("reports a forward reference instead of resolving it", () => {
        const { document } = tableWith(variable("v1", "h", "w / 2"), variable("v2", "w", "50"));
        const { scope, errors } = document.variables.evaluate();
        expect(errors.get("v1")).toBe("Unknown identifier: w");
        expect(scope.has("h")).toBe(false);
        // The rest of the table still resolves — one bad row is not fatal.
        expect(scope.get("w")?.value).toBe(50);
    });

    test("rejects a name that is not an identifier", () => {
        const { document } = tableWith(variable("v1", "1bad", "10"));
        expect(document.variables.evaluate().errors.get("v1")).toBe("Invalid variable name: 1bad");
    });

    test("rejects shadowing a constant", () => {
        const { document } = tableWith(variable("v1", "pi", "3.2"));
        expect(document.variables.evaluate().errors.get("v1")).toBe("Variable name shadows a constant: pi");
    });

    test("rejects a duplicate name", () => {
        const { document } = tableWith(variable("v1", "w", "1"), variable("v2", "w", "2"));
        const { scope, errors } = document.variables.evaluate();
        expect(errors.get("v2")).toBe("Duplicate variable name: w");
        expect(scope.get("w")?.value).toBe(1);
    });

    // The name is claimed before the row resolves: fixing the first `w` must not silently
    // change which value the document means by `w`.
    test("a name repeated below a broken row is still a duplicate", () => {
        const { document } = tableWith(variable("v1", "w", "nope"), variable("v2", "w", "5"));
        const { scope, errors } = document.variables.evaluate();
        expect(errors.get("v1")).toBe("Unknown identifier: nope");
        expect(errors.get("v2")).toBe("Duplicate variable name: w");
        expect(scope.has("w")).toBe(false);
    });

    test("rejects an expression whose unit contradicts the declared one", () => {
        const { document } = tableWith(
            variable("v1", "a", "45", { type: "angle" }),
            variable("v2", "bad", "a", { type: "length" }),
        );
        const { errors } = document.variables.evaluate();
        expect(errors.get("v2")).toBe("Dimension mismatch: expected length, got angle");
    });

    test("accepts a unitless expression for any declared unit", () => {
        const { document } = tableWith(
            variable("v1", "w", "50"),
            variable("v2", "ratio", "w / w", { type: "unitless" }),
            variable("v3", "a", "w / w", { type: "angle" }),
        );
        const { scope, errors } = document.variables.evaluate();
        expect(errors.size).toBe(0);
        expect(scope.get("ratio")?.unit).toEqual(UNITLESS);
        expect(scope.get("a")?.unit).toEqual(ANGLE_UNITS);
        expect(scope.get("a")?.value).toBe(1);
    });
});

describe("a table that arrives malformed", () => {
    /**
     * The stored table is JSON — from a file, an undo record, or a hand edit. None of it is
     * typed, and a document must still open: a bad row reports on itself, and a bad table
     * reads as empty. Before, either one threw out of every reader.
     */
    function rawTable(json: string): VariableTable {
        const document = new TestDocument();
        document.history.disabled = true;
        document.variables.variablesJson = json;
        document.history.disabled = false;
        return document.variables as VariableTable;
    }

    const good = { id: "v0", name: "w", expression: "50", type: "length" };

    test("an unreadable table reads as empty", () => {
        const table = rawTable("{ not json");
        expect(table.items).toEqual([]);
        expect(table.evaluate().scope.size).toBe(0);
    });

    test("a stored value that is not a list reads as empty", () => {
        const table = rawTable(JSON.stringify({ w: 50 }));
        expect(table.items).toEqual([]);
        expect(table.evaluate().scope.size).toBe(0);
    });

    test.each<{ row: Record<string, unknown>; error: string }>([
        { row: { id: "v1", name: "a", type: "length" }, error: "Missing expression: a" },
        { row: { id: "v2", name: "b", expression: "10" }, error: "Unknown variable type: undefined" },
        {
            row: { id: "v3", name: "c", expression: "10", type: "Length" },
            error: "Unknown variable type: Length",
        },
        { row: { id: "v4", expression: "10", type: "length" }, error: "Invalid variable name: undefined" },
    ])("reports `$error` on its own row", ({ row, error }) => {
        const evaluated = rawTable(JSON.stringify([good, row])).evaluate();
        expect(evaluated.errors.get(String(row["id"]))).toBe(error);
        // The row above it is unaffected — the error stays on the row that has it.
        expect(evaluated.scope.get("w")?.value).toBe(50);
    });

    test("a row that is not an object is skipped, not fatal", () => {
        const evaluated = rawTable(JSON.stringify([null, good])).evaluate();
        expect(evaluated.errors.size).toBe(0);
        expect(evaluated.scope.get("w")?.value).toBe(50);
    });

    test("a parameter may be named after an Object.prototype member", () => {
        // `constructor` shadows nothing — only `pi` and `e` are reserved.
        const table = rawTable(JSON.stringify([{ ...good, name: "constructor" }]));
        expect(table.evaluate().errors.size).toBe(0);
        expect(table.evaluate().scope.get("constructor")?.value).toBe(50);
    });
});

describe("VariableTable", () => {
    test("starts empty", () => {
        const document = new TestDocument();
        expect(document.variables.items).toEqual([]);
        expect(document.variables.evaluate().scope.size).toBe(0);
    });

    test("round-trips through variablesJson, description included", () => {
        const items = [variable("v1", "w", "50", { description: "总宽" })];
        const { document, table } = tableWith(...items);
        expect(JSON.parse(table.variablesJson)).toEqual(items);
        table.variablesJson = JSON.stringify([...items, variable("v2", "h", "10")]);
        expect(document.variables.items).toHaveLength(2);
    });

    test("bumps the revision on every effective write", () => {
        const { table } = tableWith();
        const initial = table.revision;
        table.setItems([variable("v1", "w", "1")]);
        expect(table.revision).toBe(initial + 1);
        table.setItems([variable("v1", "w", "2")]);
        expect(table.revision).toBe(initial + 2);
        // A write that does not change the value is not an effective write.
        table.setItems([variable("v1", "w", "2")]);
        expect(table.revision).toBe(initial + 2);
    });

    test("notifies once per write", () => {
        const { table } = tableWith();
        let notified = 0;
        table.onPropertyChanged((property) => {
            if (property === "variablesJson") notified++;
        });
        table.setItems([variable("v1", "w", "1")]);
        expect(notified).toBe(1);
    });

    test("records one undo step per write, and undo restores the previous table", async () => {
        const { document, table } = tableWith(variable("v1", "w", "1"));
        Transaction.execute(document, "edit variables", () => {
            table.setItems([variable("v1", "w", "1"), variable("v2", "h", "2")]);
        });
        expect(table.items).toHaveLength(2);
        expect(document.history.undoCount()).toBe(1);

        await document.history.undo();
        expect(table.items).toHaveLength(1);
        expect(document.variables.evaluate().scope.get("w")?.value).toBe(1);

        await document.history.redo();
        expect(table.items).toHaveLength(2);
        expect(document.variables.evaluate().scope.get("h")?.value).toBe(2);
    });

    test("undo bumps the revision too, so consumers re-sync", async () => {
        const { document, table } = tableWith(variable("v1", "w", "1"));
        const before = table.revision;
        Transaction.execute(document, "edit variables", () => {
            table.setItems([variable("v1", "w", "2")]);
        });
        await document.history.undo();
        expect(table.revision).toBeGreaterThan(before + 1);
    });

    test("stops notifying once the handler is removed", () => {
        const { table } = tableWith();
        let notified = 0;
        const handler = (property: string) => {
            if (property === "variablesJson") notified++;
        };
        table.onPropertyChanged(handler);
        table.setItems([variable("v1", "w", "1")]);
        expect(notified).toBe(1);
        table.removePropertyChanged(handler);
        table.setItems([variable("v1", "w", "2")]);
        expect(notified).toBe(1);
    });
});

describe("evaluateVariables over a base scope", () => {
    const base = new Map([["w", { value: 10, unit: LENGTH_UNITS }]]);

    test("sees the base, and a redefinition shadows it with a warning", () => {
        const evaluated = evaluateVariables([variable("v1", "h", "w * 2"), variable("v2", "w", "3")], base);
        expect(evaluated.errors.size).toBe(0);
        expect(evaluated.values.get("v1")?.value).toBe(20);
        expect(evaluated.scope.get("w")?.value).toBe(3);
        expect(evaluated.warnings.get("v2")).toBe("Shadows w from a lower layer");
    });

    test("checks duplicates within the list only", () => {
        const evaluated = evaluateVariables([variable("v1", "w", "1"), variable("v2", "w", "2")], base);
        expect(evaluated.errors.get("v2")).toBe("Duplicate variable name: w");
        expect(evaluated.scope.get("w")?.value).toBe(1);
    });
});

describe("evaluateVariableLayers", () => {
    test("lower layers first; each sees the ones below and a redefinition names its origin", () => {
        const evaluated = evaluateVariableLayers([
            { name: "Studio A", items: [variable("a1", "w", "10")] },
            { name: "Studio B", items: [variable("b1", "w", "w + 1"), variable("b2", "h", "w")] },
            { name: "Table", items: [variable("t1", "d", "h * 2")] },
        ]);
        expect(evaluated.errors.size).toBe(0);
        // Studio B's `w` resolves against Studio A's, then shadows it from there on.
        expect(evaluated.values.get("a1")?.value).toBe(10);
        expect(evaluated.values.get("b1")?.value).toBe(11);
        expect(evaluated.warnings.get("b1")).toBe("Shadows w from Studio A");
        expect(evaluated.scope.get("w")?.value).toBe(11);
        expect(evaluated.scope.get("d")?.value).toBe(22);
    });

    test("a lower layer cannot see a higher one", () => {
        const evaluated = evaluateVariableLayers([
            { name: "Studio A", items: [variable("a1", "h", "w")] },
            { name: "Table", items: [variable("t1", "w", "5")] },
        ]);
        expect(evaluated.errors.get("a1")).toBe("Unknown identifier: w");
    });
});

describe("the document scope with Variable Studios", () => {
    function studio(document: TestDocument, name: string, ...items: VariableData[]): VariableStudioNode {
        const node = new VariableStudioNode({ document, name, items });
        Transaction.execute(document, "add studio", () => document.modelManager.addNode(node));
        return node;
    }

    test("a studio's variables are in the document scope", () => {
        const { document } = tableWith();
        studio(document, "Variable Studio 1", variable("s1", "w", "40"));
        expect(document.variables.evaluate().scope.get("w")?.value).toBe(40);
        expect(document.variables.scope.get("w")?.unit).toEqual(LENGTH_UNITS);
    });

    test("the table sees every studio and shadows a studio name, with a warning on the table row", () => {
        const { document } = tableWith(variable("t1", "w", "5"), variable("t2", "area", "w * depth"));
        studio(
            document,
            "Variable Studio 1",
            variable("s1", "w", "40"),
            variable("s2", "depth", "3", { type: "unitless" }),
        );
        const evaluated = document.variables.evaluate();
        expect(evaluated.scope.get("w")?.value).toBe(5);
        expect(evaluated.scope.get("area")?.value).toBe(15);
        expect(evaluated.warnings.get("t1")).toBe("Shadows w from Variable Studio 1");
        // The shadowed studio row still reports the value it resolved to.
        expect(evaluated.values.get("s1")?.value).toBe(40);
        expect(evaluated.errors.size).toBe(0);
    });

    test("studios stack in model-tree order, and moving one changes who wins", () => {
        const { document } = tableWith();
        studio(document, "Variable Studio 1", variable("a", "w", "1"));
        const second = studio(document, "Variable Studio 2", variable("b", "w", "2"));
        expect(document.variables.evaluate().scope.get("w")?.value).toBe(2);
        expect(document.variables.evaluate().warnings.get("b")).toBe("Shadows w from Variable Studio 1");

        Transaction.execute(document, "reorder", () => {
            document.modelManager.rootNode.move(second, document.modelManager.rootNode, undefined);
        });
        expect(document.modelManager.rootNode.firstChild).toBe(second);
        expect(document.variables.evaluate().scope.get("w")?.value).toBe(1);
        expect(document.variables.evaluate().warnings.get("a")).toBe("Shadows w from Variable Studio 2");
    });

    test("a repeated name inside one studio is an error on the later row", () => {
        const { document } = tableWith();
        studio(document, "Variable Studio 1", variable("a", "w", "1"), variable("b", "w", "2"));
        expect(document.variables.evaluate().errors.get("b")).toBe("Duplicate variable name: w");
    });

    test("a studio edit re-scopes once, revision first, and undo restores it", async () => {
        const { document } = tableWith();
        const node = studio(document, "Variable Studio 1", variable("s1", "w", "1"));
        const seen: number[] = [];
        document.variables.onPropertyChanged((property) => {
            if (property === "scope") seen.push(document.variables.revision);
        });
        const before = document.variables.revision;

        Transaction.execute(document, "edit studio", () => node.setItems([variable("s1", "w", "2")]));
        expect(seen).toEqual([before + 1]);
        expect(document.variables.evaluate().scope.get("w")?.value).toBe(2);

        await document.history.undo();
        expect(node.items[0].expression).toBe("1");
        expect(document.variables.evaluate().scope.get("w")?.value).toBe(1);
        expect(seen).toEqual([before + 1, before + 2]);
    });

    test("adding and removing a studio re-scope — undo of its creation included", async () => {
        const { document } = tableWith();
        let scopes = 0;
        document.variables.onPropertyChanged((property) => {
            if (property === "scope") scopes++;
        });
        studio(document, "Variable Studio 1", variable("s1", "w", "7"));
        expect(scopes).toBe(1);
        expect(document.variables.evaluate().scope.has("w")).toBe(true);

        await document.history.undo();
        expect(scopes).toBe(2);
        expect(document.variables.evaluate().scope.has("w")).toBe(false);

        await document.history.redo();
        expect(scopes).toBe(3);
        expect(document.variables.evaluate().scope.get("w")?.value).toBe(7);
    });

    test("a node that is not a studio leaves the scope alone", () => {
        const { document } = tableWith(variable("t1", "w", "1"));
        let scopes = 0;
        document.variables.onPropertyChanged((property) => {
            if (property === "scope") scopes++;
        });
        const revision = document.variables.revision;
        Transaction.execute(document, "folder", () =>
            document.modelManager.addNode(new FolderNode({ document, name: "group" })),
        );
        expect(scopes).toBe(0);
        expect(document.variables.revision).toBe(revision);
    });

    test("a table write notifies the rows, then the scope, with the revision already bumped", () => {
        const { table } = tableWith();
        const seen: string[] = [];
        table.onPropertyChanged((property) => seen.push(`${String(property)}@${table.revision}`));
        const before = table.revision;
        table.setItems([variable("v1", "w", "1")]);
        expect(seen).toEqual([`variablesJson@${before + 1}`, `scope@${before + 1}`]);
    });

    test("evaluate is memoized per revision", () => {
        const { document, table } = tableWith(variable("v1", "w", "1"));
        const first = table.evaluate();
        expect(table.evaluate()).toBe(first);
        studio(document, "Variable Studio 1", variable("s1", "h", "2"));
        expect(table.evaluate()).not.toBe(first);
        expect(table.evaluate().scope.get("h")?.value).toBe(2);
    });
});
