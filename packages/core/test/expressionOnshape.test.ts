// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Onshape's variable-table spellings: `#f(#a, #b)` calling a function a feature stored,
 * the unit written after a product chain (`13/16 in`, `(9 + 5/8) in`), `PI`, and a bare
 * number on a Length row read in the document's units.
 */

import { Result } from "../src/foundation/result";
import {
    type EvaluatedValue,
    evaluateExpression,
    type Scope,
    withScopeContext,
} from "../src/parameters/expression";
import { LENGTH_UNITS, UNITLESS } from "../src/parameters/unitSpec";
import { evaluateDocumentScope, type VariableLayer } from "../src/parameters/variableTable";
import { TestDocument } from "../test-utils";

const length = (mm: number): EvaluatedValue => ({ value: mm, unit: LENGTH_UNITS });
const IN = 25.4;

function scopeOf(entries: Record<string, EvaluatedValue>): Scope {
    return new Map(Object.entries(entries));
}

describe("units written after a chain", () => {
    test.each([
        ["13/16 in", (13 / 16) * IN],
        ["(9 + 5/8) in", 9.625 * IN],
        ["(1/8in)", IN / 8],
        ["3 * 2 in", 6 * IN],
        ["2 in + 3 in", 5 * IN],
        ["-(3) in", -3 * IN],
        ["(24-4.5) in", 19.5 * IN],
        ["(3/32) in", (3 / 32) * IN],
    ])("`%s` is a length", (source, mm) => {
        const result = evaluateExpression(source, new Map());
        expect(result.isOk).toBe(true);
        expect(result.value.value).toBeCloseTo(mm, 9);
        expect(result.value.unit).toEqual(LENGTH_UNITS);
    });

    test("a unit after an operand of a chain that already carries one applies to that operand", () => {
        const ratio = evaluateExpression("10 mm / 2 mm", new Map());
        expect(ratio.isOk).toBe(true);
        expect(ratio.value.value).toBe(5);
        expect(ratio.value.unit).toEqual(UNITLESS);
        const area = evaluateExpression("2 mm * 3 mm", new Map());
        expect(area.isOk).toBe(true);
        expect(area.value.value).toBe(6);
        expect(area.value.unit.length).toBe(2);
    });

    test("a bare unit name is a quantity: `6.75 *in` and `#w / in`", () => {
        const scope = scopeOf({ w: length(2 * IN) });
        expect(evaluateExpression("6.75 *in", scope).value.value).toBeCloseTo(6.75 * IN, 9);
        const ratio = evaluateExpression("#w / in", scope);
        expect(ratio.value.value).toBeCloseTo(2, 9);
        expect(ratio.value.unit).toEqual(UNITLESS);
        expect(evaluateExpression("(#w/in*#w/in) * in", scope).value.value).toBeCloseTo(4 * IN, 9);
    });

    test("PI is the constant, like pi", () => {
        expect(evaluateExpression("((2 in + (1/8in)) * PI) / 2", new Map()).value.value).toBeCloseTo(
            (2.125 * IN * Math.PI) / 2,
            9,
        );
    });
});

describe("function variables", () => {
    /** Onshape's sizeCrimp: the crimp allowance for a duct diameter. */
    const sizeCrimp: EvaluatedValue = {
        value: Number.NaN,
        unit: UNITLESS,
        call: (args) => {
            const od = args[0];
            if (typeof od === "string") return Result.err("sizeCrimp takes a length");
            const inches = od.value / IN;
            const crimp = inches <= 5 ? 3 / 8 : inches <= 8.625 ? 1 / 2 : inches <= 12.75 ? 5 / 8 : 1;
            return Result.ok(length(crimp * IN));
        },
    };
    const sizeOverlap: EvaluatedValue = {
        value: Number.NaN,
        unit: UNITLESS,
        call: (args) => {
            const [x, y] = args;
            if (typeof x === "string" || typeof y === "string") return Result.err("lengths only");
            const overlap = x.value - y.value;
            return Result.ok(length(overlap > 1.5 * IN || overlap <= 0 ? IN : overlap / 2));
        },
    };

    test("`#f(#a, #b)` calls the function, with and without the #", () => {
        const scope = scopeOf({ sizeCrimp, sizeOverlap, OD: length(9.625 * IN), ID: length(6.625 * IN) });
        expect(evaluateExpression("#sizeCrimp(#OD)", scope).value.value).toBeCloseTo(0.625 * IN, 9);
        expect(evaluateExpression("sizeCrimp(OD) + 0 in", scope).value.value).toBeCloseTo(0.625 * IN, 9);
        expect(evaluateExpression("#sizeOverlap(#OD,#ID)", scope).value.value).toBeCloseTo(IN, 9);
        expect(evaluateExpression("#sizeOverlap(7 in, 6.5 in)", scope).value.value).toBeCloseTo(0.25 * IN, 9);
    });

    test("a plain variable cannot be called, and a function is not a number", () => {
        const scope = scopeOf({ sizeCrimp, OD: length(IN) });
        expect(evaluateExpression("#OD(2)", scope).error).toBe("OD is not a function");
        expect(evaluateExpression("#sizeCrimp + 1", scope).error).toBe(
            "Expression result is not a finite number",
        );
    });
});

describe("the document's units for bare numbers", () => {
    test("a Length row written `1` is one document unit; a function row joins the scope", () => {
        const document = new TestDocument();
        document.userData = {
            displayUnits: { length: "in", angle: "deg", lengthPrecision: 3, anglePrecision: 1 },
        };
        const base = withScopeContext(new Map(), { document });
        const layers: VariableLayer[] = [
            {
                name: "Add My Functions",
                items: [{ id: "f", name: "sizeOverlap", type: "function", expression: "function" }],
                functions: new Map([
                    [
                        "sizeOverlap",
                        {
                            call: (args) => {
                                const [x, y] = args as EvaluatedValue[];
                                const overlap = x.value - y.value;
                                return Result.ok(
                                    length(overlap > 1.5 * IN || overlap <= 0 ? IN : overlap / 2),
                                );
                            },
                        },
                    ],
                ]),
            },
            {
                name: "Part Studio 1",
                items: [
                    { id: "od", name: "OD", type: "length", expression: "(9+ 5/8) in" },
                    { id: "id", name: "ID", type: "length", expression: "(6 + 5/8) in" },
                    { id: "wo", name: "Wall_Overlap", type: "length", expression: "1" },
                    { id: "mt", name: "Material_Thickness", type: "length", expression: "0.016" },
                    { id: "ov", name: "Overlap", type: "length", expression: "#sizeOverlap(#OD,#ID)" },
                    {
                        id: "mwl",
                        name: "Male_Wall_Length",
                        type: "length",
                        expression: "(((#ID+(#Material_Thickness*3))*PI)/2)+(#Wall_Overlap*2)",
                    },
                ],
            },
        ];
        const evaluated = evaluateDocumentScope(undefined, layers, base);
        expect([...evaluated.errors]).toEqual([]);
        const inches = (name: string) => evaluated.scope.get(name)!.value / IN;
        expect(inches("Wall_Overlap")).toBeCloseTo(1, 9);
        expect(inches("Material_Thickness")).toBeCloseTo(0.016, 9);
        expect(inches("Overlap")).toBeCloseTo(1, 9);
        expect(inches("Male_Wall_Length")).toBeCloseTo(12.482, 3);
        expect(evaluated.scope.get("sizeOverlap")?.call).toBeDefined();
        expect(Number.isNaN(evaluated.scope.get("sizeOverlap")!.value)).toBe(true);
    });
});
