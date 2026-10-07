// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IShape, Plane, Result, ShapeTypes, XYZ } from "@chili3d/core";
import {
    type CamOperationContext,
    type CamOperationHandler,
    camOperation,
    registerCamOperation,
} from "../../src/model/operation";
import type { CamOperationData } from "../../src/model/setup";
import type { ToolData } from "../../src/model/tool";
import type { ToolpathData, ToolpathMove, Vec3 } from "../../src/model/toolpath";
import "../../src/ops5x";
import { avoidCollision, TriangleGrid, toolAssembly } from "../../src/ops5x/collision";
import { GENERIC_AC_TRUNNION } from "../../src/ops5x/machines";
import { FLOWLINE_5X_TYPE } from "../../src/ops5x/ops/flowline";
import { INDEXED_TYPE } from "../../src/ops5x/ops/indexed";
import { CONTOUR_5X_TYPE } from "../../src/ops5x/ops/surfaceNormal";
import { SWARF_TYPE } from "../../src/ops5x/ops/swarf";
import { toolpathMode } from "../../src/ops5x/posts/plan";
import { FaceSampler } from "../../src/ops5x/surface";
import { addScaled, angleBetween, distance, dot, length, normalize } from "../../src/ops5x/vec";
import { curvedFace, faceFacing, fakeContext, setupKernel } from "./fakeContext";

beforeAll(setupKernel);

const FLAT_10: ToolData = {
    id: "flat10",
    number: 1,
    name: "Flat 10",
    kind: "flatEndmill",
    diameter: 10,
    fluteLength: 40,
    stickout: 60,
    holder: { diameter: 32, length: 50 },
    cutting: { spindleRpm: 9000, feed: 1500, plungeFeed: 500 },
};

const BALL_6: ToolData = {
    id: "ball6",
    number: 2,
    name: "Ball 6",
    kind: "ballEndmill",
    diameter: 6,
    fluteLength: 18,
    stickout: 40,
    cutting: { spindleRpm: 12000, feed: 1200, plungeFeed: 400 },
};

function operationOf(type: string, params: Record<string, unknown>, tool: ToolData): CamOperationData {
    const handler = camOperation(type);
    expect(handler).not.toBeUndefined();
    return {
        id: `op-${type}`,
        type,
        name: type,
        toolId: tool.id,
        params: { ...handler!.defaults(GENERIC_AC_TRUNNION, tool), ...params },
    };
}

async function generate(type: string, params: Record<string, unknown>, context: CamOperationContext) {
    return await camOperation(type)!.generate(operationOf(type, params, context.tool), context);
}

/** The cutting moves (at the operation's feed, not the plunges and retracts). */
function cuts(path: ToolpathData, feed: number): Extract<ToolpathMove, { kind: "linear" }>[] {
    return path.moves.filter(
        (move): move is Extract<ToolpathMove, { kind: "linear" }> =>
            move.kind === "linear" && move.feed === feed,
    );
}

function prism(vector: Vec3): IShape {
    const face = shapeFactory.rect(Plane.XY, 40, 20);
    expect(face.isOk).toBe(true);
    const solid = shapeFactory.prism(face.value, new XYZ(vector[0], vector[1], vector[2]));
    expect(solid.isOk).toBe(true);
    return solid.value;
}

