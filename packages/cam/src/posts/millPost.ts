// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { CamParameterSpec } from "../model/operation";
import type { CamProgram, PostProcessor } from "../model/post";
import type { ToolCuttingData, ToolData } from "../model/tool";
import type { ToolpathData, ToolpathMove, Vec3 } from "../model/toolpath";
import { type CommentStyle, GCodeWriter, type NumberFormat, optionOf } from "./gcodeWriter";
import {
    type ArcMove,
    arcPoints,
    type DrillMove,
    drillPlanes,
    isVerticalAxis,
    planeAxes,
    planeCode,
    programTools,
    resolvePostOptions,
    splitArc,
    toolDescription,
} from "./motion";

/**
 * 3-axis milling posts: one engine, a dialect per controller family (Fanuc, Haas NGC,
 * LinuxCNC, GRBL, Mach3/Mach4). The dialect says how numbers and comments are spelled,
 * the safe start and end blocks, how the tool changes (an automatic changer with tool
 * length offsets, or a manual stop), which drilling cycles the control runs (the others
 * are expanded into moves), and how dwells are timed. Arcs go out as I/J/K centre offsets,
 * as radius words (split at 180°), or linearized.
 */

/** The widest arc a post writes in R format: well-conditioned (the centre error stays below 2× the end rounding). */
const R_MAX_SWEEP = (150 * Math.PI) / 180;
export type DrillCode = "G81" | "G82" | "G83" | "G73" | "G84" | "G85";
type Coolant = NonNullable<ToolCuttingData["coolant"]>;

export interface MillDialect {
    readonly id: string;
    readonly name: string;
    readonly extension: string;
    readonly format: NumberFormat;
    readonly feedFormat: NumberFormat;
    readonly comments: CommentStyle;
    readonly uppercaseComments: boolean;
    /** `%` before and after the program (tape markers). */
    readonly percent: boolean;
    /** Digits of the `O` program number (4: `O1001`, 5: `O01001`); none when absent. */
    readonly programNumberDigits?: number;
    /** Blocks after the header: modes and units. */
    readonly safeStart: readonly string[];
    /** Blocks sending Z home (before tool changes and at the end); a clearance retract when absent. */
    readonly homeZ?: readonly string[];
    /** An automatic tool changer (`T1 M6`); without one a change is a stop (`M0`) for the operator. */
    readonly toolChanger: boolean;
    readonly toolLengthOffset: boolean;
    /** Canned drilling cycles the control runs; others are expanded. */
    readonly cycles: readonly DrillCode[];
    /** Rigid tapping by `G33.1 Z K` when the control has no G84 (LinuxCNC). */
    readonly rigidTapG331?: boolean;
    /** Unit of the `P` word of G4/G82: milliseconds (Fanuc) or seconds. */
    readonly dwell: "ms" | "s";
    /** On/off codes per coolant. */
    readonly coolant: Readonly<Record<Exclude<Coolant, "off">, readonly [string, string]>>;
    readonly end: readonly string[];
}

const GENERIC_COOLANT: MillDialect["coolant"] = {
    flood: ["M8", "M9"],
    mist: ["M7", "M9"],
    air: ["M7", "M9"],
    throughTool: ["M8", "M9"],
};

const ALL_CYCLES: readonly DrillCode[] = ["G81", "G82", "G83", "G73", "G84", "G85"];

export const FANUC_DIALECT: MillDialect = {
    id: "fanuc",
    name: "Fanuc (generic)",
    extension: ".nc",
    format: { decimals: 3, forceDecimal: true },
    feedFormat: { decimals: 1, forceDecimal: true },
    comments: "parens",
    uppercaseComments: true,
    percent: true,
    programNumberDigits: 4,
    safeStart: ["G90 G94 G17 G49 G40 G80", "G21"],
    homeZ: ["G28 G91 Z0.", "G90"],
    toolChanger: true,
    toolLengthOffset: true,
    cycles: ALL_CYCLES,
    dwell: "ms",
    coolant: GENERIC_COOLANT,
    end: ["M30"],
};

export const HAAS_DIALECT: MillDialect = {
    ...FANUC_DIALECT,
    id: "haas",
    name: "Haas (NGC)",
    programNumberDigits: 5,
    safeStart: ["G90 G94 G17 G40 G49 G80", "G21"],
    homeZ: ["G53 G0 Z0."],
    dwell: "s",
    coolant: {
        flood: ["M8", "M9"],
        mist: ["M7", "M9"],
        air: ["M83", "M84"],
        throughTool: ["M88", "M89"],
    },
};

