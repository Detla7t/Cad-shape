// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    evaluateNcExpression,
    lexNcBlock,
    type NcProgram,
    type NcReadOptions,
    parseNcExpression,
    readNcProgram,
    type ToolpathMove,
} from "../../src";
import { GENERIC_AC_TRUNNION, GENERIC_AC_TRUNNION_NON_TCP } from "../../src/ops5x/machines";

/** Focused behaviour of the NC reader: lexing, expressions, modal state, cycles, subprograms, dialects. */

const read = (lines: string[], options: NcReadOptions = {}) => readNcProgram(lines.join("\n"), options);

/** Every move of a program, toolpaths joined, comments left out. */
function moves(program: NcProgram): ToolpathMove[] {
    return program.toolpaths.flatMap((path) => path.toolpath.moves).filter((move) => move.kind !== "comment");
}

const messages = (program: NcProgram) => program.diagnostics.map((d) => d.message);

describe("lexing blocks", () => {
    test("words, sequence numbers, comments in both styles, block delete", () => {
        const block = lexNcBlock("/N120 G01 X-1.5 Y.25 (approach) Z3. F200 ; finish", 7);
        expect(block.line).toBe(7);
        expect(block.deleted).toBe(true);
        expect(block.sequence).toBe(120);
        expect(block.words.map((w) => [w.letter, w.value])).toEqual([
            ["G", 1],
            ["X", -1.5],
            ["Y", 0.25],
            ["Z", 3],
            ["F", 200],
        ]);
        expect(block.words.find((w) => w.letter === "Z")?.decimal).toBe(true);
        expect(block.words.find((w) => w.letter === "F")?.decimal).toBe(false);
        expect(block.comments).toEqual(["approach", "finish"]);
    });

    test("packed words, tape marks and program numbers", () => {
        expect(lexNcBlock("G0X10Y-5.Z.5", 1).words.map((w) => [w.letter, w.value])).toEqual([
            ["G", 0],
            ["X", 10],
            ["Y", -5],
            ["Z", 0.5],
        ]);
        expect(lexNcBlock("%", 1).percent).toBe(true);
        expect(lexNcBlock("O1234 (BRACKET)", 1)).toMatchObject({
            programNumber: "1234",
            comments: ["BRACKET"],
        });
        expect(lexNcBlock(":0100", 1).programNumber).toBe("0100");
    });

    test("parameters, expressions and assignments", () => {
        const block = lexNcBlock("#101 = [#100 * 2] G1 X#101 Y[1 + 2] Z-#3", 1);
        expect(block.assignments).toHaveLength(1);
        expect(block.words.map((w) => w.letter)).toEqual(["G", "X", "Y", "Z"]);
        expect(block.words[1].expr).toEqual({ k: "var", index: { k: "num", v: 101 } });
        expect(block.words[2].value).toBeNaN();
        expect(lexNcBlock("#<depth> = 3", 1).assignments[0].target).toEqual({ k: "named", name: "DEPTH" });
    });

    test("o-words, macro control flow, named and keyword words", () => {
        expect(lexNcBlock("o100 call [1.5] [#2]", 1).oword).toMatchObject({ label: "100", keyword: "CALL" });
        expect(lexNcBlock("O<pocket> sub", 1).oword).toMatchObject({ label: "<pocket>", keyword: "SUB" });
        expect(lexNcBlock("IF [#1 GT 10] GOTO 20", 1).macro).toMatchObject({ kind: "if" });
        expect(lexNcBlock("WHILE [#1 LT 3] DO1", 1).macro).toMatchObject({ kind: "while", label: 1 });
        expect(lexNcBlock("END1", 1).macro).toEqual({ kind: "end", label: 1 });
        const siemens = lexNcBlock("G2 X10 Y0 CR=5 A3=-0.5 C3=0.866", 1);
        expect(siemens.named.map((n) => n.name)).toEqual(["CR", "A3", "C3"]);
        expect(lexNcBlock('CYCLE800(1,"TC1",0,57)', 1).calls).toEqual([
            { name: "CYCLE800", args: '1,"TC1",0,57' },
        ]);
        expect(lexNcBlock("SET_PRINT_STATS_INFO TOTAL_LAYER=12", 1)).toMatchObject({
            keywords: ["SET_PRINT_STATS_INFO"],
            named: [{ name: "TOTAL_LAYER", text: "12" }],
        });
        expect(lexNcBlock("M117 Printing layer 3", 1).message).toBe("Printing layer 3");
    });

    test("what cannot be read is reported, the rest of the block still counts", () => {
        const block = lexNcBlock("G1 X10 @ Y5", 1);
        expect(block.errors).toEqual(['unexpected "@"']);
        expect(block.words.map((w) => w.letter)).toEqual(["G", "X", "Y"]);
    });
});

