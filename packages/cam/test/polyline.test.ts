// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { grownShadow, shadowRegion, simplify2, simplify3, simplifyClosed, TriangleIndex } from "../src";
import { regionArea } from "../src/geometry2d";
import { boxMesh, mergeMeshes } from "./_helpers/meshes";

describe("collinear-point reduction", () => {
    test("drops points within the tolerance of the chord, keeps corners", () => {
        const line: number[] = [];
        for (let k = 0; k <= 10; k++) line.push(k, 0, k === 5 ? 0.004 : 0);
        expect(simplify3(line, 0.005)).toEqual([0, 0, 0, 10, 0, 0]);
        expect(simplify3(line, 0.0035)).toEqual([0, 0, 0, 5, 0, 0.004, 10, 0, 0]);
        expect(
            simplify2(
                [
                    [0, 0],
                    [1, 0.001],
                    [2, 0],
                    [2, 2],
                ],
                0.01,
            ),
        ).toEqual([
            [0, 0],
            [2, 0],
            [2, 2],
        ]);
        const box = simplifyClosed(
            [
                [0, 0],
                [5, 0],
                [10, 0],
                [10, 5],
                [10, 10],
                [5, 10],
                [0, 10],
                [0, 5],
            ],
            0.01,
        );
        expect(box).toEqual([
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
        ]);
    });
});

describe("mesh shadow", () => {
    test("a box's shadow grown by g is the rectangle with rounded corners", async () => {
        const box = boxMesh([0, 0, 0], [20, 10, 5]);
        const index = new TriangleIndex(box.positions, box.indices);
        const grown = await grownShadow(index, 1, 0.5, 0.001);
        expect(grown.length).toBe(1);
        expect(regionArea(grown)).toBeCloseTo(22 * 12 - (4 - Math.PI), 1);
        // Shrunk back by the grid's growth: the rectangle itself (corners re-sharpened).
        expect(regionArea(await shadowRegion(index, 0, 0.5, 0.001))).toBeCloseTo(200, 0);
    });

    test("separate parts keep separate shadows; gaps narrower than the growth close", async () => {
        const apart = mergeMeshes(boxMesh([0, 0, 0], [10, 10, 5]), boxMesh([14, 0, 0], [24, 10, 5]));
        const index = new TriangleIndex(apart.positions, apart.indices);
        expect((await shadowRegion(index, 0, 0.5, 0.001)).length).toBe(2);
        expect((await shadowRegion(index, 0, 2.5, 0.001)).length).toBe(1);
    });
});