describe("swarf", () => {
    test("flanks a slanted extrude wall with the tool axis exactly along its rulings", async () => {
        const part = prism([0, 10, 30]);
        const wallNormal = normalize([0, -30, 10]);
        const wall = faceFacing(part, wallNormal);
        const context = fakeContext({
            machine: GENERIC_AC_TRUNNION,
            tool: FLAT_10,
            parts: [part],
            faces: [wall],
        });
        const result = await generate(SWARF_TYPE, { maxStep: 4, levels: 2, stepdown: 10 }, context);
        expect(result.isOk).toBe(true);
        const ruling = normalize([0, 10, 30]);
        const cutting = cuts(result.value, FLAT_10.cutting.feed);
        expect(cutting.length).toBeGreaterThan(10);
        for (const move of cutting) {
            expect(angleBetween(move.axis!, ruling)).toBeLessThan(1e-9);
            // The flank is one radius off the wall plane (through the origin).
            expect(dot(move.to, wallNormal)).toBeCloseTo(5, 6);
        }
        // Two levels: the upper pass 10 mm up the axis, then the one at the wall bottom.
        const bottomZ = 5 * wallNormal[2];
        const levels = new Set(cutting.map((move) => Math.round((move.to[2] - bottomZ) * 1e6) / 1e6));
        expect([...levels].sort((a, b) => a - b)).toEqual([0, Math.round(10 * ruling[2] * 1e6) / 1e6]);
        // Climb: the material on the right of the travel, so this wall is cut towards −X.
        const lowest = result.value.moves.filter(
            (move): move is Extract<ToolpathMove, { kind: "linear" }> =>
                move.kind === "linear" && Math.abs(move.to[2] - bottomZ) < 1e-6,
        );
        expect(lowest[0].to[0]).toBeGreaterThan(lowest[lowest.length - 1].to[0]);
        expect(Math.max(...lowest.map((move) => move.to[0]))).toBeCloseTo(40, 6);
        expect(Math.min(...lowest.map((move) => move.to[0]))).toBeCloseTo(0, 6);
    });

    test("follows the generators of a cone", async () => {
        const cone = shapeFactory.cone(new XYZ(0, 0, 1), new XYZ(0, 0, 0), 20, 10, 30);
        expect(cone.isOk).toBe(true);
        const face = curvedFace(cone.value);
        const context = fakeContext({
            machine: GENERIC_AC_TRUNNION,
            tool: FLAT_10,
            parts: [cone.value],
            faces: [face],
        });
        const result = await generate(SWARF_TYPE, { maxStep: 3, checkCollisions: false }, context);

        expect(result.isOk).toBe(true);
        const cutting = cuts(result.value, FLAT_10.cutting.feed);
        expect(cutting.length).toBeGreaterThan(30);
        const slant = Math.hypot(10, 30);
        for (const move of cutting) {
            const u = Math.atan2(move.to[1], move.to[0]);
            const generator = normalize([-10 * Math.cos(u), -10 * Math.sin(u), 30]);
            expect(angleBetween(move.axis!, generator)).toBeLessThan(1e-6);
            expect(Math.hypot(move.to[0], move.to[1])).toBeCloseTo(20 + (5 * 30) / slant, 6);
            expect(move.to[2]).toBeCloseTo((5 * 10) / slant, 6);
        }
    });

    test.each([
        // Flanking the overhang buries the bottom edge 2·R·sin(18.4°) deep.
        ["none", -10 * Math.sin(Math.atan(10 / 30)), false],
        ["raise", 0, false],
        ["tilt", 0, true],
    ])("keeps the tool's bottom edge out of the floor under an overhang (%s)", async (floorAvoidance, deepestEdge, upright) => {
        const part = prism([0, -10, 30]);
        const ruling = normalize([0, -10, 30]);
        const wall = faceFacing(part, normalize([0, -30, -10]));
        const context = fakeContext({
            machine: GENERIC_AC_TRUNNION,
            tool: FLAT_10,
            parts: [part],
            faces: [wall],
        });
        const result = await generate(
            SWARF_TYPE,
            { maxStep: 5, floorAvoidance, maxFloorTilt: 45, checkCollisions: false },
            context,
        );
        expect(result.isOk).toBe(true);
        const cutting = cuts(result.value, FLAT_10.cutting.feed);
        const bottomEdge = (move: (typeof cutting)[number]) =>
            move.to[2] - 5 * Math.sqrt(1 - move.axis![2] ** 2);
        expect(cutting.length).toBeGreaterThan(5);
        // Tilting goes in 0.5° steps, so it may clear the floor by a little more.
        expect(Math.min(...cutting.map(bottomEdge))).toBeCloseTo(deepestEdge, 1);
        for (const move of cutting) {
            expect(move.axis![2] > ruling[2] + 1e-9).toBe(upright);
            expect(angleBetween(move.axis!, ruling) < 1e-9).toBe(!upright);
        }
    });

    test("rejects a face that is not a ruled wall", async () => {
        const sphere = shapeFactory.sphere(new XYZ(0, 0, 0), 20);
        const context = fakeContext({
            machine: GENERIC_AC_TRUNNION,
            tool: FLAT_10,
            parts: [sphere.value],
            faces: [curvedFace(sphere.value)],
        });
        const result = await generate(SWARF_TYPE, {}, context);
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("face 1");
    });
});

