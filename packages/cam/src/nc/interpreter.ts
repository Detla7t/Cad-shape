// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MachineProfileData } from "../model/machine";
import type { ToolpathData, ToolpathMove, Vec3 } from "../model/toolpath";
import { FiveAxisKinematics } from "../ops5x/kinematics";
import { type Mat3, mulMM, mulMV, rotation, transpose, X_AXIS, Y_AXIS, Z_AXIS } from "../ops5x/vec";
import { arcPoints, arcSweep, planeAxes } from "../posts/motion";
import { type NcCoolant, type NcDialect, ncDialect } from "./dialects";
import { type Expr, evaluate, lexBlock, type NcBlock, type NcWord } from "./lexer";
import type { NcDiagnostic, NcDialectId, NcReadOptions, NcSeverity, NcToolInfo } from "./program";

/**
 * The NC interpreter: runs a program block by block the way a controller does — modal
 * groups in RS274/NGC order of execution (feed mode, F, S, T, M6, spindle, coolant, dwell,
 * plane, units, compensation, length offset, work offset, distance modes, retract mode,
 * reference returns and offsets, motion, stops), parameters and macro control flow,
 * subprograms — and records what the tool does as toolpath moves in the WCS of the
 * program's first work offset, millimetres.
 *
 * It reads what is common to the dialects and the dialect-specific parts the posts of this
 * module write; what it cannot interpret is reported (once per kind, with a count) and
 * skipped, never guessed.
 */

type Arc = Extract<ToolpathMove, { kind: "arc" }>;
type Plane = Arc["plane"];
type CycleCode = 73 | 74 | 76 | 81 | 82 | 83 | 84 | 85 | 86 | 87 | 88 | 89;

const MM_PER_INCH = 25.4;
const LENGTH_EPSILON = 1e-9;
/** Radii of an arc's start and end may differ this much (mm) before it is reported. */
const ARC_RADIUS_TOLERANCE = 0.01;
/** Arcs that cannot stay arcs (tilted planes, machine coordinates) are split within this, mm. */
const CHORD_TOLERANCE = 0.002;
/** Printer arcs with extrusion are split at most this much (radians), as the old preview did. */
const PRINTER_ARC_STEP = Math.PI / 36;

const FANUC_ARGUMENTS: Record<string, number> = {
    A: 1,
    B: 2,
    C: 3,
    I: 4,
    J: 5,
    K: 6,
    D: 7,
    E: 8,
    F: 9,
    H: 11,
    M: 13,
    Q: 17,
    R: 18,
    S: 19,
    T: 20,
    U: 21,
    V: 22,
    W: 23,
    X: 24,
    Y: 25,
    Z: 26,
};

/** Mill M codes that do nothing to the path (orientation, rigid tap, overrides, …). */
const PASSIVE_MILL_M = new Set([10, 11, 19, 29, 48, 49, 50, 51, 52, 53, 101, 102, 103, 104]);

const SIEMENS_KEYWORDS = new Set([
    "TRAORI",
    "TRAFOOF",
    "ORIAXES",
    "ORIWKS",
    "ORIMKS",
    "ORIVECT",
    "ORIEULER",
    "ORIRPY",
    "SUPA",
    "SOFT",
    "BRISK",
    "FFWON",
    "FFWOF",
    "CFC",
    "CFTCP",
    "G642",
    "G641",
    "G601",
    "G602",
]);

export interface ReaderResult {
    readonly dialect: NcDialectId;
    readonly units: "mm" | "inch" | undefined;
    readonly toolpaths: BuiltToolpath[];
    readonly diagnostics: NcDiagnostic[];
    readonly tools: NcToolInfo[];
    readonly lineCount: number;
    readonly programNumber?: string;
    readonly name?: string;
    readonly homeUsed: boolean;
    readonly maxProgrammedZ: number;
    readonly layers: number;
    /** Spindle speeds (laser powers) the program switches on with. */
    readonly spindle?: { readonly min: number; readonly max: number };
}

export interface BuiltToolpath {
    toolNumber: number;
    moves: ToolpathMove[];
    lines: number[];
    homeMoves: Set<number>;
    start?: Vec3;
    spindleRpm?: number;
    coolant?: ToolpathData["coolant"];
    label?: string;
}

/** A block's words by letter, evaluated, plus its G and M codes (×10: G43.4 → 434). */
type Words = Map<string, { readonly word: NcWord; readonly value: number }> & { g: number[]; m: number[] };

/** Siemens `NAME=value` words; `mode` is AC(…) (absolute) or IC(…) (incremental). */
type NamedValues = Map<
    string,
    { readonly value?: number; readonly text: string; readonly mode?: "ac" | "ic" }
>;

interface TiltFrame {
    /** Origin of the tilted plane in the active work coordinates. */
    readonly origin: Vec3;
    /** Columns: the plane's axes in work coordinates. */
    readonly frame: Mat3;
    /** The tool is oriented along the plane's Z (G53.1, CYCLE800, a 2D rotation). */
    readonly oriented: boolean;
}

interface CycleState {
    code: CycleCode;
    /** R plane and bottom in program coordinates (absolute, mm). */
    r: number;
    z: number;
    q?: number;
    dwell?: number;
    initialZ: number;
}

interface CallFrame {
    readonly returnPc: number;
    readonly startPc: number;
    repeats: number;
    readonly kind: "program" | "local" | "macro" | "oword";
    readonly label?: string;
    readonly scoped: boolean;
}

interface OwordFrame {
    readonly label: string;
    readonly keyword: "if" | "while" | "do" | "repeat";
    readonly startPc: number;
    done?: boolean;
    remaining?: number;
}

class Diagnostics {
    private readonly entries = new Map<
        string,
        { line: number; severity: NcSeverity; message: string; count: number }
    >();

    add(line: number, severity: NcSeverity, message: string): void {
        const key = `${severity}|${message}`;
        const entry = this.entries.get(key);
        if (entry === undefined) this.entries.set(key, { line, severity, message, count: 1 });
        else entry.count++;
    }

    list(): NcDiagnostic[] {
        const rank = { error: 0, warning: 1, info: 2 } as const;
        return [...this.entries.values()].sort(
            (a, b) => a.line - b.line || rank[a.severity] - rank[b.severity],
        );
    }
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const same = (a: Vec3, b: Vec3) =>
    Math.abs(a[0] - b[0]) < LENGTH_EPSILON &&
    Math.abs(a[1] - b[1]) < LENGTH_EPSILON &&
    Math.abs(a[2] - b[2]) < LENGTH_EPSILON;
const isVertical = (axis: Vec3 | undefined) =>
    axis === undefined || (Math.abs(axis[0]) < 1e-9 && Math.abs(axis[1]) < 1e-9 && axis[2] > 0);

/** Euler Z-X-Z (Fanuc G68.2 I J K): R = Rz(I)·Rx(J)·Rz(K). */
export function frameFromEulerZXZ(i: number, j: number, k: number): Mat3 {
    return mulMM(mulMM(rotation(Z_AXIS, i), rotation(X_AXIS, j)), rotation(Z_AXIS, k));
}

/** Siemens CYCLE800 axis by axis X-Y-Z: R = Rx(A)·Ry(B)·Rz(C). */
export function frameFromAxisByAxisXYZ(a: number, b: number, c: number): Mat3 {
    return mulMM(mulMM(rotation(X_AXIS, a), rotation(Y_AXIS, b)), rotation(Z_AXIS, c));
}

/** Parses the numbers of a call's argument list ("1,"TC1",0,57,…"); strings come back as NaN. */
function callArguments(args: string): number[] {
    return args.split(",").map((part) => {
        const text = part.trim();
        return text === "" ? 0 : Number(text);
    });
}

export class NcReader {
    private readonly lines: string[];
    private readonly blocks: (NcBlock | undefined)[];
    private readonly cache: boolean;
    readonly dialect: NcDialect;
    private readonly machine?: MachineProfileData;
    private readonly kinematics?: FiveAxisKinematics;
    private readonly diagnostics = new Diagnostics();
    private readonly toolpaths: BuiltToolpath[] = [];
    private current: BuiltToolpath | undefined;
    private readonly toolInfo = new Map<number, NcToolInfo>();

    // ------------------------------------------------------------------ Parameters
    private readonly globals = new Map<number | string, number>();
    private readonly locals: Map<number | string, number>[] = [new Map()];

    // ------------------------------------------------------------------ Modal state
    private inch = false;
    private unitsSeen: "mm" | "inch" | undefined;
    private absolute = true;
    private arcAbsolute = false;
    private plane: Plane = "XY";
    private feedMode: "minute" | "inverse" | "revolution" = "minute";
    private feed: number;
    private motion: "G0" | "G1" | "G2" | "G3" | "G5" | "G5.1" | "G33" | "G38" | "cycle" | undefined;
    private cycle: CycleState | undefined;
    private cycleCode: CycleCode | undefined;
    private retractToR = false;
    private rpm = 0;
    private spindleOn = false;
    private coolant: NcCoolant | "off" = "off";
    private toolNumber = 0;
    private pendingTool: number | undefined;
    private manualTool: number | undefined;
    private tcp = false;
    private dwo = false;
    private tilt: TiltFrame | undefined;
    private orientation: "axes" | "vector" = "axes";
    private vector: Vec3 | undefined;
    private angles: Record<string, number> = { A: 0, B: 0, C: 0 };
    private uv: [number, number] = [0, 0];
    private absoluteE: boolean;
    private eValue = 0;

    // ------------------------------------------------------------------ Frames
    private activeOffset = "G54";
    private readonly offsets = new Map<string, Vec3>();
    private g92: Vec3 = [0, 0, 0];
    private g52: Vec3 = [0, 0, 0];
    /** The frame offset at the first motion: positions are reported relative to it. */
    private base: Vec3 | undefined;
    private unknownOffsetReported = new Set<string>();

    // ------------------------------------------------------------------ Position
    /** Current position in base (output) coordinates. */
    private position: Vec3;
    private zState: "unknown" | "home" | "programmed";
    private positionKnown: boolean;
    private homeUsed = false;
    private maxProgrammedZ = Number.NEGATIVE_INFINITY;
    private readonly homeZ: number;

    // ------------------------------------------------------------------ Control
    private pc = 0;
    private ended = false;
    private readonly calls: CallFrame[] = [];
    private readonly loops: { label: number; pc: number }[] = [];
    private readonly owords: OwordFrame[] = [];
    private programStarts: Map<string, number> | undefined;
    private sequenceIndex: Map<number, number> | undefined;
    private owordIndex: Map<string, { pc: number; keyword: string }[]> | undefined;
    private line = 0;
    private programNumber: string | undefined;
    private programName: string | undefined;
    private pendingComments: { readonly text: string; readonly line: number }[] = [];
    private beamOn = false;
    private lastBeamOn: { toolpath: BuiltToolpath; index: number } | undefined;
    private layers = 0;

