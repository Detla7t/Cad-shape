// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { MachineKind } from "../model/machine";
import type { CamParameterSpec } from "../model/operation";
import type { CamProgram, PostProcessor } from "../model/post";
import type { ToolpathMove } from "../model/toolpath";
import { GCodeWriter, type NumberFormat, optionOf } from "./gcodeWriter";
import { type ArcMove, arcPoints, resolvePostOptions } from "./motion";

/**
 * 2D cutting posts — plasma (EIA with torch height control), waterjet and laser. The
 * toolpaths already carry the kerf (offset by half of it), so programs run with G40; the
 * table works in XY (Z only when asked), and the beam is switched by `cutterOn` /
 * `cutterOff`: the on code, the pierce delay as G4, then torch height control enabled
 * (plasma), and in reverse at the end of the cut.
 */

export interface CuttingDialect {
    readonly id: string;
    readonly name: string;
    readonly machineKinds: readonly MachineKind[];
    readonly extension: string;
    readonly format: NumberFormat;
    readonly feedFormat: NumberFormat;
    readonly percent: boolean;
    readonly safeStart: readonly string[];
    readonly end: readonly string[];
    /** Beam on/off: `{power}` is replaced by the power option (laser S value). */
    readonly beamOn: string;
    readonly beamOff: string;
    /** Torch height control codes; plasma only. */
    readonly thc?: { readonly on: string; readonly off: string };
    /** Header comments (e.g. GRBL's laser mode setting). */
    readonly notes?: readonly string[];
}

export const PLASMA_DIALECT: CuttingDialect = {
    id: "plasma",
    name: "Plasma (generic EIA)",
    machineKinds: ["plasma"],
    extension: ".nc",
    format: { decimals: 3 },
    feedFormat: { decimals: 0 },
    percent: true,
    safeStart: ["G90 G94 G17 G40", "G21"],
    end: ["M30"],
    beamOn: "M07",
    beamOff: "M08",
    thc: { on: "M51", off: "M50" },
};

export const WATERJET_DIALECT: CuttingDialect = {
    id: "waterjet",
    name: "Waterjet (generic G-code)",
    machineKinds: ["waterjet"],
    extension: ".nc",
    format: { decimals: 3 },
    feedFormat: { decimals: 0 },
    percent: true,
    safeStart: ["G90 G94 G17 G40", "G21"],
    end: ["M30"],
    beamOn: "M03",
    beamOff: "M05",
};

export const LASER_DIALECT: CuttingDialect = {
    id: "laser-generic",
    name: "Laser (generic G-code)",
    machineKinds: ["laser"],
    extension: ".nc",
    format: { decimals: 3 },
    feedFormat: { decimals: 0 },
    percent: false,
    safeStart: ["G90 G94 G17 G40", "G21"],
    end: ["M30"],
    beamOn: "M3 S{power}",
    beamOff: "M5",
};

export const LASER_GRBL_DIALECT: CuttingDialect = {
    id: "laser-grbl",
    name: "Laser (GRBL laser mode)",
    machineKinds: ["laser"],
    extension: ".gcode",
    format: { decimals: 3 },
    feedFormat: { decimals: 0 },
    percent: false,
    safeStart: ["G90 G94 G17", "G21"],
    end: ["M30"],
    beamOn: "M4 S{power}",
    beamOff: "M5",
    notes: ["Laser mode: set $32=1 (dynamic power M4)"],
};

const CUTTING_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "pierceDelay", label: "Pierce delay (s)", kind: "number", min: 0 },
    { key: "beamOn", label: "Beam on code", kind: "string" },
    { key: "beamOff", label: "Beam off code", kind: "string" },
    { key: "outputZ", label: "Output Z", kind: "boolean" },
    {
        key: "arcs",
        label: "Arcs",
        kind: "enum",
        options: [
            { value: "ijk", label: "I/J centre" },
            { value: "linear", label: "Linearize" },
        ],
    },
    { key: "lineNumbers", label: "Line numbers", kind: "boolean" },
    { key: "comments", label: "Comments", kind: "boolean" },
];

const PLASMA_PARAMETERS: readonly CamParameterSpec[] = [
    ...CUTTING_PARAMETERS,
    { key: "thc", label: "Torch height control", kind: "boolean" },
    { key: "thcOn", label: "THC on code", kind: "string", visibleWhen: { key: "thc", values: [true] } },
    { key: "thcOff", label: "THC off code", kind: "string", visibleWhen: { key: "thc", values: [true] } },
];

const LASER_PARAMETERS: readonly CamParameterSpec[] = [
    ...CUTTING_PARAMETERS,
    { key: "power", label: "Power (S)", kind: "number", min: 0 },
];

class CuttingPostError extends Error {}

export class CuttingPost implements PostProcessor {
    readonly id: string;
    readonly name: string;
    readonly machineKinds: readonly MachineKind[];
    readonly extension: string;
    readonly parameters: readonly CamParameterSpec[];
    readonly defaultOptions: Readonly<Record<string, unknown>>;

    constructor(readonly dialect: CuttingDialect) {
        this.id = dialect.id;
        this.name = dialect.name;
        this.machineKinds = dialect.machineKinds;
        this.extension = dialect.extension;
        const laser = dialect.machineKinds.includes("laser");
        this.parameters = dialect.thc ? PLASMA_PARAMETERS : laser ? LASER_PARAMETERS : CUTTING_PARAMETERS;
        this.defaultOptions = {
            beamOn: dialect.beamOn,
            beamOff: dialect.beamOff,
            outputZ: false,
            arcs: "ijk",
            lineNumbers: false,
            comments: true,
            ...(dialect.thc ? { thcOn: dialect.thc.on, thcOff: dialect.thc.off } : {}),
            ...(laser ? { power: 1000 } : {}),
        };
    }

