// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEdge, IShape, XYZ } from "@chili3d/core";
import { projectView } from "../src/cad/projection";

/**
 * How edges are sorted into visible and hidden from a hidden-line-removal result, with
 * fake shapes (the real kernel is exercised in `projection.kernel.test.ts`).
 */

type Point = [number, number, number];

function fakeLine(a: Point, b: Point): IEdge {
    const xyz = (p: Point) => ({ x: p[0], y: p[1], z: p[2] }) as XYZ;
    return {
        curve: { basisCurve: { curveType: "line" } },
        ends: () => [xyz(a), xyz(b)],
        dispose: () => {},
    } as unknown as IEdge;
}

/** A shape whose top view (normal +Z, x along +X) shows `edges`, of which HLR reports `visible`. */
function fakeShape(edges: [Point, Point][], visible: [Point, Point][]): IShape {
    return {
        hlr: () => ({ findSubShapes: () => visible.map(([a, b]) => fakeLine(a, b)), dispose: () => {} }),
        findSubShapes: () => edges.map(([a, b]) => fakeLine(a, b)),
    } as unknown as IShape;
}

describe("projection visibility", () => {
    const square: [Point, Point][] = [
        [
            [0, 0, 5],
            [10, 0, 5],
        ],
        [
            [10, 0, 5],
            [10, 10, 5],
        ],
    ];
    const behind: [Point, Point] = [
        [5, 0, 0],
        [5, 10, 0],
    ];

    test("edges the HLR result shows are VISIBLE, the others HIDDEN (dashed)", () => {
        const view = projectView([fakeShape([...square, behind], square)], "top");
        expect(
            view.map((entity) => [entity.layer, entity.kind === "line" ? [entity.a, entity.b] : undefined]),
        ).toEqual([
            [
                "VISIBLE",
                [
                    [0, 0],
                    [10, 0],
                ],
            ],
            [
                "VISIBLE",
                [
                    [10, 0],
                    [10, 10],
                ],
            ],
            [
                "HIDDEN",
                [
                    [5, 0],
                    [5, 10],
                ],
            ],
        ]);
    });

    test("hidden edges can be left out", () => {
        const view = projectView([fakeShape([...square, behind], square)], "top", { hidden: false });
        expect(view.every((entity) => entity.layer === "VISIBLE")).toBe(true);
        expect(view).toHaveLength(2);
    });

    test("a hidden edge projecting onto a visible one is drawn once, as visible", () => {
        const below: [Point, Point] = [
            [10, 0, 0],
            [0, 0, 0],
        ];
        const part: [Point, Point] = [
            [2, 0, 0],
            [4, 0, 0],
        ];
        const view = projectView([fakeShape([...square, below, part], square)], "top");
        expect(view.map((entity) => entity.layer)).toEqual(["VISIBLE", "VISIBLE"]);
    });
});
