// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    flatPaths,
    pathsOf,
    polygonBoolean,
    polygonClipPolylines,
    polygonNesting,
    polygonOffset,
    polygonSimplify,
} from "../src";

type Loop = [number, number][];

const rect = (x0: number, y0: number, x1: number, y1: number): Loop => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
];

const area = (loop: Loop) => {
    let twice = 0;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        twice += loop[j][0] * loop[i][1] - loop[i][0] * loop[j][1];
    }
    return twice / 2;
};

const totalArea = (loops: Loop[]) => loops.reduce((sum, loop) => sum + area(loop), 0);

describe("flat paths", () => {
    test("pack and unpack point lists", () => {
        const loops: Loop[] = [rect(0, 0, 1, 2), [], [[5, 6]]];
        const flat = flatPaths(loops);
        expect([...flat.lengths]).toEqual([4, 0, 1]);
        expect([...flat.coords]).toEqual([0, 0, 1, 0, 1, 2, 0, 2, 5, 6]);
        expect(pathsOf(flat)).toEqual(loops);
    });
});

describe("polygon booleans", () => {
    const a = flatPaths([rect(0, 0, 10, 10)]);
    const b = flatPaths([rect(5, 5, 15, 15)]);

    test.each([
        ["union", 175],
        ["difference", 75],
        ["intersection", 25],
        ["xor", 150],
    ] as const)("%s of two squares", (op, expected) => {
        expect(totalArea(pathsOf(polygonBoolean(op, a, b)))).toBe(expected);
    });

    test("outer loops come counter-clockwise, then their holes clockwise", () => {
        const frame = pathsOf(
            polygonBoolean("difference", flatPaths([rect(0, 0, 20, 20)]), flatPaths([rect(5, 5, 15, 15)])),
        );
        expect(frame).toHaveLength(2);
        expect(area(frame[0])).toBe(400);
        expect(area(frame[1])).toBe(-100);
    });

    test("the fill rule resolves overlaps", () => {
        const two = flatPaths([rect(0, 0, 10, 10), rect(5, 5, 15, 15)]);
        expect(totalArea(pathsOf(polygonSimplify(two, { fill: "evenOdd" })))).toBe(150);
        expect(totalArea(pathsOf(polygonSimplify(two, { fill: "nonZero" })))).toBe(175);
        expect(totalArea(pathsOf(polygonSimplify(two, { fill: "negative" })))).toBe(0);
    });

    test("results sit on the grid", () => {
        const fine = pathsOf(polygonSimplify(flatPaths([rect(0.00004, 0, 1, 1)])));
        expect(fine[0].map((p) => p[0]).sort()).toEqual([0, 0, 1, 1]);
        const coarse = pathsOf(polygonSimplify(flatPaths([rect(0.0004, 0, 1, 1)]), { scale: 1000 }));
        expect(coarse[0].map((p) => p[0]).sort()).toEqual([0, 0, 1, 1]);
    });

    test("malformed input throws", () => {
        const bad = { coords: new Float64Array([0, 0, 1]), lengths: new Uint32Array([2]) };
        expect(() => polygonBoolean("union", bad)).toThrow(/coordinates do not match/);
        const nan = flatPaths([
            [
                [0, 0],
                [Number.NaN, 0],
                [1, 1],
            ],
        ]);
        expect(() => polygonBoolean("union", nan)).toThrow(/finite/);
        const huge = flatPaths([rect(0, 0, 1e9, 1)]);
        expect(() => polygonBoolean("union", huge)).toThrow(/beyond/);
        expect(() => polygonBoolean("nand" as "union", a)).toThrow(/unknown boolean operation/);
        expect(() => polygonBoolean("union", a, b, { fill: "odd" as "evenOdd" })).toThrow(
            /unknown fill rule/,
        );
    });
});

