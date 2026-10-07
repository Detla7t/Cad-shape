// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    arcRadius,
    arcSweep,
    circlePoints,
    difference,
    distanceToLoops,
    fitArcs,
    intersection,
    nestRectangles,
    offset,
    type Point2,
    pathLength,
    pathPoints,
    pathSignedArea,
    regionArea,
    regions,
    shortPathOrder,
    signedArea,
    subPath,
    tabCenters,
    tabIntervals,
    tourLength,
    union,
} from "../src/geometry2d";

const rect = (x0: number, y0: number, x1: number, y1: number): Point2[] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
];

describe("offsets", () => {
    test("a square grows by round joins to the exact rounded-square area", () => {
        const [grown, ...rest] = offset([rect(0, 0, 10, 10)], 2);
        expect(rest).toHaveLength(0);
        expect(signedArea(grown)).toBeCloseTo(100 + 4 * 10 * 2 + Math.PI * 4, 1);
        // Every vertex is exactly 2 from the square.
        for (const p of grown) expect(distanceToLoops(p, [rect(0, 0, 10, 10)])).toBeCloseTo(2, 3);
    });

    test("shrinking keeps sharp corners and grows holes", () => {
        const loops = [rect(0, 0, 40, 30), circlePoints([20, 15], 5, 0.002, false)];
        const shrunk = offset(loops, -3);
        const found = regions(shrunk);
        expect(found).toHaveLength(1);
        expect(found[0].holes).toHaveLength(1);
        expect(signedArea(found[0].outer)).toBeCloseTo(34 * 24, 3);
        expect(-signedArea(found[0].holes[0])).toBeCloseTo(Math.PI * 64, 0);
        for (const p of found[0].holes[0]) expect(Math.hypot(p[0] - 20, p[1] - 15)).toBeCloseTo(8, 2);
    });

    test("a loop smaller than the offset vanishes; a waist splits it in two", () => {
        expect(offset([rect(0, 0, 4, 4)], -2.5)).toHaveLength(0);
        const dumbbell: Point2[] = [
            [0, 0],
            [10, 0],
            [10, 4],
            [12, 4],
            [12, 0],
            [22, 0],
            [22, 10],
            [12, 10],
            [12, 6],
            [10, 6],
            [10, 10],
            [0, 10],
        ];
        expect(offset([dumbbell], -1.5)).toHaveLength(2);
    });
});

describe("booleans", () => {
    test("union, difference and intersection areas", () => {
        const a = rect(0, 0, 10, 10);
        const b = rect(5, 5, 15, 15);
        expect(regionArea(union([a], [b]))).toBeCloseTo(175, 6);
        expect(regionArea(difference([a], [b]))).toBeCloseTo(75, 6);
        expect(regionArea(intersection([a], [b]))).toBeCloseTo(25, 6);
    });
});

