// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    distanceToLoops,
    offset,
    type Point2,
    pocketOperation,
    pointInLoops,
    type ToolpathData,
} from "../src";
import { circleLoop, cuttingSamples, fakeContext, millTool, operation, rectLoop } from "./_helpers/context";

/**
 * A 40×30 rectangular pocket around a Ø10 island, cut 6 deep with a Ø6 end mill: the tool
 * centre keeps its radius (plus stock to leave) from the walls and the island, the last wall
 * pass sits exactly there, and every point the tool can reach is cut.
 */

const outer = rectLoop(0, 0, 40, 30);
const island = circleLoop([20, 15], 5, 0.001, false);
const walls = [outer, island];
const r = 3;

function generate(params: Record<string, unknown>): ToolpathData {
    const context = fakeContext({
        tool: millTool(6),
        loops: [
            { points: outer, closed: true, role: "sketch", z: -6 },
            { points: island, closed: true, role: "sketch", z: -6 },
        ],
        stock: { min: [-5, -5, -10], max: [45, 35, 0] },
    });
    const result = pocketOperation.generate(operation("pocket2d", params), context);
    if (!("isOk" in result)) throw new Error("pocket generation is synchronous");
    expect(result.isOk).toBe(true);
    return result.value;
}

function checkPocket(path: ToolpathData, stockToLeave: number) {
    const samples = cuttingSamples(path, 0.2);
    const inside = samples.filter((s) => s.z < 0 - 1e-6);
    expect(inside.length).toBeGreaterThan(100);
    let nearest = Number.POSITIVE_INFINITY;
    for (const { p } of inside) {
        // Inside the pocket, outside the island, and at least r + stock from every wall.
        expect(pointInLoops(p, walls)).toBe(true);
        const d = distanceToLoops(p, walls);
        expect(d).toBeGreaterThanOrEqual(r + stockToLeave - 2e-3);
        nearest = Math.min(nearest, d);
    }
    // The wall pass runs exactly at r + stock to leave.
    expect(nearest).toBeCloseTo(r + stockToLeave, 2);

    // Full coverage at the floor: every point the tool can reach is within r of a pass.
    const floor = samples.filter((s) => Math.abs(s.z + 6) < 1e-6).map((s) => s.p);
    const buckets = new Map<string, Point2[]>();
    const cell = (p: Point2) => [Math.floor(p[0] / r), Math.floor(p[1] / r)];
    for (const f of floor) {
        const [i, j] = cell(f);
        const key = `${i},${j}`;
        buckets.set(key, [...(buckets.get(key) ?? []), f]);
    }
    const nearestFloor = (q: Point2) => {
        const [i, j] = cell(q);
        let best = Number.POSITIVE_INFINITY;
        for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
                for (const f of buckets.get(`${i + di},${j + dj}`) ?? [])
                    best = Math.min(best, Math.hypot(f[0] - q[0], f[1] - q[1]));
            }
        }
        return best;
    };
    const reachable = offset(walls, -(r + stockToLeave));
    let checked = 0;
    for (let x = 0.25; x < 40; x += 0.5) {
        for (let y = 0.25; y < 30; y += 0.5) {
            const q: Point2 = [x, y];
            if (!pointInLoops(q, walls) || distanceToLoops(q, walls) < stockToLeave + 0.01) continue;
            // Reachable: within r of where the tool centre may go.
            const centreOk = pointInLoops(q, reachable) || distanceToLoops(q, reachable) <= r - 0.01;
            if (!centreOk) continue;
            // Floor samples are 0.2 apart: a point r from a pass is within r + 0.1 of a sample.
            expect(nearestFloor(q)).toBeLessThanOrEqual(r + 0.1);
            checked++;
        }
    }
    expect(checked).toBeGreaterThan(3000);
}

describe("2D pocket", () => {
    test("offset strategy keeps the tool off the walls and island and clears the floor", () => {
        const path = generate({
            strategy: "offset",
            stepover: 45,
            stepdown: 3,
            stockToLeave: 0,
            bottomFrom: "geometry",
        });
        checkPocket(path, 0);
        // Two levels: -3 and -6.
        const zs = new Set(cuttingSamples(path).map((s) => Math.round(s.z * 1000) / 1000));
        expect(zs.has(-3)).toBe(true);
        expect(zs.has(-6)).toBe(true);
        expect(Math.min(...zs)).toBe(-6);
        // Offset rings come out as arcs around the island.
        expect(path.moves.some((m) => m.kind === "arc")).toBe(true);
    });

    test("the last pass leaves the stock to leave", () => {
        checkPocket(generate({ strategy: "offset", stepover: 40, stepdown: 6, stockToLeave: 0.3 }), 0.3);
    });

    test("zig-zag rows plus the boundary ring cover the pocket too", () => {
        checkPocket(
            generate({ strategy: "zigzag", stepover: 45, stepdown: 6, stockToLeave: 0, zigzagAngle: 0 }),
            0,
        );
    });

    test("a finishing pass runs at r + stock after roughing at r + stock + finish stock", () => {
        const path = generate({
            strategy: "offset",
            stepover: 45,
            stepdown: 6,
            finishPass: true,
            finishStock: 0.5,
        });
        checkPocket(path, 0);
        const finish = path.moves.findIndex((m) => m.kind === "comment" && m.text === "Finishing pass");
        expect(finish).toBeGreaterThan(0);
        const rough = cuttingSamples({ ...path, moves: path.moves.slice(0, finish) }).filter(
            (s) => s.z < -1e-6,
        );
        const closest = Math.min(...rough.map((s) => distanceToLoops(s.p, walls)));
        expect(closest).toBeCloseTo(r + 0.5, 2);
    });

    test("helix entry descends no steeper than the ramp angle", () => {
        const path = generate({
            strategy: "offset",
            stepover: 45,
            stepdown: 3,
            entry: "helix",
            rampAngle: 3,
            helixRadius: 2,
        });
        const helix = path.moves.filter((m) => m.kind === "arc");
        expect(helix.length).toBeGreaterThan(0);
        let at: readonly number[] | undefined;
        let steepest = 0;
        for (const move of path.moves) {
            if (move.kind === "arc" && at !== undefined && move.to[2] < at[2] - 1e-9) {
                const r0 = Math.hypot(at[0] - move.center[0], at[1] - move.center[1]);
                const length = Math.PI * r0; // half circles
                steepest = Math.max(steepest, (at[2] - move.to[2]) / length);
            }
            if ("to" in move) at = move.to;
        }
        expect(steepest).toBeGreaterThan(0);
        expect(steepest).toBeLessThanOrEqual(Math.tan((3 * Math.PI) / 180) + 1e-9);
    });

    test("a tool too large for the pocket is an error", () => {
        const context = fakeContext({
            tool: millTool(32),
            loops: [{ points: outer, closed: true, z: -6 }],
            stock: { min: [-5, -5, -10], max: [45, 35, 0] },
        });
        const result = pocketOperation.generate(operation("pocket2d", {}), context);
        expect("isOk" in result && result.isOk).toBe(false);
    });

    test("no selection is an error", () => {
        const context = fakeContext({ stock: { min: [0, 0, -10], max: [10, 10, 0] } });
        const result = pocketOperation.generate(operation("pocket2d", {}), context);
        expect("isOk" in result && !result.isOk && result.error).toContain("Select");
    });
});