    constructor(
        text: string,
        dialect: NcDialectId,
        private readonly options: NcReadOptions,
        homeZ: number,
    ) {
        this.lines = text.split("\n");
        this.cache = this.lines.length <= 400_000;
        this.blocks = this.cache ? new Array(this.lines.length) : [];
        this.dialect = ncDialect(dialect);
        this.machine = options.machine;
        this.homeZ = options.homeZ ?? homeZ;
        const family = this.dialect.family;
        this.feed = options.feed ?? (family === "printer" ? 3000 : 0);
        this.absoluteE = false;
        if (this.machine?.rotaryAxes?.length) {
            const kinematics = FiveAxisKinematics.fromProfile(this.machine);
            if (kinematics.isOk) this.kinematics = kinematics.value;
            else this.report(0, "warning", `The machine's kinematics cannot be used: ${kinematics.error}`);
        }
        for (const [key, value] of Object.entries(options.workOffsets ?? {})) this.offsets.set(key, value);
        // The wire is threaded at setup, by the operator: a program starts with it in.
        this.beamOn = family === "wire";
        const machineStart = family === "mill" ? undefined : ([0, 0, 0] as Vec3);
        const start = options.start ?? machineStart;
        this.position = start ?? [0, 0, this.homeZ];
        this.zState = start !== undefined ? "programmed" : "unknown";
        this.positionKnown = start !== undefined;
    }

    // ------------------------------------------------------------------ Running

    run(): ReaderResult {
        if (this.dialect.family === "conversational") {
            this.report(
                0,
                "error",
                `${this.dialect.name} (Klartext) programs are not supported: only ISO G-code is read`,
            );
            return this.result();
        }
        const limit = this.options.maxBlocks ?? 5_000_000;
        let executed = 0;
        while (!this.ended && this.pc < this.lines.length) {
            if (++executed > limit) {
                this.report(this.line, "error", `Stopped after ${limit} blocks (an endless loop?)`);
                break;
            }
            const pc = this.pc;
            this.pc++;
            const block = this.blockAt(pc);
            this.line = block.line;
            this.execute(block);
        }
        if (this.calls.length > 0 && !this.ended) {
            this.report(this.line, "warning", "The program ends inside a subprogram (no M99 / endsub)");
        }
        this.flushComments();
        return this.result();
    }

    private result(): ReaderResult {
        this.finishToolpath();
        return {
            dialect: this.dialect.id,
            units: this.unitsSeen,
            toolpaths: this.toolpaths,
            diagnostics: this.diagnostics.list(),
            tools: [...this.toolInfo.values()].sort((a, b) => a.number - b.number),
            lineCount: this.lines.length,
            ...(this.programNumber === undefined ? {} : { programNumber: this.programNumber }),
            ...(this.programName === undefined ? {} : { name: this.programName }),
            homeUsed: this.homeUsed,
            maxProgrammedZ: this.maxProgrammedZ,
            layers: this.layers,
            ...(this.spindle === undefined ? {} : { spindle: this.spindle }),
        };
    }

    private blockAt(pc: number): NcBlock {
        if (this.cache) {
            const cached = this.blocks[pc];
            if (cached !== undefined) return cached;
            const block = lexBlock(this.lines[pc], pc + 1);
            this.blocks[pc] = block;
            return block;
        }
        return lexBlock(this.lines[pc], pc + 1);
    }

    private report(line: number, severity: NcSeverity, message: string): void {
        this.diagnostics.add(line, severity, message);
    }

    // ------------------------------------------------------------------ Parameters

    private isLocal(index: number | string): boolean {
        if (typeof index === "number") return index >= 1 && index <= 33;
        return !index.startsWith("_");
    }

    private read = (index: number | string): number => {
        const scope = this.isLocal(index) ? this.locals[this.locals.length - 1] : this.globals;
        const value = scope.get(index);
        if (value !== undefined) return value;
        if (typeof index === "number") return this.systemParameter(index);
        return Number.NaN;
    };

    private write(index: number | string, value: number): void {
        const scope = this.isLocal(index) ? this.locals[this.locals.length - 1] : this.globals;
        scope.set(index, value);
    }

    /** The few system parameters programs read: work offsets (LinuxCNC/Fanuc numbering). */
    private systemParameter(index: number): number {
        if (index >= 5221 && index <= 5400) {
            const slot = Math.floor((index - 5221) / 20);
            const axis = (index - 5221) % 20;
            const key = slot < 6 ? `G${54 + slot}` : `G59.${slot - 5}`;
            const offset = this.offsets.get(key);
            if (offset !== undefined && axis < 3) return offset[axis];
            return 0;
        }
        if (index === 0) return Number.NaN;
        return Number.NaN;
    }

    private value(word: NcWord): number {
        if (word.expr === undefined) return word.value;
        const value = evaluate(word.expr, this.read);
        if (Number.isNaN(value))
            this.report(this.line, "warning", `${word.letter}: the expression has no value`);
        return value;
    }

    private expression(expr: Expr): number {
        return evaluate(expr, this.read);
    }

    // ------------------------------------------------------------------ Blocks

    private execute(block: NcBlock): void {
        if (block.deleted)
            this.report(block.line, "info", "Block delete (/) lines are run, as with the switch off");
        for (const error of block.errors) this.report(block.line, "error", `Cannot read: ${error}`);
        if (block.percent) return;
        this.readComments(block);
        if (block.system !== undefined) {
            this.report(block.line, "info", "GRBL system commands ($…) do not move the machine");
            return;
        }
        if (block.oword !== undefined) {
            this.executeOword(block);
            return;
        }
        if (block.programNumber !== undefined) {
            if (this.programNumber === undefined && this.calls.length === 0) {
                this.programNumber = block.programNumber;
                if (block.comments[0] !== undefined) this.programName = block.comments[0];
            } else if (this.calls.length === 0 && this.positionKnown) {
                // Another program begins after the main one without an end: stop here.
                this.report(
                    block.line,
                    "warning",
                    `Program O${block.programNumber} starts before the main program ended`,
                );
                this.ended = true;
                return;
            }
        }
        if (block.empty) {
            for (const text of block.comments) this.pendingComments.push({ text, line: block.line });
            return;
        }
        // Word values are read with the parameters as they were before the line's assignments.
        const words = this.evaluateWords(block);
        if (block.macro !== undefined && this.executeMacro(block)) return;
        for (const assignment of block.assignments) this.assign(assignment.target, assignment.value);
        if (words !== undefined) this.executeWords(block, words);
    }

    private assign(target: Expr, value: Expr): void {
        const result = this.expression(value);
        if (target.k === "named") this.write(target.name, result);
        else if (target.k === "var") this.write(Math.round(this.expression(target.index)), result);
    }

    private readComments(block: NcBlock): void {
        for (const comment of block.comments) {
            const tool = /^T(\d+)\b\s*(.*)$/i.exec(comment);
            if (tool !== null) this.toolComment(Number(tool[1]), tool[2]);
            const change = /\btool change:?\s*T(\d+)/i.exec(comment);
            if (change !== null && this.dialect.manualToolChange) this.manualTool = Number(change[1]);
            if (/^LAYER_CHANGE$|^LAYER:\s*-?\d+/i.test(comment)) this.layers++;
        }
        for (const call of block.calls) {
            if (call.name === "MSG")
                this.pendingComments.push({ text: call.args.replace(/^\s*"|"\s*$/g, ""), line: block.line });
        }
    }

    private toolComment(number: number, text: string): void {
        if (this.toolInfo.has(number)) return;
        const diameter = /\b(?:D\s*=?|DIA(?:METER)?\s*=?|Ø)\s*(\d+\.?\d*)/i.exec(text);
        const corner = /\b(?:CR|R)\s*=\s*(\d+\.?\d*)/i.exec(text);
        this.toolInfo.set(number, {
            number,
            description: text.trim(),
            ...(diameter === null ? {} : { diameter: Number(diameter[1]) }),
            ...(corner === null ? {} : { cornerRadius: Number(corner[1]) }),
        });
    }

    private flushComments(): void {
        if (this.pendingComments.length === 0) return;
        const comments = this.pendingComments;
        this.pendingComments = [];
        const line = this.line;
        if (this.dialect.family === "printer") {
            for (const comment of comments) {
                if (!/^LAYER_CHANGE$/i.test(comment.text)) continue;
                this.line = comment.line;
                this.emit({ kind: "comment", text: comment.text });
            }
            this.line = line;
            return;
        }
        // Header comments (before any toolpath began) are the program's, not a toolpath's.
        if (this.current === undefined && this.toolpaths.length === 0) return;
        for (const comment of comments) {
            this.line = comment.line;
            this.emit({ kind: "comment", text: comment.text });
        }
        this.line = line;
    }

    // ------------------------------------------------------------------ Macro control flow

    /** Runs IF/GOTO/WHILE/END; true when the block is done (a jump happened or it was only that). */
    private executeMacro(block: NcBlock): boolean {
        const macro = block.macro!;
        switch (macro.kind) {
            case "goto":
                this.gotoSequence(this.expression(macro.target));
                return true;
            case "if": {
                const condition = this.expression(macro.condition);
                if (condition !== 0 && !Number.isNaN(condition)) {
                    if (macro.goto !== undefined) {
                        this.gotoSequence(this.expression(macro.goto));
                        return true;
                    }
                    for (const assignment of macro.then ?? [])
                        this.assign(assignment.target, assignment.value);
                }
                return true;
            }
            case "while": {
                const condition = this.expression(macro.condition);
                if (condition !== 0 && !Number.isNaN(condition)) {
                    if (this.loops.at(-1)?.pc !== this.pc - 1)
                        this.loops.push({ label: macro.label, pc: this.pc - 1 });
                    return true;
                }
                if (this.loops.at(-1)?.pc === this.pc - 1) this.loops.pop();
                // Skip past the matching ENDm.
                for (let pc = this.pc; pc < this.lines.length; pc++) {
                    if (!/\bEND\s*\d/i.test(this.lines[pc])) continue;
                    const candidate = this.blockAt(pc).macro;
                    if (candidate?.kind === "end" && candidate.label === macro.label) {
                        this.pc = pc + 1;
                        return true;
                    }
                }
                this.report(block.line, "error", `WHILE … DO${macro.label} has no END${macro.label}`);
                this.ended = true;
                return true;
            }
            case "end": {
                const loop = this.loops.at(-1);
                if (loop !== undefined && loop.label === macro.label) this.pc = loop.pc;
                return false;
            }
        }
    }

    private gotoSequence(number: number): void {
        const pc = this.findSequence(number);
        if (pc === undefined) {
            this.report(this.line, "error", `GOTO ${number}: there is no block N${number}`);
            this.ended = true;
            return;
        }
        this.pc = pc;
    }

    private findSequence(number: number): number | undefined {
        if (this.sequenceIndex === undefined) {
            this.sequenceIndex = new Map();
            this.lines.forEach((text, pc) => {
                const match = /^\s*\/?\s*N\s*(\d+)/i.exec(text);
                if (match !== null && !this.sequenceIndex!.has(Number(match[1])))
                    this.sequenceIndex!.set(Number(match[1]), pc);
            });
        }
        return this.sequenceIndex.get(Math.round(number));
    }

    private findProgram(number: string): number | undefined {
        if (this.programStarts === undefined) {
            this.programStarts = new Map();
            this.lines.forEach((text, pc) => {
                const match = /^\s*(?:O|:)\s*(\d+)\b/i.exec(text);
                if (match === null) return;
                if (
                    /^\s*O\s*\d+\s+(sub|endsub|call|do|while|endwhile|if|elseif|else|endif|repeat|endrepeat|return|break|continue)\b/i.test(
                        text,
                    )
                )
                    return;
                const key = String(Number(match[1]));
                if (!this.programStarts!.has(key)) this.programStarts!.set(key, pc);
            });
        }
        return this.programStarts.get(String(Number(number)));
    }

    private callProgram(kind: CallFrame["kind"], startPc: number, repeats: number, scoped: boolean): void {
        if (this.calls.length > 64) {
            this.report(this.line, "error", "Subprograms nest more than 64 deep");
            this.ended = true;
            return;
        }
        this.calls.push({ returnPc: this.pc, startPc, repeats: Math.max(1, repeats), kind, scoped });
        if (scoped) this.locals.push(new Map());
        this.pc = startPc;
    }

