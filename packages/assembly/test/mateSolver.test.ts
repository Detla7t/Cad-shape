// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    applyRigid,
    axisAngle,
    dot,
    type Frame,
    IDENTITY,
    makeFrame,
    norm,
    type Rigid,
    sub,
    transformFrame,
    type Vec3,
} from "../src/math/rigid";
import {
    MATE_DOF_REMOVED,
    type MateType,
    mateTarget,
    type SolverInstance,
    type SolverMate,
    solveMates,
} from "../src/solver/mateSolver";

/**
 * The mate solver on plain frames: two 10 mm blocks, A grounded at the origin, B dropped
 * somewhere skewed. A's connector sits on its top face (outward +Z), B's on its bottom face
 * (outward −Z) — the frames a pick of the two touching faces infers.
 */

const TOP: Frame = makeFrame([5, 5, 10], [0, 0, 1], [1, 0, 0]);
const BOTTOM: Frame = makeFrame([5, 5, 0], [0, 0, -1], [1, 0, 0]);

const skewed: Rigid = {
    r: axisAngle([0.3, 0.5, 0.8].map((x) => x / Math.hypot(0.3, 0.5, 0.8)) as unknown as Vec3, 1.1),
    t: [40, -25, 13],
};

const instances = (bTransform: Rigid = skewed): SolverInstance[] => [
    { id: "A", transform: IDENTITY, grounded: true },
    { id: "B", transform: bTransform, grounded: false },
];

const mate = (type: MateType, extra: Partial<SolverMate> = {}): SolverMate => ({
    id: `${type}-1`,
    type,
    a: { instanceId: "A", frame: TOP },
    b: { instanceId: "B", frame: BOTTOM },
    ...extra,
});

function worldFrame(result: ReturnType<typeof solveMates>, id: string, frame: Frame): Frame {
    return transformFrame(result.transforms.get(id)!, frame);
}

const close = (a: Vec3, b: Vec3, tol = 1e-6) => norm(sub(a, b)) < tol;

