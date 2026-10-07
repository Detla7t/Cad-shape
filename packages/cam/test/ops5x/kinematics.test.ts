// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MachineProfileData } from "../../src/model/machine";
import type { Vec3 } from "../../src/model/toolpath";
import { FiveAxisKinematics } from "../../src/ops5x/kinematics";
import {
    interpolatedTip,
    limitAxisSteps,
    linearizeSegment,
    motionPoint,
    rotaryDelta,
} from "../../src/ops5x/linearize";
import {
    GENERIC_AC_TRUNNION,
    GENERIC_AC_TRUNNION_NON_TCP,
    GENERIC_BC_HEAD_TABLE,
    GENERIC_CA_HEAD_HEAD,
} from "../../src/ops5x/machines";
import { angleBetween, DEG, distance, distanceToSegment, lerp } from "../../src/ops5x/vec";

function kinematicsOf(
    profile: MachineProfileData,
    options?: Parameters<typeof FiveAxisKinematics.fromProfile>[1],
) {
    const result = FiveAxisKinematics.fromProfile(profile, options);
    expect(result.isOk).toBe(true);
    return result.value;
}

/** Unit vector `polar` degrees off +Z towards azimuth `azimuth` (from +X). */
function axisAt(polar: number, azimuth: number): Vec3 {
    const p = polar * DEG;
    const a = azimuth * DEG;
    return [Math.sin(p) * Math.cos(a), Math.sin(p) * Math.sin(a), Math.cos(p)];
}

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
}