    private returnFromProgram(sequence?: number): void {
        const frame = this.calls.at(-1);
        if (frame === undefined) {
            if (sequence !== undefined) {
                this.gotoSequence(sequence);
                return;
            }
            // M99 in a main program repeats it forever on a control; a preview ends here.
            this.report(this.line, "info", "M99 in the main program: it would repeat; the preview ends here");
            this.ended = true;
            return;
        }
        if (frame.repeats > 1) {
            frame.repeats--;
            this.pc = frame.startPc;
            return;
        }
        this.calls.pop();
        if (frame.scoped) this.locals.pop();
        this.pc = frame.returnPc;
        if (sequence !== undefined) this.gotoSequence(sequence);
    }

    // ------------------------------------------------------------------ O-words (LinuxCNC)

    private owordLines(label: string): { pc: number; keyword: string }[] {
        if (this.owordIndex === undefined) {
            this.owordIndex = new Map();
            this.lines.forEach((text, pc) => {
                if (!/^\s*\/?\s*(N\d+\s*)?o/i.test(text)) return;
                const block = this.blockAt(pc);
                if (block.oword === undefined) return;
                const list = this.owordIndex!.get(block.oword.label) ?? [];
                list.push({ pc, keyword: block.oword.keyword });
                this.owordIndex!.set(block.oword.label, list);
            });
        }
        return this.owordIndex.get(label) ?? [];
    }

    private nextOword(label: string, after: number, keywords: readonly string[]): number | undefined {
        return this.owordLines(label).find((entry) => entry.pc > after && keywords.includes(entry.keyword))
            ?.pc;
    }

    private executeOword(block: NcBlock): void {
        const { label, keyword, args } = block.oword!;
        const here = this.pc - 1;
        const condition = () => {
            const value = args[0] === undefined ? Number.NaN : this.expression(args[0]);
            return value !== 0 && !Number.isNaN(value);
        };
        switch (keyword) {
            case "SUB": {
                // A definition: skip it when reached in sequence.
                const end = this.nextOword(label, here, ["ENDSUB"]);
                if (end === undefined) {
                    this.report(block.line, "error", `o${label} sub has no endsub`);
                    this.ended = true;
                    return;
                }
                this.pc = end + 1;
                return;
            }
            case "ENDSUB":
            case "RETURN": {
                while (this.owords.length > 0 && this.calls.at(-1)?.label === label) {
                    const top = this.owords.at(-1)!;
                    if (top.startPc < (this.calls.at(-1)?.startPc ?? 0)) break;
                    this.owords.pop();
                }
                if (args[0] !== undefined) this.globals.set("_value", this.expression(args[0]));
                if (this.calls.at(-1)?.kind === "oword") this.returnFromProgram();
                return;
            }
            case "CALL": {
                const start = this.owordLines(label).find((entry) => entry.keyword === "SUB")?.pc;
                if (start === undefined) {
                    this.report(
                        block.line,
                        "error",
                        `o${label} call: there is no o${label} sub in this file`,
                    );
                    return;
                }
                const values = args.map((arg) => this.expression(arg));
                this.calls.push({
                    returnPc: this.pc,
                    startPc: start + 1,
                    repeats: 1,
                    kind: "oword",
                    label,
                    scoped: true,
                });
                const locals = new Map<number | string, number>();
                values.forEach((value, index) => {
                    locals.set(index + 1, value);
                });
                this.locals.push(locals);
                this.pc = start + 1;
                return;
            }
            case "IF": {
                if (condition()) {
                    this.owords.push({ label, keyword: "if", startPc: here, done: true });
                    return;
                }
                this.owords.push({ label, keyword: "if", startPc: here, done: false });
                const next = this.nextOword(label, here, ["ELSEIF", "ELSE", "ENDIF"]);
                if (next === undefined) {
                    this.report(block.line, "error", `o${label} if has no endif`);
                    this.ended = true;
                    return;
                }
                this.pc = next;
                return;
            }
            case "ELSEIF":
            case "ELSE": {
                const frame = this.owords.at(-1);
                if (frame === undefined || frame.label !== label) {
                    this.report(block.line, "error", `o${label} ${keyword.toLowerCase()} without if`);
                    return;
                }
                if (frame.done || (keyword === "ELSEIF" && !condition())) {
                    const next = frame.done
                        ? this.nextOword(label, here, ["ENDIF"])
                        : this.nextOword(label, here, ["ELSEIF", "ELSE", "ENDIF"]);
                    if (next !== undefined) this.pc = next;
                    return;
                }
                frame.done = true;
                return;
            }
            case "ENDIF":
                if (this.owords.at(-1)?.label === label) this.owords.pop();
                return;
            case "DO":
                this.owords.push({ label, keyword: "do", startPc: here });
                return;
            case "WHILE": {
                const frame = this.owords.at(-1);
                if (frame?.label === label && frame.keyword === "do") {
                    // The end of a do … while loop.
                    if (condition()) this.pc = frame.startPc + 1;
                    else this.owords.pop();
                    return;
                }
                if (condition()) {
                    if (frame?.label !== label || frame.startPc !== here)
                        this.owords.push({ label, keyword: "while", startPc: here });
                    return;
                }
                if (frame?.label === label && frame.startPc === here) this.owords.pop();
                const end = this.nextOword(label, here, ["ENDWHILE"]);
                if (end === undefined) {
                    this.report(block.line, "error", `o${label} while has no endwhile`);
                    this.ended = true;
                    return;
                }
                this.pc = end + 1;
                return;
            }
            case "ENDWHILE": {
                const frame = this.owords.at(-1);
                if (frame?.label === label) this.pc = frame.startPc;
                return;
            }
            case "REPEAT": {
                const count = args[0] === undefined ? 0 : Math.round(this.expression(args[0]));
                if (count <= 0) {
                    const end = this.nextOword(label, here, ["ENDREPEAT"]);
                    if (end !== undefined) this.pc = end + 1;
                    return;
                }
                this.owords.push({ label, keyword: "repeat", startPc: here, remaining: count });
                return;
            }
            case "ENDREPEAT": {
                const frame = this.owords.at(-1);
                if (frame?.label !== label) return;
                frame.remaining = (frame.remaining ?? 1) - 1;
                if (frame.remaining > 0) this.pc = frame.startPc + 1;
                else this.owords.pop();
                return;
            }
            case "BREAK":
            case "CONTINUE": {
                const index = this.owords.map((frame) => frame.label).lastIndexOf(label);
                if (index < 0) return;
                const frame = this.owords[index];
                this.owords.length = index + (keyword === "CONTINUE" ? 1 : 0);
                if (keyword === "CONTINUE") {
                    this.pc =
                        frame.keyword === "repeat" || frame.keyword === "do"
                            ? frame.startPc + 1
                            : frame.startPc;
                    if (frame.keyword === "repeat") {
                        frame.remaining = (frame.remaining ?? 1) - 1;
                        if (frame.remaining <= 0) {
                            this.owords.pop();
                            const end = this.nextOword(label, here, ["ENDREPEAT"]);
                            if (end !== undefined) this.pc = end + 1;
                        }
                    }
                    return;
                }
                const ends = { while: ["ENDWHILE"], repeat: ["ENDREPEAT"], do: ["WHILE"], if: ["ENDIF"] }[
                    frame.keyword
                ];
                const end = this.nextOword(label, here, ends);
                if (end !== undefined) this.pc = end + 1;
                return;
            }
            default:
                this.report(block.line, "warning", `o-word ${keyword.toLowerCase()} is not supported`);
        }
    }

    // ------------------------------------------------------------------ Words

    private evaluateWords(block: NcBlock): Words {
        const words = new Map() as Words;
        words.g = [];
        words.m = [];
        for (const word of block.words) {
            const value = this.value(word);
            if (word.letter === "G") {
                words.g.push(Math.round(value * 10));
                continue;
            }
            if (word.letter === "M") {
                words.m.push(Math.round(value * 10));
                continue;
            }
            if (words.has(word.letter)) {
                this.report(
                    block.line,
                    "warning",
                    `${word.letter} appears twice in one block; the last one counts`,
                );
            }
            words.set(word.letter, { word, value });
        }
        return words;
    }

    private executeWords(block: NcBlock, words: Words): void {
        const g = new Set(words.g);
        const m = new Set(words.m);
        const has = (letter: string) => words.has(letter);
        const num = (letter: string) => words.get(letter)?.value;
        if (this.dialect.family === "printer") {
            this.printerWords(block, words, g, m);
            return;
        }

        // Named values and keywords (Siemens).
        const named: NamedValues = new Map();
        for (const entry of block.named) {
            const fn = entry.value?.k === "fn" ? entry.value.name : undefined;
            const mode = fn === "IC" ? "ic" : fn === "AC" ? "ac" : undefined;
            named.set(entry.name, {
                value: entry.value === undefined ? undefined : this.expression(entry.value),
                text: entry.text,
                ...(mode === undefined ? {} : { mode }),
            });
        }
        this.executeKeywords(block, named);

        // Unknown codes first, so they are reported once whatever else the block does.
        for (const code of g) this.checkG(code);
        for (const code of m) this.checkM(code);
        if (has(",R") || has(",C")) {
            this.report(block.line, "warning", "Corner rounding / chamfer words (,R ,C) are not drawn");
        }

        // 1. Feed rate mode, feed.
        if (g.has(930)) this.feedMode = "inverse";
        if (g.has(940)) this.feedMode = "minute";
        if (g.has(950)) this.feedMode = "revolution";
        const isDwell = g.has(40);
        if (has("F") && !(isDwell && this.dialect.dwell === "siemens")) {
            const f = num("F")!;
            if (this.feedMode === "inverse") this.inverseFeed = f;
            else {
                this.feed = f * this.scale();
                this.feedPerRev = this.feedMode === "revolution";
            }
        }
        // 2. Spindle speed (a laser's power).
        if (has("S") && !(isDwell && this.dialect.dwell === "siemens")) {
            this.rpm = num("S")!;
            if (this.spindleOn) this.noteSpindle();
        }
        // 3. Tool select, 4. tool change.
        if (has("T")) this.pendingTool = Math.round(num("T")!);
        if (m.has(60)) {
            if (this.pendingTool === undefined) {
                this.report(block.line, "warning", "M6 without a T word: the tool stays");
            } else {
                this.toolChange(this.pendingTool, block.line);
            }
        }
        if (m.has(610) && has("Q")) this.toolChange(Math.round(num("Q")!), block.line);
        // 5. Spindle / beam, 6. coolant.
        this.spindleCodes(m, block.line);
        for (const code of m) {
            if (code % 10 !== 0) continue;
            const coolant = this.dialect.coolantOn[code / 10];
            if (coolant !== undefined) this.setCoolant(coolant);
            else if (this.dialect.coolantOff.includes(code / 10)) this.setCoolant("off");
        }
        // 7. Dwell (its X/P/F words are times, not positions).
        if (isDwell) {
            this.dwell(words, block.line);
            this.afterMotion(m, block.line);
            return;
        }
        // 8. Plane, units, compensation, length offsets.
        if (g.has(170)) this.plane = "XY";
        if (g.has(180)) this.plane = "ZX";
        if (g.has(190)) this.plane = "YZ";
        if (g.has(200) || (this.dialect.siemensUnits && (g.has(700) || g.has(7000)))) this.setUnits(true);
        if (g.has(210) || (this.dialect.siemensUnits && (g.has(710) || g.has(7100)))) this.setUnits(false);
        if (!this.dialect.siemensUnits && (g.has(700) || g.has(710)))
            this.report(block.line, "warning", "G70/G71 are lathe cycles here (not supported)");
        if (g.has(410) || g.has(420)) {
            this.report(
                block.line,
                "warning",
                "Cutter compensation (G41/G42) is not applied: the backplot shows the programmed path",
            );
        }
        if (g.has(434) || g.has(435) || g.has(2340)) this.setTcp(true);
        if (g.has(490)) this.setTcp(false);
        // 9. Coordinate systems.
        this.workOffsetCodes(g, words, block.line);
        // 10. Distance modes, retract mode.
        if (g.has(900)) this.absolute = true;
        if (g.has(910)) this.absolute = false;
        if (g.has(901)) this.arcAbsolute = true;
        if (g.has(911)) this.arcAbsolute = false;
        if (g.has(980)) this.retractToR = false;
        if (g.has(990)) this.retractToR = true;
        // Tilted planes and DWO.
        if (g.has(682)) this.tiltedPlane(words, block.line);
        else if (g.has(680)) this.rotation2d(words, block.line);
        if (g.has(531) || g.has(536)) this.orientTool(block.line);
        if (g.has(690)) this.setTilt(undefined);
        if (g.has(2540)) this.setDwo(true);
        if (g.has(2550)) this.setDwo(false);
        // Motion modes are modal even in a block that is busy with something else.
        this.motionModes(g, block.line);
        // 11. Non-modal: offsets, reference returns, machine coordinates (their axis words are theirs).
        if (g.has(100)) {
            this.g10(words, block.line);
            this.afterMotion(m, block.line);
            return;
        }
        if (g.has(920) || g.has(520)) {
            if (g.has(920)) this.g92Command(words);
            else this.withFrameChange(() => (this.g52 = this.axisValues(words, this.g52)));
            this.afterMotion(m, block.line);
            return;
        }
        if (g.has(921) || g.has(922)) this.withFrameChange(() => (this.g92 = [0, 0, 0]));
        if (g.has(280) || g.has(300)) {
            this.referenceReturn(words, block.line);
            this.afterMotion(m, block.line);
            return;
        }
        if (g.has(530) || block.keywords.includes("SUPA")) {
            this.machineMove(words, block.line);
            this.afterMotion(m, block.line);
            return;
        }
        if (g.has(650)) {
            this.macroCall(words, block.line);
            return;
        }
        // 12. Motion.
        const axisWords = ["X", "Y", "Z", "A", "B", "C", "U", "V", "W"].some((letter) => has(letter));
        const siemensAxes = ["X", "Y", "Z", "A3", "B3", "C3"].some((name) => named.has(name));
        if (g.has(331)) this.rigidTap(words, block.line);
        else if (axisWords || siemensAxes || (this.motion === "cycle" && has("R"))) {
            this.motionBlock(block, words, named);
        } else if ((this.motion === "G2" || this.motion === "G3") && (has("I") || has("J") || has("K"))) {
            // A full circle with only centre words.
            this.motionBlock(block, words, named);
        }
        this.afterMotion(m, block.line);
    }