describe("expressions", () => {
    test.each([
        ["1 + 2 * 3", 7],
        ["[1 + 2] * 3", 9],
        ["2 ** 3 ** 2", 512],
        ["10 MOD 3", 1],
        ["SIN[30]", 0.5],
        ["SQRT[16] + ABS[-2]", 6],
        ["ATAN[1]/[-1]", 135],
        ["FIX[2.7] + FUP[2.2]", 5],
        ["3 GT 2 AND 1 EQ 1", 1],
        ["ROUND[-2.5]", -3],
    ])("%s = %d", (text, value) => {
        const { expr, errors } = parseNcExpression(text);
        expect(errors).toEqual([]);
        expect(evaluateNcExpression(expr, () => Number.NaN)).toBeCloseTo(value, 9);
    });

    test("parameters are read on their line before its assignments (LinuxCNC)", () => {
        const program = read(["#1 = 10", "G0 X0 Y0 Z5", "#1 = 20 G1 X#1 F100", "G1 Y#1"]);
        const ends = moves(program).map((move) => ("to" in move ? move.to : undefined));
        expect(ends.slice(-2)).toEqual([
            [10, 0, 5],
            [10, 20, 5],
        ]);
    });
});

describe("modal state", () => {
    test("inches are converted to millimetres, feeds included", () => {
        const program = read(["G20 G90", "G0 X1 Y0 Z0.5", "G1 X2 F10"]);
        expect(program.units).toBe("inch");
        expect(moves(program)).toEqual([
            { kind: "rapid", to: [25.4, 0, 12.7] },
            { kind: "linear", to: [50.8, 0, 12.7], feed: 254 },
        ]);
    });

    test("incremental moves and absolute arc centres", () => {
        const program = read(["G0 X0 Y0 Z0", "G91 G1 X10 Y5 F100", "G90 G90.1", "G3 X10 Y15 I10 J10"]);
        expect(moves(program).slice(-2)).toEqual([
            { kind: "linear", to: [10, 5, 0], feed: 100 },
            { kind: "arc", to: [10, 15, 0], center: [10, 10, 0], clockwise: false, plane: "XY", feed: 100 },
        ]);
    });

    test.each([
        ["G2, R > 0: the short way", "G2 X8 Y0 R5", [4, -3], true],
        ["G3, R > 0", "G3 X8 Y0 R5", [4, 3], false],
        ["G2, R < 0: more than half a circle", "G2 X8 Y0 R-5", [4, 3], true],
        ["a half circle", "G3 X10 Y0 R5", [5, 0], false],
    ] as const)("R-format arcs: %s", (_name, block, center, clockwise) => {
        const program = read(["G0 X0 Y0 Z0", "G1 F100", block]);
        const arc = moves(program).at(-1);
        expect(arc).toMatchObject({ kind: "arc", clockwise });
        const c = (arc as Extract<ToolpathMove, { kind: "arc" }>).center;
        expect(c[0]).toBeCloseTo(center[0], 9);
        expect(c[1]).toBeCloseTo(center[1], 9);
    });

    test("arcs in G18 and G19, and a helix with extra turns (LinuxCNC P)", () => {
        const program = read(
            [
                "G0 X0 Y0 Z0",
                "G1 F100",
                "G18 G2 X10 Z0 I5 K0",
                "G19 G3 Y10 Z0 J5 K0",
                "G17 G2 X10 Y10 Z-3 I5 J0 P3",
            ],
            { dialect: "linuxcnc" },
        );
        const arcs = moves(program).filter((move) => move.kind === "arc");
        expect(arcs.map((arc) => (arc.kind === "arc" ? arc.plane : ""))).toEqual([
            "ZX",
            "YZ",
            "XY",
            "XY",
            "XY",
        ]);
        // Two full turns and the closing turn, the helix climbing evenly.
        expect(arcs.slice(2).map((arc) => arc.to[2])).toEqual([-1, -2, -3]);
    });

    test("inverse time (G93) and per-revolution (G95) feeds come out in mm/min", () => {
        const program = read(["G0 X0 Y0 Z0", "S1000 M3", "G93 G1 X10 F30", "G95 G1 X20 F0.1"]);
        expect(moves(program).slice(-2)).toEqual([
            { kind: "linear", to: [10, 0, 0], feed: 300 },
            { kind: "linear", to: [20, 0, 0], feed: 100 },
        ]);
    });

    test("cutter compensation is reported, not applied", () => {
        const program = read(["G0 X0 Y0 Z0", "G41 D1 G1 X10 F100", "G40"]);
        expect(messages(program)).toContain(
            "Cutter compensation (G41/G42) is not applied: the backplot shows the programmed path",
        );
        expect(moves(program).at(-1)).toEqual({ kind: "linear", to: [10, 0, 0], feed: 100 });
    });
});

