// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MachineProfileData } from "../../src/model/machine";
import { postProcessor } from "../../src/model/post";
import type { ToolpathData, ToolpathMove } from "../../src/model/toolpath";
import "../../src/ops5x";
import { FiveAxisKinematics } from "../../src/ops5x/kinematics";
import {
    GENERIC_AC_TRUNNION,
    GENERIC_AC_TRUNNION_NON_TCP,
    GENERIC_BC_HEAD_TABLE,
    GENERIC_CA_HEAD_HEAD,
} from "../../src/ops5x/machines";
import { planProgram, toolpathMode } from "../../src/ops5x/posts/plan";
import { angleBetween } from "../../src/ops5x/vec";
import { BALL_6, program, SETUP, tilted } from "./postFixture";
import { GOLDEN } from "./postGoldens";

describe("5-axis posts", () => {
    test.each([
        ["fanuc-30i-5axis", GENERIC_AC_TRUNNION, undefined],
        ["haas-umc-5axis", GENERIC_AC_TRUNNION, undefined],
        ["siemens-840d-5axis", GENERIC_AC_TRUNNION, undefined],
        ["heidenhain-tnc-5axis", GENERIC_BC_HEAD_TABLE, undefined],
        ["generic-5axis-nontcp", GENERIC_AC_TRUNNION_NON_TCP, { tolerance: 0.05, maxAngleStep: 30 }],
    ])("%s writes the golden program", (id, machine, options) => {
        const post = postProcessor(id);
        expect(post).not.toBeUndefined();
        const output = post!.post(program(machine), options);
        expect(output.isOk).toBe(true);
        expect(output.value).toBe(GOLDEN[id]);
    });

    test.each([
        ["fanuc-30i-5axis", GENERIC_AC_TRUNNION],
        ["haas-umc-5axis", GENERIC_AC_TRUNNION],
        ["siemens-840d-5axis", GENERIC_AC_TRUNNION],
        ["heidenhain-tnc-5axis", GENERIC_BC_HEAD_TABLE],
    ])("%s writes its comments in ASCII", (id, machine) => {
        const base = program(machine);
        const named = {
            ...base,
            name: "Gehäuse",
            tools: new Map([...base.tools].map(([key, tool]) => [key, { ...tool, name: "Kugelfräser Ø6" }])),
            toolpaths: base.toolpaths.map((path) => ({
                ...path,
                label: `${path.label} Ø6, 30°`,
                moves: [{ kind: "comment", text: "tool Ø6 × 2" } as ToolpathMove, ...path.moves],
            })),
        };
        const output = postProcessor(id)!.post(named);
        expect(output.isOk).toBe(true);
        expect(output.value).toMatch(/^[\x20-\x7e\n]*$/);
        expect(output.value.toUpperCase()).toContain("KUGELFRASER D6");
        expect(output.value.toUpperCase()).toContain("TOOL D6 X 2");
    });

    test("toolpaths are classified by their tool axes", () => {
        const { toolpaths } = program(GENERIC_AC_TRUNNION);
        expect(toolpaths.map((path) => toolpathMode(path).mode)).toEqual([
            "3axis",
            "indexed",
            "simultaneous",
        ]);
        expect(angleBetween(toolpathMode(toolpaths[1]).axis, tilted(30, 90))).toBeLessThan(1e-9);
    });

    test("vector output writes the WCS tool axis (Siemens A3/B3/C3, Heidenhain LN)", () => {
        const siemens = postProcessor("siemens-840d-5axis")!.post(program(GENERIC_CA_HEAD_HEAD), {
            orientation: "vector",
        });
        expect(siemens.isOk).toBe(true);
        expect(siemens.value).toContain("ORIWKS ORIVECT");
        expect(siemens.value).toContain("X20 A3=-0.34202 C3=0.939693");
        const heidenhain = postProcessor("heidenhain-tnc-5axis")!.post(program(GENERIC_CA_HEAD_HEAD), {
            orientation: "vector",
        });
        expect(heidenhain.isOk).toBe(true);
        expect(heidenhain.value).toMatch(
            /LN X\+20\.000 Y\+0\.000 Z\+0\.000 TX-0\.3420201 TY\+0\.0000000 TZ\+0\.9396926 R0/,
        );
    });

    test("a limited rotary rewinds off the part instead of passing its limit", () => {
        const limited: MachineProfileData = {
            ...GENERIC_AC_TRUNNION,
            rotaryAxes: [
                { name: "A", direction: [1, 0, 0], min: -120, max: 30, carrier: "table" },
                { name: "C", direction: [0, 0, 1], min: -200, max: 200, carrier: "table" },
            ],
        };
        // The tool axis circles the pole twice: C would wind to 720°.
        const moves: ToolpathMove[] = [{ kind: "rapid", to: [0, 0, 10], axis: tilted(30, 0) }];
        for (let azimuth = 0; azimuth <= 720; azimuth += 15) {
            moves.push({ kind: "linear", to: [azimuth / 10, 0, 0], feed: 800, axis: tilted(30, azimuth) });
        }
        const plan = planProgram(
            { ...program(limited), toolpaths: [{ toolId: BALL_6.id, moves }] },
            { tcp: true, rewindRetract: 25 },
        );
        expect(plan.isOk).toBe(true);
        const kinematics = FiveAxisKinematics.fromProfile(limited).value;
        const blocks = plan.value.toolpaths[0].blocks;
        const rewinds = blocks.filter(
            (block) => block.kind === "comment" && block.text === "rewind rotary axes",
        );
        expect(rewinds.length).toBeGreaterThan(0);
        for (const block of blocks) {
            if (block.kind !== "rapid" && block.kind !== "linear") continue;
            expect(kinematics.withinLimits(block.point.angles)).toBe(true);
            expect(angleBetween(kinematics.toolAxis(block.point.angles), block.point.axis)).toBeLessThan(
                1e-7,
            );
            if (block.kind === "linear") expect(block.rotary).toBeLessThan(30);
        }
    });

    test.each([
        [true, 0, 180],
        [false, 540, 900],
    ])("unwind %s: a continuous C starts the next toolpath at |C| in [%d, %d]", (unwind, low, high) => {
        const winding: ToolpathMove[] = [{ kind: "rapid", to: [0, 0, 10], axis: tilted(30, 0) }];
        for (let azimuth = 0; azimuth <= 720; azimuth += 15) {
            winding.push({ kind: "linear", to: [azimuth / 10, 0, 0], feed: 800, axis: tilted(30, azimuth) });
        }
        const next: ToolpathMove[] = [
            { kind: "rapid", to: [0, 0, 10], axis: tilted(30, 45) },
            { kind: "linear", to: [0, 0, 0], feed: 800, axis: tilted(30, 45) },
        ];
        const plan = planProgram(
            {
                ...program(GENERIC_AC_TRUNNION),
                toolpaths: [
                    { toolId: BALL_6.id, moves: winding },
                    { toolId: BALL_6.id, moves: next },
                ],
            },
            { tcp: true, unwind },
        );
        expect(plan.isOk).toBe(true);
        const wound = plan.value.toolpaths[0].blocks.at(-1);
        expect(wound?.kind).toBe("linear");
        expect(Math.abs((wound as { point: { angles: number[] } }).point.angles[1])).toBeGreaterThan(540);
        const c = Math.abs(plan.value.toolpaths[1].angles?.[1] ?? Number.NaN);
        expect(c).toBeGreaterThanOrEqual(low);
        expect(c).toBeLessThanOrEqual(high);
    });

    test("an unreachable tool axis fails the post naming the axis and its limits", () => {
        const unreachable: ToolpathData = {
            toolId: BALL_6.id,
            moves: [
                { kind: "rapid", to: [0, 0, 10], axis: tilted(130, 0) },
                { kind: "linear", to: [0, 0, 0], feed: 500, axis: tilted(130, 0) },
            ],
        };
        const result = postProcessor("fanuc-30i-5axis")!.post({
            ...program(GENERIC_AC_TRUNNION),
            toolpaths: [unreachable],
        });
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("Toolpath 1");
        expect(result.error).toContain("A =");
    });

    test("a 3-axis machine posts 3-axis toolpaths and refuses tilted ones", () => {
        const threeAxis: MachineProfileData = {
            ...GENERIC_AC_TRUNNION,
            rotaryAxes: [],
            kinematics: undefined,
        };
        const full = program(threeAxis);
        const flat = postProcessor("fanuc-30i-5axis")!.post({ ...full, toolpaths: [full.toolpaths[0]] });
        expect(flat.isOk).toBe(true);
        expect(flat.value).toContain("G00 G90 G54\n");
        expect(flat.value).not.toMatch(/[AC]0\./);
        const tiltedPath = postProcessor("fanuc-30i-5axis")!.post(full);
        expect(tiltedPath.isOk).toBe(false);
        expect(tiltedPath.error).toContain("no rotary axes");
    });

    test("the setup's program name and the tool table head the program", () => {
        const output = postProcessor("haas-umc-5axis")!.post({
            ...program(GENERIC_AC_TRUNNION),
            setup: { ...SETUP, programName: "PART" },
        });
        expect(output.value.split("\n").slice(0, 4)).toEqual([
            "%",
            "O1000 (BRACKET)",
            "(MACHINE: GENERIC 5-AXIS AC TRUNNION TABLE-TABLE)",
            "(T2 D6 BALL ENDMILL - BALL 6)",
        ]);
    });
});