describe("multi-axis contour", () => {
    function horizontalCylinder(): IShape {
        const cylinder = shapeFactory.cylinder(new XYZ(1, 0, 0), new XYZ(0, 0, 0), 20, 60);
        expect(cylinder.isOk).toBe(true);
        return cylinder.value;
    }

    test.each([
        [0, 0],
        [10, 0],
        [0, 15],
    ])("drives a raster over a cylinder with the axis on the radial normal (lead %d°, tilt %d°)", async (lead, tilt) => {
        const cylinder = horizontalCylinder();
        const context = fakeContext({
            machine: GENERIC_AC_TRUNNION,
            tool: BALL_6,
            parts: [cylinder],
            faces: [curvedFace(cylinder)],
        });
        const result = await generate(
            CONTOUR_5X_TYPE,
            { drive: "raster", rasterAngle: 90, stepover: 10, maxStep: 2, lead, tilt, maxAngleStep: 0 },
            context,
        );
        expect(result.isOk).toBe(true);
        const cutting = cuts(result.value, BALL_6.cutting.feed);
        expect(cutting.length).toBeGreaterThan(50);
        for (const move of cutting) {
            // Ball centre on the cylinder offset by the ball radius; its radial is the contact normal.
            const center = addScaled(move.to, move.axis!, 3);
            const radial = normalize([0, center[1], center[2]]);
            expect(Math.hypot(center[1], center[2])).toBeCloseTo(23, 3);
            expect(angleBetween(move.axis!, radial)).toBeCloseTo(Math.max(lead, tilt), 4);
            // Lead leans along the feed (around the cylinder), tilt sideways (along X).
            expect(Math.abs(move.axis![0])).toBeCloseTo(Math.sin((tilt * Math.PI) / 180), 4);
            expect(radial[2]).toBeGreaterThan(0);
        }
        // Raster lines at x = 0, 10, …, 60 (stepover 10 across the 60 mm face).
        const xs = new Set(cutting.map((move) => Math.round(move.to[0] + 3 * move.axis![0])));
        expect([...xs].sort((a, b) => a - b)).toEqual([0, 10, 20, 30, 40, 50, 60]);
    });

    /** The circular edge of a cylinder at the given axial end. */
    function circleEdge(cylinder: IShape, atEnd: (point: Vec3) => boolean): IEdge {
        const edge = (cylinder.findSubShapes(ShapeTypes.edge) as IEdge[]).find((candidate) => {
            const start = candidate.startPoint();
            return (
                Math.abs(candidate.length() - 2 * Math.PI * 20) < 1e-6 && atEnd([start.x, start.y, start.z])
            );
        });
        expect(edge).not.toBeUndefined();
        return edge!;
    }

    test("drives along a picked edge with the axis on the surface normal", async () => {
        const cylinder = shapeFactory.cylinder(new XYZ(0, 0, 1), new XYZ(0, 0, 0), 20, 30).value;
        const context = fakeContext({
            machine: GENERIC_AC_TRUNNION,
            tool: BALL_6,
            parts: [cylinder],
            faces: [curvedFace(cylinder)],
            edges: [circleEdge(cylinder, (point) => point[2] > 15)],
        });
        const result = await generate(
            CONTOUR_5X_TYPE,
            { drive: "edges", maxStep: 2, maxAngleStep: 5, checkCollisions: false },
            context,
        );
        expect(result.isOk).toBe(true);
        const cutting = cuts(result.value, BALL_6.cutting.feed);
        expect(cutting.length).toBeGreaterThan(60);
        for (const move of cutting) {
            // Ball on the surface normal: the tip is the contact, chords within the 0.01 tolerance.
            expect(Math.abs(Math.hypot(move.to[0], move.to[1]) - 20)).toBeLessThanOrEqual(0.01 + 1e-9);
            expect(move.to[2]).toBeCloseTo(30, 9);
            expect(angleBetween(move.axis!, normalize([move.to[0], move.to[1], 0]))).toBeLessThan(0.01);
        }
    });

    test("fails naming the point when a wide holder cannot tilt clear of the part", async () => {
        const cylinder = shapeFactory.cylinder(new XYZ(0, 0, 1), new XYZ(0, 0, 0), 20, 30).value;
        const stubby: ToolData = { ...BALL_6, stickout: 20, holder: { diameter: 80, length: 50 } };
        const context = fakeContext({
            machine: GENERIC_AC_TRUNNION,
            tool: stubby,
            parts: [cylinder],
            faces: [curvedFace(cylinder)],
            edges: [circleEdge(cylinder, (point) => point[2] > 15)],
        });
        const result = await generate(
            CONTOUR_5X_TYPE,
            { drive: "edges", maxStep: 2, maxTiltAway: 10 },
            context,
        );
        expect(result.isOk).toBe(false);
        expect(result.error).toMatch(
            /The tool holder hits the part at \(.+\) with the tip at \(.+, 30\.000\)/,
        );
        expect(result.error).toContain("tilting up to 10°");
    });

    test("fails naming the rotary limit when the surface turns under the trunnion's reach", async () => {
        const cylinder = horizontalCylinder();
        const context = fakeContext({
            machine: GENERIC_AC_TRUNNION,
            tool: BALL_6,
            parts: [cylinder],
            faces: [curvedFace(cylinder)],
            edges: [circleEdge(cylinder, (point) => point[0] > 30)],
        });
        const result = await generate(
            CONTOUR_5X_TYPE,
            { drive: "edges", maxStep: 2, maxAngleStep: 0, checkCollisions: false },
            context,
        );
        // All the way round includes the underside: A would pass −120°.
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("A =");
        expect(result.error).toContain("-120…30");
    });

    test("tilts away from a holder collision, or fails naming the point", () => {
        // A wall at x = 12 beside a vertical tool at the origin: the Ø32 holder overlaps it.
        const wall = {
            positions: new Float32Array([12, -50, 0, 12, 50, 0, 12, 50, 200, 12, -50, 200]),
            indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        };
        const grid = new TriangleGrid(wall);
        const assembly = toolAssembly(FLAT_10);
        const place = (): Vec3 => [0, 0, 0];
        const tilted = avoidCollision(grid, assembly, [0, 0, 1], place, { maxTilt: 30, clearance: 0.5 });
        expect(tilted.isOk).toBe(true);
        expect(tilted.value.tilted).toBeGreaterThan(0);
        expect(tilted.value.axis[0]).toBeLessThan(0);
        const holderAxisPoint = addScaled(tilted.value.tip, tilted.value.axis, assembly.stickout);
        expect(holderAxisPoint[0]).toBeLessThan(12 - assembly.holderRadius);
        const stuck = avoidCollision(grid, assembly, [0, 0, 1], place, { maxTilt: 2, clearance: 0.5 });
        expect(stuck.isOk).toBe(false);
        expect(stuck.error).toContain("holder");
        expect(stuck.error).toContain("(12.000,");
    });
});

