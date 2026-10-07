// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CamOperationHandler,
    camOperations,
    engraveOperation,
    faceOperation,
    type MachineProfileData,
    OPERATIONS_2D,
    slotOperation,
    type ToolpathData,
    vcarveOperation,
} from "../src";
import { distanceToLoops, distanceToPolyline } from "../src/geometry2d";
import { cuttingSamples, fakeContext, millTool, operation, rectLoop } from "./_helpers/context";

function run(
    handler: CamOperationHandler,
    params: Record<string, unknown>,
    options: Parameters<typeof fakeContext>[0],
): ToolpathData {
    const result = handler.generate(operation(handler.type, params), fakeContext(options));
    if (!("isOk" in result)) throw new Error("synchronous");
    if (!result.isOk) throw new Error(result.error);
    return result.value;
}

describe("the 2D operation set", () => {
    test("registers by machine kind", () => {
        // Other operation sets (5-axis, additive) register beside these; look at the 2D ones.
        const own = new Set(OPERATIONS_2D.map((h) => h.type));
        const types = (kind: MachineProfileData["kind"]) =>
            camOperations(kind)
                .map((h) => h.type)
                .filter((type) => own.has(type))
                .sort();
        expect(types("mill")).toEqual(
            [
                "chamfer2d",
                "contour2d",
                "drill",
                "engrave",
                "face",
                "pocket2d",
                "slot",
                "threadMill",
                "vcarve",
            ].sort(),
        );
        expect(types("plasma")).toEqual(["mark", "profileCut"]);
        expect(types("laser")).toEqual(["mark", "profileCut"]);
        expect(types("waterjet")).toEqual(["mark", "profileCut"]);
        expect(types("wireEdm")).toEqual(["wireContour"]);
    });

    test.each(
        OPERATIONS_2D.map((h) => [h.type, h] as const),
    )("%s: defaults are parameters, conditions name parameters", (_type, handler) => {
        const machine: MachineProfileData = {
            id: "m",
            name: "m",
            kind: handler.machineKinds[0],
            linearAxes: [],
            maxFeed: 10000,
            rapidFeed: 20000,
            post: { id: "p" },
            cutting: { kerf: 1 },
            wire: {
                wireDiameter: 0.25,
                sparkGap: 0.02,
                maxTaper: 10,
                programPlaneHeight: 0,
                uvPlaneHeight: 50,
            },
        };
        const defaults = handler.defaults(machine, millTool(6));
        const specs = handler.parameters({ id: "o", type: handler.type, name: "o", params: defaults });
        const keys = new Set(specs.map((s) => s.key));
        for (const key of Object.keys(defaults)) expect(keys.has(key)).toBe(true);
        for (const spec of specs) {
            if (spec.visibleWhen !== undefined) expect(keys.has(spec.visibleWhen.key)).toBe(true);
            if (spec.kind === "enum") expect(spec.options?.length).toBeGreaterThan(1);
        }
    });
});

describe("facing", () => {
    test("zig-zag rows cover the stock top, start and end clear of it, at each level", () => {
        const path = run(
            faceOperation,
            { bottomFrom: "depth", depth: 2, stepdown: 1, stepover: 70 },
            { tool: millTool(50), stock: { min: [0, 0, -20], max: [100, 60, 2] } },
        );
        const samples = cuttingSamples(path, 0.5);
        const levels = [...new Set(samples.map((s) => s.z))].sort((a, b) => a - b);
        expect(levels).toEqual([0, 1]);
        for (const z of levels) {
            const level = samples.filter((s) => s.z === z);
            // Every stock point is under the cutter on some pass.
            for (let x = 0; x <= 100; x += 5) {
                for (let y = 0; y <= 60; y += 5) {
                    const best = Math.min(...level.map((s) => Math.hypot(s.p[0] - x, s.p[1] - y)));
                    expect(best).toBeLessThanOrEqual(25 + 0.3);
                }
            }
            const xs = level.map((s) => s.p[0]);
            expect(Math.min(...xs)).toBeCloseTo(-27, 9);
            expect(Math.max(...xs)).toBeCloseTo(127, 9);
        }
        // Rapids never go below the stock top inside the stock.
        for (const move of path.moves) {
            if (move.kind !== "rapid") continue;
            const inside = move.to[0] > -25 && move.to[0] < 125 && move.to[1] > -25 && move.to[1] < 85;
            if (move.to[2] < 2) expect(inside).toBe(false);
        }
    });
});