    /** The motion group (G0–G3, splines, threading, probing, drilling cycles, G80). */
    private motionModes(g: Set<number>, line: number): void {
        if (g.has(800)) {
            this.cycle = undefined;
            this.cycleCode = undefined;
            if (this.motion === "cycle") this.motion = undefined;
        }
        for (const [code, motion] of [
            [0, "G0"],
            [10, "G1"],
            [20, "G2"],
            [30, "G3"],
            [50, "G5"],
            [51, "G5.1"],
        ] as const) {
            if (g.has(code)) {
                this.motion = motion;
                this.cycle = undefined;
                this.cycleCode = undefined;
            }
        }
        if (g.has(52)) this.report(line, "error", "G5.2 NURBS are not supported");
        if (g.has(330) || g.has(331) || g.has(760)) this.motion = "G33";
        if ([382, 383, 384, 385].some((code) => g.has(code))) this.motion = "G38";
        for (const code of [73, 74, 76, 81, 82, 83, 84, 85, 86, 87, 88, 89] as const) {
            if (g.has(code * 10)) {
                if (this.motion !== "cycle") this.cycle = undefined;
                this.cycleCode = code;
                this.motion = "cycle";
            }
        }
    }

    /** Printer firmware: moves with extrusion, extrusion modes, homing, dwell, extruder changes. */
    private printerWords(block: NcBlock, words: Words, g: Set<number>, m: Set<number>): void {
        if (m.has(820)) this.absoluteE = true;
        if (m.has(830)) this.absoluteE = false;
        if (words.has("T") && m.size === 0 && g.size === 0) {
            this.toolChange(Math.round(words.get("T")!.value), block.line);
        }
        if (g.size === 0) {
            this.afterMotion(m, block.line);
            return;
        }
        if (words.has("F") && !g.has(40)) this.feed = words.get("F")!.value * this.scale();
        if (g.has(40)) {
            this.dwell(words, block.line);
            return;
        }
        if (g.has(200)) this.setUnits(true);
        if (g.has(210)) this.setUnits(false);
        if (g.has(900)) this.absolute = true;
        if (g.has(910)) this.absolute = false;
        if (g.has(920)) {
            this.g92Command(words);
            return;
        }
        if (g.has(280)) {
            this.referenceReturn(words, block.line);
            return;
        }
        for (const [code, motion] of [
            [0, "G0"],
            [10, "G1"],
            [20, "G2"],
            [30, "G3"],
        ] as const) {
            if (g.has(code)) this.motion = motion;
        }
        if ([0, 10, 20, 30].some((code) => g.has(code))) this.motionBlock(block, words, new Map());
        this.afterMotion(m, block.line);
    }

    private inverseFeed = 0;
    private feedPerRev = false;

    /** Program stops and ends, after the block's motion. */
    private afterMotion(m: Set<number>, line: number): void {
        const printer = this.dialect.family === "printer";
        if (m.has(0) || m.has(10)) {
            if (this.manualTool !== undefined && this.dialect.manualToolChange) {
                this.toolChange(this.manualTool, line);
                this.manualTool = undefined;
            } else {
                this.emit({ kind: "dwell", seconds: 0 });
            }
        }
        if (m.has(600) && this.dialect.family === "mill") this.emit({ kind: "dwell", seconds: 0 });
        if (!printer && (m.has(20) || m.has(300))) {
            if (this.calls.length > 0 && this.calls.at(-1)!.kind !== "oword") {
                this.report(line, "warning", "M2/M30 inside a subprogram ends the whole program");
            }
            this.ended = true;
        }
        if (m.has(980) && !printer) this.subprogramCall(line);
        if (m.has(970) && !printer) this.localSubprogramCall(line);
        if (m.has(990) && !printer) {
            const p = this.wordNumber("P");
            this.returnFromProgram(p === undefined ? undefined : Math.round(p));
        }
    }

    /** The current block's word value (for codes processed after the word map is gone). */
    private wordNumber(letter: string): number | undefined {
        const block = this.blockAt(this.line - 1);
        const word = block.words.find((candidate) => candidate.letter === letter);
        return word === undefined ? undefined : this.value(word);
    }

    private subprogramCall(line: number): void {
        const p = this.wordNumber("P");
        if (p === undefined) {
            this.report(line, "error", "M98 needs P (the program number)");
            return;
        }
        let program = String(Math.round(p));
        let repeats = Math.round(this.wordNumber("L") ?? this.wordNumber("K") ?? 1);
        let start = this.findProgram(program);
        if (start === undefined && program.length > 4) {
            // Fanuc 0i: P<count><4-digit program>.
            repeats = Number(program.slice(0, -4));
            program = program.slice(-4);
            start = this.findProgram(program);
        }
        if (start === undefined) {
            this.report(line, "error", `M98 P${program}: program O${program} is not in this file`);
            return;
        }
        this.callProgram("program", start + 1, repeats, false);
    }

    private localSubprogramCall(line: number): void {
        const p = this.wordNumber("P");
        const start = p === undefined ? undefined : this.findSequence(p);
        if (start === undefined) {
            this.report(line, "error", `M97 P${p ?? ""}: there is no block N${p ?? ""}`);
            return;
        }
        this.callProgram("local", start, Math.round(this.wordNumber("L") ?? 1), false);
    }

    private macroCall(words: Words, line: number): void {
        const p = words.get("P")?.value;
        const start = p === undefined ? undefined : this.findProgram(String(Math.round(p)));
        if (start === undefined) {
            this.report(line, "error", `G65 P${p ?? ""}: the macro is not in this file`);
            return;
        }
        const locals = new Map<number | string, number>();
        for (const [letter, { value }] of words) {
            const index = FANUC_ARGUMENTS[letter];
            if (index !== undefined && letter !== "P" && letter !== "L") locals.set(index, value);
        }
        this.calls.push({
            returnPc: this.pc,
            startPc: start + 1,
            repeats: Math.max(1, Math.round(words.get("L")?.value ?? 1)),
            kind: "macro",
            scoped: true,
        });
        this.locals.push(locals);
        this.pc = start + 1;
    }

    private checkG(code: number): void {
        const known = new Set([
            0, 10, 20, 30, 40, 50, 51, 52, 90, 100, 170, 180, 190, 200, 210, 280, 281, 300, 301, 330, 331,
            382, 383, 384, 385, 400, 410, 420, 430, 431, 434, 435, 440, 490, 520, 530, 531, 536, 540, 541,
            550, 560, 570, 580, 590, 591, 592, 593, 610, 611, 640, 680, 682, 690, 700, 710, 730, 740, 760,
            800, 810, 820, 830, 840, 850, 860, 870, 880, 890, 900, 901, 910, 911, 920, 921, 922, 923, 930,
            940, 950, 960, 970, 980, 990, 1540, 2340, 2540, 2550, 650, 1870, 1030, 7000, 7100, 6420, 6410,
            6010, 6020,
        ]);
        if (code >= 1100 && code <= 1290) return; // Haas G110–G129 work offsets
        if (this.dialect.family === "printer") {
            // Printers: G28/G29/G80 (mesh levelling), G10/G11 (retraction) … do not move the path.
            if (![0, 10, 20, 30, 40, 200, 210, 280, 900, 910, 920].includes(code)) return;
        }
        if (!known.has(code)) {
            const text = code % 10 === 0 ? `G${code / 10}` : `G${(code / 10).toFixed(1)}`;
            this.report(this.line, "warning", `${text} is not supported`);
        }
    }

    private checkM(code: number): void {
        const family = this.dialect.family;
        if (family === "printer") return;
        const base = code / 10;
        const handled = [0, 1, 2, 3, 4, 5, 6, 30, 60, 61, 97, 98, 99];
        if (handled.includes(base)) return;
        if (this.dialect.coolantOn[base] !== undefined || this.dialect.coolantOff.includes(base)) return;
        if (this.dialect.beamOn?.includes(base) || this.dialect.beamOff?.includes(base)) return;
        if (this.dialect.passive?.includes(base)) return;
        if (family === "mill" && PASSIVE_MILL_M.has(base)) return;
        const text = code % 10 === 0 ? `M${base}` : `M${base.toFixed(1)}`;
        this.report(this.line, "info", `${text} does not change the path (ignored)`);
    }

