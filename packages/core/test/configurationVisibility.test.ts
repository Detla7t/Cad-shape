// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ConfigurationInputData, type ConfigurationVisibility, configurationVisible } from "../src";

const inputs: ConfigurationInputData[] = [
    {
        id: "shape",
        kind: "list",
        name: "Shape",
        options: [
            { id: "circle", name: "Round" },
            { id: "square", name: "Square" },
        ],
    },
    { id: "holes", kind: "checkbox", name: "Holes", defaultValue: false },
    { id: "length", kind: "variable", name: "Length", type: "length", defaultExpression: "1 in" },
];
const rule: ConfigurationVisibility = {
    match: "all",
    conditions: [
        { inputId: "shape", operator: "is", values: ["circle"] },
        { inputId: "holes", operator: "is", values: [true] },
    ],
};

test("visibility supports all/any, defaults, multi-select and stable option ids across renames", () => {
    expect(configurationVisible(rule, inputs, {})).toBe(false);
    expect(configurationVisible(rule, inputs, { Holes: true })).toBe(true);
    expect(configurationVisible({ ...rule, match: "any" }, inputs, {})).toBe(true);
    expect(configurationVisible(rule, inputs, { Shape: "Square", Holes: true })).toBe(false);
    const renamed = inputs.map((input) =>
        input.kind === "list"
            ? {
                  ...input,
                  options: [
                      { id: "circle", name: "Circle" },
                      { id: "square", name: "Square" },
                  ],
              }
            : input,
    );
    expect(configurationVisible(rule, renamed, { Shape: "Circle", Holes: true })).toBe(true);
    expect(
        configurationVisible(
            {
                match: "all",
                conditions: [{ inputId: "shape", operator: "isNot", values: ["circle", "square"] }],
            },
            inputs,
            {},
        ),
    ).toBe(false);
});

test("numeric visibility resolves expressions and units; invalid/deleted sources do not match", () => {
    const numeric: ConfigurationVisibility = {
        match: "all",
        conditions: [{ inputId: "length", operator: "gte", values: ["25.4 mm"] }],
    };
    expect(configurationVisible(numeric, inputs, {})).toBe(true);
    expect(configurationVisible(numeric, inputs, { Length: "20 mm" })).toBe(false);
    expect(configurationVisible(numeric, inputs, { Length: "bad" })).toBe(false);
    expect(
        configurationVisible(
            numeric,
            inputs.filter((input) => input.id !== "length"),
            {},
        ),
    ).toBe(false);
});

test("a deleted list option does not turn an is-not rule into an always-visible input", () => {
    expect(
        configurationVisible(
            {
                match: "all",
                conditions: [{ inputId: "shape", operator: "isNot", values: ["deleted-option"] }],
            },
            inputs,
            {},
        ),
    ).toBe(false);
});