export const LINUXCNC_DIALECT: MillDialect = {
    id: "linuxcnc",
    name: "LinuxCNC",
    extension: ".ngc",
    format: { decimals: 4 },
    feedFormat: { decimals: 1 },
    comments: "parens",
    uppercaseComments: false,
    percent: true,
    safeStart: ["G90 G94 G17 G40 G49 G80", "G21"],
    homeZ: ["G53 G0 Z0"],
    toolChanger: true,
    toolLengthOffset: true,
    cycles: ["G81", "G82", "G83", "G73", "G85"],
    rigidTapG331: true,
    dwell: "s",
    coolant: GENERIC_COOLANT,
    end: ["M2"],
};

export const GRBL_DIALECT: MillDialect = {
    id: "grbl",
    name: "GRBL",
    extension: ".nc",
    format: { decimals: 3 },
    feedFormat: { decimals: 0 },
    comments: "parens",
    uppercaseComments: false,
    percent: false,
    safeStart: ["G90 G94 G17", "G21"],
    toolChanger: false,
    toolLengthOffset: false,
    cycles: [],
    dwell: "s",
    coolant: GENERIC_COOLANT,
    end: ["M30"],
};

export const MACH3_DIALECT: MillDialect = {
    id: "mach3",
    name: "Mach3 / Mach4",
    extension: ".tap",
    format: { decimals: 4 },
    feedFormat: { decimals: 1 },
    comments: "parens",
    uppercaseComments: false,
    percent: true,
    safeStart: ["G90 G94 G91.1 G40 G49 G17", "G21"],
    homeZ: ["G28 G91 Z0", "G90"],
    toolChanger: true,
    toolLengthOffset: true,
    cycles: ["G81", "G82", "G83", "G73", "G85"],
    dwell: "s",
    coolant: GENERIC_COOLANT,
    end: ["M30"],
};

/** Retract above the last depth before re-entering a peck (G83 expansion), mm. */
export const PECK_CLEARANCE = 0.5;
/** Back-off of a chip-break peck (G73 expansion), mm. */
export const CHIP_BREAK_RETRACT = 0.5;

const WORK_OFFSETS = ["G54", "G55", "G56", "G57", "G58", "G59"];

export const MILL_POST_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "programNumber", label: "Program number", kind: "integer", min: 1, max: 99999 },
    {
        key: "workOffset",
        label: "Work offset",
        kind: "enum",
        options: WORK_OFFSETS.map((x) => ({ value: x, label: x })),
    },
    {
        key: "arcs",
        label: "Arcs",
        kind: "enum",
        options: [
            { value: "ijk", label: "I/J/K centre" },
            { value: "r", label: "Radius (R)" },
            { value: "linear", label: "Linearize" },
        ],
    },
    {
        key: "arcTolerance",
        label: "Linearize tolerance",
        kind: "length",
        min: 0.0001,
        visibleWhen: { key: "arcs", values: ["linear"] },
    },
    { key: "cannedCycles", label: "Canned drilling cycles", kind: "boolean" },
    { key: "lineNumbers", label: "Line numbers", kind: "boolean" },
    {
        key: "lineStart",
        label: "First line number",
        kind: "integer",
        min: 0,
        visibleWhen: { key: "lineNumbers", values: [true] },
    },
    {
        key: "lineIncrement",
        label: "Line number increment",
        kind: "integer",
        min: 1,
        visibleWhen: { key: "lineNumbers", values: [true] },
    },
    { key: "comments", label: "Comments", kind: "boolean" },
    { key: "coolant", label: "Coolant codes", kind: "boolean" },
];

const MILL_DEFAULTS = {
    programNumber: 1001,
    workOffset: "G54",
    arcs: "ijk",
    arcTolerance: 0.005,
    cannedCycles: true,
    lineNumbers: false,
    lineStart: 10,
    lineIncrement: 10,
    comments: true,
    coolant: true,
} as const;

interface MillState {
    position: [number, number, number] | undefined;
    tool: ToolData | undefined;
    rpm: number | undefined;
    spindleOn: boolean;
    coolantOff: string | undefined;
    coolantOn: string | undefined;
    pendingLengthOffset: boolean;
    cycle: string | undefined;
}

