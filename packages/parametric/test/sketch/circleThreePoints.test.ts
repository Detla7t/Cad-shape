// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { circleThroughPoints } from "../../src/sketch/commands/sketchCircle";

test("three rim points define an exact circle independently of winding", () => {
    for (const points of [
        [
            [5, 2],
            [1, 6],
            [-3, 2],
        ],
        [
            [-3, 2],
            [1, 6],
            [5, 2],
        ],
    ] as [number, number][][]) {
        const circle = circleThroughPoints(points[0], points[1], points[2]);
        expect(circle).toEqual([1, 2, 4]);
    }
});
test("collinear or duplicate picks cannot create an infinite circle", () => {
    expect(circleThroughPoints([0, 0], [1, 0], [2, 0])).toBeUndefined();
    expect(circleThroughPoints([3, 4], [3, 4], [6, 1])).toBeUndefined();
});
