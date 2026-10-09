// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ActiveConfigurationData,
    evaluateDocumentScope,
    LENGTH_UNITS,
    Plane,
    type Scope,
    type VariableData,
} from "@chili3d/core";
import type { SketchData } from "@chili3d/parametric";
import { SketchSolver } from "../../parametric/src/sketch/solver";
import "../../parametric/test/sketch/setup";
import { endCapConfigurationInputs, END_CAP_INPUT_NAMES as N } from "../src/app/endCapConfiguration";
import { END_CAP_VARIABLES, plainEndCapSketch, reducingEndCapSketch } from "../src/app/endCapNative";
import { type EndCapParams, endCapPattern } from "../src/endcap/endCap";
import { DUCT_SIZES } from "../src/endcap/sizes";
import { arc, line, type Segment, sameGeometry } from "../src/geometry";

const inputs = endCapConfigurationInputs();
const variables: VariableData[] = END_CAP_VARIABLES.map((variable) => ({
    id: variable.name,
    name: variable.name,
    type: "length",
    expression: variable.expression,
}));

function scopeFor(params: EndCapParams): Scope {
    const label = (inches: number | undefined) =>
        DUCT_SIZES.find((size) => size.inches === inches)?.label ?? DUCT_SIZES[0].label;
    const active: ActiveConfigurationData = {
        [N.endcap]: !params.reducing,
        [N.od]: label(params.od),
        [N.id]: label(params.id),
        [N.wall]: params.wallHeight !== undefined,
        ...(params.wallHeight === undefined ? {} : { [N.finishWall]: `${params.wallHeight} in` }),
    };
    const evaluated = evaluateDocumentScope({ inputs, active }, [{ name: "End cap", items: variables }]);
    expect([...evaluated.errors]).toEqual([]);
    return evaluated.scope;
}

const MM = 25.4;
const DEG = 180 / Math.PI;

/** The solved sketch as flat-pattern segments, inches. */
function segments(solver: SketchSolver): Segment[] {
    return solver.entities().map((entity) => {
        const v = entity.params.map((x) => x / MM);
        if (entity.type === "line") return line([v[0], v[1]], [v[2], v[3]]);
        const [cx, cy, sx, sy, ex, ey] = v;
        return arc(
            [cx, cy],
            Math.hypot(sx - cx, sy - cy),
            Math.atan2(sy - cy, sx - cx) * DEG,
            Math.atan2(ey - cy, ex - cx) * DEG,
        );
    });
}

function expected(params: EndCapParams): Segment[] {
    const pattern = endCapPattern(params);
    expect(pattern.isOk).toBe(true);
    if (!pattern.isOk) return [];
    return pattern.value.parts.flatMap((part) => [...part.outline, ...part.bendLines]);
}

function solve(data: SketchData, params: EndCapParams) {
    const solver = new SketchSolver(Plane.XY, data, scopeFor(params));
    expect([...solver.datumErrors]).toEqual([]);
    const outcome = solver.solve(true);
    expect(outcome.result).toMatch(/^Ok/);
    return solver;
}

const reducers: EndCapParams[] = DUCT_SIZES.flatMap((od) =>
    DUCT_SIZES.filter((id) => id.inches < od.inches).map((id) => ({
        reducing: true,
        od: od.inches,
        id: id.inches,
    })),
);
const plains: EndCapParams[] = DUCT_SIZES.map((od) => ({ reducing: false, od: od.inches }));

describe("the native End Cap Configurator", () => {
    test("every variable resolves to a length in the default configuration", () => {
        const scope = scopeFor({ reducing: true, od: 9.625, id: 6.625 });
        for (const variable of END_CAP_VARIABLES) {
            expect(scope.get(variable.name)?.unit).toEqual(LENGTH_UNITS);
        }
        expect(scope.get("duct_od")!.value).toBeCloseTo(9.625 * MM, 9);
        expect(scope.get("wall")!.value).toBeCloseTo(2.875 * MM, 9);
    });

    test.each([
        ["Reducing End Cap", reducingEndCapSketch(), { reducing: true, od: 9.625, id: 6.625 }],
        ["End Cap", plainEndCapSketch(), { reducing: false, od: 9.625 }],
    ] as const)("%s is fully constrained and draws the default size", (_name, data, params) => {
        const solver = solve(data, params);
        expect(solver.dofs()).toBe(0);
        expect(sameGeometry(segments(solver), expected(params))).toBe(true);
    });

    test("one reducing sketch follows the configuration through all 231 reducers, in any order", () => {
        const solver = solve(reducingEndCapSketch(), reducers[0]);
        const failures: string[] = [];
        // Ascending, then a shuffle of large jumps (a fixed permutation: 97 is coprime to 231).
        const order = [...reducers, ...reducers.map((_, i) => reducers[(i * 97) % reducers.length])];
        for (const params of order) {
            const outcome = solver.followScope(scopeFor(params));
            if (!outcome.result.startsWith("Ok") || !sameGeometry(segments(solver), expected(params))) {
                failures.push(`${params.od} x ${params.id}: ${outcome.result}`);
            }
        }
        expect(failures).toEqual([]);
        expect(reducers).toHaveLength(231);
    });

    test("one plain sketch follows the configuration through all 22 sizes, in any order", () => {
        const solver = solve(plainEndCapSketch(), plains[0]);
        const failures: string[] = [];
        for (const params of [
            ...plains,
            ...[...plains].reverse(),
            ...plains.map((_, i) => plains[(i * 7) % 22]),
        ]) {
            const outcome = solver.followScope(scopeFor(params));
            if (!outcome.result.startsWith("Ok") || !sameGeometry(segments(solver), expected(params))) {
                failures.push(`${params.od}: ${outcome.result}`);
            }
        }
        expect(failures).toEqual([]);
    });

    test("a set finish wall height moves the collar strips", () => {
        const params = { reducing: true, od: 12.75, id: 8.625, wallHeight: 1.5 };
        const solver = solve(reducingEndCapSketch(), { reducing: true, od: 9.625, id: 6.625 });
        expect(solver.followScope(scopeFor(params)).result).toMatch(/^Ok/);
        expect(sameGeometry(segments(solver), expected(params))).toBe(true);
    });
});