describe("coordinate systems", () => {
    test("G10 L2 work offsets put fixtures where they are; unknown ones are reported", () => {
        const program = read([
            "G10 L2 P1 X0 Y0 Z0",
            "G10 L2 P2 X100 Y0 Z0",
            "G54 G0 X0 Y0 Z5",
            "G55 G0 X0 Y0",
            "G56 X0",
        ]);
        expect(moves(program).map((move) => ("to" in move ? move.to : undefined))).toEqual([
            [0, 0, 5],
            [100, 0, 5],
            [0, 0, 5],
        ]);
        expect(messages(program)).toContain(
            "G56: its origin is unknown here; drawn on the first work offset's origin",
        );
    });

    test("a G92 before any motion declares where the tool is", () => {
        const program = read(["G92 X10 Y5 Z0", "G1 X20 F100"]);
        expect(program.toolpaths[0].start).toEqual([10, 5, 0]);
        expect(moves(program)).toEqual([{ kind: "linear", to: [20, 5, 0], feed: 100 }]);
    });

    test("a G92 after motion shifts the program without moving the tool", () => {
        const program = read(["G0 X10 Y0 Z0", "G92 X0", "G1 X5 F100"]);
        expect(moves(program).at(-1)).toEqual({ kind: "linear", to: [15, 0, 0], feed: 100 });
    });

    test("reference returns are home moves at the highest programmed Z", () => {
        const program = read(["G0 X0 Y0 Z20", "G1 Z-1 F100", "G28 G91 Z0", "G90"]);
        const [path] = program.toolpaths;
        expect(path.toolpath.moves.at(-1)).toEqual({ kind: "rapid", to: [0, 0, 20] });
        expect(path.homeMoves.has(path.toolpath.moves.length - 1)).toBe(true);
        expect(program.diagnostics[0].message).toContain("highest programmed Z (Z20)");
    });

    test("G53 with a known work offset is exact", () => {
        const program = read(["G0 X0 Y0 Z10", "G53 G0 Z-50"], { workOffsets: { G54: [100, 100, -200] } });
        expect(moves(program).at(-1)).toEqual({ kind: "rapid", to: [0, 0, 150] });
    });
});

