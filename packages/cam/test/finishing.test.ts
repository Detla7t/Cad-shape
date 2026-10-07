// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IFace } from "@chili3d/core";
import {
    Cutter,
    camOperation,
    DropCutter,
    HeightField,
    PARALLEL_3D,
    SCALLOP_3D,
    scallopStepover,
    surfacingSetup,
    type ToolpathData,
    TriangleIndex,
    type Vec3,
    WATERLINE_3D,
    waterlineLevels,
} from "../src";
import { signedArea } from "../src/geometry2d";
import { withinTolerance } from "./_helpers/gouge";
import {
    cylinderMesh,
    extrudeXZ,
    hemisphereMesh,
    mergeMeshes,
    planeMesh,
    type TestMesh,
    toCamMesh,
} from "./_helpers/meshes";
import { cutPoints, cutSegments, testContext, testOperation, testTool } from "./_helpers/surfacing";

const UNBOUNDED = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };

function indexOf(mesh: TestMesh) {
    return new TriangleIndex(mesh.positions, mesh.indices);
}

/** The index of the single-precision mesh an operation context hands out. */
function camIndexOf(mesh: TestMesh) {
    const cam = toCamMesh(mesh);
    return new TriangleIndex(cam.positions, cam.indices);
}

async function generate(
    type: string,
    mesh: TestMesh,
    tool = testTool("ballEndmill", 6),
    params = {},
    margin = 2,
    faces: IFace[] = [],
) {
    const handler = camOperation(type)!;
    expect(handler).not.toBeUndefined();
    const context = testContext(mesh, tool, { margin, faces });
    const operation = testOperation(type, { ...handler.defaults(context.machine, tool), ...params });
    const result = await handler.generate(operation, context);
    expect(result.isOk).toBe(true);
    return result.value as ToolpathData;
}

/**
 * Feed moves never take the tip under the cutter-location surface: points by no more than a
 * nanometre-scale level epsilon, segments by no more than `tolerance` (3D distance).
 */
function expectNoGouge(path: ToolpathData, drop: DropCutter, tolerance: number) {
    const points = cutPoints(path);
    expect(points.length).toBeGreaterThan(10);
    for (const [x, y, z] of points) expect(z).toBeGreaterThanOrEqual(drop.drop(x, y) - 2e-6);
    for (const [a, b] of cutSegments(path)) {
        for (let i = 1; i < 8; i++) {
            const s = i / 8;
            const x = a[0] + (b[0] - a[0]) * s;
            const y = a[1] + (b[1] - a[1]) * s;
            expect(withinTolerance(drop, x, y, a[2] + (b[2] - a[2]) * s, tolerance)).toBe(true);
        }
    }
}

