// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Cutter, cutterForTool, DropCutter, holderForTool, type ToolData, TriangleIndex } from "../src";
import { boxMesh, hemisphereMesh, mergeMeshes, planeMesh, type TestMesh } from "./_helpers/meshes";

function dropper(mesh: TestMesh, cutter: Cutter, options = {}) {
    return new DropCutter(new TriangleIndex(mesh.positions, mesh.indices), cutter, options);
}

const CUTTERS: [string, Cutter][] = [
    ["flat", Cutter.flat(3)],
    ["ball", Cutter.ball(3)],
    ["bull", Cutter.bull(3, 1)],
    ["cone", Cutter.cone(3, 90)],
];

describe("triangle index", () => {
    test("rectangle queries find exactly the overlapping triangles and skip degenerate ones", () => {
        const mesh = hemisphereMesh(10, 48, 24);
        const degenerate = {
            positions: new Float64Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
            indices: new Uint32Array([0, 1, 2]),
        };
        const index = new TriangleIndex(
            mergeMeshes(mesh, degenerate).positions,
            mergeMeshes(mesh, degenerate).indices,
        );
        expect(index.count).toBe(mesh.indices.length / 3);
        const rect = [-2.5, 1, 4, 6.5] as const;
        const found = new Set<number>();
        index.forEachInRect(rect[0], rect[1], rect[2], rect[3], (t) => found.add(t));
        let expected = 0;
        for (let t = 0; t < index.count; t++) {
            const b = index.bounds.subarray(t * 6, t * 6 + 6);
            const overlaps = b[0] <= rect[2] && b[3] >= rect[0] && b[1] <= rect[3] && b[4] >= rect[1];
            if (overlaps) {
                expected++;
                expect(found.has(t)).toBe(true);
            }
        }
        expect(found.size).toBe(expected);
        expect(expected).toBeGreaterThan(10);
    });

    test("each welded vertex and edge is owned by exactly one triangle", () => {
        const index = new TriangleIndex(
            boxMesh([0, 0, 0], [1, 1, 1]).positions,
            boxMesh([0, 0, 0], [1, 1, 1]).indices,
        );
        let vertices = 0;
        let edges = 0;
        for (const owns of index.owns) {
            for (let bit = 0; bit < 3; bit++) vertices += (owns >> bit) & 1;
            for (let bit = 3; bit < 6; bit++) edges += (owns >> bit) & 1;
        }
        expect(vertices).toBe(8);
        expect(edges).toBe(18); // 12 box edges + 6 face diagonals
    });
});