describe("tools, spindle, coolant", () => {
    test("toolpaths split at tool changes, labelled by the comment before them", () => {
        const program = read(
            [
                "(T1 D=6. CR=0. - FLAT END MILL)",
                "(T2 D=3.5 DRILL)",
                "(ROUGH)",
                "T1 M6",
                "S8000 M3 M8",
                "G0 X0 Y0 Z5",
                "G1 Z-1 F200",
                "(DRILL)",
                "T2 M6",
                "S2000 M4",
                "M88",
                "G0 X10 Y10",
            ],
            { dialect: "haas" },
        );
        expect(
            program.toolpaths.map((path) => [
                path.toolNumber,
                path.toolpath.label,
                path.toolpath.spindleRpm,
                path.toolpath.coolant,
            ]),
        ).toEqual([
            [1, "ROUGH", 8000, "flood"],
            [2, "DRILL", 2000, "throughTool"],
        ]);
        expect(program.tools).toEqual([
            { number: 1, description: "D=6. CR=0. - FLAT END MILL", diameter: 6, cornerRadius: 0 },
            { number: 2, description: "D=3.5 DRILL", diameter: 3.5 },
        ]);
        expect(program.toolpaths[0].lines).toEqual([6, 7]);
    });

    test("M6 without a T is reported", () => {
        expect(messages(read(["M6", "G0 X0"]))).toContain("M6 without a T word: the tool stays");
    });
});

describe("drilling cycles", () => {
    test("G99 returns to R between holes; G80 cancels", () => {
        const program = read(["G0 X0 Y0 Z20", "G99 G81 X10 Y0 Z-5 R2 F100", "X20", "G80", "G0 Z20"]);
        expect(moves(program)).toEqual([
            { kind: "rapid", to: [0, 0, 20] },
            { kind: "rapid", to: [10, 0, 20] },
            { kind: "rapid", to: [10, 0, 2] },
            { kind: "drill", at: [10, 0, 2], depth: 7, retract: 2, cycle: "drill", feed: 100 },
            { kind: "rapid", to: [20, 0, 2] },
            { kind: "drill", at: [20, 0, 2], depth: 7, retract: 2, cycle: "drill", feed: 100 },
            { kind: "rapid", to: [20, 0, 20] },
        ]);
    });

    test("incremental cycles with repeats (G91 … K)", () => {
        const program = read(["G0 X0 Y0 Z10", "G91 G98 G81 X10 Z-5 R-8 K3 F100", "G90 G80"]);
        const holes = moves(program).filter((move) => move.kind === "drill");
        expect(holes.map((hole) => (hole.kind === "drill" ? [hole.at, hole.depth] : []))).toEqual([
            [[10, 0, 2], 5],
            [[20, 0, 2], 5],
            [[30, 0, 2], 5],
        ]);
    });

    test.each([
        ["fanuc", "G82 X0 Y0 Z-5 R1 P500 F100", 0.5],
        ["haas", "G82 X0 Y0 Z-5 R1 P0.5 F100", 0.5],
        ["haas", "G82 X0 Y0 Z-5 R1 P500 F100", 0.5],
        ["linuxcnc", "G82 X0 Y0 Z-5 R1 P0.5 F100", 0.5],
    ] as const)("%s dwell in %s", (dialect, block, seconds) => {
        const hole = moves(read(["G0 X0 Y0 Z10", block], { dialect })).find((move) => move.kind === "drill");
        expect(hole).toMatchObject({ kind: "drill", dwell: seconds });
    });

    test("pecks, chip breaks, taps and bores", () => {
        const program = read([
            "G0 X0 Y0 Z10",
            "G98 G83 X0 Y0 Z-10 R2 Q3 F100",
            "G73 X5 Q2",
            "G84 X10 F500",
            "G85 X15",
            "G89 X20 P1000",
            "G80",
        ]);
        expect(
            moves(program)
                .filter((move) => move.kind === "drill")
                .map((move) => (move.kind === "drill" ? [move.cycle, move.peck, move.dwell] : [])),
        ).toEqual([
            ["peck", 3, undefined],
            ["chipBreak", 2, undefined],
            ["tap", undefined, undefined],
            ["bore", undefined, undefined],
            ["bore", undefined, 1],
        ]);
    });

    test("LinuxCNC G33.1 rigid tapping is a tap", () => {
        const program = read(["G0 X5 Y5 Z3", "S400 M3", "G33.1 Z-10 K1.25"], { dialect: "linuxcnc" });
        expect(moves(program).at(-1)).toEqual({
            kind: "drill",
            at: [5, 5, 3],
            depth: 13,
            retract: 3,
            cycle: "tap",
            feed: 500,
        });
    });
});

