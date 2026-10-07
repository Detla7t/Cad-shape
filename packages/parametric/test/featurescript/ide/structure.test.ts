// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DEFAULT_STUDIO_SOURCE } from "../../../src/featurescript/featureStudioNode";
import { scanDeclarations } from "../../../src/featurescript/ui/ide/declarations";
import { foldRanges } from "../../../src/featurescript/ui/ide/folding";
import { formatFeatureScript, indentFor } from "../../../src/featurescript/ui/ide/format";
import { outlineOf } from "../../../src/featurescript/ui/ide/outline";
import { HEADER } from "./_helpers";

describe("outline", () => {
    const source = `${HEADER}
annotation { "Feature Type Name" : "Slot" }
export const slot = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        isLength(definition.width, LENGTH_BOUNDS);
        definition.flip is boolean;
    }
    {
    });

export function slotWidth(context is Context, depth) returns ValueWithUnits
{
    return depth;
}

const PRIVATE_LIMIT = 3;
export enum SlotEnd { ROUND, SQUARE }
export type SlotSpec typecheck canBeSlotSpec;
export predicate canBeSlotSpec(value) { value is map; }
`;
    const items = outlineOf(scanDeclarations(source));

    test("lists the declarations in source order, without imports", () => {
        expect(items.map((item) => [item.kind, item.name])).toEqual([
            ["feature", "slot"],
            ["function", "slotWidth"],
            ["const", "PRIVATE_LIMIT"],
            ["enum", "SlotEnd"],
            ["type", "SlotSpec"],
            ["predicate", "canBeSlotSpec"],
        ]);
    });

    test("a feature shows its feature name and parameter count; a function its parameters", () => {
        expect(items[0]).toMatchObject({ label: "Slot", detail: "2", exported: true });
        expect(items[1]).toMatchObject({ detail: "(context, depth)" });
        expect(items[3]).toMatchObject({ detail: "2" });
    });

    test("marks what is exported and jumps to the declared name", () => {
        expect(items[2].exported).toBe(false);
        for (const item of items) expect(source.slice(item.from, item.to)).toBe(item.name);
    });
});

describe("format document", () => {
    test("re-indents by bracket depth, Onshape style", () => {
        const messy = [
            "export const f = defineFeature(function(context is Context, id is Id, definition is map)",
            "precondition",
            "{",
            '  annotation { "Name" : "W" }',
            "        isLength(definition.w, LENGTH_BOUNDS);",
            "}",
            "{",
            "if (definition.w > 0)   ",
            "{",
            'opExtrude(context, id + "e", {',
            '"entities" : q',
            "});",
            "}",
            "});",
        ].join("\n");
        expect(formatFeatureScript(messy)).toBe(
            [
                "export const f = defineFeature(function(context is Context, id is Id, definition is map)",
                "    precondition",
                "    {",
                '        annotation { "Name" : "W" }',
                "        isLength(definition.w, LENGTH_BOUNDS);",
                "    }",
                "    {",
                "        if (definition.w > 0)",
                "        {",
                '            opExtrude(context, id + "e", {',
                '                    "entities" : q',
                "            });",
                "        }",
                "    });",
            ].join("\n"),
        );
    });

    test("brackets inside strings and comments do not count; doc comment stars stay aligned", () => {
        const source = [
            "function f()",
            "{",
            '  var s = "{(";',
            "// } )",
            "/**",
            "* Doc.",
            "*/",
            "return s;",
            "}",
        ].join("\n");
        expect(formatFeatureScript(source)).toBe(
            [
                "function f()",
                "{",
                '    var s = "{(";',
                "    // } )",
                "    /**",
                "     * Doc.",
                "     */",
                "    return s;",
                "}",
            ].join("\n"),
        );
    });

    test("is idempotent and leaves the default studio as it is", () => {
        expect(formatFeatureScript(DEFAULT_STUDIO_SOURCE)).toBe(DEFAULT_STUDIO_SOURCE);
        const once = formatFeatureScript("f(\n{\nx;\n}\n);");
        expect(formatFeatureScript(once)).toBe(once);
    });

    test("a closing line aligns with its opener's line; contents get a unit per bracket open there", () => {
        const open = [
            { indent: 4, line: 1 },
            { indent: 8, line: 5 },
            { indent: 8, line: 5 },
        ];
        expect(indentFor(open, '"entities" : q')).toBe(16);
        expect(indentFor(open, "});")).toBe(8);
        expect(indentFor(open.slice(0, 1), "x;")).toBe(8);
        expect(indentFor([], "x;")).toBe(0);
    });

    test("a call continued over lines indents its arguments and returns afterwards", () => {
        expect(formatFeatureScript(["foo(a,", "b);", "next();"].join("\n"))).toBe(
            ["foo(a,", "    b);", "next();"].join("\n"),
        );
    });
});

describe("folding", () => {
    const source = [
        "/**", // 1
        " * Doc.", // 2
        " */", // 3
        "export function f(a,", // 4
        "    b)", // 5
        "{", // 6
        "    if (a) { b(); }", // 7
        "    return [", // 8
        "        1", // 9
        "    ];", // 10
        "}", // 11
    ].join("\n");
    const ranges = foldRanges(source);

    test("a multi-line block folds between its brackets; one-line pairs do not fold", () => {
        expect(source.slice(ranges.get(6)?.from, ranges.get(6)?.to)).toBe(
            "\n    if (a) { b(); }\n    return [\n        1\n    ];\n",
        );
        expect(ranges.has(7)).toBe(false);
        expect(source.slice(ranges.get(8)?.from, ranges.get(8)?.to)).toBe("\n        1\n    ");
        expect(source.slice(ranges.get(4)?.from, ranges.get(4)?.to)).toBe("a,\n    b");
    });

    test("a doc comment folds from the end of its first line to its closing */", () => {
        expect(source.slice(ranges.get(1)?.from, ranges.get(1)?.to)).toBe("\n * Doc.\n ");
    });
});