class MillPostError extends Error {}

export class MillPost implements PostProcessor {
    readonly id: string;
    readonly name: string;
    readonly machineKinds = ["mill"] as const;
    readonly extension: string;
    readonly parameters = MILL_POST_PARAMETERS;
    readonly defaultOptions: Readonly<Record<string, unknown>> = MILL_DEFAULTS;

    constructor(readonly dialect: MillDialect) {
        this.id = dialect.id;
        this.name = dialect.name;
        this.extension = dialect.extension;
    }

    post(program: CamProgram, options?: Readonly<Record<string, unknown>>): Result<string> {
        try {
            return Result.ok(
                new MillProgramWriter(
                    this.dialect,
                    program,
                    resolvePostOptions(this, program, options),
                ).write(),
            );
        } catch (error) {
            if (error instanceof MillPostError) return Result.err(error.message);
            throw error;
        }
    }
}

class MillProgramWriter {
    private readonly w: GCodeWriter;
    private readonly state: MillState = {
        position: undefined,
        tool: undefined,
        rpm: undefined,
        spindleOn: false,
        coolantOff: undefined,
        coolantOn: undefined,
        pendingLengthOffset: false,
        cycle: undefined,
    };
    private readonly arcs: string;
    private readonly clearance: number;

    constructor(
        private readonly dialect: MillDialect,
        private readonly program: CamProgram,
        private readonly options: Readonly<Record<string, unknown>>,
    ) {
        const lineNumbers = optionOf(options, "lineNumbers", false);
        this.w = new GCodeWriter({
            format: dialect.format,
            feedFormat: dialect.feedFormat,
            comments: optionOf(options, "comments", true) ? dialect.comments : "none",
            uppercaseComments: dialect.uppercaseComments,
            lineNumbers: lineNumbers
                ? {
                      start: optionOf(options, "lineStart", 10),
                      increment: optionOf(options, "lineIncrement", 10),
                      max: 99999,
                  }
                : false,
        });
        this.arcs = optionOf(options, "arcs", "ijk");
        this.clearance = clearanceHeight(program.toolpaths);
    }

    write(): string {
        this.validate();
        this.header();
        for (const path of this.program.toolpaths) this.toolpath(path);
        this.footer();
        return this.w.toString();
    }

    private validate(): void {
        for (const path of this.program.toolpaths) {
            if (!this.program.tools.has(path.toolId)) {
                throw new MillPostError(
                    `Toolpath "${path.label ?? path.toolId}" uses an unknown tool "${path.toolId}"`,
                );
            }
            for (const move of path.moves) {
                if ((move.kind === "rapid" || move.kind === "linear") && !isVerticalAxis(move.axis)) {
                    throw new MillPostError(
                        `${this.dialect.name} writes 3-axis programs; "${path.label ?? "a toolpath"}" tilts the tool — choose a 5-axis post`,
                    );
                }
                if (move.kind === "taper" || move.kind === "extrude") {
                    throw new MillPostError(`${this.dialect.name} cannot write ${move.kind} moves`);
                }
            }
        }
    }

    // ------------------------------------------------------------------ Program frame

    private header(): void {
        const { w, dialect } = this;
        if (dialect.percent) w.raw("%");
        const name = this.program.setup.programName ?? this.program.name;
        if (dialect.programNumberDigits !== undefined) {
            const number = /^\d+$/.test(name) ? Number(name) : optionOf(this.options, "programNumber", 1001);
            const label = /^\d+$/.test(name) ? this.program.name : name;
            const comment = w.commentText(label);
            w.raw(
                `O${String(number).padStart(dialect.programNumberDigits, "0")}${comment ? ` ${comment}` : ""}`,
            );
        } else {
            w.comment(name);
        }
        for (const tool of programTools(this.program)) {
            w.comment(`T${tool.number} ${toolDescription(tool, (x) => w.num(x))}`);
        }
        for (const line of dialect.safeStart) w.block(line);
        w.modalWord("plane", "G17");
        if (dialect.toolChanger) this.homeZ();
    }