describe("drop-cutter", () => {
    test.each(CUTTERS)("%s cutter on a plane at z = 5 stands on it", (_name, cutter) => {
        const drop = dropper(planeMesh(5, 40, 3), cutter);
        for (const [x, y] of [
            [0, 0],
            [3.3, -7.1],
            [-12, 4.44],
            [6.6667, 6.6667],
        ]) {
            expect(drop.drop(x, y)).toBeCloseTo(5, 9);
        }
    });

    test("ball over a hemisphere: tip = √((R + r)² − d²) − r above the centre", () => {
        const R = 10;
        const r = 3;
        const drop = dropper(hemisphereMesh(R, 256, 128), Cutter.ball(r));
        // The mesh is inscribed: at most its sag below the sphere (≈ 1e-3 here), never above.
        for (const [d, angle] of [
            [0, 0],
            [2, 0.3],
            [5, 1.1],
            [8, 2.5],
            [10.5, 4],
            [12.5, 5.5],
        ]) {
            const analytic = Math.sqrt((R + r) ** 2 - d * d) - r;
            const z = drop.drop(d * Math.cos(angle), d * Math.sin(angle));
            expect(z).toBeLessThanOrEqual(analytic + 1e-9);
            expect(z).toBeGreaterThan(analytic - 2e-3);
        }
        expect(drop.drop(13.2, 0)).toBe(-Infinity);
    });

    test("edges of a box: flat, ball, bull and cone contacts are exact", () => {
        const box = boxMesh([0, 0, 0], [10, 10, 10]);
        const flat = dropper(box, Cutter.flat(3));
        expect(flat.drop(12.9, 5)).toBe(10);
        expect(flat.drop(13.1, 5)).toBe(-Infinity);
        expect(flat.drop(5, -2.999)).toBe(10);

        const ball = dropper(box, Cutter.ball(3));
        const bull = dropper(box, Cutter.bull(3, 1));
        const cone = dropper(box, Cutter.cone(3, 90));
        for (const d of [0.4, 1.7, 2.2, 2.9]) {
            expect(ball.drop(10 + d, 5)).toBeCloseTo(10 - (3 - Math.sqrt(9 - d * d)), 9);
            expect(bull.drop(5, -d)).toBeCloseTo(d <= 2 ? 10 : 10 - (1 - Math.sqrt(1 - (d - 2) ** 2)), 9);
            expect(cone.drop(10 + d, 7)).toBeCloseTo(10 - d, 9);
        }
        // Past the corner the vertex is the contact.
        const d = Math.hypot(1.2, 1.6);
        expect(ball.drop(11.2, 11.6)).toBeCloseTo(10 - (3 - Math.sqrt(9 - d * d)), 9);
    });

    test("inclined plane: facet contacts follow each profile", () => {
        const slope = Math.tan(Math.PI / 6);
        const size = 200;
        const mesh: TestMesh = {
            positions: new Float64Array([
                -size,
                -size,
                -size * slope,
                size,
                -size,
                size * slope,
                size,
                size,
                size * slope,
                -size,
                size,
                -size * slope,
            ]),
            indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        };
        const x = 3.7;
        const at = x * slope;
        const cos = Math.cos(Math.PI / 6);
        const sin = Math.sin(Math.PI / 6);
        expect(dropper(mesh, Cutter.ball(3)).drop(x, 1)).toBeCloseTo(at + 3 / cos - 3, 9);
        expect(dropper(mesh, Cutter.flat(3)).drop(x, 1)).toBeCloseTo((x + 3) * slope, 9);
        const dc = 2 + sin; // bull: flat radius + r·sin
        expect(dropper(mesh, Cutter.bull(3, 1)).drop(x, 1)).toBeCloseTo(at + dc * slope - (1 - cos), 9);
        expect(dropper(mesh, Cutter.cone(3, 90)).drop(x, 1)).toBeCloseTo(at, 9);
        const wide = Cutter.cone(3, 150); // flatter than the plane: touches with its rim
        expect(dropper(mesh, wide).drop(x, 1)).toBeCloseTo(at + 3 * slope - wide.height(3), 9);
    });

    test.each([
        ["bull", Cutter.bull(4, 1.5)],
        ["cone", Cutter.cone(4, 70)],
        ["offset cone", Cutter.cone(4, 70).offset(0.7)],
        ["offset flat", Cutter.flat(4).offset(0.5)],
    ])("%s on a sloped edge matches a brute-force search along the edge", (_name, cutter) => {
        const mesh: TestMesh = {
            positions: new Float64Array([-5, -1, 2, 6, 3, 7, 0, 9, -30]),
            indices: new Uint32Array([0, 1, 2]),
        };
        const drop = dropper(mesh, cutter);
        for (const [x, y] of [
            [1, -2],
            [3, 0.5],
            [-2, -3.2],
            [5, 0],
        ]) {
            let best = -Infinity;
            const samples = 400000;
            for (let i = 0; i <= samples; i++) {
                const t = i / samples;
                const px = -5 + 11 * t;
                const py = -1 + 4 * t;
                const pz = 2 + 5 * t;
                const d = Math.hypot(px - x, py - y);
                if (d <= cutter.radius) best = Math.max(best, pz - cutter.height(d));
            }
            expect(best).toBeGreaterThan(-Infinity);
            // The facet slopes away (down towards the third vertex): the edge is the contact.
            expect(drop.drop(x, y)).toBeCloseTo(best, 6);
        }
    });

    test("a holder wider than the cutter is kept off a tall wall", () => {
        const wall = boxMesh([7, -20, 0], [12, 20, 40]);
        const floor = planeMesh(0, 60, 2);
        const index = new TriangleIndex(mergeMeshes(wall, floor).positions, mergeMeshes(wall, floor).indices);
        const bare = new DropCutter(index, Cutter.flat(3));
        expect(bare.drop(0, 0)).toBe(0);
        const held = new DropCutter(index, Cutter.flat(3), { holder: { radius: 10, offset: 20 } });
        expect(held.drop(0, 0)).toBe(20);
        expect(held.drop(-4, 0)).toBe(0);
        const tool: ToolData = {
            id: "t",
            number: 1,
            name: "6mm flat",
            kind: "flatEndmill",
            diameter: 6,
            stickout: 20,
            holder: { diameter: 20, length: 40 },
            cutting: { feed: 1000 },
        };
        expect(holderForTool(tool)).toEqual({ radius: 10, offset: 20 });
    });

    test("a cutter grown by the stock to leave and lifted by it leaves that much", () => {
        const box = boxMesh([0, 0, 0], [10, 10, 10]);
        const index = new TriangleIndex(box.positions, box.indices);
        const s = 0.5;
        const drop = new DropCutter(index, Cutter.flat(3).offset(s), { lift: s });
        expect(drop.drop(5, 5)).toBeCloseTo(10.5, 9);
        // Beside the wall: the grown cutter's corner (radius s) rides the top edge.
        const d = 3.2;
        expect(drop.drop(10 + d, 5)).toBeCloseTo(10 - (s - Math.sqrt(s * s - (d - 3) ** 2)) + s, 9);
        expect(drop.drop(10 + 3.5 + 1e-6, 5)).toBe(-Infinity);
    });

    test("tools map to their profiles", () => {
        const tool = (kind: ToolData["kind"], extra: Partial<ToolData> = {}): ToolData => ({
            id: kind,
            number: 1,
            name: kind,
            kind,
            diameter: 8,
            cutting: { feed: 1000 },
            ...extra,
        });
        expect(cutterForTool(tool("ballEndmill")).value.kind).toBe("ball");
        expect(cutterForTool(tool("flatEndmill")).value.kind).toBe("flat");
        const bull = cutterForTool(tool("bullNose", { cornerRadius: 1 })).value;
        expect([bull.flatRadius, bull.cornerRadius]).toEqual([3, 1]);
        const vBit = cutterForTool(tool("vBit", { tipAngle: 60 })).value;
        expect(vBit.height(4)).toBeCloseTo(4 / Math.tan(Math.PI / 6), 12);
        expect(cutterForTool(tool("jet")).isOk).toBe(false);
    });

    test("paths stay on or above the surface: walls become vertical steps", () => {
        const box = boxMesh([0, 0, 0], [10, 10, 10]);
        const floor = planeMesh(0, 60, 2);
        const merged = mergeMeshes(box, floor);
        const drop = dropper(merged, Cutter.flat(3));
        const tolerance = 0.01;
        const points = drop.dropPath(-10, 5, 20, 5, { sampling: 1, tolerance });
        const zs: number[] = [];
        for (let k = 0; k < points.length; k += 3) zs.push(points[k + 2]);
        expect(Math.min(...zs)).toBe(0);
        expect(Math.max(...zs)).toBe(10);
        // Every point is on or above the cutter-location surface ...
        for (let k = 0; k < points.length; k += 3) {
            expect(points[k + 2]).toBeGreaterThanOrEqual(drop.drop(points[k], points[k + 1]) - 1e-12);
        }
        // ... and so is every segment, to the tolerance.
        for (let k = 3; k < points.length; k += 3) {
            for (let i = 1; i < 20; i++) {
                const s = i / 20;
                const x = points[k - 3] + (points[k] - points[k - 3]) * s;
                const z = points[k - 1] + (points[k + 2] - points[k - 1]) * s;
                expect(z).toBeGreaterThanOrEqual(drop.drop(x, 5) - tolerance);
            }
        }
    });
});
