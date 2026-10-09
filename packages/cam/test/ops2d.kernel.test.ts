// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, type IFace, type IShape, Plane, ShapeTypes, XYZ } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import {
    type CamLoop,
    chamferOperation,
    circleOfEdge,
    contourOperation,
    detectHoles,
    drillOperation,
    faceRegion,
    pocketOperation,
    type ToolData,
    type ToolpathData,
    type ToolpathMove,
    threadMillOperation,
} from "../src";
import { circlePoints, distanceToPolyline } from "../src/geometry2d";
import { cuttingSamples, fakeContext, millTool, operation, rectLoop } from "./_helpers/context";

/**
 * Operations on real kernel geometry: a 60×40×20 block with a Ø6 through hole, a Ø8 blind
 * hole 5 deep, and a Ø10×4 counterbore over a Ø5 through hole; a block with a pocket.
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

const up = { x: 0, y: 0, z: 1 };

function ok<T>(result: { isOk: boolean; value: T; error: unknown }): T {
    if (!result.isOk) throw new Error(String(result.error));
    return result.value;
}

function drilledBlock(): IShape {
    const block = ok(shapeFactory.box(Plane.XY, 60, 40, 20));
    const tools = [
        ok(shapeFactory.cylinder(up, { x: 10, y: 10, z: -1 }, 3, 22)),
        ok(shapeFactory.cylinder(up, { x: 45, y: 25, z: 15 }, 4, 6)),
        ok(shapeFactory.cylinder(up, { x: 30, y: 30, z: 16 }, 5, 5)),
        ok(shapeFactory.cylinder(up, { x: 30, y: 30, z: -1 }, 2.5, 22)),
    ];
    return ok(shapeFactory.booleanCut([block], tools));
}

function generate(
    handler: { generate: typeof drillOperation.generate },
    params: Record<string, unknown>,
    options: Parameters<typeof fakeContext>[0],
): ToolpathData {
    const result = handler.generate(operation("op", params), fakeContext(options));
    if (!("isOk" in result)) throw new Error("synchronous");
    if (!result.isOk) throw new Error(result.error);
    return result.value;
}

const drills = (path: ToolpathData) =>
    path.moves.filter((m): m is Extract<ToolpathMove, { kind: "drill" }> => m.kind === "drill");

const drillTool: Partial<ToolData> = {
    id: "drill6",
    kind: "drill",
    diameter: 6,
    tipAngle: 118,
    cutting: { feed: 200, spindleRpm: 2000 },
};

describe("hole recognition", () => {
    test("finds the vertical holes with centres, diameters, tops, bottoms and through/blind", () => {
        const holes = detectHoles([drilledBlock()]).sort(
            (a, b) => a.center[0] - b.center[0] || a.diameter - b.diameter,
        );
        expect(holes).toHaveLength(4);
        const [through6, cbore5, cbore10, blind8] = [holes[0], holes[1], holes[2], holes[3]];
        expect(through6.center[0]).toBeCloseTo(10, 6);
        expect(through6.center[1]).toBeCloseTo(10, 6);
        expect(through6.diameter).toBeCloseTo(6, 6);
        expect(through6.top).toBeCloseTo(20, 6);
        expect(through6.bottom).toBeCloseTo(0, 6);
        expect(through6.through).toBe(true);
        expect(cbore5.diameter).toBeCloseTo(5, 6);
        expect(cbore5.top).toBeCloseTo(16, 6);
        expect(cbore5.bottom).toBeCloseTo(0, 6);
        expect(cbore5.through).toBe(true);
        expect(cbore10.diameter).toBeCloseTo(10, 6);
        expect(cbore10.top).toBeCloseTo(20, 6);
        expect(cbore10.bottom).toBeCloseTo(16, 6);
        expect(cbore10.through).toBe(false);
        expect(blind8.center[0]).toBeCloseTo(45, 6);
        expect(blind8.center[1]).toBeCloseTo(25, 6);
        expect(blind8.diameter).toBeCloseTo(8, 6);
        expect(blind8.bottom).toBeCloseTo(15, 6);
        expect(blind8.through).toBe(false);
    });

    test("a boss is not a hole", () => {
        const plate = ok(shapeFactory.box(Plane.XY, 40, 40, 5));
        const pin = ok(shapeFactory.cylinder(up, { x: 20, y: 20, z: 5 }, 4, 10));
        const part = ok(shapeFactory.booleanFuse([plate], [pin], true));
        expect(detectHoles([part])).toHaveLength(0);
    });
});

describe("drilling", () => {
    let block: IShape;
    beforeAll(() => {
        block = drilledBlock();
    });
    const stock = { min: [0, 0, 0] as const, max: [60, 40, 20] as const };

    test("drills the matching hole through, with breakthrough and the drill point", () => {
        const path = generate(
            drillOperation,
            { minDiameter: 5.9, maxDiameter: 6.1, breakthrough: 1, retractOffset: 2 },
            { tool: drillTool, parts: [block], stock },
        );
        const cycles = drills(path);
        expect(cycles).toHaveLength(1);
        const [cycle] = cycles;
        expect(cycle.at[0]).toBeCloseTo(10, 6);
        expect(cycle.at[1]).toBeCloseTo(10, 6);
        expect(cycle.at[2]).toBeCloseTo(20, 6);
        const tip = 3 / Math.tan((59 * Math.PI) / 180);
        expect(cycle.depth).toBeCloseTo(20 + 1 + tip, 6);
        expect(cycle.retract).toBeCloseTo(22, 6);
        expect(cycle.retract).toBeGreaterThanOrEqual(cycle.at[2]);
        expect(cycle.cycle).toBe("drill");
        expect(cycle.feed).toBe(200);
    });

    test("visits holes in a short order and drills blind holes to their floor", () => {
        const path = generate(
            drillOperation,
            { maxDiameter: 8.5, cycle: "peck", peck: 2 },
            { tool: drillTool, parts: [block], stock },
        );
        const cycles = drills(path);
        expect(cycles.map((c) => [Math.round(c.at[0]), Math.round(c.at[1])])).toEqual([
            [10, 10],
            [30, 30],
            [45, 25],
        ]);
        const tip = 3 / Math.tan((59 * Math.PI) / 180);
        expect(cycles[1].at[2]).toBeCloseTo(16, 6);
        expect(cycles[1].depth).toBeCloseTo(16 + 1 + tip, 6);
        expect(cycles[2].depth).toBeCloseTo(5, 6);
        for (const c of cycles) {
            expect(c.cycle).toBe("peck");
            expect(c.peck).toBe(2);
        }
        // Rapids between holes stay above the stock.
        const rapids = path.moves.filter(
            (m): m is Extract<ToolpathMove, { kind: "rapid" }> => m.kind === "rapid",
        );
        expect(Math.min(...rapids.map((r) => r.to[2]))).toBeGreaterThanOrEqual(20);
    });

    test("tapping feeds at speed × pitch; spot drilling goes to the chamfer depth", () => {
        const tap = generate(
            drillOperation,
            { minDiameter: 7.9, maxDiameter: 8.1 },
            {
                tool: {
                    id: "tap",
                    kind: "tap",
                    diameter: 8,
                    pitch: 1.25,
                    cutting: { feed: 100, spindleRpm: 400 },
                },
                parts: [block],
                stock,
            },
        );
        expect(drills(tap)[0].cycle).toBe("tap");
        expect(drills(tap)[0].feed).toBeCloseTo(500, 9);
        const spot = generate(
            drillOperation,
            { maxDiameter: 6.1, spotChamfer: 0.25 },
            {
                tool: { id: "spot", kind: "spotDrill", diameter: 10, tipAngle: 90, cutting: { feed: 150 } },
                parts: [block],
                stock,
            },
        );
        const depths = drills(spot)
            .map((c) => c.depth)
            .sort((a, b) => a - b);
        expect(depths[0]).toBeCloseTo(2.5 + 0.25, 9);
        expect(depths[1]).toBeCloseTo(3 + 0.25, 9);
    });

    test("a picked hole face drills just that hole; picked rims drill a set depth", () => {
        const faces = block.findSubShapes(ShapeTypes.face) as IFace[];
        // The blind hole's wall: the only face spanning z 15 to 20.
        const blindFace = faces.find((face) => {
            const box = face.boundingBox();
            return Math.abs(box.min.z - 15) < 1e-6 && Math.abs(box.max.z - 20) < 1e-6;
        });
        expect(blindFace).not.toBeUndefined();
        const picked = generate(
            drillOperation,
            {},
            { tool: drillTool, parts: [block], faces: [blindFace!], stock },
        );
        expect(drills(picked)).toHaveLength(1);
        expect(drills(picked)[0].at[0]).toBeCloseTo(45, 6);

        const edges = (block.findSubShapes(ShapeTypes.edge) as IEdge[]).filter((edge) => {
            const circle = circleOfEdge(edge);
            return (
                circle !== undefined && Math.abs(circle.radius - 3) < 1e-6 && Math.abs(circle.z - 20) < 1e-6
            );
        });
        expect(edges.length).toBeGreaterThan(0);
        const rims = generate(
            drillOperation,
            { depthFrom: "depth", depth: 7 },
            { tool: drillTool, parts: [block], edges, stock },
        );
        expect(drills(rims)).toHaveLength(1);
        expect(drills(rims)[0].depth).toBe(7);
        expect(drills(rims)[0].at[2]).toBeCloseTo(20, 6);
    });

    test("picked rims drill the hole they lie on to its floor; a loose circle stops at the stock bottom", () => {
        // The stock 1 mm above the part (the setup's top margin).
        const tallStock = { min: [0, 0, 0] as const, max: [60, 40, 21] as const };
        const rims = (block.findSubShapes(ShapeTypes.edge) as IEdge[]).filter((edge) => {
            const circle = circleOfEdge(edge);
            // Both rims of the Ø6 through hole and the top rim of the Ø8 blind one.
            return (
                circle !== undefined &&
                ((Math.abs(circle.radius - 3) < 1e-6 && Math.abs(circle.center[0] - 10) < 1e-6) ||
                    (Math.abs(circle.radius - 4) < 1e-6 && Math.abs(circle.z - 20) < 1e-6))
            );
        });
        expect(rims).toHaveLength(3);
        // A sketch circle where the part has no hole, on the part's top.
        const loose: CamLoop = {
            points: circlePoints([50, 8], 2.5, 0.001, false),
            closed: true,
            z: 20,
            role: "sketch",
        };
        const path = generate(
            drillOperation,
            { breakthrough: 1, tipCompensation: true },
            { tool: drillTool, parts: [block], edges: rims, loops: [loose], stock: tallStock },
        );
        const cycles = drills(path).sort((a, b) => a.at[0] - b.at[0]);
        expect(cycles).toHaveLength(3);
        const at = [
            [10, 10, 20],
            [45, 25, 20],
            [50, 8, 20],
        ];
        cycles.forEach((cycle, i) => {
            for (let k = 0; k < 3; k++) expect(cycle.at[k]).toBeCloseTo(at[i][k], 6);
        });
        const tip = 3 / Math.tan((59 * Math.PI) / 180);
        // Through: the part's 20 mm, the breakthrough and the point — not the stock's 21 from the rim.
        expect(cycles[0].depth).toBeCloseTo(20 + 1 + tip, 6);
        // Blind: to its floor at z 15 — the stock's height from the rim drilled it through the part.
        expect(cycles[1].depth).toBeCloseTo(5, 6);
        // No hole under it: through the stock to its bottom, never deeper than the stock below the rim.
        expect(cycles[2].depth).toBeCloseTo(20 + 1 + tip, 6);
    });

    test("thread milling the blind hole: a helix at the ISO major diameter, a pitch per turn", () => {
        const faces = block.findSubShapes(ShapeTypes.face) as IFace[];
        const blindFace = faces.find((face) => {
            const box = face.boundingBox();
            return Math.abs(box.min.z - 15) < 1e-6 && Math.abs(box.max.z - 20) < 1e-6;
        });
        expect(blindFace).not.toBeUndefined();
        const path = generate(
            threadMillOperation,
            { pitch: 1.25, hand: "right", direction: "climb" },
            { tool: millTool(6, { kind: "threadMill" }), parts: [block], faces: [blindFace!], stock },
        );
        const major = 8 + 1.0825 * 1.25;
        const helix = path.moves.filter(
            (m): m is Extract<ToolpathMove, { kind: "arc" }> =>
                m.kind === "arc" && Math.abs(m.center[0] - 45) < 1e-9 && Math.abs(m.center[1] - 25) < 1e-9,
        );
        expect(helix.length).toBe(8);
        for (const arc of helix) {
            expect(Math.hypot(arc.to[0] - 45, arc.to[1] - 25)).toBeCloseTo(major / 2 - 3, 9);
            // Right-hand climb inside a hole: counter-clockwise, rising half a pitch per half turn.
            expect(arc.clockwise).toBe(false);
        }
        const zs = helix.map((a) => a.to[2]);
        for (let i = 1; i < zs.length; i++) expect(zs[i] - zs[i - 1]).toBeCloseTo(0.625, 9);
        expect(zs[zs.length - 1]).toBeCloseTo(20, 9);
        expect(zs[0]).toBeCloseTo(15 + 0.625, 9);
    });
});

describe("milling picked faces", () => {
    test("pocket from its floor face: down to the face, the tool radius off the walls", () => {
        const block = ok(shapeFactory.box(Plane.XY, 60, 40, 20));
        const pocketTool = ok(
            shapeFactory.box(
                new Plane({ origin: new XYZ({ x: 10, y: 10, z: 14 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
                30,
                20,
                10,
            ),
        );
        const part = ok(shapeFactory.booleanCut([block], [pocketTool]));
        const floor = (part.findSubShapes(ShapeTypes.face) as IFace[]).find((face) => {
            const box = face.boundingBox();
            return Math.abs(box.max.z - 14) < 1e-6 && Math.abs(box.min.z - 14) < 1e-6;
        });
        expect(floor).not.toBeUndefined();
        const region = faceRegion(floor!);
        expect(region).not.toBeUndefined();
        expect(region!.z).toBeCloseTo(14, 6);
        const path = generate(
            pocketOperation,
            { stepdown: 3, stepover: 45 },
            {
                tool: millTool(6),
                parts: [part],
                faces: [floor!],
                stock: { min: [0, 0, 0], max: [60, 40, 20] },
            },
        );
        const samples = cuttingSamples(path).filter((s) => s.z < 20 - 1e-6);
        expect(Math.min(...samples.map((s) => s.z))).toBeCloseTo(14, 9);
        const walls = rectLoop(10, 10, 40, 30);
        for (const s of samples)
            expect(distanceToPolyline(s.p, walls, true)).toBeGreaterThanOrEqual(3 - 2e-3);
    });

    test("contour around the block's bottom face goes the radius outside, through the stock", () => {
        const block = ok(shapeFactory.box(Plane.XY, 60, 40, 20));
        const bottom = (block.findSubShapes(ShapeTypes.face) as IFace[]).find(
            (face) => Math.abs(face.boundingBox().max.z) < 1e-6,
        );
        expect(bottom).not.toBeUndefined();
        const path = generate(
            contourOperation,
            { stepdown: 10, leadIn: "none", leadOut: "none" },
            {
                tool: millTool(8),
                parts: [block],
                faces: [bottom!],
                stock: { min: [-5, -5, 0], max: [65, 45, 20] },
            },
        );
        const samples = cuttingSamples(path).filter((s) => s.z < 20);
        expect(Math.min(...samples.map((s) => s.z))).toBeCloseTo(0, 9);
        for (const s of samples)
            expect(distanceToPolyline(s.p, rectLoop(0, 0, 60, 40), true)).toBeCloseTo(4, 3);
    });

    test("chamfering picked top edges: the air side found from the part, cone depth from the width", () => {
        const block = ok(shapeFactory.box(Plane.XY, 60, 40, 20));
        const topEdges = (block.findSubShapes(ShapeTypes.edge) as IEdge[]).filter((edge) => {
            const [a, b] = edge.ends();
            return Math.abs(a.z - 20) < 1e-6 && Math.abs(b.z - 20) < 1e-6;
        });
        expect(topEdges).toHaveLength(4);
        const path = generate(
            chamferOperation,
            { width: 1, tipOffset: 0.5, leadIn: "none" },
            {
                tool: { id: "ch", kind: "chamfer", diameter: 10, tipAngle: 90, cutting: { feed: 600 } },
                parts: [block],
                edges: topEdges,
                stock: { min: [-5, -5, 0], max: [65, 45, 20] },
            },
        );
        const samples = cuttingSamples(path).filter((s) => s.z < 20);
        // 45° tool: tip 1 + 0.5 below the top, centre 0.5 outside the edge.
        for (const s of samples) {
            expect(s.z).toBeCloseTo(18.5, 9);
            expect(distanceToPolyline(s.p, rectLoop(0, 0, 60, 40), true)).toBeCloseTo(0.5, 3);
            expect(s.p[0] < 0 || s.p[0] > 60 || s.p[1] < 0 || s.p[1] > 40).toBe(true);
        }
    });
});