describe("5-axis kinematics", () => {
    test.each([
        ["AC table-table", GENERIC_AC_TRUNNION, 115],
        ["BC head-table", GENERIC_BC_HEAD_TABLE, 105],
        ["CA head-head", GENERIC_CA_HEAD_HEAD, 100],
    ])("FK∘IK is the identity on reachable tool axes (%s)", (_name, profile, maxPolar) => {
        const kinematics = kinematicsOf(profile);
        const next = random(7);
        for (let i = 0; i < 200; i++) {
            const axis = axisAt(next() * maxPolar, next() * 360 - 180);
            const solved = kinematics.inverse(axis);
            expect(solved.isOk).toBe(true);
            expect(kinematics.withinLimits(solved.value.angles)).toBe(true);
            expect(angleBetween(kinematics.toolAxis(solved.value.angles), axis)).toBeLessThan(1e-7);
        }
    });

    test.each([
        ["AC table-table", GENERIC_AC_TRUNNION],
        ["BC head-table", GENERIC_BC_HEAD_TABLE],
        ["CA head-head", GENERIC_CA_HEAD_HEAD],
    ])("both solutions reach the axis and mirror the tilt (%s)", (_name, profile) => {
        const kinematics = kinematicsOf(profile);
        const axis = axisAt(35, 60);
        const solutions = kinematics.solutions(axis);
        expect(solutions.length).toBe(2);
        for (const solution of solutions) {
            expect(angleBetween(kinematics.toolAxis(solution.angles), axis)).toBeLessThan(1e-9);
        }
        const tilt = kinematics.tiltJoint;
        const spin = 1 - tilt;
        expect(solutions[0].angles[tilt]).toBeCloseTo(-solutions[1].angles[tilt], 9);
        const spinDifference = Math.abs(solutions[0].angles[spin] - solutions[1].angles[spin]);
        expect(spinDifference).toBeCloseTo(180, 9);
    });

    test("the trunnion's A limits pick the reachable solution or fail naming the axis", () => {
        const kinematics = kinematicsOf(GENERIC_AC_TRUNNION);
        // 60° off vertical: A = +60 is beyond the +30 limit, so A = -60 is used.
        const sixty = kinematics.inverse(axisAt(60, 20));
        expect(sixty.isOk).toBe(true);
        expect(sixty.value.angles[0]).toBeCloseTo(-60, 9);
        // 130° needs |A| = 130 on either side: out of -120…30.
        const beyond = kinematics.inverse(axisAt(130, 20));
        expect(beyond.isOk).toBe(false);
        expect(beyond.error).toContain("A =");
        expect(beyond.error).toContain("-120…30");
    });

    test("continuity follows the previous angles and unwinds C the short way round", () => {
        const kinematics = kinematicsOf(GENERIC_AC_TRUNNION);
        let previous: number[] | undefined;
        const cs: number[] = [];
        for (let azimuth = 0; azimuth <= 720; azimuth += 10) {
            const solved = kinematics.inverse(axisAt(30, azimuth), previous);
            expect(solved.isOk).toBe(true);
            if (previous) expect(rotaryDelta(previous, solved.value.angles)).toBeLessThan(10 + 1e-6);
            previous = solved.value.angles;
            cs.push(previous[1]);
        }
        // The continuous C keeps turning one way through 720° instead of jumping back.
        expect(cs[cs.length - 1] - cs[0]).toBeCloseTo(-720, 6);
        expect(cs.every((c, i) => i === 0 || c < cs[i - 1])).toBe(true);
        // The A = -30 branch needs C = -90 for this axis; next to a previous C of 350° that is 270°.
        const near = kinematics.inverse(axisAt(30, 0), [-30, 350]);
        expect(near.isOk).toBe(true);
        expect(near.value.angles[0]).toBeCloseTo(-30, 9);
        expect(near.value.angles[1]).toBeCloseTo(270, 9);
    });

    test("at the pole the free C axis holds its previous angle", () => {
        const kinematics = kinematicsOf(GENERIC_AC_TRUNNION);
        const vertical = kinematics.inverse([0, 0, 1], [-20, 37]);
        expect(vertical.isOk).toBe(true);
        expect(vertical.value.singular).toBe(true);
        expect(vertical.value.angles).toEqual([0, 37]);
        // Inside the 0.01° cone the axis still holds C.
        const almost = kinematics.inverse(axisAt(0.005, 120), [-20, 37]);
        expect(almost.value.singular).toBe(true);
        expect(almost.value.angles[1]).toBe(37);
        expect(Math.abs(almost.value.angles[0])).toBeLessThan(0.01);
        // Head-head: the pole is the C head's axis.
        const head = kinematicsOf(GENERIC_CA_HEAD_HEAD).inverse([0, 0, 1], [12, 5]);
        expect(head.value.singular).toBe(true);
        expect(head.value.angles).toEqual([12, 0]);
    });

    test("a limited C rewinds into its range instead of exceeding it", () => {
        const kinematics = kinematicsOf(GENERIC_CA_HEAD_HEAD);
        const solved = kinematics.inverse(axisAt(30, 10), [10, 355]);
        expect(solved.isOk).toBe(true);
        expect(solved.value.angles[0]).toBeLessThanOrEqual(360);
        expect(kinematics.withinLimits(solved.value.angles)).toBe(true);
        // Without limits it would have continued past 360°.
        const free = kinematics.inverse(axisAt(30, 10), [355, 30], true);
        const limited = kinematics.inverse(axisAt(30, 10), [355, 30]);
        expect(free.value.angles[0]).toBeGreaterThan(360);
        expect(limited.value.angles[0]).toBeLessThanOrEqual(360);
    });

    test.each([
        ["AC table-table, centre offset", GENERIC_AC_TRUNNION, { workOffset: [-40, 25, -80] as Vec3 }],
        ["BC head-table", GENERIC_BC_HEAD_TABLE, {}],
        ["CA head-head", GENERIC_CA_HEAD_HEAD, {}],
    ])("machine coordinates round-trip through the tip (%s)", (_name, profile, options) => {
        const kinematics = kinematicsOf(profile, options);
        const next = random(11);
        for (let i = 0; i < 50; i++) {
            const tip: Vec3 = [next() * 200 - 100, next() * 200 - 100, next() * 50];
            const solved = kinematics.inverse(axisAt(next() * 90, next() * 360));
            const machine = kinematics.machinePosition(tip, solved.value.angles, 80);
            expect(distance(kinematics.tipPosition(machine, solved.value.angles, 80), tip)).toBeLessThan(
                1e-9,
            );
        }
    });

    test("machine coordinates follow the table rotation and the head pivot", () => {
        const table = kinematicsOf(GENERIC_AC_TRUNNION);
        // C +90° turns the table: a WCS point on +X comes under the tool at +Y.
        const turned = table.machinePosition([10, 0, 0], [0, 90]);
        expect(distance(turned, [0, 10, 0])).toBeLessThan(1e-12);
        // A head-head A +90° swings the spindle; the pivot (200 + 50 above the tip) stays put.
        const head = kinematicsOf(GENERIC_CA_HEAD_HEAD);
        const angles = [0, 90];
        const axis = head.toolAxis(angles);
        expect(distance(axis, [0, -1, 0])).toBeLessThan(1e-12);
        const machine = head.machinePosition([0, 0, 0], angles, 50);
        // Controlled point = pivot − 250·Z; pivot = tip + 250·axis.
        expect(distance(machine, [0, -250, -250])).toBeLessThan(1e-9);
    });

    test("a 4-axis A table reaches only axes in the YZ plane", () => {
        const fourAxis: MachineProfileData = {
            ...GENERIC_AC_TRUNNION,
            id: "test-4ax",
            rotaryAxes: [{ name: "A", direction: [1, 0, 0], carrier: "table" }],
            kinematics: undefined,
        };
        const kinematics = kinematicsOf(fourAxis);
        const inPlane = kinematics.inverse(axisAt(40, 90));
        expect(inPlane.isOk).toBe(true);
        expect(angleBetween(kinematics.toolAxis(inPlane.value.angles), axisAt(40, 90))).toBeLessThan(1e-9);
        expect(kinematics.inverse(axisAt(40, 0)).isOk).toBe(false);
    });

    test("profiles without a describable chain fail", () => {
        const parallel: MachineProfileData = {
            ...GENERIC_AC_TRUNNION,
            rotaryAxes: [
                { name: "A", direction: [0, 0, 1], carrier: "table" },
                { name: "C", direction: [0, 0, 1], carrier: "table" },
            ],
        };
        expect(FiveAxisKinematics.fromProfile(parallel).isOk).toBe(false);
        const noRotaries: MachineProfileData = {
            ...GENERIC_AC_TRUNNION,
            rotaryAxes: [],
            kinematics: undefined,
        };
        expect(FiveAxisKinematics.fromProfile(noRotaries).isOk).toBe(false);
    });
});