    private footer(): void {
        const { w, dialect } = this;
        this.endCycle();
        this.coolant("off");
        if (this.state.spindleOn) w.block("M5");
        this.homeZ();
        for (const line of dialect.end) w.block(line);
        if (dialect.percent) w.raw("%");
    }

    private homeZ(): void {
        const { w, dialect } = this;
        if (dialect.homeZ === undefined) {
            if (this.state.position === undefined) return;
            this.rapid([undefined, undefined, Math.max(this.clearance, this.state.position[2])]);
            return;
        }
        for (const line of dialect.homeZ) w.block(line);
        if (dialect.homeZ.some((line) => /\bG0\b/.test(line))) w.modalWord("motion", "G0");
        w.forgetAxes("Z");
        if (this.state.position !== undefined)
            this.state.position = [this.state.position[0], this.state.position[1], Number.POSITIVE_INFINITY];
    }

    // ------------------------------------------------------------------ Toolpaths

    private toolpath(path: ToolpathData): void {
        const { w } = this;
        const tool = this.program.tools.get(path.toolId)!;
        this.endCycle();
        if (path.label) w.comment(path.label);
        if (this.state.tool?.id !== tool.id) this.toolChange(tool);
        const rpm = path.spindleRpm ?? tool.cutting.spindleRpm;
        if (!this.state.spindleOn || rpm !== this.state.rpm) {
            w.block(rpm === undefined ? undefined : `S${w.spindleNum(rpm)}`, "M3");
            this.state.rpm = rpm;
            this.state.spindleOn = true;
        }
        w.block(w.modalWord("wcs", optionOf(this.options, "workOffset", "G54")));
        this.coolant(path.coolant ?? tool.cutting.coolant ?? "off");
        for (const move of path.moves) this.move(move);
        this.endCycle();
    }

    private toolChange(tool: ToolData): void {
        const { w, dialect } = this;
        const first = this.state.tool === undefined;
        if (!first) {
            this.coolant("off");
            if (this.state.spindleOn) w.block("M5");
            this.state.spindleOn = false;
            this.homeZ();
        }
        if (dialect.toolChanger) {
            w.block(`T${tool.number}`, "M6");
        } else if (!first) {
            w.comment(`Tool change: T${tool.number} ${toolDescription(tool, (x) => w.num(x))}`);
            w.block("M0");
        }
        this.state.tool = tool;
        this.state.pendingLengthOffset = dialect.toolLengthOffset;
        w.forgetAxes();
        w.forgetFeed();
        w.resetModal("motion");
    }

    private coolant(coolant: Coolant): void {
        if (!optionOf(this.options, "coolant", true)) return;
        const codes = coolant === "off" ? undefined : this.dialect.coolant[coolant];
        if (codes?.[0] === this.state.coolantOn) return;
        if (this.state.coolantOff !== undefined) this.w.block(this.state.coolantOff);
        this.state.coolantOn = codes?.[0];
        this.state.coolantOff = codes?.[1];
        if (codes !== undefined) this.w.block(codes[0]);
    }

    // ------------------------------------------------------------------ Moves

    private move(move: ToolpathMove): void {
        switch (move.kind) {
            case "rapid":
                this.endCycle();
                this.rapid(move.to);
                return;
            case "linear":
                this.endCycle();
                this.linear(move.to, move.feed);
                return;
            case "arc":
                this.endCycle();
                this.arc(move);
                return;
            case "drill":
                this.drill(move);
                return;
            case "dwell":
                this.endCycle();
                this.dwell(move.seconds);
                return;
            case "comment":
                this.w.comment(move.text);
                return;
            case "raw":
                this.w.raw(move.code);
                return;
            default:
                // Beam on/off has no meaning on a mill; extrusion and tapers were rejected.
                return;
        }
    }

    private positionWords(to: readonly (number | undefined)[]): string[] {
        const words = [this.w.axis("X", to[0]), this.w.axis("Y", to[1]), this.w.axis("Z", to[2])];
        return words.filter((word): word is string => word !== undefined);
    }

    private moveTo(to: readonly (number | undefined)[]): void {
        const at = this.state.position ?? [0, 0, 0];
        this.state.position = [to[0] ?? at[0], to[1] ?? at[1], to[2] ?? at[2]];
    }