describe("flowline", () => {
    test("follows the iso curves round a vertical cylinder with the axis on the normal", async () => {
        const cylinder = shapeFactory.cylinder(new XYZ(0, 0, 1), new XYZ(0, 0, 0), 20, 30);
        const face = curvedFace(cylinder.value);
        const context = fakeContext({
            machine: GENERIC_AC_TRUNNION,
            tool: BALL_6,
            parts: [cylinder.value],
            faces: [face],
        });
        const sampler = new FaceSampler(face);
        const bounds = sampler.uvBounds().value;
        sampler.dispose();
        expect(bounds.u2 - bounds.u1).toBeCloseTo(2 * Math.PI, 9);
        expect(bounds.v2 - bounds.v1).toBeCloseTo(30, 9);
        const result = await generate(
            FLOWLINE_5X_TYPE,
            { direction: "u", stepover: 10, maxStep: 3, maxAngleStep: 5, checkCollisions: false },
            context,
        );
        expect(result.isOk).toBe(true);
        const cutting = cuts(result.value, BALL_6.cutting.feed);
        for (const move of cutting) {
            expect(Math.abs(Math.hypot(move.to[0], move.to[1]) - 20)).toBeLessThanOrEqual(0.01 + 1e-9);
            expect(Math.abs(move.axis![2])).toBeLessThan(1e-9);
            expect(angleBetween(move.axis!, normalize([move.to[0], move.to[1], 0]))).toBeLessThan(0.01);
        }
        // Four passes (v = 0, 10, 20, 30), each once round.
        const heights = new Set(cutting.map((move) => Math.round(move.to[2] * 1e6) / 1e6));
        expect([...heights].sort((a, b) => a - b)).toEqual([0, 10, 20, 30]);
    });
});