describe("5-axis linearization", () => {
    test("non-TCP blocks keep the joint-interpolated tip within the tolerance of the line", () => {
        const kinematics = kinematicsOf(GENERIC_AC_TRUNNION_NON_TCP);
        const start = motionPoint(kinematics, [60, 0, 10], [0, 0, 1], [0, 0]);
        expect(start.isOk).toBe(true);
        const end = motionPoint(kinematics, [60, 30, 10], axisAt(40, 135), start.value.angles);
        const counts: number[] = [];
        for (const tolerance of [0.1, 0.01, 0.001]) {
            const blocks = linearizeSegment(kinematics, start.value, end.value, { tolerance });
            expect(blocks.isOk).toBe(true);
            counts.push(blocks.value.length);
            let from = start.value;
            for (const block of blocks.value) {
                for (let t = 0; t <= 1; t += 0.05) {
                    const actual = interpolatedTip(kinematics, from, block, t).tip;
                    // The probes guarantee the tolerance up to the curvature between them.
                    expect(distanceToSegment(actual, start.value.tip, end.value.tip)).toBeLessThan(
                        tolerance * 1.5,
                    );
                }
                expect(angleBetween(kinematics.toolAxis(block.angles), block.axis)).toBeLessThan(1e-7);
                from = block;
            }
            expect(blocks.value.at(-1)?.tip).toEqual(end.value.tip);
        }
        expect(counts[0]).toBeGreaterThan(1);
        expect(counts[1]).toBeGreaterThan(counts[0]);
        expect(counts[2]).toBeGreaterThan(counts[1]);
    });

    test("TCP blocks split only by the rotary step", () => {
        const kinematics = kinematicsOf(GENERIC_AC_TRUNNION);
        const start = motionPoint(kinematics, [60, 0, 10], axisAt(10, 0), [0, 0]).value;
        const end = motionPoint(kinematics, [60, 30, 10], axisAt(40, 135), start.angles).value;
        const unlimited = linearizeSegment(kinematics, start, end, { tcp: true });
        expect(unlimited.value.length).toBe(1);
        const stepped = linearizeSegment(kinematics, start, end, { tcp: true, maxAngleStep: 5 });
        let from = start;
        for (const block of stepped.value) {
            expect(rotaryDelta(from.angles, block.angles)).toBeLessThanOrEqual(5 + 1e-9);
            expect(distanceToSegment(block.tip, start.tip, end.tip)).toBeLessThan(1e-9);
            from = block;
        }
        expect(stepped.value.length).toBeGreaterThan(1);
    });

    test("leaving the pole turns the free axis on the pole first", () => {
        const kinematics = kinematicsOf(GENERIC_AC_TRUNNION);
        const start = motionPoint(kinematics, [60, 0, 10], [0, 0, 1], [0, 0]).value;
        const end = motionPoint(kinematics, [60, 30, 10], axisAt(40, 135), start.angles).value;
        expect(Math.abs(end.angles[1])).toBeGreaterThan(10);
        const blocks = linearizeSegment(kinematics, start, end, { tcp: true, maxAngleStep: 5 }).value;
        const onPole = blocks.filter((block) => distance(block.tip, start.tip) < 1e-12);
        expect(onPole.length).toBeGreaterThan(1);
        for (const block of onPole) {
            expect(block.angles[0]).toBeCloseTo(0, 9);
            expect(angleBetween(block.axis, [0, 0, 1])).toBeLessThan(1e-9);
        }
        expect(onPole.at(-1)!.angles[1]).toBeCloseTo(end.angles[1], 9);
        let from = start;
        for (const block of blocks) {
            expect(rotaryDelta(from.angles, block.angles)).toBeLessThanOrEqual(5 + 1e-9);
            from = block;
        }
    });

    test("axis steps are limited in WCS along the great circle", () => {
        const moves = limitAxisSteps(
            [
                { kind: "rapid", to: [0, 0, 10], axis: [0, 0, 1] },
                { kind: "linear", to: [10, 0, 10], feed: 500, axis: axisAt(10, 0) },
            ],
            2,
        );
        expect(moves.length).toBe(6);
        for (let i = 1; i < moves.length; i++) {
            const move = moves[i] as { to: Vec3; axis: Vec3 };
            expect(angleBetween(move.axis, axisAt(2 * i, 0))).toBeLessThan(1e-9);
            expect(distance(move.to, lerp([0, 0, 10], [10, 0, 10], i / 5))).toBeLessThan(1e-12);
        }
    });
});