describe("polygon offsets", () => {
    test("round joins keep every vertex the distance from a square", () => {
        const [ring, ...rest] = pathsOf(polygonOffset(flatPaths([rect(0, 0, 10, 10)]), 2));
        expect(rest).toHaveLength(0);
        for (const [x, y] of ring) {
            const dx = Math.max(0, -x, x - 10);
            const dy = Math.max(0, -y, y - 10);
            // Within a grid unit (0.1 µm) of the arc.
            expect(Math.abs(Math.hypot(dx, dy) - 2)).toBeLessThan(1e-4);
        }
        expect(area(ring)).toBeCloseTo(100 + 80 + Math.PI * 4, 1);
    });

    test("mitres keep corners square; a frame shrinks and its hole grows", () => {
        const frame = flatPaths([rect(0, 0, 20, 20), rect(5, 5, 15, 15).reverse()]);
        const inset = pathsOf(
            polygonOffset(frame, -0.225, { join: { kind: "miter", limit: 3 }, scale: 1000 }),
        );
        expect(inset.map((loop) => loop.length)).toEqual([4, 4]);
        expect(area(inset[0])).toBeCloseTo(19.55 ** 2, 9);
        expect(area(inset[1])).toBeCloseTo(-(10.45 ** 2), 9);
    });

    test("bevels chamfer corners", () => {
        const [ring] = pathsOf(
            polygonOffset(flatPaths([rect(0, 0, 10, 10)]), 1, { join: { kind: "bevel" } }),
        );
        expect(ring).toHaveLength(8);
        expect(area(ring)).toBeCloseTo(100 + 40 + 2, 9);
    });

    test("an inset wider than the part leaves nothing", () => {
        expect(polygonOffset(flatPaths([rect(0, 0, 4, 4)]), -2.5).lengths).toHaveLength(0);
    });

    test("bad joins throw", () => {
        const square = flatPaths([rect(0, 0, 1, 1)]);
        expect(() => polygonOffset(square, 1, { join: { kind: "round", tolerance: 0 } })).toThrow(
            /tolerance/,
        );
        expect(() => polygonOffset(square, Number.NaN)).toThrow(/finite/);
        expect(() => polygonOffset(square, 1, { join: { kind: "square" } as never })).toThrow(/unknown join/);
    });
});

describe("polyline clipping", () => {
    const square = flatPaths([rect(0, 0, 10, 10)]);
    const line: Loop = [
        [-5, 5],
        [5, 5],
        [5, 15],
        [8, 15],
        [8, 5],
        [15, 5],
    ];

    test("inside pieces keep their direction and join across vertices", () => {
        expect(pathsOf(polygonClipPolylines(flatPaths([line]), square))).toEqual([
            [
                [0, 5],
                [5, 5],
                [5, 10],
            ],
            [
                [8, 10],
                [8, 5],
                [10, 5],
            ],
        ]);
    });

    test("outside pieces are the rest", () => {
        expect(pathsOf(polygonClipPolylines(flatPaths([line]), square, { keep: "outside" }))).toEqual([
            [
                [-5, 5],
                [0, 5],
            ],
            [
                [5, 10],
                [5, 15],
                [8, 15],
                [8, 10],
            ],
            [
                [10, 5],
                [15, 5],
            ],
        ]);
    });

    test("crossing lines stay apart", () => {
        const lines = flatPaths([
            [
                [-20, 3],
                [20, 3],
            ],
            [
                [3, 20],
                [3, -20],
            ],
        ]);
        expect(pathsOf(polygonClipPolylines(lines, square))).toEqual([
            [
                [0, 3],
                [10, 3],
            ],
            [
                [3, 10],
                [3, 0],
            ],
        ]);
    });

    test("an unknown side throws", () => {
        expect(() => polygonClipPolylines(flatPaths([line]), square, { keep: "both" as "inside" })).toThrow(
            /unknown side/,
        );
    });
});

describe("loop nesting", () => {
    test("outer loops, holes and islands nest by containment", () => {
        const tree = polygonNesting(
            flatPaths([rect(20, 20, 80, 80), rect(0, 0, 100, 100), rect(10, 10, 90, 90), [[0, 0]]]),
        );
        expect([...tree.order]).toEqual([1, 2, 0]);
        expect([...tree.parent]).toEqual([2, -1, 1, -1]);
        expect([...tree.depth]).toEqual([2, 0, 1, 0]);
    });
});