describe("3+2 indexed", () => {
    const received: { context?: CamOperationContext } = {};
    const fakeInner: CamOperationHandler = {
        type: "test-plane-square",
        label: "Test square",
        category: "2d",
        machineKinds: ["mill"],
        defaults: () => ({ depth: 1 }),
        parameters: () => [{ key: "depth", label: "Depth", kind: "length" }],
        generate(operation, context) {
            received.context = context;
            const z = -Number(operation.params["depth"]);
            return Result.ok({
                toolId: context.tool.id,
                label: "square",
                moves: [
                    { kind: "rapid", to: [0, 0, 10] },
                    { kind: "rapid", to: [0, 0, 1] },
                    { kind: "linear", to: [0, 0, z], feed: 300 },
                    { kind: "linear", to: [10, 0, z], feed: 900 },
                    {
                        kind: "arc",
                        to: [20, 10, z],
                        center: [10, 10, z],
                        clockwise: false,
                        plane: "XY",
                        feed: 900,
                    },
                    { kind: "linear", to: [20, 20, z], feed: 900 },
                    { kind: "rapid", to: [20, 20, 10] },
                ],
            });
        },
    };
    registerCamOperation(fakeInner);

    function box() {
        const solid = shapeFactory.box(Plane.XY, 40, 30, 20);
        expect(solid.isOk).toBe(true);
        return solid.value;
    }

    test("runs the inner operation in the face's frame and maps it back with a fixed axis", async () => {
        const part = box();
        const front = faceFacing(part, [0, -1, 0]);
        const context = fakeContext({
            machine: GENERIC_AC_TRUNNION,
            tool: FLAT_10,
            parts: [part],
            faces: [front],
        });
        const result = await generate(
            INDEXED_TYPE,
            {
                innerType: fakeInner.type,
                "inner.depth": 2,
                orientation: "face",
                origin: "face",
                arcTolerance: 0.001,
            },
            context,
        );
        expect(result.isOk).toBe(true);

        // The inner operation saw the face as its +Z plane, the part behind it.
        const inner = received.context!;
        const innerFace = inner.selectedFaces()[0];
        const sampler = new FaceSampler(innerFace);
        const bounds = sampler.uvBounds().value;
        const center = sampler.at((bounds.u1 + bounds.u2) / 2, (bounds.v1 + bounds.v2) / 2);
        sampler.dispose();
        expect(angleBetween(center.normal, [0, 0, 1])).toBeLessThan(1e-9);
        expect(length(center.point)).toBeLessThan(1e-9);
        expect(inner.stock.max[2]).toBeCloseTo(0, 9);
        expect(inner.stock.min[2]).toBeCloseTo(-30, 9);
        const mesh = inner.partMesh();
        let top = Number.NEGATIVE_INFINITY;
        for (let i = 2; i < mesh.positions.length; i += 3) top = Math.max(top, mesh.positions[i]);
        expect(top).toBeCloseTo(0, 4);

        // Frame: +Z = −Y (the face normal), +X = X, +Y = Z; origin at the face centre (20, 0, 10).
        const toWcs = (p: Vec3): Vec3 => [20 + p[0], 0 - p[2], 10 + p[1]];
        const moves = result.value.moves;
        expect(moves.every((move) => move.kind === "rapid" || move.kind === "linear")).toBe(true);
        for (const move of moves) {
            expect(angleBetween((move as { axis: Vec3 }).axis, [0, -1, 0])).toBeLessThan(1e-12);
        }
        expect(distance((moves[0] as { to: Vec3 }).to, toWcs([0, 0, 10]))).toBeLessThan(1e-12);
        expect(distance((moves[3] as { to: Vec3 }).to, toWcs([10, 0, -2]))).toBeLessThan(1e-12);
        expect(distance((moves.at(-1) as { to: Vec3 }).to, toWcs([20, 20, 10]))).toBeLessThan(1e-12);
        // The arc became straight moves on the mapped circle.
        const arcCenter = toWcs([10, 10, -2]);
        const arc = moves.slice(4, -2) as { to: Vec3 }[];
        expect(arc.length).toBeGreaterThan(10);
        for (const move of arc) expect(distance(move.to, arcCenter)).toBeCloseTo(10, 9);
        // A post sees a 3+2 toolpath.
        expect(toolpathMode(result.value).mode).toBe("indexed");
    });

    test("tilts by explicit rotary angles through the machine kinematics", async () => {
        const part = box();
        const context = fakeContext({ machine: GENERIC_AC_TRUNNION, tool: FLAT_10, parts: [part] });
        const result = await generate(
            INDEXED_TYPE,
            { innerType: fakeInner.type, orientation: "rotary", A: -90, C: 0 },
            context,
        );
        expect(result.isOk).toBe(true);
        for (const move of result.value.moves) {
            expect(angleBetween((move as { axis: Vec3 }).axis, [0, -1, 0])).toBeLessThan(1e-9);
        }
        // 130° off vertical is past the trunnion's A travel on either side.
        const beyond = await generate(
            INDEXED_TYPE,
            { innerType: fakeInner.type, orientation: "rotary", A: -130 },
            context,
        );
        expect(beyond.isOk).toBe(false);
        expect(beyond.error).toContain("A =");
    });

    test("fails without an inner operation or a planar face", async () => {
        const part = box();
        const context = fakeContext({ machine: GENERIC_AC_TRUNNION, tool: FLAT_10, parts: [part] });
        const none = await generate(INDEXED_TYPE, {}, context);
        expect(none.isOk).toBe(false);
        expect(none.error).toContain("choose the operation");
        const cylinder = shapeFactory.cylinder(new XYZ(0, 0, 1), new XYZ(0, 0, 0), 10, 10).value;
        const curved = await generate(
            INDEXED_TYPE,
            { innerType: fakeInner.type },
            fakeContext({
                machine: GENERIC_AC_TRUNNION,
                tool: FLAT_10,
                parts: [cylinder],
                faces: [curvedFace(cylinder)],
            }),
        );
        expect(curved.isOk).toBe(false);
        expect(curved.error).toContain("not planar");
    });

    test("lists the inner operation's parameters under its own", () => {
        const handler = camOperation(INDEXED_TYPE)!;
        const specs = handler.parameters(operationOf(INDEXED_TYPE, { innerType: fakeInner.type }, FLAT_10));
        expect(specs.find((spec) => spec.key === "inner.depth")?.label).toBe("Test square: Depth");
        const types = specs.find((spec) => spec.key === "innerType")?.options?.map((option) => option.value);
        expect(types).toContain(fakeInner.type);
        expect(types).not.toContain(INDEXED_TYPE);
    });
});