    post(program: CamProgram, options?: Readonly<Record<string, unknown>>): Result<string> {
        const resolved = resolvePostOptions(this, program, options);
        try {
            return Result.ok(new CuttingProgramWriter(this.dialect, program, resolved).write());
        } catch (error) {
            if (error instanceof CuttingPostError) return Result.err(error.message);
            throw error;
        }
    }
}

class CuttingProgramWriter {
    private readonly w: GCodeWriter;
    private position: [number, number, number] | undefined;
    private beamOn = false;
    private thcOn = false;
    private readonly outputZ: boolean;
    private readonly thc: boolean;

    constructor(
        private readonly dialect: CuttingDialect,
        private readonly program: CamProgram,
        private readonly options: Readonly<Record<string, unknown>>,
    ) {
        this.w = new GCodeWriter({
            format: dialect.format,
            feedFormat: dialect.feedFormat,
            comments: optionOf(options, "comments", true) ? "parens" : "none",
            lineNumbers: optionOf(options, "lineNumbers", false)
                ? { start: 10, increment: 10, max: 99999 }
                : false,
        });
        this.outputZ = optionOf(options, "outputZ", false);
        this.thc =
            dialect.thc !== undefined &&
            optionOf(options, "thc", program.machine.cutting?.torchHeightControl ?? true);
    }

    write(): string {
        const { w, dialect } = this;
        if (dialect.percent) w.raw("%");
        w.comment(this.program.setup.programName ?? this.program.name);
        const kerf = this.program.machine.cutting?.kerf;
        if (kerf !== undefined) w.comment(`Kerf ${w.num(kerf)} mm in the toolpaths`);
        for (const note of dialect.notes ?? []) w.comment(note);
        for (const line of dialect.safeStart) w.block(line);
        w.modalWord("plane", "G17");
        for (const path of this.program.toolpaths) {
            if (path.label) w.comment(path.label);
            for (const move of path.moves) this.move(move);
        }
        this.cutterOff();
        for (const line of dialect.end) w.block(line);
        if (dialect.percent) w.raw("%");
        return w.toString();
    }

    private move(move: ToolpathMove): void {
        const { w } = this;
        switch (move.kind) {
            case "rapid":
                this.motion("G0", move.to);
                return;
            case "linear":
            case "taper":
                this.motion("G1", move.to, move.feed);
                return;
            case "arc":
                this.arc(move);
                return;
            case "cutterOn":
                this.cutterOn(move.pierceDelay);
                return;
            case "cutterOff":
                this.cutterOff();
                return;
            case "dwell":
                if (move.seconds <= 0) w.block("M0");
                else w.block("G4", `P${w.num(move.seconds)}`);
                return;
            case "drill":
                // A pierce mark: position, fire for the dwell (or the pierce delay), stop.
                this.motion("G0", move.at);
                this.cutterOn(move.dwell);
                this.cutterOff();
                return;
            case "comment":
                w.comment(move.text);
                return;
            case "raw":
                w.raw(move.code);
                return;
            case "extrude":
                throw new CuttingPostError(`${this.dialect.name} cannot write extrusion moves`);
        }
    }

    private motion(code: "G0" | "G1", to: readonly number[], feed?: number): void {
        const { w } = this;
        const words = [w.axis("X", to[0]), w.axis("Y", to[1]), this.outputZ ? w.axis("Z", to[2]) : undefined];
        if (words.some((word) => word !== undefined)) {
            w.block(w.motion(code), ...words, code === "G1" ? w.feed(feed) : undefined);
        }
        this.position = [to[0], to[1], to[2]];
    }

    private arc(move: ArcMove): void {
        const { w } = this;
        const from = this.position;
        if (from === undefined)
            throw new CuttingPostError("An arc cannot start a program: position the cutter first");
        if (move.plane !== "XY" || optionOf(this.options, "arcs", "ijk") === "linear") {
            for (const point of arcPoints(from, move, 0.005)) this.motion("G1", point, move.feed);
            return;
        }
        w.block(
            w.motion(move.clockwise ? "G2" : "G3"),
            w.axis("X", move.to[0]),
            w.axis("Y", move.to[1]),
            this.outputZ ? w.axis("Z", move.to[2]) : undefined,
            w.word("I", move.center[0] - from[0]),
            w.word("J", move.center[1] - from[1]),
            w.feed(move.feed),
        );
        this.position = [move.to[0], move.to[1], move.to[2]];
    }

    private cutterOn(pierceDelay: number | undefined): void {
        const { w } = this;
        if (this.beamOn) return;
        const power = optionOf(this.options, "power", 1000);
        w.block(
            optionOf(this.options, "beamOn", this.dialect.beamOn).replace("{power}", w.spindleNum(power)),
        );
        this.beamOn = true;
        const delay =
            pierceDelay ??
            optionOf(this.options, "pierceDelay", this.program.machine.cutting?.pierceDelay ?? 0);
        if (delay > 0) w.block("G4", `P${w.num(delay)}`);
        if (this.thc) {
            w.block(optionOf(this.options, "thcOn", this.dialect.thc!.on));
            this.thcOn = true;
        }
    }

    private cutterOff(): void {
        const { w } = this;
        if (!this.beamOn) return;
        if (this.thcOn) {
            w.block(optionOf(this.options, "thcOff", this.dialect.thc!.off));
            this.thcOn = false;
        }
        w.block(optionOf(this.options, "beamOff", this.dialect.beamOff));
        this.beamOn = false;
    }
}

export const CUTTING_DIALECTS: readonly CuttingDialect[] = [
    PLASMA_DIALECT,
    WATERJET_DIALECT,
    LASER_DIALECT,
    LASER_GRBL_DIALECT,
];