describe("arc fitting", () => {
    test("a circle polygon comes back as two half arcs on the exact circle", () => {
        const path = fitArcs(circlePoints([3, 4], 7.5), true);
        expect(path.segments).toHaveLength(2);
        for (const segment of path.segments) {
            expect(segment.kind).toBe("arc");
            if (segment.kind !== "arc") continue;
            expect(segment.center[0]).toBeCloseTo(3, 4);
            expect(segment.center[1]).toBeCloseTo(4, 4);
            expect(arcRadius(segment)).toBeCloseTo(7.5, 4);
            expect(arcSweep(segment)).toBeCloseTo(Math.PI, 6);
        }
        expect(pathLength(path)).toBeCloseTo(2 * Math.PI * 7.5, 3);
    });

    test("a rounded rectangle is four lines and four quarter arcs", () => {
        const [rounded] = offset([rect(0, 0, 20, 10)], 3);
        const path = fitArcs(rounded, true);
        const arcs = path.segments.filter((s) => s.kind === "arc");
        const lines = path.segments.filter((s) => s.kind === "line");
        expect(arcs).toHaveLength(4);
        expect(lines).toHaveLength(4);
        for (const arc of arcs) {
            if (arc.kind !== "arc") continue;
            expect(arcRadius(arc)).toBeCloseTo(3, 3);
            expect(arcSweep(arc)).toBeCloseTo(Math.PI / 2, 2);
        }
        expect(pathLength(path)).toBeCloseTo(60 + 2 * Math.PI * 3, 2);
    });

    test("a polygon inscribed in a circle stays a polygon", () => {
        const hexagon = circlePoints([0, 0], 10, 5);
        expect(hexagon.length).toBe(8);
        const path = fitArcs(hexagon, true);
        expect(path.segments.every((s) => s.kind === "line")).toBe(true);
    });

    test("an open polyline keeps its start and fits its arc portion", () => {
        const half = circlePoints([0, 0], 5)
            .filter((p) => p[1] > 1e-9)
            .sort((a, b) => a[0] - b[0]);
        const points: Point2[] = [[-10, 0], [-5, 0], ...half, [5, 0], [10, 0]];
        const path = fitArcs(points, false);
        expect(path.segments[0].from).toEqual([-10, 0]);
        expect(path.segments.filter((s) => s.kind === "arc").length).toBeGreaterThanOrEqual(1);
        const closing = { kind: "line" as const, from: [10, 0] as Point2, to: [-10, 0] as Point2 };
        // Clockwise over the top half circle: the enclosed half disc counts negative.
        expect(pathSignedArea({ segments: [...path.segments, closing], closed: true })).toBeCloseTo(
            (-Math.PI * 25) / 2,
            3,
        );
    });

    test("sub-paths split arcs and lines by length", () => {
        const path = fitArcs(circlePoints([0, 0], 10), true);
        const quarter = subPath(path, 0, (Math.PI * 10) / 2);
        expect(pathLength(quarter)).toBeCloseTo((Math.PI * 10) / 2, 6);
        const points = pathPoints(quarter, 0.001);
        for (const p of points) expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 4);
    });
});

describe("ordering, tabs, nesting", () => {
    test("2-opt never makes a nearest-neighbour tour longer", () => {
        const points: Point2[] = [];
        for (let i = 0; i < 30; i++) points.push([(i * 37) % 101, (i * 53) % 97]);
        const order = shortPathOrder(points, [0, 0]);
        expect([...order].sort((a, b) => a - b)).toEqual(points.map((_, i) => i));
        const greedy = shortPathOrder(points, [0, 0], 0);
        expect(
            tourLength(
                order.map((i) => points[i]),
                [0, 0],
            ),
        ).toBeLessThanOrEqual(
            tourLength(
                greedy.map((i) => points[i]),
                [0, 0],
            ) + 1e-9,
        );
    });

    test("tab intervals are centred and wrap across the seam", () => {
        expect(tabCenters(100, 4)).toEqual([12.5, 37.5, 62.5, 87.5]);
        expect(tabIntervals(100, [1, 50], 4)).toEqual([
            { start: 0, end: 3 },
            { start: 48, end: 52 },
            { start: 99, end: 100 },
        ]);
    });

    test("rectangles nest without overlaps inside the margins", () => {
        const items = [
            { id: "a", width: 300, height: 200 },
            { id: "b", width: 300, height: 200 },
            { id: "c", width: 150, height: 400 },
            { id: "d", width: 100, height: 100 },
            { id: "e", width: 500, height: 80 },
        ];
        const result = nestRectangles(items, {
            sheet: { x: 0, y: 0, width: 1000, height: 500 },
            spacing: 10,
            margin: 5,
            allowRotation: true,
        });
        expect(result.unplaced).toEqual([]);
        expect(result.placed).toHaveLength(5);
        for (const a of result.placed) {
            expect(a.x).toBeGreaterThanOrEqual(5 - 1e-9);
            expect(a.y).toBeGreaterThanOrEqual(5 - 1e-9);
            expect(a.x + a.width).toBeLessThanOrEqual(995 + 1e-9);
            expect(a.y + a.height).toBeLessThanOrEqual(495 + 1e-9);
            for (const b of result.placed) {
                if (a === b) continue;
                const apart =
                    a.x + a.width + 10 <= b.x + 1e-9 ||
                    b.x + b.width + 10 <= a.x + 1e-9 ||
                    a.y + a.height + 10 <= b.y + 1e-9 ||
                    b.y + b.height + 10 <= a.y + 1e-9;
                expect(apart).toBe(true);
            }
        }
    });
});
