// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Cutter,
    camOperation,
    DropCutter,
    roughingLevels,
    surfacingSetup,
    type ToolpathData,
    TriangleIndex,
    type Vec3,
    ZLEVEL_ROUGHING,
} from "../src";
import { difference, offset, type Point2, pointInLoops, regionArea } from "../src/geometry2d";
import { withinTolerance } from "./_helpers/gouge";
import { boxMesh, extrudeXZ, mergeMeshes, type TestMesh, toCamMesh } from "./_helpers/meshes";
import { testContext, testOperation, testTool } from "./_helpers/surfacing";

const BASE = { min: [-30, -20, 0], max: [30, 20, 10] };
const BOSS = { min: [-10, -10, 10], max: [10, 10, 20] };
const PART = mergeMeshes(boxMesh(BASE.min, BASE.max), boxMesh(BOSS.min, BOSS.max));
const STOCK = { min: [-33, -23, 0] as Vec3, max: [33, 23, 22] as Vec3 };
const TOOL = testTool("flatEndmill", 6);
const PARAMS = { stepdown: 3, stepover: 2.4, stockToLeave: 0.5, tolerance: 0.02, entry: "helix" };

function rect(min: readonly number[], max: readonly number[]): Point2[] {
    return [
        [min[0], min[1]],
        [max[0], min[1]],
        [max[0], max[1]],
        [min[0], max[1]],
    ];
}

async function rough(mesh: TestMesh, params: Record<string, unknown>, stock = STOCK) {
    const handler = camOperation(ZLEVEL_ROUGHING)!;
    expect(handler).not.toBeUndefined();
    const context = testContext(mesh, TOOL, { stock });
    const operation = testOperation(ZLEVEL_ROUGHING, {
        ...handler.defaults(context.machine, TOOL),
        ...params,
    });
    const result = await handler.generate(operation, context);
    expect(result.isOk).toBe(true);
    return { path: result.value as ToolpathData, context, operation };
}

/** Distance from a point to the nearest of many segments, through a bucket grid of `cell`. */
function nearestSegment(lines: readonly (readonly Point2[])[], cell: number): (p: Point2) => number {
    const buckets = new Map<string, number[][]>();
    for (const line of lines) {
        for (let k = 1; k < line.length; k++) {
            const [ax, ay] = line[k - 1];
            const [bx, by] = line[k];
            for (let i = Math.floor(Math.min(ax, bx) / cell); i <= Math.floor(Math.max(ax, bx) / cell); i++) {
                for (
                    let j = Math.floor(Math.min(ay, by) / cell);
                    j <= Math.floor(Math.max(ay, by) / cell);
                    j++
                ) {
                    const key = `${i},${j}`;
                    buckets.set(key, [...(buckets.get(key) ?? []), [ax, ay, bx, by]]);
                }
            }
        }
    }
    return ([px, py]) => {
        let best = Infinity;
        const i0 = Math.floor(px / cell);
        const j0 = Math.floor(py / cell);
        for (let i = i0 - 1; i <= i0 + 1; i++) {
            for (let j = j0 - 1; j <= j0 + 1; j++) {
                for (const [ax, ay, bx, by] of buckets.get(`${i},${j}`) ?? []) {
                    const dx = bx - ax;
                    const dy = by - ay;
                    const l2 = dx * dx + dy * dy;
                    const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
                    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
                }
            }
        }
        return best;
    };
}

/** Every cutting move as a polyline of tip points (arcs tessellated). */
function tessellate(path: ToolpathData): Vec3[][] {
    const out: Vec3[][] = [];
    let at: Vec3 | undefined;
    for (const move of path.moves) {
        if (move.kind === "linear" && at) out.push([at, move.to]);
        if (move.kind === "arc" && at) {
            const [cx, cy] = move.center;
            const a0 = Math.atan2(at[1] - cy, at[0] - cx);
            let a1 = Math.atan2(move.to[1] - cy, move.to[0] - cx);
            if (move.clockwise) while (a1 >= a0 - 1e-12) a1 -= 2 * Math.PI;
            else while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI;
            const radius = Math.hypot(at[0] - cx, at[1] - cy);
            const n = 32;
            const points: Vec3[] = [];
            for (let k = 0; k <= n; k++) {
                const a = a0 + ((a1 - a0) * k) / n;
                points.push([
                    cx + radius * Math.cos(a),
                    cy + radius * Math.sin(a),
                    at[2] + ((move.to[2] - at[2]) * k) / n,
                ]);
            }
            out.push(points);
        }
        if (move.kind === "rapid" || move.kind === "linear" || move.kind === "arc") at = move.to;
    }
    return out;
}

