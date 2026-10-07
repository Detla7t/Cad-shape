// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assignActiveArm,
    type ConfigurationInputData,
    documentConfiguration,
    evaluateDocumentScope,
    formatConfiguredValue,
    isConfiguredValue,
    LENGTH_UNITS,
    parseConfiguredValue,
    resolveUnitSpec,
    restoreConfiguration,
    type Scope,
    selectConfiguredArm,
    selectConfiguredBoolean,
    Transaction,
    UNITLESS,
    type VariableData,
    VariableStudioNode,
    type VariableTable,
} from "../src";
import { TestDocument } from "../test-utils";

const SIZE: ConfigurationInputData = {
    kind: "list",
    id: "c-size",
    name: "Size",
    options: [
        { id: "o-s", name: "S" },
        { id: "o-m", name: "M" },
        { id: "o-l", name: "L" },
    ],
    defaultOption: "o-m",
};
const HOLES: ConfigurationInputData = { kind: "checkbox", id: "c-holes", name: "Holes", defaultValue: true };
const LENGTH: ConfigurationInputData = {
    kind: "variable",
    id: "c-length",
    name: "Length",
    type: "length",
    defaultExpression: "120",
    min: 10,
    max: 500,
};

function variable(id: string, name: string, expression: string): VariableData {
    return { id, name, expression, type: "length" };
}

/** The scope of a configuration (plus an optional table layer) in the given active state. */
function scopeOf(
    active: Record<string, string | boolean> = {},
    items: VariableData[] = [],
    inputs: ConfigurationInputData[] = [SIZE, HOLES, LENGTH],
): Scope {
    return evaluateDocumentScope({ inputs, active }, [{ name: "table", items }]).scope;
}

function documentWith(inputs: ConfigurationInputData[], items: VariableData[] = []) {
    const document = new TestDocument();
    // Seeding is setup, not an edit — keep it out of the undo stack.
    document.history.disabled = true;
    document.variables.setConfigurationInputs(inputs);
    document.variables.setItems(items);
    document.history.disabled = false;
    return { document, table: document.variables as VariableTable };
}