    private rapid(to: readonly (number | undefined)[]): void {
        const { w } = this;
        if (this.state.pendingLengthOffset && to[2] !== undefined && this.state.tool !== undefined) {
            const xy = this.positionWords([to[0], to[1], undefined]);
            if (xy.length > 0) w.block(w.motion("G0"), ...xy);
            w.block(w.motion("G0"), "G43", w.axis("Z", to[2], true), `H${this.state.tool.number}`);
            this.state.pendingLengthOffset = false;
        } else {
            const words = this.positionWords(to);
            if (words.length > 0) w.block(w.motion("G0"), ...words);
        }
        this.moveTo(to);
    }

    private linear(to: Vec3 | readonly (number | undefined)[], feed: number): void {
        const { w } = this;
        const words = this.positionWords(to);
        if (words.length === 0) return;
        const offset = this.lengthOffsetWords();
        w.block(w.motion("G1"), ...offset, ...words, w.feed(feed));
        this.moveTo(to);
    }

    private lengthOffsetWords(): string[] {
        if (!this.state.pendingLengthOffset || this.state.tool === undefined) return [];
        this.state.pendingLengthOffset = false;
        return ["G43", `H${this.state.tool.number}`];
    }

    private arc(move: ArcMove): void {
        const from = this.state.position;
        if (from === undefined)
            throw new MillPostError("An arc cannot start a program: position the tool first");
        if (this.arcs === "linear") {
            for (const point of arcPoints(from, move, optionOf(this.options, "arcTolerance", 0.005))) {
                this.linear(point, move.feed);
            }
            return;
        }
        // R names the centre only up to the chord's rounding, and near a half circle that error
        // explodes (0.0005 mm on the ends moves a 180° arc's centre by ~0.1 mm; controllers
        // alarm on the radius mismatch): R arcs stay at or below R_MAX_SWEEP.
        const pieces = this.arcs === "r" ? splitArc(from, move, R_MAX_SWEEP) : [move];
        for (const piece of pieces) this.arcPiece(piece);
    }

    private arcPiece(move: ArcMove): void {
        const { w } = this;
        const from = this.state.position!;
        const [u, v] = planeAxes(move.plane);
        const plane = w.modalWord("plane", planeCode(move.plane));
        const motion = w.motion(move.clockwise ? "G2" : "G3");
        const end = this.positionWords(move.to);
        const centre: string[] = [];
        if (this.arcs === "r") {
            centre.push(w.word("R", Math.hypot(from[u] - move.center[u], from[v] - move.center[v])));
        } else {
            const letters = ["I", "J", "K"];
            for (const axis of [0, 1, 2]) {
                if (axis === u || axis === v)
                    centre.push(w.word(letters[axis], move.center[axis] - from[axis]));
            }
        }
        w.block(plane, motion, ...this.lengthOffsetWords(), ...end, ...centre, w.feed(move.feed));
        this.moveTo(move.to);
    }

    private dwell(seconds: number): void {
        if (seconds <= 0) {
            this.w.block("M0");
            return;
        }
        this.w.block("G4", this.dwellWord(seconds));
    }

    private dwellWord(seconds: number): string {
        return this.dialect.dwell === "ms" ? `P${Math.round(seconds * 1000)}` : `P${this.w.num(seconds)}`;
    }

    // ------------------------------------------------------------------ Drilling

    private endCycle(): void {
        if (this.state.cycle === undefined) return;
        this.w.block("G80");
        this.w.resetModal("motion");
        this.state.cycle = undefined;
    }

    private drill(move: DrillMove): void {
        const { bottom, r } = drillPlanes(move);
        const code = drillCode(move);
        const canned = optionOf(this.options, "cannedCycles", true) && this.dialect.cycles.includes(code);
        // The cycle starts (and G98 returns) at the current height: be above the R plane.
        const z = this.state.position?.[2];
        if (z === undefined || z < r) {
            this.endCycle();
            this.rapid([undefined, undefined, r]);
        }
        if (canned) {
            this.cannedCycle(move, code, bottom, r);
            return;
        }
        this.endCycle();
        this.expandedCycle(move, bottom, r);
    }

