// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EMPTY_SCOPE, evaluateExpression, LENGTH_UNITS, resolveUnitSpec, UNITLESS } from "../src";

const value = (source: string) => {
    const result = evaluateExpression(source, EMPTY_SCOPE);
    expect(result.isOk).toBe(true);
    return result.value;
};

describe("comparisons and Onshape's conditional", () => {
    test.each([
        ["2 < 3", 1],
        ["3 < 3", 0],
        ["3 <= 3", 1],
        ["4 > 3", 1],
        ["4 >= 5", 0],
        ["2.5 in == 63.5 mm", 1],
        ["1 != 1", 0],
        ["1 < 2 && 2 < 1", 0],
        ["1 < 2 || 2 < 1", 1],
    ])("%s is %d", (source, expected) => {
        expect(value(source)).toEqual({ value: expected, unit: UNITLESS });
    });

    test("a conditional picks a branch and keeps its unit", () => {
        expect(value("9.625 in < 13.375 in ? 0.625 in : 0.75 in")).toEqual({
            value: 15.875,
            unit: LENGTH_UNITS,
        });
        expect(value("16 in < 13.375 in ? 0.625 in : 0.75 in").value).toBeCloseTo(19.05, 9);
    });

    test("conditionals chain to the right, like Onshape's", () => {
        const flange = (od: number) =>
            resolveUnitSpec(
                `${od} in < 5.25 in ? 0.375 in : ${od} in < 9.125 in ? 0.5 in : ${od} in < 13.375 in ? 0.625 in : ${od} in < 18.5 in ? 0.75 in : 1 in`,
                EMPTY_SCOPE,
                LENGTH_UNITS,
            ).value / 25.4;
        const rounded = (od: number) => Math.round(flange(od) * 1e9) / 1e9;
        expect([4, 6.625, 12.75, 16, 24].map(rounded)).toEqual([0.375, 0.5, 0.625, 0.75, 1]);
    });

    test.each([
        ["1 in < 2 deg", "Dimension mismatch"],
        ["1 < 2 ? 1 in : 2 deg", "Dimension mismatch"],
        ["1 < 2 ? 3", "Expected :"],
    ])("%s is refused", (source, message) => {
        const result = evaluateExpression(source, EMPTY_SCOPE);
        expect(result.isOk).toBe(false);
        expect(result.isOk ? "" : result.error).toContain(message);
    });
});