describe("parallel finishing", () => {
    const R = 10;
    const r = 3;
    const mesh = hemisphereMesh(R, 128, 64); // sag ≈ 0.004
    const sag = 0.004;

    test("passes over a hemisphere follow the analytic offset surface and never gouge", async () => {
        const tolerance = 0.01;
        const path = await generate(PARALLEL_3D, mesh, testTool("ballEndmill", 2 * r), {
            angle: 30,
            stepover: 0.8,
            tolerance,
            boundary: "stock",
            leadDistance: 0,
        });
        const drop = new DropCutter(camIndexOf(mesh), Cutter.ball(r), { floor: 0 });
        expectNoGouge(path, drop, tolerance);
        // The mesh lies between the sphere and the sphere shrunk by its sag: every point lies
        // between their offset surfaces (or above by a vertical step where a wall is cut).
        const offsetSurface = (radius: number, d: number) =>
            d < radius + r ? Math.max(0, Math.sqrt((radius + r) ** 2 - d * d) - r) : 0;
        let onDome = 0;
        for (const [x, y, z] of cutPoints(path)) {
            const d = Math.hypot(x, y);
            expect(z).toBeGreaterThanOrEqual(offsetSurface(R - sag, d) - 1e-6);
            expect(z).toBeLessThanOrEqual(offsetSurface(R, d) + tolerance);
            if (d < R) onDome++;
        }
        expect(onDome).toBeGreaterThan(200);
    }, 60_000);

    test("zig-zag passes stay down between neighbours; retract linking lifts between every pass", async () => {
        const params = { stepover: 1.5, boundary: "stock", leadDistance: 0 };
        const stayDown = await generate(PARALLEL_3D, mesh, testTool("ballEndmill", 6), params);
        const retract = await generate(PARALLEL_3D, mesh, testTool("ballEndmill", 6), {
            ...params,
            linking: "retract",
        });
        const rapids = (path: ToolpathData) => path.moves.filter((move) => move.kind === "rapid").length;
        // 24 mm of stock at 1.5 mm stepover: 17 passes, 16 links of up, over, down.
        expect(rapids(stayDown)).toBeLessThanOrEqual(4);
        expect(rapids(retract)).toBe(2 + 3 * 16 + 1);
    });

    test("scallop height sets the stepover; the height range clips and clamps passes", async () => {
        expect(scallopStepover(Cutter.ball(3), 0.01)).toBeCloseTo(2 * Math.sqrt(2 * 3 * 0.01 - 0.0001), 12);
        expect(scallopStepover(Cutter.bull(3, 1), 0.01)).toBeCloseTo(4 + 2 * Math.sqrt(0.02 - 0.0001), 12);
        const path = await generate(PARALLEL_3D, mesh, testTool("ballEndmill", 6), {
            stepoverMode: "scallop",
            scallopHeight: 0.05,
            boundary: "stock",
            minZ: 2,
            maxZ: 8,
            leadDistance: 0,
        });
        const zs = cutPoints(path).map((point) => point[2]);
        expect(Math.min(...zs)).toBeCloseTo(2, 9);
        expect(Math.max(...zs)).toBeLessThanOrEqual(8 + 1e-9);
    });

    test("the silhouette boundary keeps the tool centre over the part", async () => {
        const path = await generate(PARALLEL_3D, mesh, testTool("ballEndmill", 6), {
            stepover: 1,
            boundary: "silhouette",
            containment: "center",
            leadDistance: 0,
        });
        for (const [x, y] of cutPoints(path)) expect(Math.hypot(x, y)).toBeLessThanOrEqual(R + 0.02);
    });

    test("selected faces bound the passes by their silhouette", async () => {
        // The cap of the dome above z = 8 (radius 6) as one picked face.
        const index: number[] = [];
        for (let t = 0; t < mesh.indices.length; t += 3) {
            const corners = [0, 1, 2].map((k) => mesh.indices[t + k]);
            if (corners.every((v) => mesh.positions[v * 3 + 2] >= 8 - 1e-9)) index.push(...corners);
        }
        const face = {
            mesh: { faces: { position: new Float32Array(mesh.positions), index: new Uint32Array(index) } },
        };
        const path = await generate(
            PARALLEL_3D,
            mesh,
            testTool("ballEndmill", 6),
            { stepover: 0.5, boundary: "selection", containment: "center", leadDistance: 0 },
            2,
            [face as unknown as IFace],
        );
        const points = cutPoints(path);
        expect(points.length).toBeGreaterThan(100);
        const cap = Math.sqrt(R * R - 64);
        for (const [x, y] of points) expect(Math.hypot(x, y)).toBeLessThanOrEqual(cap + 0.02);
        expect(Math.max(...points.map(([x, y]) => Math.hypot(x, y)))).toBeGreaterThan(cap - 0.5);
    });

    test("scallop rings are the boundary's offsets dropped onto the dome", async () => {
        const tolerance = 0.01;
        const path = await generate(SCALLOP_3D, mesh, testTool("ballEndmill", 2 * r), {
            stepover: 1,
            tolerance,
            boundary: "silhouette",
            containment: "center",
            leadDistance: 0,
        });
        expectNoGouge(path, new DropCutter(camIndexOf(mesh), Cutter.ball(r), { floor: 0 }), tolerance);
        const offsetSurface = (radius: number, d: number) =>
            d < radius + r ? Math.max(0, Math.sqrt((radius + r) ** 2 - d * d) - r) : 0;
        const rings = new Set<number>();
        let onRing = 0;
        const points = cutPoints(path);
        for (const [x, y, z] of points) {
            const d = Math.hypot(x, y);
            expect(z).toBeGreaterThanOrEqual(offsetSurface(R - sag, d) - 1e-6);
            expect(z).toBeLessThanOrEqual(offsetSurface(R, d) + tolerance);
            // Rings at 10, 9, 8, … mm from the axis (links between them excepted).
            const k = Math.round(R - d);
            if (Math.abs(d - (R - k)) < 0.02) {
                onRing++;
                rings.add(k);
            }
        }
        expect(onRing).toBeGreaterThan(0.9 * points.length);
        expect(rings.size).toBeGreaterThanOrEqual(9);
        // Outside in, counter-clockwise: the first ring is the boundary.
        const first = points.slice(1, 20).map(([x, y]) => [x, y] as const);
        expect(Math.hypot(...first[0])).toBeGreaterThan(R - 0.05);
        expect(signedArea(first)).toBeGreaterThan(0);
    }, 60_000);

    test("one-way passes all cut in the pass direction", async () => {
        const path = await generate(PARALLEL_3D, mesh, testTool("ballEndmill", 6), {
            direction: "oneWay",
            stepover: 2,
            boundary: "stock",
            leadDistance: 0,
        });
        let passes = 0;
        for (const [a, b] of cutSegments(path)) {
            if (Math.abs(b[0] - a[0]) < 1e-9 && Math.abs(b[1] - a[1]) < 1e-9) continue;
            expect(b[0] - a[0]).toBeGreaterThan(0);
            expect(Math.abs(b[1] - a[1])).toBeLessThan(1e-9);
            passes++;
        }
        expect(passes).toBeGreaterThan(50);
    });
});

