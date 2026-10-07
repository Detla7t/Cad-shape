// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Cutter, camOperation, DropCutter, PENCIL_3D, type ToolpathData, TriangleIndex } from "../src";
import { withinTolerance } from "./_helpers/gouge";
import { hemisphereMesh, mergeMeshes, planeMesh, type TestMesh, toCamMesh } from "./_helpers/meshes";
import { cutPoints, cutSegments, testContext, testOperation, testTool } from "./_helpers/surfacing";

async function pencil(mesh: TestMesh, params: Record<string, unknown> = {}) {
    const handler = camOperation(PENCIL_3D);
    expect(handler).not.toBeUndefined();
    const tool = testTool("ballEndmill", 6);
    const context = testContext(mesh, tool, { margin: 2 });
    const operation = testOperation(PENCIL_3D, {
        ...handler?.defaults(context.machine, tool),
        leadDistance: 0,
        ...params,
    });
    return handler?.generate(operation, context);
}

function exactDrop(mesh: TestMesh) {
    const cam = toCamMesh(mesh);
    return new DropCutter(new TriangleIndex(cam.positions, cam.indices), Cutter.ball(3), { floor: 0 });
}

describe("pencil finishing", () => {
    test("a 90° V-groove gets one pass along its crease, r(√2 − 1) above it", async () => {
        const groove: TestMesh = {
            positions: new Float64Array([
                -20, -15, 20, 0, -15, 0, 0, 15, 0, -20, 15, 20, 20, -15, 20, 20, 15, 20,
            ]),
            indices: new Uint32Array([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2]),
        };
        const result = await pencil(groove);
        expect(result?.isOk).toBe(true);
        const path = result?.value as ToolpathData;
        const drop = exactDrop(groove);
        // Points along the cut (straight passes keep only their ends).
        const along: number[][] = [];
        for (const [a, b] of cutSegments(path)) {
            for (let k = 0; k <= 20; k++) {
                const point = [0, 1, 2].map((i) => a[i] + ((b[i] - a[i]) * k) / 20);
                if (Math.abs(point[1]) < 11 && Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) along.push(point);
            }
        }
        expect(along.length).toBeGreaterThan(10);
        for (const [x, y, z] of cutPoints(path)) expect(withinTolerance(drop, x, y, z, 0.01)).toBe(true);
        // On the crease to a quarter of the tolerance (off it the V rises 1:1).
        const crease = 3 * (Math.SQRT2 - 1);
        for (const [x, , z] of along) {
            expect(Math.abs(x)).toBeLessThan(0.0025 + 1e-9);
            expect(z).toBeGreaterThanOrEqual(crease - 0.005);
            expect(z - crease).toBeLessThan(0.0025 + 1e-9);
        }
        // The crease runs the length of the groove.
        const ys = along.map(([, y]) => y);
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20);
    });

    test("a dome on a floor gets a ring at its foot where the ball touches both", async () => {
        const R = 10;
        const r = 3;
        const part = mergeMeshes(hemisphereMesh(R, 128, 64), planeMesh(0, 40, 4));
        const result = await pencil(part, { tolerance: 0.005 });
        expect(result?.isOk).toBe(true);
        const path = result?.value as ToolpathData;
        const drop = exactDrop(part);
        const foot = Math.sqrt((R + r) ** 2 - r * r);
        const points = cutPoints(path);
        for (const [x, y, z] of points) expect(withinTolerance(drop, x, y, z, 0.005)).toBe(true);
        // Nothing but the ring: on the floor at the foot circle (chords between crease
        // points cut a hair inside it, where the ball starts to climb the dome).
        const ring = points.filter(([x, y, z]) => z < 0.05 && Math.abs(Math.hypot(x, y) - foot) < 0.02);
        expect(ring.length).toBe(points.length);
        expect(ring.filter(([, , z]) => Math.abs(z) < 1e-9).length).toBeGreaterThan(points.length / 3);
        // All the way round.
        const angles = ring.map(([x, y]) => Math.atan2(y, x)).sort((a, b) => a - b);
        const gaps = angles.slice(1).map((a, k) => a - angles[k]);
        expect(Math.max(...gaps, 2 * Math.PI - (angles[angles.length - 1] - angles[0]))).toBeLessThan(0.2);
    }, 60_000);

    test("a convex dome has no corners to pencil", async () => {
        const result = await pencil(hemisphereMesh(10, 64, 32));
        expect(result?.isOk).toBe(false);
    });
});