/** The pieces of the cutting moves that run at height z, as XY polylines (optionally without arcs). */
function atLevel(path: ToolpathData, z: number, arcs = true): Point2[][] {
    const lines: Point2[][] = [];
    for (const polyline of tessellate(path)) {
        if (!arcs && polyline.length > 2) continue;
        for (let k = 1; k < polyline.length; k++) {
            const a = polyline[k - 1];
            const b = polyline[k];
            if (Math.abs(a[2] - z) >= 1e-9 || Math.abs(b[2] - z) >= 1e-9) continue;
            // Chain onto the previous piece when it ends here (fewer, longer polylines).
            const last = lines[lines.length - 1];
            const end = last?.[last.length - 1];
            if (end && Math.abs(end[0] - a[0]) < 1e-12 && Math.abs(end[1] - a[1]) < 1e-12)
                last.push([b[0], b[1]]);
            else
                lines.push([
                    [a[0], a[1]],
                    [b[0], b[1]],
                ]);
        }
    }
    return lines;
}

describe("Z-level roughing", () => {
    test("levels fall every step-down and at the flat areas, at the axial stock to leave", async () => {
        const context = testContext(PART, TOOL, { stock: STOCK });
        const operation = testOperation(ZLEVEL_ROUGHING, PARAMS);
        const setup = surfacingSetup(operation, context, { tolerance: 0.02, stockToLeave: 0.3 }).value;
        const levels = (await roughingLevels(setup, PARAMS)).value;
        const heights = levels.map((level) => level.z);
        expect(heights[0]).toBeCloseTo(20.5, 9);
        expect(heights).toContain(10.5);
        expect(heights[heights.length - 1]).toBeCloseTo(0.5, 9);
        for (let k = 1; k < heights.length; k++) {
            expect(heights[k - 1] - heights[k]).toBeGreaterThan(0);
            expect(heights[k - 1] - heights[k]).toBeLessThanOrEqual(3 + 1e-9);
        }
        // Above the boss the whole box is clear; below the base top only a ring around it.
        const box = regionArea([rect(STOCK.min, STOCK.max)]);
        expect(regionArea(levels[0].region)).toBeGreaterThan(box);
        const low = levels.find((level) => level.z < 10)!;
        expect(regionArea(low.region)).toBeLessThan(box / 4);
    });

    test("each level clears the stock and leaves the stock to leave on the box with a boss", async () => {
        const { path, context, operation } = await rough(PART, PARAMS);
        const setup = surfacingSetup(operation, context, { tolerance: 0.02, stockToLeave: 0.3 }).value;
        const levels = (await roughingLevels(setup, operation.params)).value;
        expect(levels.length).toBe(10);
        const s = 0.5;
        const tolerance = 0.02;
        const stock = [rect(STOCK.min, STOCK.max)];
        // Sample the stock every 0.2 mm: a sample is cut when a tool centre path passes within
        // the tool radius (3) of it.
        const h = 0.2;
        for (const { z } of levels) {
            const distance = nearestSegment(atLevel(path, z), 3);
            const section = z >= 20 ? [] : z > 10 ? [rect(BOSS.min, BOSS.max)] : [rect(BASE.min, BASE.max)];
            const kept = offset(section, s - tolerance, { tolerance: 0.002 });
            const toCut = difference(stock, offset(section, s + tolerance, { tolerance: 0.002 }));
            let cut = 0;
            let intruding = 0;
            let uncut = 0;
            for (let x = STOCK.min[0] + h / 2; x < STOCK.max[0]; x += h) {
                for (let y = STOCK.min[1] + h / 2; y < STOCK.max[1]; y += h) {
                    const reached = distance([x, y]) <= 3;
                    if (reached) cut++;
                    // Nothing cut within the stock to leave (less the tolerance) ...
                    if (reached && kept.length > 0 && pointInLoops([x, y], kept)) intruding++;
                    // ... and all the stock cut beyond it (plus the tolerance).
                    if (!reached && pointInLoops([x, y], toCut)) uncut++;
                }
            }
            expect(cut * h * h).toBeGreaterThan(100);
            expect(intruding).toBe(0);
            expect(uncut * h * h).toBeLessThan(0.05);
            expect(regionArea(toCut)).toBeGreaterThan(100);
        }
    }, 60_000);

    test("no move goes under the stock-to-leave surface; entries are helices from the material top", async () => {
        const { path } = await rough(PART, PARAMS);
        const cam = toCamMesh(PART);
        const drop = new DropCutter(
            new TriangleIndex(cam.positions, cam.indices),
            Cutter.flat(3).offset(0.5),
            {
                lift: 0.5,
                floor: 0.5,
            },
        );
        for (const polyline of tessellate(path)) {
            for (const [x, y, z] of polyline) expect(withinTolerance(drop, x, y, z, 0.02)).toBe(true);
        }
        expect(path.moves.filter((move) => move.kind === "arc").length).toBeGreaterThan(10);
        // Straight down only through air: never more than the feed start distance.
        let at: Vec3 | undefined;
        for (const move of path.moves) {
            if (move.kind === "linear" && at && Math.hypot(move.to[0] - at[0], move.to[1] - at[1]) < 1e-9) {
                expect(at[2] - move.to[2]).toBeLessThanOrEqual(1 + 1e-9);
            }
            if (move.kind === "rapid" || move.kind === "linear" || move.kind === "arc") at = move.to;
        }
    }, 60_000);

    test("ramp entries descend along the ring no steeper than the ramp angle", async () => {
        const { path } = await rough(PART, { ...PARAMS, entry: "ramp", rampAngle: 5 });
        let at: Vec3 | undefined;
        let ramps = 0;
        for (const move of path.moves) {
            if (move.kind === "linear" && at && move.to[2] < at[2] - 1e-9) {
                const run = Math.hypot(move.to[0] - at[0], move.to[1] - at[1]);
                if (run > 1e-9) {
                    ramps++;
                    expect((at[2] - move.to[2]) / run).toBeLessThanOrEqual(
                        Math.tan((5 * Math.PI) / 180) + 1e-9,
                    );
                } else {
                    expect(at[2] - move.to[2]).toBeLessThanOrEqual(1 + 1e-9);
                }
            }
            if (move.kind === "rapid" || move.kind === "linear" || move.kind === "arc") at = move.to;
        }
        expect(ramps).toBeGreaterThan(5);
        expect(path.moves.some((move) => move.kind === "arc")).toBe(false);
    });

    test("intermediate levels clear only the steps the main levels leave on sloped walls", async () => {
        // A block with both ends sloped at 45°.
        const wedge = extrudeXZ(
            [
                [0, 0],
                [40, 0],
                [30, 10],
                [10, 10],
            ],
            0,
            20,
        );
        const stock = { min: [-3, -3, 0] as Vec3, max: [43, 23, 10] as Vec3 };
        const params = { stepdown: 4, stepover: 2.4, stockToLeave: 0, tolerance: 0.02, intermediateSteps: 1 };
        const context = testContext(wedge, TOOL, { stock });
        const operation = testOperation(ZLEVEL_ROUGHING, params);
        const setup = surfacingSetup(operation, context, { tolerance: 0.02, stockToLeave: 0 }).value;
        const levels = (await roughingLevels(setup, params)).value;
        const rest = levels.filter((level) => level.rest);
        expect(rest.length).toBeGreaterThanOrEqual(2);
        const { path } = await rough(wedge, params, stock);
        for (const level of rest) {
            const index = levels.indexOf(level);
            const below = levels
                .slice(0, index)
                .reverse()
                .find((candidate) => !candidate.rest)!;
            const lines = atLevel(path, level.z, false);
            expect(lines.length).toBeGreaterThan(0);
            // Rings cut only where the main level below could not go: never inside the region it
            // cleared, past its boundary (a helix entry may circle out into that cleared air).
            const cleared = offset(below.region, -0.05, { tolerance: 0.005 });
            for (const line of lines)
                for (const point of line) expect(pointInLoops(point, cleared)).toBe(false);
            expect(regionArea(level.region)).toBeLessThan(regionArea(below.region) / 3);
        }
    });
});