    private executeKeywords(block: NcBlock, named: NamedValues): void {
        const family = this.dialect.family;
        for (const keyword of block.keywords) {
            if (family === "printer") continue; // extended commands (Klipper macros) do not move
            if (this.dialect.id === "siemens" || SIEMENS_KEYWORDS.has(keyword)) {
                switch (keyword) {
                    case "TRAORI":
                        this.setTcp(true);
                        continue;
                    case "TRAFOOF":
                        this.setTcp(false);
                        continue;
                    case "ORIAXES":
                        this.orientation = "axes";
                        continue;
                    case "ORIVECT":
                    case "ORIWKS":
                        if (keyword === "ORIVECT") this.orientation = "vector";
                        continue;
                    case "SUPA":
                    case "ORIMKS":
                        continue;
                    default:
                        if (SIEMENS_KEYWORDS.has(keyword)) continue;
                }
            }
            this.report(block.line, "warning", `${keyword} is not supported`);
        }
        for (const call of block.calls) {
            if (call.name === "MSG") continue;
            if (call.name === "CYCLE800") {
                this.cycle800(call.args, block.line);
                continue;
            }
            if (family === "printer") continue;
            this.report(block.line, "warning", `${call.name}(…) is not supported`);
        }
        for (const [name] of named) {
            if (family === "printer") continue;
            if (["CR", "A3", "B3", "C3", "X", "Y", "Z", "I", "J", "K", "AR"].includes(name)) continue;
            if (/^R\d+$/.test(name)) {
                this.report(block.line, "warning", "Siemens R parameters are not supported");
                continue;
            }
            this.report(block.line, "warning", `${name}= is not supported`);
        }
    }

    // ------------------------------------------------------------------ Modes

    private scale(): number {
        return this.inch ? MM_PER_INCH : 1;
    }

    private setUnits(inch: boolean): void {
        this.inch = inch;
        this.unitsSeen ??= inch ? "inch" : "mm";
    }

    private noteSpindle(): void {
        const path = this.current;
        if (path !== undefined && path.spindleRpm === undefined && this.rpm > 0) path.spindleRpm = this.rpm;
        if (this.rpm > 0) {
            this.spindle = {
                min: Math.min(this.spindle?.min ?? this.rpm, this.rpm),
                max: Math.max(this.spindle?.max ?? this.rpm, this.rpm),
            };
        }
    }

    private spindle: { min: number; max: number } | undefined;

    private spindleCodes(m: Set<number>, line: number): void {
        const beamOn = this.dialect.beamOn ?? [];
        const beamOff = this.dialect.beamOff ?? [];
        if (this.dialect.family === "printer") return;
        if (this.dialect.family === "cutting" || this.dialect.family === "wire") {
            for (const code of m) {
                if (code % 10 !== 0) continue;
                if (beamOn.includes(code / 10)) this.cutterOn();
                else if (beamOff.includes(code / 10)) this.cutterOff();
            }
            if (this.dialect.id === "laser" && (m.has(30) || m.has(40))) {
                this.spindleOn = true;
                this.noteSpindle();
            }
            return;
        }
        if (m.has(30) || m.has(40)) {
            this.spindleOn = true;
            this.noteSpindle();
            if (this.rpm <= 0) this.report(line, "info", "The spindle starts without a speed (S)");
        }
        if (m.has(50)) this.spindleOn = false;
    }

    private cutterOn(): void {
        if (this.beamOn) return;
        this.beamOn = true;
        const index = this.emit({ kind: "cutterOn" });
        this.lastBeamOn = { toolpath: this.current!, index };
    }

    private cutterOff(): void {
        if (!this.beamOn) return;
        this.beamOn = false;
        this.lastBeamOn = undefined;
        this.emit({ kind: "cutterOff" });
    }

    private setCoolant(coolant: NcCoolant | "off"): void {
        this.coolant = coolant;
        // The toolpath's coolant is the last one switched on before it cuts.
        const path = this.current;
        const cutting = path?.moves.some((move) => move.kind !== "comment" && move.kind !== "rapid") ?? false;
        if (path !== undefined && coolant !== "off" && (path.coolant === undefined || !cutting))
            path.coolant = coolant;
    }

    private toolChange(number: number, line: number): void {
        if (this.current?.moves.some((move) => move.kind !== "comment")) {
            this.finishToolpath();
        }
        const first = this.toolpaths.length === 0 && this.current === undefined;
        // The comment right before a tool change names the toolpath (a post's operation label).
        const label = this.pendingComments.pop();
        // Comments before the first tool are the program's header (name, tool list).
        if (first) this.pendingComments = [];
        this.toolNumber = number;
        this.pendingTool = undefined;
        // A mill's tool change stops the spindle; the new tool's speed comes with its M3.
        if (this.dialect.family === "mill") this.spindleOn = false;
        if (this.current === undefined) this.startToolpath();
        const path = this.current!;
        path.toolNumber = number;
        if (label !== undefined) path.label = label.text;
        this.flushComments();
        if (this.tcp) this.report(line, "warning", "A tool change with tool centre point control on");
    }

    private setTcp(on: boolean): void {
        if (on && this.kinematics === undefined && !this.reportedNoKinematics) {
            this.reportedNoKinematics = true;
            this.report(
                this.line,
                "warning",
                "Tool centre point control without a machine profile: rotary words do not tilt the tool",
            );
        }
        this.withFrameChange(() => {
            this.tcp = on;
        });
    }

    private reportedNoKinematics = false;

    private setDwo(on: boolean): void {
        this.withFrameChange(() => {
            this.dwo = on;
        });
    }

    private setTilt(tilt: TiltFrame | undefined): void {
        this.withFrameChange(() => {
            this.tilt = tilt;
        });
    }

    private tiltedPlane(words: Words, line: number): void {
        const v = (letter: string) => words.get(letter)?.value ?? 0;
        const s = this.scale();
        const p = (words.get("P")?.value ?? 0) | 0;
        if (p !== 0) {
            this.report(
                line,
                "warning",
                `G68.2 P${p} (other angle conventions) is not supported; Euler Z-X-Z assumed`,
            );
        }
        const frame = frameFromEulerZXZ(v("I"), v("J"), v("K"));
        this.setTilt({ origin: [v("X") * s, v("Y") * s, v("Z") * s], frame, oriented: false });
    }

    private rotation2d(words: Words, line: number): void {
        const v = (letter: string) => words.get(letter)?.value;
        const s = this.scale();
        const r = v("R") ?? 0;
        if (v("I") !== undefined || v("J") !== undefined || v("K") !== undefined) {
            const axis: Vec3 = [v("I") ?? 0, v("J") ?? 0, v("K") ?? 0];
            this.setTilt({
                origin: [(v("X") ?? 0) * s, (v("Y") ?? 0) * s, (v("Z") ?? 0) * s],
                frame: rotation(axis, r),
                oriented: true,
            });
            return;
        }
        if (this.plane !== "XY")
            this.report(line, "warning", "G68 outside G17 is not supported; rotated about Z");
        this.setTilt({
            origin: [(v("X") ?? 0) * s, (v("Y") ?? 0) * s, 0],
            frame: rotation(Z_AXIS, r),
            oriented: true,
        });
    }

    private orientTool(line: number): void {
        if (this.tilt === undefined) {
            this.report(line, "warning", "G53.1 without a tilted plane (G68.2)");
            return;
        }
        const tilt = this.tilt;
        this.withFrameChange(() => {
            this.tilt = { ...tilt, oriented: true };
        });
    }

    private cycle800(args: string, line: number): void {
        if (args.trim() === "") {
            this.setTilt(undefined);
            return;
        }
        const values = callArguments(args);
        const mode = values[3];
        if (mode !== 57) {
            this.report(
                line,
                "warning",
                `CYCLE800 mode ${mode} is not supported; axis by axis X-Y-Z assumed`,
            );
        }
        const s = this.scale();
        const origin: Vec3 = [(values[4] || 0) * s, (values[5] || 0) * s, (values[6] || 0) * s];
        const frame = frameFromAxisByAxisXYZ(values[7] || 0, values[8] || 0, values[9] || 0);
        const after: Vec3 = [(values[10] || 0) * s, (values[11] || 0) * s, (values[12] || 0) * s];
        this.setTilt({ origin: add(origin, mulMV(frame, after)), frame, oriented: true });
    }

    // ------------------------------------------------------------------ Work offsets

    private offsetKey(g: Set<number>, words: Words): string | undefined {
        for (let index = 0; index < 6; index++) if (g.has(540 + index * 10)) return `G${54 + index}`;
        for (const sub of [1, 2, 3]) if (g.has(590 + sub)) return `G59.${sub}`;
        const p = words.get("P")?.value;
        if (g.has(541)) return `G54.1 P${Math.round(p ?? 1)}`;
        if (g.has(1540)) return `G54.1 P${Math.round(p ?? 1)}`;
        for (const code of g) {
            if (code >= 1100 && code <= 1290 && code % 10 === 0) return `G54.1 P${(code - 1090) / 10}`;
        }
        return undefined;
    }

    private frameOffset(): Vec3 {
        const offset = this.offsets.get(this.activeOffset) ?? [0, 0, 0];
        return add(add(offset, this.g92), this.g52);
    }

    /**
     * Applies a change of the coordinate system; the tool stays where it is. Before the first
     * motion the reported frame is still the program's own, so the position is re-expressed
     * in the new system (a G92 at the start declares where the tool is).
     */
    private withFrameChange(change: () => void): void {
        if (this.base === undefined) {
            const machine = add(this.position, this.frameOffset());
            change();
            this.position = sub(machine, this.frameOffset());
            return;
        }
        change();
    }

    private workOffsetCodes(g: Set<number>, words: Words, line: number): void {
        if (g.has(100)) return; // G10 L2 P… names an offset, it does not select it
        const key = this.offsetKey(g, words);
        if (key === undefined || key === this.activeOffset) return;
        if (this.base !== undefined && !this.offsets.has(key) && !this.unknownOffsetReported.has(key)) {
            this.unknownOffsetReported.add(key);
            this.report(
                line,
                "info",
                `${key}: its origin is unknown here; drawn on the first work offset's origin`,
            );
        }
        this.withFrameChange(() => {
            this.activeOffset = key;
        });
    }

    private g10(words: Words, line: number): void {
        const l = Math.round(words.get("L")?.value ?? -1);
        const p = Math.round(words.get("P")?.value ?? 0);
        if (l !== 2 && l !== 20) {
            this.report(line, "info", `G10 L${l} (tool or other tables) does not change the path`);
            return;
        }
        let key: string;
        if (l === 20 && this.dialect.id !== "linuxcnc") key = `G54.1 P${p}`;
        else if (p === 0) key = this.activeOffset;
        else if (p <= 6) key = `G${53 + p}`;
        else if (p <= 9) key = `G59.${p - 6}`;
        else {
            this.report(line, "warning", `G10 L${l} P${p} is not supported`);
            return;
        }
        const s = this.scale();
        const current = this.offsets.get(key) ?? [0, 0, 0];
        const next: [number, number, number] = [current[0], current[1], current[2]];
        const linuxL20 = l === 20 && this.dialect.id === "linuxcnc";
        const program = linuxL20 ? this.toProgram(this.position) : undefined;
        (["X", "Y", "Z"] as const).forEach((letter, axis) => {
            const value = words.get(letter)?.value;
            if (value === undefined) return;
            if (linuxL20) {
                // Set so that the current position reads `value`.
                const machine = program![axis] + this.frameOffset()[axis];
                next[axis] = machine - value * s - this.g92[axis] - this.g52[axis];
            } else {
                next[axis] = value * s;
            }
        });
        const apply = () => this.offsets.set(key, next);
        if (key === this.activeOffset) this.withFrameChange(apply);
        else apply();
    }