describe("engraving and V-carving", () => {
    test("engraving follows the loops and lines exactly at depth", () => {
        const path = run(
            engraveOperation,
            { depth: 0.4, stepdown: 0.2 },
            {
                tool: { id: "e", kind: "engraver", diameter: 0.5, tipAngle: 60, cutting: { feed: 400 } },
                loops: [
                    { points: rectLoop(0, 0, 20, 10), closed: true, z: 0 },
                    {
                        points: [
                            [2, 2],
                            [18, 8],
                        ],
                        closed: false,
                        z: 0,
                    },
                ],
                stock: { min: [-5, -5, -5], max: [25, 15, 0] },
            },
        );
        const samples = cuttingSamples(path, 0.1).filter((s) => s.z < -1e-9);
        expect([...new Set(samples.map((s) => Math.round(s.z * 1e9) / 1e9))].sort((a, b) => a - b)).toEqual([
            -0.4, -0.2,
        ]);
        for (const s of samples) {
            const d = Math.min(
                distanceToPolyline(s.p, rectLoop(0, 0, 20, 10), true),
                distanceToPolyline(
                    s.p,
                    [
                        [2, 2],
                        [18, 8],
                    ],
                    false,
                ),
            );
            expect(d).toBeLessThan(1e-6);
        }
    });

    test("V-carving cuts each point at the depth of its distance to the outline", () => {
        const outline = rectLoop(0, 0, 10, 4);
        const path = run(
            vcarveOperation,
            { step: 0.1 },
            {
                tool: { id: "v", kind: "vBit", diameter: 12, tipAngle: 90, cutting: { feed: 600 } },
                loops: [{ points: outline, closed: true, z: 0 }],
                stock: { min: [-5, -5, -5], max: [15, 10, 0] },
            },
        );
        const samples = cuttingSamples(path, 0.1).filter((s) => s.z < -1e-9);
        expect(samples.length).toBeGreaterThan(100);
        // Ring by ring: ρ / tan(45°) = ρ deep. (Plunges between rings are vertical.)
        const rings = samples.filter((s) => Math.abs(distanceToLoops(s.p, [outline]) + s.z) < 1e-3);
        expect(rings.length / samples.length).toBeGreaterThan(0.95);
        expect(Math.min(...samples.map((s) => s.z))).toBeLessThan(-1.85);
        expect(Math.min(...samples.map((s) => s.z))).toBeGreaterThanOrEqual(-2);
    });
});

describe("slotting", () => {
    test("ramps back and forth along the slot, then cuts it end to end at each level", () => {
        const path = run(
            slotOperation,
            { depth: 6, stepdown: 2, rampAngle: 5 },
            {
                tool: millTool(8),
                loops: [
                    {
                        points: [
                            [0, 0],
                            [50, 0],
                        ],
                        closed: false,
                        z: 0,
                    },
                ],
                stock: { min: [-10, -10, -10], max: [60, 10, 0] },
            },
        );
        const samples = cuttingSamples(path, 0.05);
        for (const s of samples) expect(Math.abs(s.p[1])).toBeLessThan(1e-9);
        let steepest = 0;
        for (let i = 1; i < samples.length; i++) {
            const runLength = Math.abs(samples[i].p[0] - samples[i - 1].p[0]);
            const drop = samples[i - 1].z - samples[i].z;
            if (runLength > 1e-9 && drop > 1e-12) steepest = Math.max(steepest, drop / runLength);
        }
        expect(steepest).toBeLessThanOrEqual(Math.tan((5 * Math.PI) / 180) + 1e-9);
        // The bottom level is cut over the slot's full length.
        const bottom = samples.filter((s) => Math.abs(s.z + 6) < 1e-9).map((s) => s.p[0]);
        expect(Math.min(...bottom)).toBeCloseTo(0, 9);
        expect(Math.max(...bottom)).toBeCloseTo(50, 9);
    });
});