describe("mate solver", () => {
    test.each([
        ["fastened", 0],
        ["revolute", 1],
        ["slider", 1],
        ["cylindrical", 2],
        ["planar", 3],
        ["ball", 3],
        ["parallel", 4],
    ] as const)("a %s mate is satisfied and leaves %i degrees of freedom", (type, dof) => {
        const result = solveMates(instances(), [mate(type)]);
        expect(result.status).toBe("solved");
        expect(result.mates[0].satisfied).toBe(true);
        expect(result.mates[0].residual).toBeLessThan(1e-6);
        expect(result.dof).toBe(dof);
        expect(result.instanceDof.get("B")).toBe(dof);
        expect(result.dof).toBe(6 - MATE_DOF_REMOVED[type]);
        expect(result.redundant).toBe(0);
        expect(result.overConstrained).toBe(false);
        expect(result.underConstrained).toBe(dof > 0);
        // The grounded instance never moves.
        expect(result.transforms.get("A")).toEqual(IDENTITY);
    });

    test("fastened puts the faces together, opposed and touching", () => {
        const result = solveMates(instances(), [mate("fastened")]);
        const b = worldFrame(result, "B", BOTTOM);
        expect(close(b.origin, [5, 5, 10])).toBe(true);
        expect(close(b.z, [0, 0, -1])).toBe(true);
        expect(close(b.x, [1, 0, 0])).toBe(true);
        // B sits on top of A, unrotated: its own origin lands at z = 10.
        expect(close(applyRigid(result.transforms.get("B")!, [0, 0, 0]), [0, 0, 10])).toBe(true);
    });

    test("an offset and a flip move the target", () => {
        const result = solveMates(instances(), [
            mate("fastened", { offset: { z: 2, angle: Math.PI / 2 }, flipped: true }),
        ]);
        const b = worldFrame(result, "B", BOTTOM);
        // 2 mm above the top face, Z aligned (flipped), X turned a quarter.
        expect(close(b.origin, [5, 5, 12])).toBe(true);
        expect(close(b.z, [0, 0, 1])).toBe(true);
        expect(close(b.x, [0, 1, 0])).toBe(true);
    });

    test("revolute keeps the axis and the point, and the angle is free", () => {
        const result = solveMates(instances(), [mate("revolute")]);
        const b = worldFrame(result, "B", BOTTOM);
        expect(close(b.origin, [5, 5, 10])).toBe(true);
        expect(close(b.z, [0, 0, -1])).toBe(true);
        expect(result.mates[0].value).toBeDefined();
    });

    test("slider keeps orientation and the axis line; the distance is free", () => {
        const start: Rigid = { r: IDENTITY.r, t: [3, 4, 30] };
        const result = solveMates(instances(start), [mate("slider")]);
        const b = worldFrame(result, "B", BOTTOM);
        expect(close([b.origin[0], b.origin[1], 0], [5, 5, 0])).toBe(true);
        // Already aligned: the solve only removes the lateral offset and keeps the height.
        expect(b.origin[2]).toBeCloseTo(30, 6);
        expect(result.mates[0].value).toBeCloseTo(20, 6);
    });

    test("planar keeps the faces in one plane, free to slide and spin in it", () => {
        const start: Rigid = { r: axisAngle([0, 0, 1], 0.4), t: [17, -8, 3] };
        const result = solveMates(instances(start), [mate("planar")]);
        const b = worldFrame(result, "B", BOTTOM);
        expect(b.origin[2]).toBeCloseTo(10, 6);
        expect(close(b.z, [0, 0, -1])).toBe(true);
        // In-plane position untouched by the snap (it only moves along the normal).
        const origin = applyRigid(result.transforms.get("B")!, [0, 0, 0]);
        expect(origin[0]).toBeCloseTo(17, 6);
        expect(origin[1]).toBeCloseTo(-8, 6);
    });

    test("conflicting mates are reported as failing and over-constrained", () => {
        const result = solveMates(instances(), [
            mate("fastened", { id: "m1" }),
            mate("fastened", { id: "m2", offset: { z: 5 } }),
        ]);
        expect(result.status).toBe("conflicting");
        expect(result.overConstrained).toBe(true);
        expect(result.failingMates.length).toBeGreaterThan(0);
        expect(result.failingMates.every((id) => id === "m1" || id === "m2")).toBe(true);
    });

    test("consistent duplicate mates are redundant: solved, but over-constrained", () => {
        const result = solveMates(instances(), [
            mate("fastened", { id: "m1" }),
            mate("revolute", { id: "m2" }),
        ]);
        expect(result.status).toBe("solved");
        expect(result.failingMates).toEqual([]);
        expect(result.dof).toBe(0);
        expect(result.redundant).toBe(5);
        expect(result.overConstrained).toBe(true);
    });

    test("a chain passes its freedom down: revolute then fastened", () => {
        const c: SolverInstance = {
            id: "C",
            transform: { r: axisAngle([1, 0, 0], 2), t: [-30, 9, 0] },
            grounded: false,
        };
        const result = solveMates(
            [...instances(), c],
            [
                mate("revolute", { id: "r" }),
                {
                    id: "f",
                    type: "fastened",
                    a: { instanceId: "B", frame: makeFrame([5, 5, -10], [0, 0, 1], [1, 0, 0]) },
                    b: { instanceId: "C", frame: BOTTOM },
                },
            ],
        );
        expect(result.status).toBe("solved");
        expect(result.dof).toBe(1);
        expect(result.instanceDof.get("B")).toBe(1);
        expect(result.instanceDof.get("C")).toBe(1);
        expect(result.floating).toEqual([]);
    });

    test("an unmated, ungrounded instance is floating with 6 DOF", () => {
        const loose: SolverInstance = { id: "L", transform: IDENTITY, grounded: false };
        const result = solveMates([...instances(), loose], [mate("fastened")]);
        expect(result.instanceDof.get("L")).toBe(6);
        expect(result.floating).toEqual(["L"]);
        expect(result.dof).toBe(6);
        expect(result.transforms.get("L")).toEqual(IDENTITY);
    });

    test("a revolute limit clamps the angle to the nearer bound", () => {
        // Start already on the axis, turned 60° about it.
        const turned: Rigid = { r: axisAngle([0, 0, 1], Math.PI / 3), t: [0, 0, 0] };
        const pivot: Vec3 = [5, 5, 10];
        const start: Rigid = {
            r: turned.r,
            t: sub(pivot, applyRigid(turned, [5, 5, 0])),
        };
        const free = solveMates(instances(start), [mate("revolute")]);
        expect(Math.abs(free.mates[0].value!)).toBeCloseTo(Math.PI / 3, 6);
        const limited = solveMates(instances(start), [
            mate("revolute", { limits: { min: -Math.PI / 6, max: Math.PI / 6 } }),
        ]);
        expect(limited.status).toBe("solved");
        expect(limited.mates[0].limitActive).toBeDefined();
        expect(Math.abs(limited.mates[0].value!)).toBeCloseTo(Math.PI / 6, 5);
        expect(limited.dof).toBe(0);
    });

    test("dragging moves an instance only within its degrees of freedom", () => {
        const solved = solveMates(instances(), [mate("revolute")]);
        const b = solved.transforms.get("B")!;
        const grabbed: Vec3 = [10, 10, 0]; // a corner of B, off the revolute axis
        const before = applyRigid(b, grabbed);
        const result = solveMates(
            [
                { id: "A", transform: IDENTITY, grounded: true },
                { id: "B", transform: b, grounded: false },
            ],
            [mate("revolute")],
            {
                drag: {
                    instanceId: "B",
                    localPoint: grabbed,
                    target: [before[0] - 20, before[1] + 20, before[2] + 50],
                },
                noSnap: true,
            },
        );
        expect(result.mates[0].satisfied).toBe(true);
        const after = applyRigid(result.transforms.get("B")!, grabbed);
        // It turned about the axis (the corner stays at the same height and radius) ...
        expect(after[2]).toBeCloseTo(before[2], 5);
        const radius = (p: Vec3) => Math.hypot(p[0] - 5, p[1] - 5);
        expect(radius(after)).toBeCloseTo(radius(before), 5);
        // ... towards the pointer.
        expect(norm(sub(after, before))).toBeGreaterThan(1);
    });

    test("mate targets compose offset, rotation and the default flip", () => {
        const target = mateTarget(mate("fastened", { offset: { x: 1 } }), TOP);
        expect(close(target.origin, [6, 5, 10])).toBe(true);
        expect(close(target.z, [0, 0, -1])).toBe(true);
        expect(dot(target.x, [1, 0, 0])).toBeCloseTo(1, 9);
    });

    test("a mate to an unknown instance fails without disturbing the rest", () => {
        const result = solveMates(instances(), [
            mate("fastened"),
            { ...mate("ball"), id: "ghost", b: { instanceId: "missing", frame: BOTTOM } },
        ]);
        expect(result.failingMates).toEqual(["ghost"]);
        expect(result.mates.find((m) => m.id === "fastened-1")!.satisfied).toBe(true);
    });
});