    private g92Command(words: Words): void {
        const printer = this.dialect.family === "printer";
        if (printer && words.has("E")) this.eValue = words.get("E")!.value;
        if (this.dialect.family === "wire") {
            // G92 … U0 V0 declares the guides' offset too.
            const s = this.scale();
            if (words.has("U")) this.uv[0] = words.get("U")!.value * s;
            if (words.has("V")) this.uv[1] = words.get("V")!.value * s;
        }
        const letters = (["X", "Y", "Z"] as const).filter((letter) => words.has(letter));
        if (letters.length === 0) {
            if (!printer && !words.has("E") && !words.has("U") && !words.has("V"))
                this.withFrameChange(() => (this.g92 = [0, 0, 0]));
            return;
        }
        const s = this.scale();
        const program = this.toProgram(this.position);
        const next: [number, number, number] = [this.g92[0], this.g92[1], this.g92[2]];
        for (const letter of letters) {
            const axis = { X: 0, Y: 1, Z: 2 }[letter];
            next[axis] += program[axis] - words.get(letter)!.value * s;
        }
        if (letters.includes("Z")) this.zState = "programmed";
        this.positionKnown ||= letters.length === 3 || this.dialect.family !== "mill";
        this.withFrameChange(() => (this.g92 = next));
        if (this.dialect.family === "wire" && letters.includes("X") && letters.includes("Y")) {
            // The wire's start hole: the operator has the wire here.
            this.positionKnown = true;
        }
    }

    private axisValues(words: Words, current: Vec3): Vec3 {
        const s = this.scale();
        return [
            (words.get("X")?.value ?? current[0] / s) * s,
            (words.get("Y")?.value ?? current[1] / s) * s,
            (words.get("Z")?.value ?? current[2] / s) * s,
        ];
    }

    // ------------------------------------------------------------------ Coordinates

    /** The tool's orientation from the rotary positions and modes (WCS), or undefined (+Z). */
    private toolAxis(): Vec3 | undefined {
        if (this.tilt?.oriented) {
            const z: Vec3 = [this.tilt.frame[0][2], this.tilt.frame[1][2], this.tilt.frame[2][2]];
            return isVertical(z) ? undefined : z;
        }
        if (this.orientation === "vector" && this.vector !== undefined) {
            return isVertical(this.vector) ? undefined : this.vector;
        }
        if (this.kinematics === undefined) return undefined;
        const axis = this.kinematics.toolAxis(this.jointAngles());
        const clean: Vec3 = [
            Math.abs(axis[0]) < 1e-12 ? 0 : axis[0],
            Math.abs(axis[1]) < 1e-12 ? 0 : axis[1],
            Math.abs(axis[2]) < 1e-12 ? 0 : axis[2],
        ];
        return isVertical(clean) ? undefined : clean;
    }

    private jointAngles(): number[] {
        return this.kinematics!.joints.map((joint) => this.angles[joint.name] ?? 0);
    }

    /** Machine coordinates of the controlled point (rotaries turned, no TCP, no DWO). */
    private machineCoordinates(): boolean {
        if (this.kinematics === undefined || this.tcp || this.dwo || this.tilt !== undefined) return false;
        return this.jointAngles().some((angle) => Math.abs(angle % 360) > 1e-9);
    }

    private toolLength(): number {
        return this.options.toolLengths?.[this.toolNumber] ?? 0;
    }

    /** Program coordinates (active system) → base (output) coordinates, without the base shift. */
    private toBaseRaw(program: Vec3): Vec3 {
        let point = program;
        if (this.tilt !== undefined) point = add(this.tilt.origin, mulMV(this.tilt.frame, point));
        else if (this.machineCoordinates()) {
            point = this.kinematics!.tipPosition(point, this.jointAngles(), this.toolLength());
        }
        return add(point, this.shift());
    }

    private shift(): Vec3 {
        if (this.base === undefined) return [0, 0, 0];
        return sub(this.frameOffset(), this.base);
    }

    private toProgram(point: Vec3): Vec3 {
        let local = sub(point, this.shift());
        if (this.tilt !== undefined) local = mulMV(transpose(this.tilt.frame), sub(local, this.tilt.origin));
        else if (this.machineCoordinates()) {
            local = this.kinematics!.machinePosition(local, this.jointAngles(), this.toolLength());
        }
        return local;
    }

    /** Whether program → base is a translation only (arcs stay arcs). */
    private translationOnly(): boolean {
        return this.tilt === undefined && !this.machineCoordinates();
    }

    // ------------------------------------------------------------------ Moves

    private startToolpath(): void {
        const path: BuiltToolpath = {
            toolNumber: this.toolNumber,
            moves: [],
            lines: [],
            homeMoves: new Set(),
            ...(this.positionKnown ? { start: this.position } : {}),
        };
        if (this.spindleOn && this.rpm > 0) path.spindleRpm = this.rpm;
        if (this.coolant !== "off") path.coolant = this.coolant;
        this.current = path;
    }

    private finishToolpath(): void {
        const path = this.current;
        if (path === undefined) return;
        this.current = undefined;
        // A run of only reference returns (the safe start before the first tool) is no toolpath.
        const idle = path.moves.every((move, index) => move.kind === "comment" || path.homeMoves.has(index));
        if (idle && (this.toolpaths.length > 0 || path.label === undefined || path.homeMoves.size > 0))
            return;
        this.toolpaths.push(path);
    }

    private emit(move: ToolpathMove, home = false): number {
        if (this.current === undefined) this.startToolpath();
        const path = this.current!;
        path.moves.push(move);
        path.lines.push(this.line);
        if (home) path.homeMoves.add(path.moves.length - 1);
        return path.moves.length - 1;
    }

    /** Called before any motion: fixes the base frame, flushes comments, starts the wire. */
    private beginMotion(): void {
        if (this.base === undefined) this.base = this.frameOffset();
        this.flushComments();
    }

    private trackZ(to: Vec3, home: boolean): void {
        if (home || this.zState !== "programmed") this.homeUsed = true;
        else this.maxProgrammedZ = Math.max(this.maxProgrammedZ, to[2]);
    }

    private moveTo(to: Vec3, kind: "rapid" | "linear", home = false): void {
        this.beginMotion();
        const axis = this.toolAxis();
        const changedAxis = !sameAxis(axis, this.lastAxis);
        // From an unknown start the first move is drawn even when it lands on the assumed position.
        if (same(to, this.position) && !changedAxis && this.positionKnown) return;
        this.trackZ(to, home);
        if (kind === "rapid") {
            const move: ToolpathMove =
                this.dialect.family === "printer"
                    ? { kind: "rapid", to, feed: this.feed }
                    : axis === undefined
                      ? { kind: "rapid", to }
                      : { kind: "rapid", to, axis };
            this.emit(move, home);
        } else {
            const feed = this.feedFor(to);
            this.emit(axis === undefined ? { kind: "linear", to, feed } : { kind: "linear", to, feed, axis });
        }
        this.lastAxis = axis;
        this.position = to;
        this.positionKnown = true;
        this.lastBeamOn = undefined;
    }

    private lastAxis: Vec3 | undefined;

    private feedFor(to: Vec3): number {
        if (this.feedMode === "inverse") {
            const distance = Math.hypot(
                to[0] - this.position[0],
                to[1] - this.position[1],
                to[2] - this.position[2],
            );
            if (this.inverseFeed <= 0) {
                this.report(this.line, "warning", "G93 inverse time feed without F");
                return this.feed;
            }
            const feed = distance * this.inverseFeed;
            if (feed > 0) this.feed = feed;
            return feed > 0 ? feed : this.feed;
        }
        if (this.feedPerRev) {
            if (this.rpm <= 0)
                this.report(this.line, "warning", "G95 feed per revolution without a spindle speed");
            return this.feed * Math.max(0, this.rpm);
        }
        // Wire EDM generators set the cutting speed themselves (feeds are optional there).
        if (this.feed <= 0 && this.dialect.family !== "wire")
            this.report(this.line, "warning", "A feed move before any feed rate (F)");
        return this.feed;
    }

    private dwell(words: Words, line: number): void {
        const p = words.get("P");
        const x = words.get("X")?.value ?? words.get("U")?.value;
        let seconds: number | undefined;
        switch (this.dialect.dwell) {
            case "fanuc":
                seconds = p !== undefined ? p.value / 1000 : x;
                break;
            case "haas":
                seconds = p !== undefined ? (p.word.decimal ? p.value : p.value / 1000) : x;
                break;
            case "seconds":
                seconds = p?.value ?? x;
                break;
            case "siemens": {
                const f = words.get("F")?.value;
                const s = words.get("S")?.value;
                seconds = f ?? (s !== undefined && this.rpm > 0 ? (s / this.rpm) * 60 : undefined);
                break;
            }
            case "printer": {
                const sValue = words.get("S")?.value;
                seconds = sValue ?? (p === undefined ? undefined : p.value / 1000);
                break;
            }
        }
        if (seconds === undefined || !Number.isFinite(seconds)) {
            this.report(line, "warning", "G4 without a time");
            return;
        }
        if (seconds <= 0) return;
        // A pierce delay: a dwell right after the beam came on.
        const beam = this.lastBeamOn;
        if (
            beam !== undefined &&
            beam.toolpath === this.current &&
            beam.index === this.current.moves.length - 1
        ) {
            beam.toolpath.moves[beam.index] = { kind: "cutterOn", pierceDelay: seconds };
            return;
        }
        this.emit({ kind: "dwell", seconds });
    }

    private referenceReturn(words: Words, line: number): void {
        const letters = (["X", "Y", "Z"] as const).filter((letter) => words.has(letter));
        if (this.dialect.family === "printer") {
            // Printers home the axes named (all when none) to 0.
            const all = letters.length === 0;
            const next: [number, number, number] = [...this.position];
            if (all || letters.includes("X")) next[0] = 0;
            if (all || letters.includes("Y")) next[1] = 0;
            if (all || letters.includes("Z")) next[2] = 0;
            this.beginMotion();
            if (!same(next, this.position)) {
                this.emit({ kind: "rapid", to: next, feed: this.feed }, true);
                this.position = next;
            }
            return;
        }
        if (letters.length === 0) {
            this.report(line, "warning", "G28/G30 without axes: every axis returns; only Z is drawn");
        }
        // The intermediate point, then the reference point of the axes named.
        const intermediate = this.target(words);
        const via = this.toBaseRaw(intermediate);
        if (letters.length > 0 && !same(via, this.position)) this.moveTo(via, "rapid");
        if (letters.length === 0 || letters.includes("Z")) this.goHome();
        if (letters.includes("X") || letters.includes("Y")) {
            this.reportHomeXY(line);
        }
    }

    private reportHomeXY(line: number): void {
        this.report(
            line,
            "info",
            "X/Y reference positions are unknown in the work offset: X and Y are left where they are",
        );
    }

    private goHome(): void {
        const to: Vec3 = [this.position[0], this.position[1], this.homeZ];
        this.moveTo(to, "rapid", true);
        this.zState = "home";
    }

