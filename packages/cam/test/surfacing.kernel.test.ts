// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IShape, Plane } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import {
    type CamOperationContext,
    Cutter,
    camOperation,
    DropCutter,
    PARALLEL_3D,
    PENCIL_3D,
    shapesMesh,
    type ToolData,
    type ToolpathData,
    TriangleIndex,
    WATERLINE_3D,
    ZLEVEL_ROUGHING,
} from "../src";
import { fakeContext, operation } from "./_helpers/context";
import { withinTolerance } from "./_helpers/gouge";
import { cutPoints } from "./_helpers/surfacing";

/**
 * The 3-axis strategies on a real kernel triangulation: a 60×40×10 block with a Ø18 dome
 * fused on top (centre on the top face, so it rises to z = 19).
 */

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function ok<T>(result: { isOk: boolean; value: T; error: unknown }): T {
    if (!result.isOk) throw new Error(String(result.error));
    return result.value;
}

function domedBlock(): IShape {
    const block = ok(shapeFactory.box(Plane.XY, 60, 40, 10));
    const dome = ok(shapeFactory.sphere({ x: 30, y: 20, z: 10 }, 9));
    return ok(shapeFactory.booleanFuse([block], [dome], true));
}

const BALL: Partial<ToolData> = { id: "ball6", kind: "ballEndmill", diameter: 6, cutting: { feed: 1500 } };

async function run(type: string, tool: Partial<ToolData>, params: Record<string, unknown>) {
    const part = domedBlock();
    const mesh = shapesMesh([part]);
    const context: CamOperationContext = {
        ...fakeContext({ tool, stock: { min: [-2, -2, 0], max: [62, 42, 24] } }),
        partMesh: () => mesh,
        parts: [part],
    };
    const handler = camOperation(type);
    expect(handler).not.toBeUndefined();
    const defaults = handler?.defaults(context.machine, context.tool) ?? {};
    const result = await handler?.generate(
        operation(type, { ...defaults, leadDistance: 0, ...params }),
        context,
    );
    expect(result?.isOk).toBe(true);
    const index = new TriangleIndex(mesh.positions, mesh.indices);
    expect(index.count).toBeGreaterThan(100);
    return { path: result?.value as ToolpathData, index };
}

describe("3-axis surfacing on a kernel mesh", () => {
    test("waterline circles the dome at R + r and stays clear of the block", async () => {
        const { path, index } = await run(WATERLINE_3D, BALL, { stepdown: 2, tolerance: 0.01 });
        const drop = new DropCutter(index, Cutter.ball(3), { floor: 0 });
        const points = cutPoints(path);
        for (const [x, y, z] of points) expect(withinTolerance(drop, x, y, z, 0.01)).toBe(true);
        // A ball with its tip at z touches the sphere (centre 30, 20, 10, radius 9) where its
        // centre is 12 from the sphere's centre.
        let onDome = 0;
        for (const [x, y, z] of points) {
            if (z <= 10 || z >= 18) continue;
            const expected = Math.sqrt(12 ** 2 - (z + 3 - 10) ** 2);
            const radius = Math.hypot(x - 30, y - 20);
            if (Math.abs(radius - expected) < 0.1) onDome++;
        }
        expect(onDome).toBeGreaterThan(100);
    }, 60_000);

    test("parallel finishing and pencil stay on the cutter-location surface", async () => {
        const parallel = await run(PARALLEL_3D, BALL, { stepover: 1.5, tolerance: 0.01 });
        const drop = new DropCutter(parallel.index, Cutter.ball(3), { floor: 0 });
        for (const [x, y, z] of cutPoints(parallel.path))
            expect(withinTolerance(drop, x, y, z, 0.01)).toBe(true);
        const pencil = await run(PENCIL_3D, BALL, { tolerance: 0.01 });
        const foot = Math.sqrt(12 ** 2 - 3 ** 2);
        const points = cutPoints(pencil.path);
        expect(points.length).toBeGreaterThan(20);
        // The ball sits on the block's top where it also touches the dome (the kernel's facets let
        // the chords between crease points ride up to 0.15 mm onto the dome).
        const ring = points.filter(
            ([x, y, z]) => z > 10 - 1e-6 && z < 10.15 && Math.abs(Math.hypot(x - 30, y - 20) - foot) < 0.15,
        );
        expect(ring.length).toBeGreaterThan(0.8 * points.length);
    }, 60_000);

    test("Z-level roughing leaves the stock to leave over the dome and the block", async () => {
        const flat: Partial<ToolData> = {
            id: "em6",
            kind: "flatEndmill",
            diameter: 6,
            cutting: { feed: 1500 },
        };
        const { path, index } = await run(ZLEVEL_ROUGHING, flat, {
            stepdown: 4,
            stepover: 2.4,
            stockToLeave: 0.5,
        });
        const drop = new DropCutter(index, Cutter.flat(3).offset(0.5), { lift: 0.5, floor: 0.5 });
        const points = cutPoints(path);
        expect(points.length).toBeGreaterThan(100);
        for (const [x, y, z] of points) expect(withinTolerance(drop, x, y, z, 0.02)).toBe(true);
        // The block's top is a flat area: a level falls at 10 + 0.5.
        expect(points.some(([, , z]) => Math.abs(z - 10.5) < 1e-9)).toBe(true);
    }, 60_000);
});
