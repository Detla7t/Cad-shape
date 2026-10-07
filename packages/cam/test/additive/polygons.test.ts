// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    areaMm2,
    bounds,
    clipLines,
    difference,
    islands,
    offset,
    type Paths,
    pathFromMm,
    union,
} from "../../src/additive/geometry/polygons";
import { rectilinearLines } from "../../src/additive/slicer/infill";

/**
 * The slicer's polygon layer on the Rust polygon kernel, pinned where its former library
 * (clipper2-js 1.2.4) went wrong: skewed offsets, in-place edits of its inputs, open-path clipping.
 */

const square = (x0: number, y0: number, x1: number, y1: number) =>
    pathFromMm([
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
    ]);

const mmBounds = (paths: Paths) => {
    const b = bounds(paths)!;
    return [b.minX / 1000, b.minY / 1000, b.maxX / 1000, b.maxY / 1000];
};

test("offsets move every edge by the distance (miter corners stay square)", () => {
    const frame = [square(0, 0, 20, 20), square(5, 5, 15, 15).reverse()];
    const inset = offset(frame, -0.225);
    expect(inset).toHaveLength(2);
    expect(mmBounds([inset[0]])).toEqual([0.225, 0.225, 19.775, 19.775]);
    expect(mmBounds([inset[1]])).toEqual([4.775, 4.775, 15.225, 15.225]);
    expect(inset.every((path) => path.length === 4)).toBe(true);
    expect(mmBounds(offset([square(0, 0, 20, 20)], 1))).toEqual([-1, -1, 21, 21]);
    // A wall thinner than twice the inset vanishes.
    expect(offset([square(0, 0, 0.4, 20)], -0.225)).toEqual([]);
});

test("boolean inputs are left untouched", () => {
    const a = [square(0, 0, 10, 10)];
    const b = [
        pathFromMm([
            [5, -1],
            [11, 4.9999],
            [11, 11],
            [5, 11],
        ]),
    ];
    const before = JSON.stringify([a, b]);
    union(a, b);
    difference(a, b);
    offset([...a, ...b], -0.3);
    expect(JSON.stringify([a, b])).toBe(before);
});

test("islands pair holes with their outer loops", () => {
    const region = union([square(0, 0, 10, 10), square(20, 0, 30, 10)]).concat([
        square(2, 2, 4, 4).reverse(),
    ]);
    const found = islands(region);
    expect(found).toHaveLength(2);
    const withHole = found.find((island) => island.holes.length === 1)!;
    expect(mmBounds([withHole.outer])).toEqual([0, 0, 10, 10]);
    expect(areaMm2(region)).toBeCloseTo(196, 9);
});

test.each([0, 45, 90, 135, 30])("lines at %d° are clipped to the region exactly", (angle) => {
    const region = [square(0, 0, 10, 10), square(4, 4, 6, 6).reverse()];
    const lines = rectilinearLines(region, angle, 0.5);
    expect(lines.length).toBeGreaterThan(15);
    let length = 0;
    for (const line of lines) {
        for (const p of line) {
            expect(p.x).toBeGreaterThanOrEqual(-1);
            expect(p.y).toBeGreaterThanOrEqual(-1);
            expect(p.x).toBeLessThanOrEqual(10001);
            expect(p.y).toBeLessThanOrEqual(10001);
            // Nothing inside the hole.
            expect(p.x > 4001 && p.x < 5999 && p.y > 4001 && p.y < 5999).toBe(false);
        }
        length += Math.hypot(line[1].x - line[0].x, line[1].y - line[0].y) / 1000;
    }
    // Lines 0.5 mm apart cover the 96 mm² area with ~192 mm of line.
    expect(length / (96 / 0.5)).toBeGreaterThan(0.95);
    expect(length / (96 / 0.5)).toBeLessThan(1.05);
});

test("polylines are clipped into the pieces inside", () => {
    const region = [square(0, 0, 10, 10)];
    const pieces = clipLines(
        [
            pathFromMm([
                [-5, 5],
                [5, 5],
                [5, 15],
                [8, 15],
                [8, 5],
                [15, 5],
            ]),
        ],
        region,
    );
    expect(pieces.map((piece) => piece.map((p) => [p.x / 1000, p.y / 1000]))).toEqual([
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
