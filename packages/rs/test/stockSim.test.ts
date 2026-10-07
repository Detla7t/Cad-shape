// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { StockSimulator } from "../src";

const BOX = { min: [0, 0, -20], max: [60, 40, 0] } as const;

/** A box as 12 triangles. */
function boxMesh(min: readonly number[], max: readonly number[]) {
    const positions: number[] = [];
    for (let k = 0; k < 8; k++) {
        positions.push(k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]);
    }
    const faces = [
        [0, 2, 3, 1],
        [4, 5, 7, 6],
        [0, 1, 5, 4],
        [2, 6, 7, 3],
        [0, 4, 6, 2],
        [1, 3, 7, 5],
    ];
    const indices = faces.flatMap((f) => [f[0], f[1], f[2], f[0], f[2], f[3]]);
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

describe("the stock simulator", () => {
    test("a flat end mill slot through the stock removes width × length × depth", () => {
        const sim = new StockSimulator(BOX, 0.25);
        const tool = sim.addTool({ kind: "flat", diameter: 10 });
        const first = sim.addPath(
            tool,
            [-10, 20, 5, -10, 20, -3, 70, 20, -3, 70, 20, 5],
            [false, false, false],
        );
        expect(first).toBe(0);
        expect(sim.moveCount).toBe(3);
        expect(sim.run()).toBe(3);
        const removed = sim.removedVolumes();
        expect([...removed].map((v) => Math.round(v))).toEqual([0, 1800, 0]);
        expect(sim.volume()).toBeCloseTo(60 * 40 * 20 - 1800, 3);
        const grid = sim.grid();
        expect([grid.nx, grid.ny, grid.cellX, grid.bottom]).toEqual([240, 160, 0.25, -20]);
        const heights = sim.heights();
        expect(heights[80 * grid.nx + 120]).toBe(-3);
        expect(heights[10 * grid.nx + 120]).toBe(0);
        sim.dispose();
        expect(sim.disposed).toBe(true);
        expect(() => sim.run()).toThrow("disposed");
    });

    test("runs a range of moves at a time and seeks back for playback", () => {
        const sim = new StockSimulator(BOX, 0.5);
        const tool = sim.addTool({ kind: "ball", diameter: 6 });
        const points: number[] = [5, 5, 5];
        for (let k = 0; k < 30; k++) points.push(5 + k * 1.7, 5 + (k % 7) * 4, -1 - (k % 3));
        sim.addPath(tool, points, new Uint8Array(30));
        expect(sim.run(10)).toBe(10);
        const after10 = sim.heights();
        sim.run();
        expect(sim.cursor).toBe(30);
        const end = sim.volume();
        sim.seek(10);
        expect(sim.cursor).toBe(10);
        expect(sim.heights()).toEqual(after10);
        sim.seek(30);
        expect(sim.volume()).toBe(end);
        expect(sim.removedVolumes()).toHaveLength(30);
        sim.dispose();
    });

    test("reports a rapid into the stock and a holder collision by move", () => {
        const sim = new StockSimulator(BOX, 0.25);
        const tool = sim.addTool({
            kind: "flat",
            diameter: 6,
            fluteLength: 15,
            holder: { diameter: 20, length: 40, stickout: 20 },
        });
        sim.addPath(tool, [10, 10, 10, 10, 10, -2, 10, 10, 10], [true, true]);
        sim.addPath(tool, [30, 20, 10, 30, 20, -25, 30, 20, 10], [false, false]);
        sim.run();
        const warnings = sim.warnings();
        expect(warnings.map((w) => [w.kind, w.moveIndex])).toEqual([
            ["rapidInStock", 0],
            ["holderCollision", 2],
            ["holderCollision", 3],
        ]);
        expect(warnings[0].depth).toBeCloseTo(2, 6);
        expect(warnings[1].depth).toBeCloseTo(5, 6);
        sim.dispose();
    });

    test("compares with a part: excess everywhere above it, a gouge where a pass goes into it", () => {
        const sim = new StockSimulator(BOX, 0.25, { gougeTolerance: 0.02 });
        const part = boxMesh([10, 10, -20], [50, 30, -5]);
        sim.setPart(part.positions, part.indices);
        const tool = sim.addTool({ kind: "flat", diameter: 6 });
        sim.addPath(tool, [-5, 20, -4.5, 65, 20, -4.5, 65, 24, -4.5], [false, false]);
        sim.addPath(tool, [65, 24, -6.2, -5, 24, -6.2], [false]);
        sim.run();
        const gouges = sim.warnings().filter((w) => w.kind === "gouge");
        expect(gouges).toHaveLength(1);
        expect(gouges[0].moveIndex).toBe(2);
        expect(gouges[0].depth).toBeCloseTo(1.2, 4);
        const comparison = sim.comparison();
        expect(comparison).not.toBeUndefined();
        expect(comparison?.maxGouge).toBeCloseTo(1.2, 4);
        // Beside the part the whole 20 mm of stock is excess.
        expect(comparison?.maxExcess).toBeCloseTo(20, 4);
        const mesh = sim.mesh();
        expect(mesh.positions.length % 3).toBe(0);
        expect(mesh.normals).toHaveLength(mesh.positions.length);
        expect(mesh.deviation).toHaveLength(mesh.positions.length / 3);
        expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3);
        const finite = [...(mesh.deviation ?? [])].filter((d) => !Number.isNaN(d));
        expect(Math.min(...finite)).toBeCloseTo(-1.2, 4);
        sim.dispose();
    });

    test("an uncut box meshes as twelve triangles without deviation", () => {
        const sim = new StockSimulator(BOX, 1);
        const mesh = sim.mesh(2);
        expect(mesh.indices).toHaveLength(36);
        expect(mesh.deviation).toBeUndefined();
        expect(sim.comparison()).toBeUndefined();
        sim.dispose();
    });

    test("refuses bad input with the kernel's reason", () => {
        expect(() => new StockSimulator({ min: [0, 0, 0], max: [0, 10, 10] }, 0.5)).toThrow("empty");
        const sim = new StockSimulator(BOX, 0.5);
        expect(() => sim.addTool({ kind: "cone", diameter: 6, angle: 200 })).toThrow("angle");
        expect(() => sim.addTool({ kind: "flat", diameter: 0 })).toThrow("radius");
        expect(() => sim.addPath(0, [0, 0, 0, 1, 1, 1], [false])).toThrow("tool 0");
        const tool = sim.addTool({ kind: "drill", diameter: 8, angle: 118 });
        expect(() => sim.addPath(tool, [0, 0, 0, 1, 1], [false])).toThrow("triples");
        expect(() => sim.setPart(new Float32Array([0, 0, 0]), new Uint32Array([0, 1, 2]))).toThrow("range");
        sim.dispose();
    });
});