describe("configured values", () => {
    test("parses a list arm set, expressions and all", () => {
        const parsed = parseConfiguredValue('configure(Size, "S": 10, "M": 20, "L": w * 2)');
        expect(parsed.isOk).toBe(true);
        expect(parsed.value).toEqual({
            input: "Size",
            arms: [
                { option: "S", value: "10" },
                { option: "M", value: "20" },
                { option: "L", value: "w * 2" },
            ],
        });
    });

    test("parses checkbox states written bare, and the Onshape #name spelling", () => {
        expect(parseConfiguredValue("configure(#Holes, true: 5, false: 0)").value).toEqual({
            input: "Holes",
            arms: [
                { option: "true", value: "5" },
                { option: "false", value: "0" },
            ],
        });
    });

    test("an arm value may hold commas and parentheses inside calls and strings", () => {
        const parsed = parseConfiguredValue('configure(Size, "S": max(1, 2), "L": "a, (b)")');
        expect(parsed.value?.arms).toEqual([
            { option: "S", value: "max(1, 2)" },
            { option: "L", value: '"a, (b)"' },
        ]);
    });

    test.each([
        ["configure Size", "Expected ( after configure"],
        ['configure(Size, "S": 1', "Missing ) in configure()"],
        ['configure(Size, "S": 1, "S": 2)', 'Duplicate option in configure(): "S"'],
        ['configure(Size, "S": )', 'Missing value for "S"'],
        ['configure(Size, "S": 1) + 2', "Unexpected text after configure(): + 2"],
        ["configure(1, true: 1)", "configure() expects a configuration input name first"],
    ])("reports %j", (text, error) => {
        const parsed = parseConfiguredValue(text);
        expect(parsed.isOk).toBe(false);
        expect(parsed.error).toBe(error);
    });

    test("formats back to the same text, quoting list options and leaving checkbox states bare", () => {
        const text = 'configure(Size, "S": 10, "M": 20, "L": w * 2)';
        expect(formatConfiguredValue(parseConfiguredValue(text).value!)).toBe(text);
        expect(
            formatConfiguredValue({
                input: "Holes",
                arms: [
                    { option: "true", value: "5" },
                    { option: 'say "hi"', value: "1" },
                ],
            }),
        ).toBe('configure(Holes, true: 5, "say \\"hi\\"": 1)');
    });

    test("only a value that starts with configure( is configured", () => {
        expect(isConfiguredValue('  configure(Size, "S": 1)')).toBe(true);
        expect(isConfiguredValue("configured + 1")).toBe(false);
        expect(isConfiguredValue(10)).toBe(false);
    });

    test("selects the arm of the active option — numbers as numbers, strings unquoted", () => {
        const value = 'configure(Size, "S": 10, "M": w * 2, "L": "THROUGH")';
        expect(selectConfiguredArm(value, scopeOf({ Size: "S" })).value).toBe(10);
        expect(selectConfiguredArm(value, scopeOf({ Size: "M" })).value).toBe("w * 2");
        expect(selectConfiguredArm(value, scopeOf({ Size: "L" })).value).toBe("THROUGH");
        // Not configured: handed back untouched.
        expect(selectConfiguredArm("w * 2", scopeOf()).value).toBe("w * 2");
    });

    test("follows nested configured values down to a plain value", () => {
        const value = 'configure(Size, "S": configure(Holes, true: 1, false: 2), "M": 3, "L": 4)';
        expect(selectConfiguredArm(value, scopeOf({ Size: "S", Holes: false })).value).toBe(2);
    });

    test.each([
        ['configure(Width, "S": 1)', "Unknown configuration input: Width"],
        ['configure(Size, "S": 1, "M": 2)', 'No value for Size = "L"'],
        ["configure(Holes, false: 0)", "No value for Holes = true"],
        ["configure(Length, true: 1)", "Length is not a list or checkbox configuration input"],
    ])("reports %j", (value, error) => {
        const selected = selectConfiguredArm(value, scopeOf({ Size: "L", Holes: true }));
        expect(selected.isOk).toBe(false);
        expect(selected.error).toBe(error);
    });

    test("resolveUnitSpec selects first and evaluates only the selected arm", () => {
        // `missing` is unknown, but its arm is never the active one.
        const value = 'configure(Size, "S": missing * 2, "M": w + 5, "L": 1)';
        const scope = scopeOf({ Size: "M" }, [variable("v1", "w", "40")]);
        const resolved = resolveUnitSpec(value, scope, LENGTH_UNITS);
        expect(resolved.isOk).toBe(true);
        expect(resolved.value).toBe(45);
        expect(resolveUnitSpec(value, scopeOf({ Size: "S" }), LENGTH_UNITS).error).toBe(
            "Unknown identifier: missing",
        );
    });

    test("selects booleans for suppression and checkbox slots", () => {
        const value = "configure(Holes, true: false, false: true)";
        expect(selectConfiguredBoolean(value, scopeOf({ Holes: true })).value).toBe(false);
        expect(selectConfiguredBoolean(value, scopeOf({ Holes: false })).value).toBe(true);
        expect(selectConfiguredBoolean(true, scopeOf()).value).toBe(true);
        expect(selectConfiguredBoolean(undefined, scopeOf()).value).toBe(false);
        expect(selectConfiguredBoolean('configure(Size, "S": 2, "M": 2, "L": 2)', scopeOf()).isOk).toBe(
            false,
        );
    });

    test("assignActiveArm edits the arm of the configuration on screen only", () => {
        const value = 'configure(Size, "S": 10, "M": 20)';
        expect(assignActiveArm(value, scopeOf({ Size: "S" }), "15").value).toBe(
            'configure(Size, "S": 15, "M": 20)',
        );
        // A missing arm is added.
        expect(assignActiveArm(value, scopeOf({ Size: "L" }), "30").value).toBe(
            'configure(Size, "S": 10, "M": 20, "L": 30)',
        );
    });
});

describe("the configuration layer of the scope", () => {
    test("a list is its option index carrying the option name; a checkbox 1 or 0", () => {
        const scope = scopeOf({ Size: "L", Holes: false });
        expect(scope.get("Size")).toEqual({ value: 2, unit: UNITLESS, option: "L", configuration: true });
        expect(scope.get("Holes")).toEqual({
            value: 0,
            unit: UNITLESS,
            option: "false",
            configuration: true,
        });
    });

    test("an input not set — or set to an option that no longer exists — takes its default", () => {
        expect(scopeOf().get("Size")?.option).toBe("M");
        expect(scopeOf({ Size: "XL" }).get("Size")?.option).toBe("M");
        expect(scopeOf().get("Holes")?.option).toBe("true");
        const noDefault = { ...SIZE, defaultOption: "gone" } as ConfigurationInputData;
        expect(scopeOf({}, [], [noDefault]).get("Size")?.option).toBe("S");
    });

    test("a configuration variable is its typed value in the active configuration", () => {
        expect(scopeOf().get("Length")).toEqual({ value: 120, unit: LENGTH_UNITS, configuration: true });
        expect(scopeOf({ Length: "200" }).get("Length")?.value).toBe(200);
        const result = evaluateDocumentScope({ inputs: [LENGTH], active: { Length: "600" } }, []);
        expect(result.errors.get("c-length")).toBe("Length must be at most 500");
        expect(result.scope.has("Length")).toBe(false);
    });

    test("sits below the studios and the table: they may use it, and shadow it with a warning", () => {
        const result = evaluateDocumentScope({ inputs: [SIZE, LENGTH], active: { Size: "S" } }, [
            { name: "Sizes", items: [variable("s1", "half", "Length / 2")] },
            {
                name: "table",
                items: [
                    variable("v1", "w", 'configure(Size, "S": 10, "M": 20, "L": 30)'),
                    variable("v2", "Length", "1"),
                ],
            },
        ]);
        expect(result.scope.get("half")?.value).toBe(60);
        expect(result.scope.get("w")?.value).toBe(10);
        expect(result.scope.get("Length")?.value).toBe(1);
        expect(result.warnings.get("v2")).toBe("Shadows Length from the configuration");
        // The shadowed input keeps its own value, by id.
        expect(result.values.get("c-length")?.value).toBe(120);
    });

    test("input names are checked like variable names", () => {
        const result = evaluateDocumentScope(
            {
                inputs: [
                    { ...HOLES, id: "a", name: "1bad" },
                    { ...HOLES, id: "b", name: "Holes" },
                    { ...HOLES, id: "c", name: "Holes" },
                    { kind: "list", id: "d", name: "Empty", options: [] },
                ],
                active: {},
            },
            [],
        );
        expect(result.errors.get("a")).toBe("Invalid configuration input name: 1bad");
        expect(result.errors.get("c")).toBe("Duplicate configuration input name: Holes");
        expect(result.errors.get("d")).toBe("Empty has no options");
    });
});