    private cannedCycle(move: DrillMove, code: DrillCode, bottom: number, r: number): void {
        const { w } = this;
        const peck = code === "G83" || code === "G73" ? (move.peck ?? Math.abs(move.depth)) : undefined;
        const dwell = code === "G82" ? move.dwell : undefined;
        const key = JSON.stringify([code, w.num(bottom), w.num(r), peck, dwell, w.feedNum(move.feed)]);
        if (this.state.cycle !== key) {
            if (this.state.cycle !== undefined) this.endCycle();
            w.resetModal("motion");
            w.block(
                "G98",
                w.motion(code),
                w.axis("X", move.at[0], true),
                w.axis("Y", move.at[1], true),
                `Z${w.num(bottom)}`,
                `R${w.num(r)}`,
                peck === undefined ? undefined : w.word("Q", peck),
                dwell === undefined ? undefined : this.dwellWord(dwell),
                `F${w.feedNum(move.feed)}`,
            );
            w.forgetFeed();
            this.state.cycle = key;
        } else {
            const words = this.positionWords([move.at[0], move.at[1], undefined]);
            w.block(...(words.length > 0 ? words : [w.axis("X", move.at[0], true)]));
        }
        this.state.position = [move.at[0], move.at[1], this.state.position![2]];
    }

    private expandedCycle(move: DrillMove, bottom: number, r: number): void {
        const { w } = this;
        const z = this.state.position![2];
        const initial = Number.isFinite(z) ? z : Math.max(this.clearance, r);
        this.rapid([move.at[0], move.at[1], undefined]);
        this.rapid([undefined, undefined, r]);
        const peck = move.peck !== undefined && move.peck > 0 ? move.peck : Math.abs(move.depth);
        switch (move.cycle) {
            case "peck": {
                let depth = r;
                while (depth > bottom + 1e-9) {
                    const next = Math.max(bottom, depth - peck);
                    if (depth < r) this.rapid([undefined, undefined, depth + PECK_CLEARANCE]);
                    this.linear([undefined, undefined, next], move.feed);
                    this.rapid([undefined, undefined, r]);
                    depth = next;
                }
                break;
            }
            case "chipBreak": {
                let depth = r;
                while (depth > bottom + 1e-9) {
                    depth = Math.max(bottom, depth - peck);
                    this.linear([undefined, undefined, depth], move.feed);
                    if (depth > bottom + 1e-9) this.rapid([undefined, undefined, depth + CHIP_BREAK_RETRACT]);
                }
                break;
            }
            case "tap": {
                const rpm = this.state.rpm;
                if (this.dialect.rigidTapG331 && rpm !== undefined && rpm > 0) {
                    w.block("G33.1", `Z${w.num(bottom)}`, w.word("K", move.feed / rpm));
                    w.resetModal("motion");
                    w.forgetAxes("Z");
                    this.state.position = [move.at[0], move.at[1], r];
                } else {
                    this.linear([undefined, undefined, bottom], move.feed);
                    w.block("M4");
                    this.linear([undefined, undefined, r], move.feed);
                    w.block("M3");
                }
                break;
            }
            case "bore":
                this.linear([undefined, undefined, bottom], move.feed);
                if (move.dwell !== undefined && move.dwell > 0) this.dwell(move.dwell);
                this.linear([undefined, undefined, r], move.feed);
                break;
            default:
                this.linear([undefined, undefined, bottom], move.feed);
                if (move.dwell !== undefined && move.dwell > 0) this.dwell(move.dwell);
                break;
        }
        this.rapid([undefined, undefined, Math.max(initial, r)]);
    }
}

function drillCode(move: DrillMove): DrillCode {
    switch (move.cycle) {
        case "peck":
            return "G83";
        case "chipBreak":
            return "G73";
        case "tap":
            return "G84";
        case "bore":
            return "G85";
        default:
            return move.dwell !== undefined && move.dwell > 0 ? "G82" : "G81";
    }
}

/** The highest rapid (or drill retract) height of a program: where a manual control retracts. */
export function clearanceHeight(toolpaths: readonly ToolpathData[]): number {
    let z = Number.NEGATIVE_INFINITY;
    for (const path of toolpaths) {
        for (const move of path.moves) {
            if (move.kind === "rapid") z = Math.max(z, move.to[2]);
            if (move.kind === "drill") z = Math.max(z, move.retract);
        }
    }
    return Number.isFinite(z) ? z : 5;
}

export const MILL_DIALECTS: readonly MillDialect[] = [
    FANUC_DIALECT,
    HAAS_DIALECT,
    LINUXCNC_DIALECT,
    GRBL_DIALECT,
    MACH3_DIALECT,
];
