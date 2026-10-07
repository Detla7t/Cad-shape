// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    asciiCommentText,
    type CamProgram,
    formatGCodeNumber,
    GCodeWriter,
    type MachineProfileData,
    postProcessor,
    postProcessors,
    type SetupData,
    type ToolData,
    type ToolpathData,
} from "../src";

const SETUP: SetupData = {
    id: "s1",
    name: "Setup 1",
    machineId: "test",
    wcs: { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
    stock: { kind: "box", margin: { x: 1, y: 1, zTop: 1, zBottom: 0 } },
    partIds: [],
    operations: [],
};

const MILL: MachineProfileData = {
    id: "test-mill",
    name: "Test mill",
    kind: "mill",
    linearAxes: [
        { name: "X", min: 0, max: 500 },
        { name: "Y", min: 0, max: 400 },
        { name: "Z", min: -400, max: 0 },
    ],
    maxFeed: 10000,
    rapidFeed: 20000,
    post: { id: "fanuc" },
};

const ENDMILL: ToolData = {
    id: "t1",
    number: 1,
    name: "6 mm flat",
    kind: "flatEndmill",
    diameter: 6,
    cutting: { spindleRpm: 10000, feed: 1000, plungeFeed: 300, coolant: "flood" },
};

const DRILL: ToolData = {
    id: "t2",
    number: 2,
    name: "5 mm drill",
    kind: "drill",
    diameter: 5,
    tipAngle: 118,
    cutting: { spindleRpm: 2000, feed: 150, coolant: "flood" },
};

const CONTOUR: ToolpathData = {
    toolId: "t1",
    label: "Contour",
    moves: [
        { kind: "rapid", to: [0, 0, 15] },
        { kind: "rapid", to: [0, 0, 5] },
        { kind: "linear", to: [0, 0, -1], feed: 300 },
        { kind: "linear", to: [20, 0, -1], feed: 1000 },
        { kind: "arc", to: [30, 10, -1], center: [20, 10, -1], clockwise: false, plane: "XY", feed: 1000 },
        { kind: "linear", to: [30, 20, -1], feed: 1000 },
        { kind: "arc", to: [30, 20, -1], center: [25, 20, -1], clockwise: true, plane: "XY", feed: 800 },
        { kind: "rapid", to: [30, 20, 15] },
    ],
};

const DRILLING: ToolpathData = {
    toolId: "t2",
    label: "Drill",
    moves: [
        { kind: "rapid", to: [10, 10, 15] },
        { kind: "drill", at: [10, 10, 0], depth: 8, retract: 2, cycle: "peck", peck: 3, feed: 150 },
        { kind: "drill", at: [20, 10, 0], depth: 8, retract: 2, cycle: "peck", peck: 3, feed: 150 },
        { kind: "rapid", to: [20, 10, 15] },
    ],
};

function program(machine: MachineProfileData, toolpaths: ToolpathData[], tools: ToolData[]): CamProgram {
    return {
        name: "Part",
        machine,
        setup: SETUP,
        tools: new Map(tools.map((tool) => [tool.id, tool])),
        toolpaths,
    };
}

const MILL_PROGRAM = program(MILL, [CONTOUR, DRILLING], [ENDMILL, DRILL]);

function post(id: string, value: CamProgram, options?: Record<string, unknown>): string {
    const processor = postProcessor(id);
    expect(processor).not.toBeUndefined();
    const result = processor!.post(value, options);
    if (!result.isOk) throw new Error(result.error);
    return result.value;
}

const lines = (...text: string[]) => `${text.join("\n")}\n`;

describe("G-code number formatting", () => {
    test.each([
        [10, { decimals: 3, forceDecimal: true }, "10."],
        [1.5, { decimals: 3, forceDecimal: true }, "1.5"],
        [-0.0001, { decimals: 3, forceDecimal: true }, "0."],
        [-0.25, { decimals: 3 }, "-0.25"],
        [0.5, { decimals: 3, leadingZero: false }, ".5"],
        [2, { decimals: 3, trailingZeros: true }, "2.000"],
        [12345.6789, { decimals: 0 }, "12346"],
    ] as const)("%s with %j is written %s", (value, format, expected) => {
        expect(formatGCodeNumber(value, format)).toBe(expected);
    });

    test("the writer suppresses unchanged modal words and numbers its blocks", () => {
        const w = new GCodeWriter({ format: { decimals: 3 }, lineNumbers: { start: 5, increment: 5 } });
        w.block(w.motion("G1"), w.axis("X", 1), w.axis("Y", 2), w.feed(100));
        w.block(w.motion("G1"), w.axis("X", 1), w.axis("Y", 3), w.feed(100));
        w.comment("note (with parens)");
        w.block(w.motion("G1"), w.axis("X", 1));
        expect(w.toString()).toBe(lines("N5 G1 X1 Y2 F100", "N10 Y3", "(note with parens)"));
    });
});

describe("mill posts", () => {
    test("every mill dialect is registered for mills", () => {
        const ids = postProcessors("mill").map((p) => p.id);
        expect(ids).toEqual(expect.arrayContaining(["fanuc", "haas", "linuxcnc", "grbl", "mach3"]));
        expect(postProcessors("plasma").map((p) => p.id)).toEqual(["plasma"]);
        expect(postProcessors("wireEdm").map((p) => p.id)).toEqual(["wire-iso"]);
    });

    test("Fanuc: tool changes, length offsets, arcs by centre, a peck cycle", () => {
        expect(post("fanuc", MILL_PROGRAM)).toBe(
            lines(
                "%",
                "O1001 (PART)",
                "(T1 D=6. FLAT ENDMILL - 6 MM FLAT)",
                "(T2 D=5. DRILL - 5 MM DRILL)",
                "G90 G94 G17 G49 G40 G80",
                "G21",
                "G28 G91 Z0.",
                "G90",
                "(CONTOUR)",
                "T1 M6",
                "S10000 M3",
                "G54",
                "M8",
                "G0 X0. Y0.",
                "G43 Z15. H1",
                "Z5.",
                "G1 Z-1. F300.",
                "X20. F1000.",
                "G3 X30. Y10. I0. J10.",
                "G1 Y20.",
                "G2 I-5. J0. F800.",
                "G0 Z15.",
                "(DRILL)",
                "M9",
                "M5",
                "G28 G91 Z0.",
                "G90",
                "T2 M6",
                "S2000 M3",
                "M8",
                "G0 X10. Y10.",
                "G43 Z15. H2",
                "G98 G83 X10. Y10. Z-8. R2. Q3. F150.",
                "X20.",
                "G80",
                "M9",
                "M5",
                "G28 G91 Z0.",
                "G90",
                "M30",
                "%",
            ),
        );
    });

    test("Fanuc with line numbers and radius arcs (a full circle split in halves)", () => {
        const text = post("fanuc", program(MILL, [CONTOUR], [ENDMILL]), {
            lineNumbers: true,
            lineStart: 10,
            lineIncrement: 5,
            arcs: "r",
        });
        expect(text).toBe(
            lines(
                "%",
                "O1001 (PART)",
                "(T1 D=6. FLAT ENDMILL - 6 MM FLAT)",
                "N10 G90 G94 G17 G49 G40 G80",
                "N15 G21",
                "N20 G28 G91 Z0.",
                "N25 G90",
                "(CONTOUR)",
                "N30 T1 M6",
                "N35 S10000 M3",
                "N40 G54",
                "N45 M8",
                "N50 G0 X0. Y0.",
                "N55 G43 Z15. H1",
                "N60 Z5.",
                "N65 G1 Z-1. F300.",
                "N70 X20. F1000.",
                "N75 G3 X30. Y10. R10.",
                "N80 G1 Y20.",
                "N85 G2 X20. R5. F800.",
                "N90 X30. R5.",
                "N95 G0 Z15.",
                "N100 M9",
                "N105 M5",
                "N110 G28 G91 Z0.",
                "N115 G90",
                "N120 M30",
                "%",
            ),
        );
    });

    test("Haas: five-digit program number, G53 home, dwell in seconds", () => {
        const dwell: ToolpathData = {
            toolId: "t2",
            moves: [
                { kind: "rapid", to: [0, 0, 10] },
                { kind: "drill", at: [0, 0, 0], depth: 2, retract: 1, cycle: "drill", dwell: 0.5, feed: 100 },
                { kind: "dwell", seconds: 1 },
            ],
        };
        expect(post("haas", program({ ...MILL, post: { id: "haas" } }, [dwell], [DRILL]))).toBe(
            lines(
                "%",
                "O01001 (PART)",
                "(T2 D=5. DRILL - 5 MM DRILL)",
                "G90 G94 G17 G40 G49 G80",
                "G21",
                "G53 G0 Z0.",
                "T2 M6",
                "S2000 M3",
                "G54",
                "M8",
                "G0 X0. Y0.",
                "G43 Z10. H2",
                "G98 G82 X0. Y0. Z-2. R1. P0.5 F100.",
                "G80",
                "G4 P1.",
                "M9",
                "M5",
                "G53 G0 Z0.",
                "M30",
                "%",
            ),
        );
    });

    test("LinuxCNC: plain numbers, G53 home, M2 at the end", () => {
        expect(post("linuxcnc", MILL_PROGRAM)).toBe(
            lines(
                "%",
                "(Part)",
                "(T1 D=6 FLAT ENDMILL - 6 mm flat)",
                "(T2 D=5 DRILL - 5 mm drill)",
                "G90 G94 G17 G40 G49 G80",
                "G21",
                "G53 G0 Z0",
                "(Contour)",
                "T1 M6",
                "S10000 M3",
                "G54",
                "M8",
                "G0 X0 Y0",
                "G43 Z15 H1",
                "Z5",
                "G1 Z-1 F300",
                "X20 F1000",
                "G3 X30 Y10 I0 J10",
                "G1 Y20",
                "G2 I-5 J0 F800",
                "G0 Z15",
                "(Drill)",
                "M9",
                "M5",
                "G53 G0 Z0",
                "T2 M6",
                "S2000 M3",
                "M8",
                "G0 X10 Y10",
                "G43 Z15 H2",
                "G98 G83 X10 Y10 Z-8 R2 Q3 F150",
                "X20",
                "G80",
                "M9",
                "M5",
                "G53 G0 Z0",
                "M2",
                "%",
            ),
        );
    });

    test("LinuxCNC taps rigidly with G33.1 (it has no G84)", () => {
        const tap: ToolpathData = {
            toolId: "t3",
            moves: [
                { kind: "rapid", to: [5, 5, 10] },
                { kind: "drill", at: [5, 5, 0], depth: 6, retract: 3, cycle: "tap", feed: 500 },
            ],
        };
        const tapTool: ToolData = {
            id: "t3",
            number: 3,
            name: "M5 tap",
            kind: "tap",
            diameter: 5,
            pitch: 0.8,
            cutting: { spindleRpm: 625, feed: 500 },
        };
        expect(post("linuxcnc", program(MILL, [tap], [tapTool]), { comments: false })).toBe(
            lines(
                "%",
                "G90 G94 G17 G40 G49 G80",
                "G21",
                "G53 G0 Z0",
                "T3 M6",
                "S625 M3",
                "G54",
                "G0 X5 Y5",
                "G43 Z10 H3",
                "Z3",
                "G33.1 Z-6 K0.8",
                "G0 Z10",
                "M5",
                "G53 G0 Z0",
                "M2",
                "%",
            ),
        );
    });

    test("GRBL: no tool changer (M0 and a comment), cycles expanded into moves", () => {
        expect(post("grbl", MILL_PROGRAM)).toBe(
            lines(
                "(Part)",
                "(T1 D=6 FLAT ENDMILL - 6 mm flat)",
                "(T2 D=5 DRILL - 5 mm drill)",
                "G90 G94 G17",
                "G21",
                "(Contour)",
                "S10000 M3",
                "G54",
                "M8",
                "G0 X0 Y0 Z15",
                "Z5",
                "G1 Z-1 F300",
                "X20 F1000",
                "G3 X30 Y10 I0 J10",
                "G1 Y20",
                "G2 I-5 J0 F800",
                "G0 Z15",
                "(Drill)",
                "M9",
                "M5",
                "(Tool change: T2 D=5 DRILL - 5 mm drill)",
                "M0",
                "S2000 M3",
                "M8",
                "G0 X10 Y10 Z15",
                "Z2",
                "G1 Z-1 F150",
                "G0 Z2",
                "Z-0.5",
                "G1 Z-4",
                "G0 Z2",
                "Z-3.5",
                "G1 Z-7",
                "G0 Z2",
                "Z-6.5",
                "G1 Z-8",
                "G0 Z2",
                "Z15",
                "X20",
                "Z2",
                "G1 Z-1",
                "G0 Z2",
                "Z-0.5",
                "G1 Z-4",
                "G0 Z2",
                "Z-3.5",
                "G1 Z-7",
                "G0 Z2",
                "Z-6.5",
                "G1 Z-8",
                "G0 Z2",
                "Z15",
                "M9",
                "M5",
                "M30",
            ),
        );
    });

    test("Mach3: G91.1 incremental arc centres, a tap expanded with spindle reverse", () => {
        const tap: ToolpathData = {
            toolId: "t2",
            moves: [
                { kind: "rapid", to: [0, 0, 5] },
                { kind: "drill", at: [0, 0, 0], depth: 4, retract: 2, cycle: "tap", feed: 200 },
            ],
        };
        expect(post("mach3", program(MILL, [tap], [DRILL]), { coolant: false })).toBe(
            lines(
                "%",
                "(Part)",
                "(T2 D=5 DRILL - 5 mm drill)",
                "G90 G94 G91.1 G40 G49 G17",
                "G21",
                "G28 G91 Z0",
                "G90",
                "T2 M6",
                "S2000 M3",
                "G54",
                "G0 X0 Y0",
                "G43 Z5 H2",
                "Z2",
                "G1 Z-4 F200",
                "M4",
                "Z2",
                "M3",
                "G0 Z5",
                "M5",
                "G28 G91 Z0",
                "G90",
                "M30",
                "%",
            ),
        );
    });

    test("drill heights: Z = top − depth, R = the absolute retract (here at the hole's top)", () => {
        const spot: ToolpathData = {
            toolId: "t2",
            moves: [
                { kind: "rapid", to: [0, 0, 20] },
                { kind: "drill", at: [0, 0, 5], depth: 3, retract: 5, cycle: "drill", feed: 100 },
                { kind: "drill", at: [10, 0, 5], depth: 3, retract: 8, cycle: "drill", feed: 100 },
            ],
        };
        const text = post("fanuc", program(MILL, [spot], [DRILL]), { comments: false, coolant: false });
        expect(text).toContain("G98 G81 X0. Y0. Z2. R5. F100.\nG80\nG98 G81 X10. Y0. Z2. R8. F100.\nG80\n");
    });

    test("arcs in the ZX plane select G18, and the next XY arc G17 again", () => {
        const planes: ToolpathData = {
            toolId: "t1",
            moves: [
                { kind: "rapid", to: [0, 0, 10] },
                { kind: "arc", to: [10, 0, 0], center: [0, 0, 0], clockwise: false, plane: "ZX", feed: 500 },
                { kind: "arc", to: [20, 0, 0], center: [15, 0, 0], clockwise: true, plane: "XY", feed: 500 },
            ],
        };
        expect(post("fanuc", program(MILL, [planes], [ENDMILL]), { comments: false, coolant: false })).toBe(
            lines(
                "%",
                "O1001",
                "G90 G94 G17 G49 G40 G80",
                "G21",
                "G28 G91 Z0.",
                "G90",
                "T1 M6",
                "S10000 M3",
                "G54",
                "G0 X0. Y0.",
                "G43 Z10. H1",
                "G18 G3 X10. Z0. I0. K-10. F500.",
                "G17 G2 X20. I5. J0.",
                "M5",
                "G28 G91 Z0.",
                "G90",
                "M30",
                "%",
            ),
        );
        const linear = post("grbl", program(MILL, [planes], [ENDMILL]), {
            arcs: "linear",
            arcTolerance: 0.01,
        });
        expect(linear).not.toMatch(/G[23] /);
        expect(linear).toContain("X20 Y0");
    });

    test("a tilted tool axis is refused by the 3-axis posts", () => {
        const tilted: ToolpathData = {
            toolId: "t1",
            moves: [{ kind: "rapid", to: [0, 0, 10], axis: [0, Math.SQRT1_2, Math.SQRT1_2] }],
        };
        const result = postProcessor("fanuc")!.post(program(MILL, [tilted], [ENDMILL]));
        expect(result.isOk).toBe(false);
        expect(result.isOk ? "" : result.error).toContain("5-axis");
    });
});

const JET: ToolData = {
    id: "jet",
    number: 1,
    name: "Torch",
    kind: "jet",
    diameter: 1.5,
    cutting: { feed: 3000 },
};

const PLASMA: MachineProfileData = {
    id: "test-plasma",
    name: "Test plasma",
    kind: "plasma",
    linearAxes: [
        { name: "X", min: 0, max: 2500 },
        { name: "Y", min: 0, max: 1250 },
    ],
    maxFeed: 10000,
    rapidFeed: 20000,
    cutting: { kerf: 1.5, pierceDelay: 0.5, torchHeightControl: true },
    post: { id: "plasma" },
};

const PLATE: ToolpathData[] = [
    {
        toolId: "jet",
        label: "Hole",
        moves: [
            { kind: "rapid", to: [20, 20, 0] },
            { kind: "cutterOn", pierceDelay: 0.8 },
            { kind: "arc", to: [20, 20, 0], center: [25, 20, 0], clockwise: true, plane: "XY", feed: 1500 },
            { kind: "cutterOff" },
        ],
    },
    {
        toolId: "jet",
        label: "Outer",
        moves: [
            { kind: "rapid", to: [0, 0, 0] },
            { kind: "cutterOn" },
            { kind: "linear", to: [50, 0, 0], feed: 3000 },
            { kind: "arc", to: [60, 10, 0], center: [50, 10, 0], clockwise: false, plane: "XY", feed: 3000 },
            { kind: "linear", to: [60, 40, 0], feed: 3000 },
            { kind: "linear", to: [0, 40, 0], feed: 3000 },
            { kind: "linear", to: [0, 0, 0], feed: 3000 },
            { kind: "cutterOff" },
        ],
    },
];

describe("comments in ASCII", () => {
    test.each([
        ["Face: tool Ø12.7", "Face: tool D12.7"],
        ["taper 3°", "taper 3 deg"],
        ["Ébauche ×2 — fin", "Ebauche x2 - fin"],
        ["钻孔 1", "1"],
        ["two\nlines", "two lines"],
    ])("%j is written %j", (text, expected) => {
        expect(asciiCommentText(text)).toBe(expected);
    });

    test.each(["fanuc", "haas", "linuxcnc", "grbl", "mach3"])("%s writes only printable ASCII", (id) => {
        const named = {
            ...MILL_PROGRAM,
            tools: new Map(
                [...MILL_PROGRAM.tools].map(([key, tool]) => [key, { ...tool, name: `${tool.name} Ø` }]),
            ),
            toolpaths: MILL_PROGRAM.toolpaths.map((path) => ({
                ...path,
                label: `${path.label ?? ""} Ø6 × 2, 90°`,
            })),
        };
        const text = post(id, named);
        expect(text).toMatch(/^[\x20-\x7e\n%]*$/);
        expect(text.toUpperCase()).toContain("D6 X 2, 90 DEG");
    });
});

describe("2D cutting posts", () => {
    test("plasma: pierce delays as G4, torch height control on after the pierce and off before the stop", () => {
        expect(post("plasma", { ...program(PLASMA, PLATE, [JET]), name: "Plate" })).toBe(
            lines(
                "%",
                "(Plate)",
                "(Kerf 1.5 mm in the toolpaths)",
                "G90 G94 G17 G40",
                "G21",
                "(Hole)",
                "G0 X20 Y20",
                "M07",
                "G4 P0.8",
                "M51",
                "G2 I5 J0 F1500",
                "M50",
                "M08",
                "(Outer)",
                "G0 X0 Y0",
                "M07",
                "G4 P0.5",
                "M51",
                "G1 X50 F3000",
                "G3 X60 Y10 I0 J10",
                "G1 Y40",
                "X0",
                "Y0",
                "M50",
                "M08",
                "M30",
                "%",
            ),
        );
    });

    test("plasma without THC, and a waterjet with its own jet codes", () => {
        const noThc = post("plasma", program(PLASMA, PLATE, [JET]), { thc: false, comments: false });
        expect(noThc).not.toContain("M51");
        expect(noThc).not.toContain("M50");
        const waterjet = {
            ...PLASMA,
            kind: "waterjet" as const,
            cutting: { kerf: 0.8, pierceDelay: 1.5 },
            post: { id: "waterjet" },
        };
        const text = post("waterjet", program(waterjet, [PLATE[0]], [JET]), { comments: false });
        expect(text).toBe(
            lines(
                "%",
                "G90 G94 G17 G40",
                "G21",
                "G0 X20 Y20",
                "M03",
                "G4 P0.8",
                "G2 I5 J0 F1500",
                "M05",
                "M30",
                "%",
            ),
        );
    });

    const ETCHED: ToolpathData = {
        toolId: "jet",
        moves: [
            { kind: "rapid", to: [30, 0, 0] },
            { kind: "cutterOn", mode: "mark" },
            { kind: "linear", to: [30, 40, 0], feed: 3000 },
            { kind: "cutterOff" },
            { kind: "rapid", to: [0, 0, 0] },
            { kind: "cutterOn" },
            { kind: "linear", to: [60, 0, 0], feed: 3000 },
            { kind: "cutterOff" },
        ],
    };

    test("plasma: a marking pass switches the marker, with no pierce delay and no torch height control", () => {
        expect(post("plasma", program(PLASMA, [ETCHED], [JET]), { comments: false })).toBe(
            lines(
                "%",
                "G90 G94 G17 G40",
                "G21",
                "G0 X30 Y0",
                "M09",
                "G1 Y40 F3000",
                "M10",
                "G0 X0 Y0",
                "M07",
                "G4 P0.5",
                "M51",
                "G1 X60",
                "M50",
                "M08",
                "M30",
                "%",
            ),
        );
    });

    test("laser: a marking pass fires at the marking power", () => {
        const laser = {
            ...PLASMA,
            kind: "laser" as const,
            cutting: { kerf: 0.2 },
            post: { id: "laser-generic" },
        };
        const text = post("laser-generic", program(laser, [ETCHED], [JET]), {
            power: 900,
            markPower: 120,
            comments: false,
        });
        expect(text).toContain(lines("G0 X30 Y0", "M3 S120", "G1 Y40 F3000", "M5", "G0 X0 Y0", "M3 S900"));
    });

    test("a waterjet has no standard marking code: marks need the post's marker codes", () => {
        const waterjet = {
            ...PLASMA,
            kind: "waterjet" as const,
            cutting: { kerf: 0.8, pierceDelay: 1.5 },
            post: { id: "waterjet" },
        };
        const refused = postProcessor("waterjet")!.post(program(waterjet, [ETCHED], [JET]), {
            comments: false,
        });
        expect(refused.isOk).toBe(false);
        expect(refused.isOk ? "" : refused.error).toContain("marking code");
        const text = post("waterjet", program(waterjet, [ETCHED], [JET]), {
            comments: false,
            markOn: "M13",
            markOff: "M14",
        });
        expect(text).toContain(
            lines("G0 X30 Y0", "M13", "G1 Y40 F3000", "M14", "G0 X0 Y0", "M03", "G4 P1.5"),
        );
    });

    test("GRBL laser mode switches the beam with M4 S-power", () => {
        const laser = {
            ...PLASMA,
            kind: "laser" as const,
            cutting: { kerf: 0.2 },
            post: { id: "laser-grbl" },
        };
        const text = post("laser-grbl", program(laser, [PLATE[1]], [JET]), { power: 800, comments: false });
        expect(text).toBe(
            lines(
                "G90 G94 G17",
                "G21",
                "G0 X0 Y0",
                "M4 S800",
                "G1 X50 F3000",
                "G3 X60 Y10 I0 J10",
                "G1 Y40",
                "X0",
                "Y0",
                "M5",
                "M30",
            ),
        );
    });
});

describe("wire EDM post", () => {
    const EDM: MachineProfileData = {
        id: "test-edm",
        name: "Test EDM",
        kind: "wireEdm",
        linearAxes: [
            { name: "X", min: 0, max: 350 },
            { name: "Y", min: 0, max: 250 },
            { name: "U", min: -50, max: 50 },
            { name: "V", min: -50, max: 50 },
        ],
        maxFeed: 50,
        rapidFeed: 1000,
        wire: { wireDiameter: 0.25, sparkGap: 0.02, maxTaper: 30, programPlaneHeight: 0, uvPlaneHeight: 100 },
        post: { id: "wire-iso" },
    };
    const WIRE: ToolData = {
        id: "w",
        number: 1,
        name: "Brass 0.25",
        kind: "wire",
        diameter: 0.25,
        cutting: { feed: 3 },
    };

    test("G92 start hole, XY + UV taper moves, M00 at a stop point, re-threading at the next start hole", () => {
        const path: ToolpathData = {
            toolId: "w",
            label: "Die",
            moves: [
                { kind: "rapid", to: [0, 0, 0] },
                { kind: "cutterOn" },
                { kind: "linear", to: [5, 0, 0], feed: 3 },
                { kind: "taper", to: [10, 0, 0], upper: [10.5, 0, 100], feed: 3 },
                { kind: "taper", to: [10, 10, 0], upper: [10.5, 10.5, 100], feed: 3 },
                { kind: "dwell", seconds: 0 },
                { kind: "linear", to: [10, 0, 0], feed: 3 },
                { kind: "cutterOff" },
                { kind: "rapid", to: [30, 0, 0] },
                { kind: "cutterOn" },
                { kind: "arc", to: [30, 0, 0], center: [35, 0, 0], clockwise: false, plane: "XY", feed: 3 },
                { kind: "cutterOff" },
            ],
        };
        expect(post("wire-iso", { ...program(EDM, [path], [WIRE]), name: "Die" })).toBe(
            lines(
                "%",
                "O1001 (DIE)",
                "(WIRE D=0.25 SPARK GAP 0.02 IN THE PATH)",
                "(PROGRAM PLANE Z=0. UV PLANE Z=100.)",
                "G90 G40",
                "G21",
                "(DIE)",
                "G92 X0. Y0. U0. V0.",
                "G1 X5.",
                "X10. U0.5",
                "Y10. V0.5",
                "M00",
                "Y0. U0. V0.",
                "M50",
                "G0 X30.",
                "M60",
                "G3 I5. J0.",
                "M50",
                "M02",
                "%",
            ),
        );
    });
});