describe("VariableTable configuration", () => {
    test("the table scope includes the configuration and a studio sees it", () => {
        const { document } = documentWith([SIZE, LENGTH], [variable("v1", "w", "Length + 1")]);
        document.history.disabled = true;
        document.modelManager.addNode(
            new VariableStudioNode({ document, items: [variable("s1", "d", 'configure(Size, "M": 7)')] }),
        );
        document.history.disabled = false;
        const { scope } = document.variables.evaluate();
        expect(scope.get("w")?.value).toBe(121);
        expect(scope.get("d")?.value).toBe(7);
    });

    test("switching the active configuration is not recorded, but re-scopes and notifies", () => {
        const { document, table } = documentWith([SIZE]);
        const events: string[] = [];
        let revisionAtScope = -1;
        table.onPropertyChanged((property) => {
            events.push(property);
            if (property === "scope") revisionAtScope = table.revision;
        });
        const before = table.revision;

        Transaction.execute(document, "switch", () => table.setActiveConfiguration({ Size: "L" }));

        expect(table.scope.get("Size")?.option).toBe("L");
        expect(events).toEqual(["activeConfigurationJson", "scope"]);
        expect(revisionAtScope).toBe(before + 1);
        expect(document.history.undoCount()).toBe(0);
    });

    test("an input edit is one undo step; undo and redo re-scope", async () => {
        const { document, table } = documentWith([SIZE]);
        Transaction.execute(document, "edit configuration", () =>
            table.setConfigurationInputs([SIZE, HOLES]),
        );
        expect(document.history.undoCount()).toBe(1);
        expect(table.scope.has("Holes")).toBe(true);

        const before = table.revision;
        await document.history.undo();
        expect(table.configurationInputs).toEqual([SIZE]);
        expect(table.scope.has("Holes")).toBe(false);
        expect(table.revision).toBeGreaterThan(before);

        await document.history.redo();
        expect(table.scope.get("Holes")?.option).toBe("true");
    });

    test("a rename carries the active choice along in one notification", () => {
        const { table } = documentWith([SIZE]);
        table.setActiveConfiguration({ Size: "L" });
        let scopes = 0;
        table.onPropertyChanged((property) => {
            if (property === "scope") scopes++;
        });
        table.setConfigurationInputs([{ ...SIZE, name: "Grade" }], { Grade: "L" });
        expect(scopes).toBe(1);
        expect(table.scope.get("Grade")?.option).toBe("L");
        expect(table.activeConfiguration).toEqual({ Grade: "L" });
    });

    test("saves as {inputs, active} and restores from it; a document without one saves nothing", () => {
        const { table } = documentWith([SIZE, HOLES]);
        table.setActiveConfiguration({ Size: "S" });
        const saved = documentConfiguration(table);
        expect(saved).toEqual({ inputs: [SIZE, HOLES], active: { Size: "S" } });
        expect(documentConfiguration(new TestDocument().variables)).toBeUndefined();

        const copy = new TestDocument();
        restoreConfiguration(copy.variables, JSON.parse(JSON.stringify(saved)));
        expect(copy.variables.configurationInputs).toEqual([SIZE, HOLES]);
        expect(copy.variables.scope.get("Size")?.option).toBe("S");
    });

    test("a corrupt stored configuration reads as none", () => {
        const { table } = documentWith([]);
        table.configurationJson = "{not json";
        table.activeConfigurationJson = "[1]";
        expect(table.configurationInputs).toEqual([]);
        expect(table.activeConfiguration).toEqual({});
    });
});