    /** G53 / SUPA: machine coordinates for this block. */
    private machineMove(words: Words, line: number): void {
        const s = this.scale();
        const offset = this.offsets.get(this.activeOffset);
        const letters = (["X", "Y", "Z"] as const).filter((letter) => words.has(letter));
        if (letters.length === 0) return;
        if (offset !== undefined) {
            // The work offset is known: machine coordinates map exactly.
            const base = this.base ?? this.frameOffset();
            const target: [number, number, number] = [
                this.position[0] + base[0],
                this.position[1] + base[1],
                this.position[2] + base[2],
            ];
            for (const letter of letters) {
                const axis = { X: 0, Y: 1, Z: 2 }[letter];
                target[axis] = words.get(letter)!.value * s;
            }
            if (letters.includes("Z")) this.zState = "programmed";
            this.moveTo(sub(target, base), this.motion === "G1" ? "linear" : "rapid");
            return;
        }
        if (letters.includes("Z")) this.goHome();
        if (letters.includes("X") || letters.includes("Y")) this.reportHomeXY(line);
    }

    /** The programmed end point (program coordinates) of a motion block. */
    private target(words: Words, named?: NamedValues): Vec3 {
        const s = this.scale();
        const current = this.toProgram(this.position);
        const out: [number, number, number] = [current[0], current[1], current[2]];
        (["X", "Y", "Z"] as const).forEach((letter, axis) => {
            const siemens = named?.get(letter);
            if (siemens?.value !== undefined) {
                const incremental = siemens.mode === "ic" || (siemens.mode === undefined && !this.absolute);
                out[axis] = incremental ? current[axis] + siemens.value * s : siemens.value * s;
                if (axis === 2 && (!incremental || this.zState === "programmed")) this.zState = "programmed";
                return;
            }
            const word = words.get(letter);
            if (word === undefined || Number.isNaN(word.value)) return;
            out[axis] = this.absolute ? word.value * s : current[axis] + word.value * s;
            if (axis === 2 && (this.absolute || this.zState === "programmed")) this.zState = "programmed";
        });
        return out;
    }

    private updateRotaries(words: Words): void {
        let changed = false;
        for (const letter of ["A", "B", "C"]) {
            const word = words.get(letter);
            if (word === undefined || Number.isNaN(word.value)) continue;
            const next = this.absolute ? word.value : this.angles[letter] + word.value;
            if (next !== this.angles[letter]) changed = true;
            this.angles[letter] = next;
        }
        if (changed && this.kinematics === undefined && !this.reportedRotary) {
            this.reportedRotary = true;
            this.report(
                this.line,
                "warning",
                "Rotary axis words (A/B/C) without a machine profile: the tool stays vertical",
            );
        }
    }

    private reportedRotary = false;

    private motionBlock(block: NcBlock, words: Words, named: NamedValues): void {
        const family = this.dialect.family;
        if (named.has("A3") || named.has("B3") || named.has("C3")) {
            const old = this.vector ?? Z_AXIS;
            const vector: Vec3 = [
                named.get("A3")?.value ?? old[0],
                named.get("B3")?.value ?? old[1],
                named.get("C3")?.value ?? old[2],
            ];
            const length = Math.hypot(vector[0], vector[1], vector[2]);
            this.vector =
                length > 0 ? [vector[0] / length, vector[1] / length, vector[2] / length] : undefined;
        }
        if (this.motion === "cycle") {
            this.cycleBlock(words, block.line);
            return;
        }
        // The end point in the program's coordinates, read before the rotaries turn.
        const target = this.target(words, named);
        this.updateRotaries(words);
        if (family === "wire") this.updateUV(words);
        if (this.motion === undefined) {
            if (["X", "Y", "Z"].some((letter) => words.has(letter))) {
                this.report(
                    block.line,
                    "warning",
                    "Coordinates without a motion mode (G0/G1): treated as G0",
                );
                this.motion = "G0";
            } else {
                return;
            }
        }
        const to = this.toBaseRaw(target);
        switch (this.motion) {
            case "G0":
            case "G1":
                if (family === "printer") this.printerMove(to, words);
                else if (family === "wire" && this.motion === "G1") this.wireMove(to);
                else this.moveTo(to, this.motion === "G0" ? "rapid" : "linear");
                return;
            case "G2":
            case "G3":
                this.arcMove(target, words, named, this.motion === "G2");
                return;
            case "G5":
            case "G5.1":
                this.splineMove(target, words, this.motion === "G5");
                return;
            case "G33":
                this.report(block.line, "warning", "Threading (G33/G76) is drawn as a straight feed move");
                this.moveTo(to, "linear");
                return;
            case "G38":
                this.report(block.line, "warning", "Probing (G38) is drawn to its end point");
                this.moveTo(to, "linear");
                return;
        }
    }

    private updateUV(words: Words): void {
        const s = this.scale();
        for (const [letter, index] of [
            ["U", 0],
            ["V", 1],
        ] as const) {
            const word = words.get(letter);
            if (word === undefined) continue;
            this.uv[index] = this.absolute ? word.value * s : this.uv[index] + word.value * s;
        }
    }

    private uvZ(): number {
        const wire = this.machine?.wire;
        if (wire === undefined && !this.reportedUv) {
            this.reportedUv = true;
            this.report(
                this.line,
                "info",
                "No wire EDM machine profile: the UV plane is drawn 100 mm above the XY plane",
            );
        }
        return wire?.uvPlaneHeight ?? 100;
    }

    private reportedUv = false;

    private wireMove(to: Vec3): void {
        if (Math.abs(this.uv[0]) < 1e-12 && Math.abs(this.uv[1]) < 1e-12) {
            this.moveTo(to, "linear");
            return;
        }
        this.beginMotion();
        if (same(to, this.position) && this.lastUv?.[0] === this.uv[0] && this.lastUv?.[1] === this.uv[1])
            return;
        this.trackZ(to, false);
        this.emit({
            kind: "taper",
            to,
            upper: [to[0] + this.uv[0], to[1] + this.uv[1], this.uvZ()],
            feed: this.feedFor(to),
        });
        this.position = to;
        this.positionKnown = true;
        this.lastUv = [this.uv[0], this.uv[1]];
    }

    private lastUv: [number, number] | undefined;

    private printerMove(to: Vec3, words: Words): void {
        const e = words.get("E")?.value;
        let extrude = 0;
        if (e !== undefined && !Number.isNaN(e)) {
            const relative = !this.absoluteE || !this.absolute;
            extrude = relative ? e : e - this.eValue;
            this.eValue = relative ? this.eValue + e : e;
        }
        this.beginMotion();
        const moved = !same(to, this.position);
        if (!moved && extrude === 0) return;
        if (moved) this.trackZ(to, false);
        if (extrude !== 0) this.emit({ kind: "extrude", to, extrude, feed: this.feed });
        else this.emit({ kind: "rapid", to, feed: this.feed });
        this.position = to;
        this.positionKnown = true;
    }

    private arcMove(target: Vec3, words: Words, named: NamedValues, clockwise: boolean): void {
        const s = this.scale();
        const start = this.toProgram(this.position);
        const [u, v] = planeAxes(this.plane);
        const letters = ["I", "J", "K"];
        const center: [number, number, number] = [start[0], start[1], start[2]];
        const radiusWord = words.get("R")?.value ?? named.get("CR")?.value;
        if (radiusWord !== undefined && !words.has("I") && !words.has("J") && !words.has("K")) {
            const radius = radiusWord * s;
            const du = target[u] - start[u];
            const dv = target[v] - start[v];
            const chord = Math.hypot(du, dv);
            if (chord < LENGTH_EPSILON) {
                this.report(this.line, "error", "An R-format arc cannot be a full circle");
                return;
            }
            let half = chord / 2;
            if (half > Math.abs(radius) + ARC_RADIUS_TOLERANCE) {
                this.report(
                    this.line,
                    "warning",
                    "Arc radius R is smaller than half the chord: drawn as a half circle",
                );
            }
            half = Math.min(half, Math.abs(radius));
            const h = Math.sqrt(Math.max(0, radius * radius - half * half));
            const side = (clockwise ? -1 : 1) * (radius >= 0 ? 1 : -1);
            const mu = (start[u] + target[u]) / 2;
            const mv = (start[v] + target[v]) / 2;
            center[u] = mu + side * h * (-dv / chord);
            center[v] = mv + side * h * (du / chord);
        } else {
            for (const axis of [u, v]) {
                const letter = letters[axis];
                const siemens = named.get(letter);
                const word = words.get(letter);
                const value = siemens?.value ?? word?.value;
                const absolute = siemens !== undefined ? siemens.mode === "ac" : this.arcAbsolute;
                if (value === undefined) {
                    center[axis] = absolute ? 0 : start[axis];
                    continue;
                }
                center[axis] = absolute ? value * s : start[axis] + value * s;
            }
            const r0 = Math.hypot(start[u] - center[u], start[v] - center[v]);
            const r1 = Math.hypot(target[u] - center[u], target[v] - center[v]);
            if (Math.abs(r0 - r1) > ARC_RADIUS_TOLERANCE + 1e-6 * Math.max(r0, r1)) {
                this.report(
                    this.line,
                    "warning",
                    `Arc start and end radii differ by more than ${ARC_RADIUS_TOLERANCE} mm`,
                );
            }
        }
        const turns = Math.max(1, Math.round(words.get("P")?.value ?? 1));
        this.emitArc(start, target, center, clockwise, turns, words);
    }

    private emitArc(
        start: Vec3,
        target: Vec3,
        center: Vec3,
        clockwise: boolean,
        turns: number,
        words: Words,
    ): void {
        const family = this.dialect.family;
        const plane = this.plane;
        const [, , w] = planeAxes(plane);
        const pieces: { to: Vec3; center: Vec3 }[] = [];
        if (turns > 1) {
            // Extra full turns of a helix (LinuxCNC P): the normal coordinate climbs with the angle.
            const arc: Arc = { kind: "arc", to: target, center, clockwise, plane, feed: 0 };
            const sweep = Math.abs(arcSweep(start, arc));
            const total = sweep + 2 * Math.PI * (turns - 1);
            for (let turn = 1; turn < turns; turn++) {
                const to: [number, number, number] = [start[0], start[1], start[2]];
                to[w] = start[w] + ((target[w] - start[w]) * (2 * Math.PI * turn)) / total;
                pieces.push({ to, center });
            }
        }
        pieces.push({ to: target, center });
        if (family === "printer") {
            this.printerArc(start, pieces, clockwise, words);
            return;
        }
        if (family === "wire" && (this.uv[0] !== 0 || this.uv[1] !== 0)) {
            let from = start;
            for (const piece of pieces) {
                const arc: Arc = {
                    kind: "arc",
                    to: piece.to,
                    center: piece.center,
                    clockwise,
                    plane,
                    feed: 0,
                };
                for (const point of arcPoints(from, arc, CHORD_TOLERANCE))
                    this.wireMove(this.toBaseRaw(point));
                from = piece.to;
            }
            return;
        }
        this.beginMotion();
        let from = start;
        for (const piece of pieces) {
            const arc: Arc = { kind: "arc", to: piece.to, center: piece.center, clockwise, plane, feed: 0 };
            if (!this.translationOnly()) {
                for (const point of arcPoints(from, arc, CHORD_TOLERANCE))
                    this.moveTo(this.toBaseRaw(point), "linear");
                from = piece.to;
                continue;
            }
            const to = this.toBaseRaw(piece.to);
            const centerBase = this.toBaseRaw(piece.center);
            const feed = this.feedFor(to);
            this.trackZ(to, false);
            this.emit({ kind: "arc", to, center: centerBase, clockwise, plane, feed });
            this.position = to;
            this.positionKnown = true;
            this.lastBeamOn = undefined;
            from = piece.to;
        }
    }