describe("waterline", () => {
    const Rc = 10;
    const segments = 128;
    const inner = Rc * Math.cos(Math.PI / segments);
    const cylinder = cylinderMesh(Rc, 0, 20, segments);

    test.each([
        ["ball", Cutter.ball(3)],
        ["flat", Cutter.flat(3)],
        ["bull", Cutter.bull(3, 1)],
    ])("%s contours around a cylinder are circles of radius R + r", async (_name, cutter) => {
        const tolerance = 0.005;
        const field = await HeightField.build(new DropCutter(indexOf(cylinder), cutter), UNBOUNDED, 0.5);
        for (const z of [2, 9.3, 15]) {
            const loops = await field.contours(z, tolerance);
            expect(loops.length).toBe(1);
            const [loop] = loops;
            expect(signedArea(loop)).toBeGreaterThan(0); // material on the left: counter-clockwise
            for (let k = 0; k < loop.length; k++) {
                const [x, y] = loop[k];
                const radius = Math.hypot(x, y);
                expect(radius).toBeGreaterThanOrEqual(inner + 3 - 1e-3);
                // Points sit on the safe side within a quarter of the tolerance.
                expect(radius).toBeLessThanOrEqual(Rc + 3 + tolerance / 4);
                const [nx, ny] = loop[(k + 1) % loop.length];
                expect(Math.hypot((x + nx) / 2, (y + ny) / 2)).toBeGreaterThan(inner + 3 - tolerance);
            }
        }
    });

    test("a cone's contour shrinks to the top edge near the top", async () => {
        const field = await HeightField.build(
            new DropCutter(indexOf(cylinder), Cutter.cone(3, 90)),
            UNBOUNDED,
            0.5,
        );
        const [low] = await field.contours(10, 0.005);
        for (const [x, y] of low) expect(Math.hypot(x, y)).toBeGreaterThan(inner + 3 - 1e-3);
        const [high] = await field.contours(18.5, 0.005);
        for (const [x, y] of high) {
            const radius = Math.hypot(x, y);
            expect(radius).toBeGreaterThan(inner + 1.5 - 1e-3);
            expect(radius).toBeLessThanOrEqual(Rc + 1.5 + 0.005 / 4);
        }
    });

    test("the operation cuts climb (clockwise) circles at each step down a boss", async () => {
        const part = mergeMeshes(cylinder, planeMesh(0, 50, 2));
        const path = await generate(WATERLINE_3D, part, testTool("ballEndmill", 6), {
            stepdown: 2,
            leadDistance: 0,
            tolerance: 0.005,
        });
        expectNoGouge(path, new DropCutter(camIndexOf(part), Cutter.ball(3), { floor: 0 }), 0.005);
        const levels = new Map<number, Vec3[]>();
        for (const point of cutPoints(path)) {
            const key = Math.round(point[2] * 1e6) / 1e6;
            levels.set(key, [...(levels.get(key) ?? []), point]);
        }
        const heights = [...levels.keys()].sort((a, b) => b - a);
        expect(heights).toEqual([18, 16, 14, 12, 10, 8, 6, 4, 2, 0]);
        for (const z of heights) {
            // Below z = 17 the ball's equator rides the wall; above, its flank the top edge.
            const reach = z + 3 > 20 ? Math.sqrt(9 - (z + 3 - 20) ** 2) : 3;
            const points = levels.get(z)!;
            const onLoop = points.filter(([x, y]) => {
                const radius = Math.hypot(x, y);
                return radius > inner + reach - 1e-3 && radius <= Rc + reach + 0.005 / 4;
            });
            // All but the corner of a link from the level above lie on the circle.
            expect(onLoop.length).toBeGreaterThanOrEqual(points.length - 1);
            expect(onLoop.length).toBeGreaterThan(50);
            expect(signedArea(onLoop.map(([x, y]) => [x, y] as const))).toBeLessThan(0);
        }
    }, 60_000);

    test("region order finishes one boss top to bottom before the next", async () => {
        const bosses = mergeMeshes(
            cylinderMesh(5, 0, 10, 64, [-15, 0]),
            cylinderMesh(5, 0, 10, 64, [15, 0]),
            planeMesh(0, 60, 2),
        );
        const params = { stepdown: 2, leadDistance: 0, tolerance: 0.01 };
        const starts = (path: ToolpathData) => {
            // Heights at which the cutter arrives at each loop (the first point at a new height).
            const zs: number[] = [];
            for (const [, , z] of cutPoints(path))
                if (zs.length === 0 || Math.abs(zs[zs.length - 1] - z) > 1e-9) zs.push(z);
            return zs;
        };
        const rises = (zs: number[]) => zs.slice(1).filter((z, k) => z > zs[k] + 1e-9).length;
        const byRegion = starts(
            await generate(WATERLINE_3D, bosses, testTool("ballEndmill", 6), { ...params, order: "region" }),
        );
        const byLevel = starts(
            await generate(WATERLINE_3D, bosses, testTool("ballEndmill", 6), { ...params, order: "level" }),
        );
        expect(rises(byRegion)).toBe(1);
        expect(rises(byLevel)).toBe(0);
        expect(byLevel.length).toBeLessThan(byRegion.length);
    }, 60_000);

    test("steep-only keeps the walls and drops shallow sides into open chains", async () => {
        // A block 30 long with its +x side sloped at 30°: flatter than the 45° limit.
        const ramp = extrudeXZ(
            [
                [0, 0],
                [30, 0],
                [30 - 10 / Math.tan(Math.PI / 6), 10],
                [0, 10],
            ],
            0,
            10,
        );
        const tool = testTool("flatEndmill", 4);
        const context = testContext(ramp, tool, { margin: 5 });
        const operation = testOperation(WATERLINE_3D, { slopeFrom: 45, stepdown: 2, tolerance: 0.01 });
        const setup = surfacingSetup(operation, context, { tolerance: 0.01, stockToLeave: 0 }).value;
        const field = await HeightField.build(setup.drop, UNBOUNDED, 0.25);
        const levels = (await waterlineLevels(field, setup, operation.params, context)).value;
        expect(levels.map((level) => level.z)).toEqual([8, 6, 4, 2, 0]);
        for (const level of levels.slice(0, -1)) {
            expect(level.passes.length).toBe(1);
            const [pass] = level.passes;
            expect(pass.closed).toBe(false);
            const slopeX = 30 - (level.z / 10) * (10 / Math.tan(Math.PI / 6));
            for (let k = 0; k < pass.points.length; k += 3) expect(pass.points[k]).toBeLessThan(slopeX + 2);
        }
    });

    test("scallop-based steps keep neighbouring contours within the scallop stepover", async () => {
        const R = 10;
        const r = 3;
        const dome = hemisphereMesh(R, 128, 64);
        const tool = testTool("ballEndmill", 2 * r);
        const context = testContext(dome, tool, { margin: 2 });
        const params = {
            stepdownMode: "scallop",
            scallopHeight: 0.02,
            stepdown: 2,
            minStepdown: 0.05,
            slopeFrom: 45,
        };
        const operation = testOperation(WATERLINE_3D, params);
        const setup = surfacingSetup(operation, context, { tolerance: 0.01, stockToLeave: 0 }).value;
        const field = await HeightField.build(setup.drop, UNBOUNDED, 0.25);
        const levels = (await waterlineLevels(field, setup, params, context)).value.filter(
            (l) => l.passes.length,
        );
        const spacing = scallopStepover(Cutter.ball(r), 0.02);
        const radius = (z: number) => Math.sqrt(Math.max(0, (R + r) ** 2 - (z + r) ** 2));
        expect(levels.length).toBeGreaterThan(8);
        for (let k = 1; k < levels.length; k++) {
            const dz = levels[k - 1].z - levels[k].z;
            expect(dz).toBeGreaterThan(0.05 - 1e-9);
            const gap = Math.hypot(radius(levels[k].z) - radius(levels[k - 1].z), dz);
            expect(gap).toBeLessThanOrEqual(spacing + 0.02);
        }
        // Steps grow towards the vertical equator.
        const steps = levels.slice(1).map((level, k) => levels[k].z - level.z);
        expect(steps[steps.length - 2]).toBeGreaterThan(steps[0]);
    }, 60_000);
});