describe("dwells and stops", () => {
    test.each([
        ["fanuc", "G4 P1500", 1.5],
        ["fanuc", "G4 X2.5", 2.5],
        ["haas", "G4 P2.", 2],
        ["haas", "G4 P250", 0.25],
        ["linuxcnc", "G4 P0.75", 0.75],
        ["siemens", "G4 F3", 3],
        ["marlin", "G4 P500", 0.5],
        ["marlin", "G4 S2", 2],
    ] as const)("%s: %s", (dialect, block, seconds) => {
        const program = read(["G0 X0 Y0 Z0", block], { dialect });
        expect(moves(program).at(-1)).toEqual({ kind: "dwell", seconds });
    });

    test("M0 and M1 are stops, M30 ends the program", () => {
        const program = read(["G0 X0 Y0 Z0", "M0", "M1", "M30", "G0 X100"]);
        expect(moves(program).slice(1)).toEqual([
            { kind: "dwell", seconds: 0 },
            { kind: "dwell", seconds: 0 },
        ]);
    });
});

describe("subprograms and macros", () => {
    test("M98 calls a program of the file, L repeats it, M99 returns", () => {
        const program = read([
            "O1000",
            "G0 X0 Y0 Z0",
            "M98 P2000 L3",
            "G0 X100",
            "M30",
            "O2000",
            "G91 G1 X10 F100",
            "G90",
            "M99",
        ]);
        expect(moves(program).map((move) => ("to" in move ? move.to[0] : undefined))).toEqual([
            0, 10, 20, 30, 100,
        ]);
        // Every move knows its line, in the subprogram too.
        expect(program.toolpaths[0].lines).toEqual([2, 7, 7, 7, 4]);
    });

    test("Fanuc 0i P<count><program>, Haas M97 local subroutines", () => {
        // P<count><4-digit program>: twice O2000.
        const fanuc = read(["G0 X0 Y0 Z0", "M98 P22000", "M30", "O2000", "G91 X1", "G90 M99"]);
        expect(moves(fanuc).map((move) => ("to" in move ? move.to[0] : undefined))).toEqual([0, 1, 2]);
        const haas = read(["G0 X0 Y0 Z0", "M97 P100 L2", "M30", "N100 G91 X5", "G90", "M99"], {
            dialect: "haas",
        });
        expect(moves(haas).map((move) => ("to" in move ? move.to[0] : undefined))).toEqual([0, 5, 10]);
    });

    test("G65 macro calls pass arguments as local variables", () => {
        const program = read(["G0 X0 Y0 Z0", "G65 P9001 X3 Y4", "M30", "O9001", "G1 X#24 Y#25 F100", "M99"]);
        expect(moves(program).at(-1)).toEqual({ kind: "linear", to: [3, 4, 0], feed: 100 });
    });

    test("Fanuc macro B: WHILE … DO / END and IF … GOTO", () => {
        const program = read([
            "G0 X0 Y0 Z0",
            "#1 = 0",
            "WHILE [#1 LT 3] DO1",
            "G1 X[#1 * 10] F100",
            "#1 = #1 + 1",
            "END1",
            "IF [#1 EQ 3] GOTO 50",
            "G0 X999",
            "N50 G0 Y5",
        ]);
        expect(moves(program).map((move) => ("to" in move ? [move.to[0], move.to[1]] : undefined))).toEqual([
            [0, 0],
            [10, 0],
            [20, 0],
            [20, 5],
        ]);
    });

    test("LinuxCNC o-words: sub/call with arguments, if/else, while, repeat", () => {
        const program = read(
            [
                "o<square> sub",
                "  G1 X#1 F100",
                "  G1 Y#1",
                "o<square> endsub",
                "G0 X0 Y0 Z0",
                "o<square> call [5]",
                "#<n> = 0",
                "o10 while [#<n> LT 2]",
                "  #<n> = [#<n> + 1]",
                "o10 endwhile",
                "o20 if [#<n> EQ 2]",
                "  G0 Z1",
                "o20 else",
                "  G0 Z99",
                "o20 endif",
                "o30 repeat [2]",
                "  G91 G1 X1",
                "  G90",
                "o30 endrepeat",
                "M2",
            ],
            { dialect: "linuxcnc" },
        );
        expect(moves(program).map((move) => ("to" in move ? move.to : undefined))).toEqual([
            [0, 0, 0],
            [5, 0, 0],
            [5, 5, 0],
            [5, 5, 1],
            [6, 5, 1],
            [7, 5, 1],
        ]);
        expect(program.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    });

    test("a missing subprogram is an error, not a guess", () => {
        expect(messages(read(["M98 P1234"]))).toContain("M98 P1234: program O1234 is not in this file");
        expect(messages(read(["o<x> call"], { dialect: "linuxcnc" }))).toContain(
            "o<x> call: there is no o<x> sub in this file",
        );
    });
});

describe("2D cutting", () => {
    test.each([
        ["plasma", ["M07", "G4 P1.2", "M51", "G1 X10 F2000", "M50", "M08"]],
        ["waterjet", ["M03", "G4 P1.2", "G1 X10 F2000", "M05"]],
        ["laser", ["M3 S800", "G4 P1.2", "G1 X10 F2000", "M5"]],
    ] as const)("%s beam codes, the pierce delay belongs to the beam", (dialect, lines) => {
        const program = read(["G0 X5 Y0", ...lines], { dialect });
        expect(moves(program)).toEqual([
            { kind: "rapid", to: [5, 0, 0] },
            { kind: "cutterOn", pierceDelay: 1.2 },
            { kind: "linear", to: [10, 0, 0], feed: 2000 },
            { kind: "cutterOff" },
        ]);
    });
});

describe("wire EDM", () => {
    test("U/V are the upper guide's offset at the machine's UV plane", () => {
        const program = read(["G92 X0 Y0 U0 V0", "G1 X10 Y0 U1 V0", "G1 X10 Y10 U1 V1", "M50", "M02"], {
            dialect: "wire",
            machine: {
                id: "w",
                name: "Wire",
                kind: "wireEdm",
                linearAxes: [],
                maxFeed: 10,
                rapidFeed: 100,
                post: { id: "wire-iso" },
                wire: {
                    wireDiameter: 0.25,
                    sparkGap: 0.02,
                    maxTaper: 30,
                    programPlaneHeight: 0,
                    uvPlaneHeight: 50,
                },
            },
        });
        expect(moves(program)).toEqual([
            { kind: "taper", to: [10, 0, 0], upper: [11, 0, 50], feed: 0 },
            { kind: "taper", to: [10, 10, 0], upper: [11, 11, 50], feed: 0 },
            { kind: "cutterOff" },
        ]);
    });
});

describe("printers", () => {
    test("absolute and relative extrusion, G92 E, homing, arcs share their extrusion", () => {
        const program = read(
            [
                "G28",
                "M82",
                "G92 E0",
                "G1 Z0.2 F600",
                "G1 X10 E1",
                "G1 X20 E2",
                "M83",
                "G3 X0 Y0 I-10 J0 E3.14",
                "G1 E-0.8 F2100",
            ],
            { dialect: "marlin" },
        );
        const extrusions = moves(program).filter((move) => move.kind === "extrude");
        expect(extrusions.slice(0, 2)).toEqual([
            { kind: "extrude", to: [10, 0, 0.2], extrude: 1, feed: 600 },
            { kind: "extrude", to: [20, 0, 0.2], extrude: 1, feed: 600 },
        ]);
        const arc = extrusions.slice(2, -1);
        expect(arc).toHaveLength(36);
        expect(arc.reduce((sum, move) => sum + (move.kind === "extrude" ? move.extrude : 0), 0)).toBeCloseTo(
            3.14,
            9,
        );
        expect(extrusions.at(-1)).toEqual({ kind: "extrude", to: [0, 0, 0.2], extrude: -0.8, feed: 2100 });
        expect(program.stats.filament).toBeCloseTo(2 + 3.14 - 0.8, 9);
    });

    test("tool changes are extruder changes; Klipper macros and temperatures are not moves", () => {
        const program = read(
            [
                "PRINT_START BED=60 EXTRUDER=210",
                "M104 S210",
                "T0",
                "G1 X10 Y10 F3000",
                "T1",
                "G1 X20 E1",
                ";LAYER_CHANGE",
            ],
            { dialect: "klipper" },
        );
        expect(program.toolpaths.map((path) => path.toolNumber)).toEqual([0, 1]);
        expect(program.diagnostics).toEqual([]);
        expect(program.stats.layers).toBe(1);
    });
});

describe("5-axis", () => {
    test("G68.2 tilts the plane; G53.1 orients the tool along its Z", () => {
        const program = read(["G0 X0 Y0 Z50", "G68.2 X0 Y0 Z0 I0 J-30 K0", "G53.1", "G0 X0 Y0 Z10", "G69"]);
        const last = moves(program).at(-1) as Extract<ToolpathMove, { kind: "rapid" }>;
        expect(last.to[1]).toBeCloseTo(5, 9);
        expect(last.to[2]).toBeCloseTo(8.660254, 6);
        expect(last.axis?.[1]).toBeCloseTo(0.5, 9);
    });

    test("tool centre point control: tip coordinates, tool axis from the rotaries", () => {
        const program = read(["G0 X0 Y0 Z10 A0 C0", "G43.4 H1", "G1 X10 A-30 C90 F500", "G49"], {
            machine: GENERIC_AC_TRUNNION,
        });
        const last = moves(program).at(-1) as Extract<ToolpathMove, { kind: "linear" }>;
        expect(last.to).toEqual([10, 0, 10]);
        expect(last.axis![0]).toBeCloseTo(-0.5, 9);
        expect(last.axis![2]).toBeCloseTo(Math.sqrt(3) / 2, 9);
    });

    test("without TCP, turned rotaries mean machine coordinates", () => {
        const program = read(["G0 X0 Y0 Z10", "G0 A90", "G1 Y-10 Z0 F500"], {
            machine: GENERIC_AC_TRUNNION_NON_TCP,
        });
        // A +90° A table turns WCS +Y onto machine +Z: machine (0, -10, 0) is the tip at Z = -10… on the table.
        const last = moves(program).at(-1) as Extract<ToolpathMove, { kind: "linear" }>;
        expect(last.to[0]).toBeCloseTo(0, 9);
        expect(Math.hypot(last.to[1], last.to[2])).toBeCloseTo(10, 9);
        expect(last.axis).not.toBeUndefined();
    });
});

describe("what is not supported is reported", () => {
    test.each([
        ["G5.2 X0 Y0", "G5.2 NURBS are not supported"],
        ["G12 I5", "G12 is not supported"],
        ["G87 X0 Y0 Z-5 R1 F100", "G87 back boring is not supported: the hole is skipped"],
        ["G1 X1 ,R2.", "Corner rounding / chamfer words (,R ,C) are not drawn"],
    ])("%s", (block, message) => {
        expect(messages(read(["G0 X0 Y0 Z5", "G1 F100", block]))).toContain(message);
    });

    test("an endless loop stops at the block limit", () => {
        const program = read(["N10 G0 X0", "GOTO 10"], { maxBlocks: 1000 });
        expect(messages(program)).toContain("Stopped after 1000 blocks (an endless loop?)");
    });
});