    private printerArc(
        start: Vec3,
        pieces: { to: Vec3; center: Vec3 }[],
        clockwise: boolean,
        words: Words,
    ): void {
        const e = words.get("E")?.value;
        let extrude = 0;
        if (e !== undefined && !Number.isNaN(e)) {
            const relative = !this.absoluteE || !this.absolute;
            extrude = relative ? e : e - this.eValue;
            this.eValue = relative ? this.eValue + e : e;
        }
        this.beginMotion();
        // Points at ≤ 5° steps; the extrusion shared by XY length.
        const points: Vec3[] = [];
        let from = start;
        for (const piece of pieces) {
            const [u, v, w] = planeAxes(this.plane);
            const r = Math.hypot(from[u] - piece.center[u], from[v] - piece.center[v]);
            const arc: Arc = {
                kind: "arc",
                to: piece.to,
                center: piece.center,
                clockwise,
                plane: this.plane,
                feed: 0,
            };
            const sweep = arcSweep(from, arc);
            const steps = Math.max(1, Math.ceil(Math.abs(sweep) / PRINTER_ARC_STEP));
            const a0 = Math.atan2(from[v] - piece.center[v], from[u] - piece.center[u]);
            for (let i = 1; i < steps; i++) {
                const a = a0 + (sweep * i) / steps;
                const point: [number, number, number] = [0, 0, 0];
                point[u] = piece.center[u] + r * Math.cos(a);
                point[v] = piece.center[v] + r * Math.sin(a);
                point[w] = from[w] + ((piece.to[w] - from[w]) * i) / steps;
                points.push(point);
            }
            points.push(piece.to);
            from = piece.to;
        }
        if (extrude === 0) {
            if (pieces.length === 1 && this.translationOnly()) {
                const to = this.toBaseRaw(pieces[0].to);
                this.emit({
                    kind: "arc",
                    to,
                    center: this.toBaseRaw(pieces[0].center),
                    clockwise,
                    plane: this.plane,
                    feed: this.feed,
                });
                this.position = to;
                return;
            }
        }
        const lengths: number[] = [];
        let previous = start;
        let total = 0;
        for (const point of points) {
            const d = Math.hypot(point[0] - previous[0], point[1] - previous[1]);
            lengths.push(d);
            total += d;
            previous = point;
        }
        points.forEach((point, index) => {
            const to = this.toBaseRaw(point);
            const share = total > 0 ? (extrude * lengths[index]) / total : 0;
            if (share !== 0) this.emit({ kind: "extrude", to, extrude: share, feed: this.feed });
            else if (!same(to, this.position)) this.emit({ kind: "rapid", to, feed: this.feed });
            this.position = to;
        });
        this.positionKnown = true;
    }

    private splineMove(target: Vec3, words: Words, cubic: boolean): void {
        if (this.plane !== "XY") {
            this.report(this.line, "error", "Splines (G5/G5.1) work in G17 only");
            return;
        }
        const s = this.scale();
        const start = this.toProgram(this.position);
        const i = (words.get("I")?.value ?? Number.NaN) * s;
        const j = (words.get("J")?.value ?? Number.NaN) * s;
        const points: Vec3[] = [];
        const steps = 32;
        if (cubic) {
            const p = (words.get("P")?.value ?? 0) * s;
            const q = (words.get("Q")?.value ?? 0) * s;
            // Without I/J the first control point mirrors the previous spline's second one.
            const c1: Vec3 = Number.isNaN(i)
                ? this.lastSplineControl !== undefined
                    ? [
                          2 * start[0] - this.lastSplineControl[0],
                          2 * start[1] - this.lastSplineControl[1],
                          start[2],
                      ]
                    : start
                : [start[0] + i, start[1] + (Number.isNaN(j) ? 0 : j), start[2]];
            const c2: Vec3 = [target[0] + p, target[1] + q, target[2]];
            for (let k = 1; k <= steps; k++) {
                const t = k / steps;
                const a = (1 - t) ** 3;
                const b = 3 * (1 - t) ** 2 * t;
                const c = 3 * (1 - t) * t * t;
                const d = t ** 3;
                points.push([
                    a * start[0] + b * c1[0] + c * c2[0] + d * target[0],
                    a * start[1] + b * c1[1] + c * c2[1] + d * target[1],
                    start[2] + (target[2] - start[2]) * t,
                ]);
            }
            this.lastSplineControl = c2;
        } else {
            const c: Vec3 = [
                start[0] + (Number.isNaN(i) ? 0 : i),
                start[1] + (Number.isNaN(j) ? 0 : j),
                start[2],
            ];
            for (let k = 1; k <= steps; k++) {
                const t = k / steps;
                const a = (1 - t) ** 2;
                const b = 2 * (1 - t) * t;
                const d = t * t;
                points.push([
                    a * start[0] + b * c[0] + d * target[0],
                    a * start[1] + b * c[1] + d * target[1],
                    start[2] + (target[2] - start[2]) * t,
                ]);
            }
        }
        for (const point of points) this.moveTo(this.toBaseRaw(point), "linear");
    }

    private lastSplineControl: Vec3 | undefined;

    // ------------------------------------------------------------------ Drilling cycles

    private cycleBlock(words: Words, line: number): void {
        const code = this.cycleCode!;
        const s = this.scale();
        const current = this.toProgram(this.position);
        const starting = this.cycle === undefined;
        const initialZ = starting ? current[2] : this.cycle!.initialZ;
        const previous = this.cycle;
        const r = words.get("R")?.value;
        const z = words.get("Z")?.value;
        let rPlane: number;
        if (r !== undefined) rPlane = this.absolute ? r * s : initialZ + r * s;
        else if (previous !== undefined) rPlane = previous.r;
        else {
            this.report(line, "error", `G${code} needs R (the retract plane)`);
            return;
        }
        let bottom: number;
        if (z !== undefined) bottom = this.absolute ? z * s : rPlane + z * s;
        else if (previous !== undefined) bottom = previous.z;
        else {
            this.report(line, "error", `G${code} needs Z (the hole bottom)`);
            return;
        }
        const q = words.get("Q")?.value;
        const p = words.get("P");
        let dwell = previous?.dwell;
        if (p !== undefined) {
            const value = p.value;
            const fanucMs =
                this.dialect.dwell === "fanuc" || (this.dialect.dwell === "haas" && !p.word.decimal);
            dwell = fanucMs ? value / 1000 : value;
        }
        const cycle: CycleState = {
            code,
            r: rPlane,
            z: bottom,
            q: q !== undefined ? Math.abs(q * s) : previous?.q,
            dwell,
            initialZ,
        };
        this.cycle = cycle;
        this.zState = "programmed";
        if (["I", "J"].some((letter) => words.has(letter)) && (code === 83 || code === 73)) {
            this.report(line, "warning", `G${code} with I/J (variable pecks) is drawn with even pecks of Q`);
        }
        if (code === 76) {
            this.report(line, "warning", "G76 fine boring is drawn as a bore (G85)");
        }
        const repeats = Math.max(0, Math.round(words.get("L")?.value ?? words.get("K")?.value ?? 1));
        let x = current[0];
        let y = current[1];
        const xWord = words.get("X")?.value;
        const yWord = words.get("Y")?.value;
        for (let repeat = 0; repeat < repeats; repeat++) {
            if (this.absolute) {
                if (xWord !== undefined) x = xWord * s;
                if (yWord !== undefined) y = yWord * s;
            } else {
                x += (xWord ?? 0) * s;
                y += (yWord ?? 0) * s;
            }
            this.drillHole(x, y, cycle, line);
        }
    }

    private drillHole(x: number, y: number, cycle: CycleState, line: number): void {
        const code = cycle.code;
        if (code === 87) {
            this.report(line, "error", "G87 back boring is not supported: the hole is skipped");
            this.moveTo(this.toBaseRaw([x, y, this.toProgram(this.position)[2]]), "rapid");
            return;
        }
        if (code === 86 || code === 88) {
            this.report(
                line,
                "info",
                `G${code} (bore, spindle stop, ${code === 86 ? "rapid" : "manual"} out) is drawn as a bore`,
            );
        }
        const kind: Extract<ToolpathMove, { kind: "drill" }>["cycle"] =
            code === 83
                ? "peck"
                : code === 73
                  ? "chipBreak"
                  : code === 84 || code === 74
                    ? "tap"
                    : code === 85 || code === 86 || code === 88 || code === 89 || code === 76
                      ? "bore"
                      : "drill";
        const peck = kind === "peck" || kind === "chipBreak" ? cycle.q : undefined;
        const dwell = code === 82 || code === 89 || code === 88 ? cycle.dwell : undefined;
        const feed = this.feedPerRev ? this.feed * this.rpm : this.feed;
        if (feed <= 0) this.report(line, "warning", "A drilling cycle before any feed rate (F)");
        const height = this.toProgram(this.position)[2];
        // G98 returns to where the cycle began (the model: the height the hole started from), G99 to R.
        const end = this.retractToR ? cycle.r : Math.max(height, cycle.r);
        this.beginMotion();
        if (!this.translationOnly()) {
            // A tilted plane: the cycle as straight moves along the plane's −Z.
            const p = (zz: number) => this.toBaseRaw([x, y, zz]);
            this.moveTo(p(height), "rapid");
            this.moveTo(p(cycle.r), "rapid");
            this.moveTo(p(cycle.z), "linear");
            if (dwell !== undefined && dwell > 0) this.emit({ kind: "dwell", seconds: dwell });
            this.moveTo(p(cycle.r), kind === "tap" || kind === "bore" ? "linear" : "rapid");
            this.moveTo(p(end), "rapid");
            return;
        }
        if (this.retractToR || (Math.abs(height - cycle.r) > LENGTH_EPSILON && height < cycle.r)) {
            // G99 (or starting below R): position at the current height, then down to R; the
            // drill move then starts and ends at R.
            this.moveTo(this.toBaseRaw([x, y, height]), "rapid");
            this.moveTo(this.toBaseRaw([x, y, cycle.r]), "rapid");
        }
        const at = this.toBaseRaw([x, y, cycle.r]);
        const move: ToolpathMove = {
            kind: "drill",
            at,
            depth: cycle.r - cycle.z,
            retract: at[2],
            cycle: kind,
            ...(peck === undefined ? {} : { peck }),
            ...(dwell === undefined || dwell <= 0 ? {} : { dwell }),
            feed,
        };
        this.trackZ(at, false);
        this.emit(move);
        this.position = this.toBaseRaw([x, y, end]);
        this.positionKnown = true;
    }

    /** LinuxCNC G33.1 rigid tapping: a tap from the current height to Z and back. */
    private rigidTap(words: Words, line: number): void {
        const s = this.scale();
        const current = this.toProgram(this.position);
        const z = words.get("Z")?.value;
        const k = words.get("K")?.value;
        if (z === undefined || k === undefined) {
            this.report(line, "error", "G33.1 needs Z and K");
            return;
        }
        const bottom = this.absolute ? z * s : current[2] + z * s;
        const at = this.toBaseRaw(current);
        this.beginMotion();
        this.trackZ(at, false);
        this.emit({
            kind: "drill",
            at,
            depth: current[2] - bottom,
            retract: at[2],
            cycle: "tap",
            feed: k * s * Math.max(0, this.rpm),
        });
        if (this.rpm <= 0) this.report(line, "warning", "G33.1 without a spindle speed");
        this.motion = undefined;
    }
}

function sameAxis(a: Vec3 | undefined, b: Vec3 | undefined): boolean {
    if (a === undefined || b === undefined) return a === b;
    return Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12 && Math.abs(a[2] - b[2]) < 1e-12;
}
