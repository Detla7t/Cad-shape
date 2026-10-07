// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { CamProgram, PostProcessor } from "../../model/post";
import type { ToolpathMove, Vec3 } from "../../model/toolpath";
import type { FiveAxisKinematics } from "../kinematics";
import { wcsToFrame } from "../moves";
import {
    coolantOf,
    formatNumber,
    ModalWords,
    type NumberStyle,
    option,
    parenComment,
    programNumber,
    spindleRpm,
    toolDescription,
    words,
} from "./format";
import { eulerZXZ } from "./frames";
import { type PlannedToolpath, type PlanOptions, planProgram } from "./plan";

/**
 * Fanuc-family 5-axis G-code (Fanuc 30i, Haas UMC, a generic non-TCP control): one writer,
 * dialects differing in how a tilted plane (3+2) and simultaneous motion are switched on.
 *
 * - 3-axis toolpaths: rotaries square, G43 length offset, arcs as G2/G3.
 * - 3+2: Fanuc G68.2 + G53.1 (coordinates in the tilted plane); Haas DWO G254 (part
 *   coordinates, the control follows the rotaries); generic: rotaries positioned, machine
 *   coordinates from the inverse kinematics.
 * - Simultaneous: Fanuc G43.4 / Haas G234 tool centre point control with tip coordinates and
 *   rotary angles; generic: machine coordinates of the controlled point, inverse time feed.
 *
 * Options (post options of the profile, overridden per call): `tolerance` (mm, non-TCP),
 * `maxAngleStep` (deg per block), `axisTolerance` (deg), `chordTolerance`, `rewindRetract`,
 * `workOffset` ([x, y, z] of the WCS origin in machine coordinates), `preferredTilt`,
 * `indexedAsSimultaneous`, `unwind` (default true), `inverseTime` (generic, default true),
 * `toolLength` (gauge length override), `sequenceNumbers` (N words). Siemens and Heidenhain
 * read the same plan options.
 */
export interface GcodeDialect {
    readonly id: string;
    readonly name: string;
    readonly indexed: "g68.2" | "dwo" | "machine";
    readonly simultaneous: "g43.4" | "g234" | "machine";
    /** Retract to the tool change / safe height. */
    readonly retract: readonly string[];
    readonly dwell: (seconds: number) => string;
    readonly throughToolCoolant: string;
}

const LINEAR: NumberStyle = { decimals: 3, trailingDot: true };
const ANGLE: NumberStyle = { decimals: 3, trailingDot: true };
const FEED: NumberStyle = { decimals: 1, trailingDot: true };
const INVERSE_FEED: NumberStyle = { decimals: 3, trailingDot: true };

const COOLANT_ON: Record<string, string> = { flood: "M08", mist: "M07", air: "M07" };

function samePoint(a: Vec3 | undefined, b: Vec3): boolean {
    return (
        a !== undefined &&
        Math.abs(a[0] - b[0]) < 5e-4 &&
        Math.abs(a[1] - b[1]) < 5e-4 &&
        Math.abs(a[2] - b[2]) < 5e-4
    );
}

/** Blocks per minute for a block of `distance` mm at `feed` mm/min (rotary-only blocks at 3600°/min). */
export function inverseTimeFeed(feed: number, distance: number, rotary: number): number {
    const minutes = Math.max(distance / Math.max(feed, 1e-9), rotary / 3600, 1e-6);
    return 1 / minutes;
}

class GcodeWriter {
    private readonly lines: string[] = [];
    private readonly modal = new ModalWords();
    private sequence = 0;
    private readonly rotaryNames: { name: string; index: number }[];

    constructor(
        private readonly dialect: GcodeDialect,
        private readonly program: CamProgram,
        kinematics: FiveAxisKinematics | undefined,
        private readonly options: Readonly<Record<string, unknown>>,
    ) {
        this.rotaryNames = (kinematics?.joints ?? [])
            .map((joint, index) => ({ name: joint.name, index }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    block(...parts: (string | undefined | false)[]): void {
        const text = words(...parts);
        if (text.length === 0) return;
        if (option(this.options, "sequenceNumbers", false) && text !== "%") {
            this.sequence += 10;
            this.lines.push(`N${this.sequence} ${text}`);
        } else {
            this.lines.push(text);
        }
    }

    text(): string {
        return `${this.lines.join("\n")}\n`;
    }

    private xyz(point: Vec3, force = false): string[] {
        return (["X", "Y", "Z"] as const).map((address, i) =>
            this.modal.word(address, formatNumber(point[i], LINEAR), force),
        );
    }

    private rotary(angles: readonly number[] | undefined, force = false): string[] {
        if (angles === undefined) return [];
        return this.rotaryNames.map(({ name, index }) =>
            this.modal.word(name, formatNumber(angles[index], ANGLE), force),
        );
    }

    /** A modal G code of `group`: written only when it changes. */
    private code(group: string, code: string): string {
        return this.modal.word(group, code) === "" ? "" : code;
    }

    private feed(value: number, style = FEED, force = false): string {
        return this.modal.word("F", formatNumber(value, style), force);
    }

    header(): void {
        const program = this.program;
        this.block("%");
        this.block(`O${String(programNumber(program)).padStart(4, "0")} ${parenComment(program.name)}`);
        this.block(parenComment(`MACHINE: ${program.machine.name}`));
        for (const tool of program.tools.values()) {
            this.block(parenComment(`T${tool.number} ${toolDescription(tool)}`));
        }
        this.block("G90 G94 G17 G21 G40 G49 G80");
    }

    footer(): void {
        this.block("M05");
        this.block("M30");
        this.block("%");
    }

    toolpath(plan: PlannedToolpath): void {
        const { path, tool } = plan;
        this.modal.reset("X", "Y", "Z", "MOTION", "PLANE", "F");
        if (path.label) this.block(parenComment(path.label));
        if (plan.toolChange) this.block(`T${tool.number} M06`);
        const rpm = spindleRpm(path, tool);
        if (rpm !== undefined) this.block(`S${Math.round(rpm)} M03`);
        const coolant = coolantOf(path, tool);
        const coolantCode = coolant === "throughTool" ? this.dialect.throughToolCoolant : COOLANT_ON[coolant];
        if (coolantCode) this.block(coolantCode);
        const lengthOffset = `G43 H${tool.number}`;
        if (plan.mode === "3axis") {
            this.block("G00 G90 G54", ...this.rotary(plan.angles));
            this.planar(plan.moves, (p) => p, lengthOffset);
        } else if (plan.mode === "indexed") {
            this.indexed(plan, lengthOffset);
        } else {
            this.simultaneous(plan, tool.number);
        }
        if (coolantCode) this.block("M09");
        for (const line of this.dialect.retract) this.block(line);
    }

    /** Rapid over the first point, then down to it with the length offset (`lengthCode`). */
    private approach(point: Vec3, lengthCode: string, angles?: readonly number[]): void {
        const [x, y] = this.xyz(point, true);
        this.block(this.code("MOTION", "G00"), x, y, ...this.rotary(angles));
        this.block(lengthCode, this.modal.word("Z", formatNumber(point[2], LINEAR), true));
    }

    /** Three-axis output of moves through a coordinate mapping (identity, a tilted plane). */
    private planar(moves: readonly ToolpathMove[], map: (point: Vec3) => Vec3, lengthCode: string): void {
        let at: Vec3 | undefined;
        for (const move of moves) {
            switch (move.kind) {
                case "rapid":
                case "linear": {
                    const to = map(move.to);
                    if (at === undefined) {
                        this.approach(to, lengthCode);
                        at = to;
                    }
                    if (samePoint(at, to)) break;
                    if (move.kind === "rapid") this.block(this.code("MOTION", "G00"), ...this.xyz(to));
                    else this.block(this.code("MOTION", "G01"), ...this.xyz(to), this.feed(move.feed));
                    at = to;
                    break;
                }
                case "arc": {
                    const start = at ?? move.to;
                    const normalIndex = { XY: 2, ZX: 1, YZ: 0 }[move.plane];
                    const centerWords = (["I", "J", "K"] as const)
                        .map((address, i) => ({ address, i }))
                        .filter(({ i }) => i !== normalIndex)
                        .map(
                            ({ address, i }) =>
                                `${address}${formatNumber(move.center[i] - start[i], LINEAR)}`,
                        );
                    this.block(
                        this.code("PLANE", { XY: "G17", ZX: "G18", YZ: "G19" }[move.plane]),
                        this.code("MOTION", move.clockwise ? "G02" : "G03"),
                        ...this.xyz(move.to),
                        ...centerWords,
                        this.feed(move.feed),
                    );
                    at = move.to;
                    break;
                }
                case "dwell":
                    this.block(this.dialect.dwell(move.seconds));
                    break;
                case "comment":
                    this.block(parenComment(move.text));
                    break;
                case "raw":
                    this.block(move.code);
                    break;
                default:
                    break;
            }
        }
    }

    private indexed(plan: PlannedToolpath, lengthOffset: string): void {
        const frame = plan.frame!;
        if (this.dialect.indexed === "g68.2") {
            const [i, j, k] = eulerZXZ(frame).map((value) => formatNumber(value, ANGLE));
            this.block("G90 G54");
            this.block(parenComment(`TILTED PLANE ${this.describeAngles(plan.angles)}`));
            this.block(`G68.2 X0. Y0. Z0. I${i} J${j} K${k}`);
            this.block("G53.1");
            this.planar(plan.moves, (p) => wcsToFrame(frame, [0, 0, 0], p), lengthOffset);
            this.block("G69");
            this.modal.reset(...this.rotaryNames.map(({ name }) => name));
            return;
        }
        this.block("G00 G90 G54", ...this.rotary(plan.angles));
        if (this.dialect.indexed === "dwo") {
            this.block("G254");
            this.planar(plan.moves, (p) => p, lengthOffset);
            this.block("G255");
            return;
        }
        // Machine coordinates of the controlled point; the rotaries stay put.
        const machineMoves = plan.blocks.map((entry): ToolpathMove => {
            if (!("point" in entry)) return entry;
            return entry.kind === "rapid"
                ? { kind: "rapid", to: entry.point.machine }
                : { kind: "linear", to: entry.point.machine, feed: entry.feed ?? 0 };
        });
        this.planar(machineMoves, (p) => p, lengthOffset);
    }

    private describeAngles(angles: readonly number[] | undefined): string {
        if (angles === undefined) return "";
        return this.rotaryNames
            .map(({ name, index }) => `${name}${formatNumber(angles[index], ANGLE)}`)
            .join(" ");
    }

    private simultaneous(plan: PlannedToolpath, toolNumber: number): void {
        const tcp = this.dialect.simultaneous !== "machine";
        const inverseTime = !tcp && option(this.options, "inverseTime", true);
        const lengthCode = {
            "g43.4": `G43.4 H${toolNumber}`,
            g234: `G234 H${toolNumber}`,
            machine: `G43 H${toolNumber}`,
        }[this.dialect.simultaneous];
        this.block("G00 G90 G54", ...this.rotary(plan.angles));
        let at: Vec3 | undefined;
        let inverse = false;
        for (const entry of plan.blocks) {
            if (entry.kind === "dwell") {
                this.block(this.dialect.dwell(entry.seconds));
                continue;
            }
            if (entry.kind === "comment") {
                this.block(parenComment(entry.text));
                continue;
            }
            if (entry.kind === "raw") {
                this.block(entry.code);
                continue;
            }
            const point = tcp ? entry.point.tip : entry.point.machine;
            if (at === undefined) this.approach(point, lengthCode, entry.point.angles);
            at = point;
            if (entry.kind === "rapid") {
                if (inverse) {
                    this.block("G94");
                    inverse = false;
                    this.modal.reset("F");
                }
                this.block(
                    this.code("MOTION", "G00"),
                    ...this.xyz(point),
                    ...this.rotary(entry.point.angles),
                );
                continue;
            }
            const axes = [...this.xyz(point), ...this.rotary(entry.point.angles)];
            if (axes.every((word) => word === "")) continue;
            let feed: string;
            if (inverseTime) {
                if (!inverse) {
                    this.block("G93");
                    inverse = true;
                }
                const blocksPerMinute = inverseTimeFeed(entry.feed ?? 0, entry.distance, entry.rotary);
                feed = this.feed(blocksPerMinute, INVERSE_FEED, true);
            } else {
                feed = this.feed(entry.feed ?? 0);
            }
            this.block(this.code("MOTION", "G01"), ...axes, feed);
        }
        if (inverse) this.block("G94");
        if (tcp) this.block("G49");
    }
}

/** Reads the shared plan options of a post from its merged options. */
export function planOptionsOf(options: Readonly<Record<string, unknown>>, tcp: boolean): PlanOptions {
    return {
        tcp,
        tolerance: option(options, "tolerance", 0.01),
        maxAngleStep: option<number | undefined>(options, "maxAngleStep", tcp ? undefined : 5),
        axisTolerance: option<number | undefined>(options, "axisTolerance", undefined),
        chordTolerance: option(options, "chordTolerance", 0.005),
        rewindRetract: option(options, "rewindRetract", 20),
        workOffset: option<Vec3 | undefined>(options, "workOffset", undefined),
        preferredTilt: option(options, "preferredTilt", "any"),
        indexedAsSimultaneous: option(options, "indexedAsSimultaneous", false),
        unwind: option(options, "unwind", true),
        toolLength: option<number | undefined>(options, "toolLength", undefined),
    };
}

/** The profile's post options with per-call options on top. */
export function mergedOptions(
    program: CamProgram,
    options: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
    return { ...(program.machine.post.options ?? {}), ...(options ?? {}) };
}

export function gcodePost(dialect: GcodeDialect): PostProcessor {
    return {
        id: dialect.id,
        name: dialect.name,
        machineKinds: ["mill"],
        extension: ".nc",
        post(program: CamProgram, options?: Readonly<Record<string, unknown>>): Result<string> {
            const merged = mergedOptions(program, options);
            const plan = planProgram(program, planOptionsOf(merged, dialect.simultaneous !== "machine"));
            if (!plan.isOk) return Result.err(plan.error);
            const writer = new GcodeWriter(dialect, program, plan.value.kinematics, merged);
            writer.header();
            for (const toolpath of plan.value.toolpaths) writer.toolpath(toolpath);
            writer.footer();
            return Result.ok(writer.text());
        },
    };
}

export const FANUC_30I_POST = gcodePost({
    id: "fanuc-30i-5axis",
    name: "Fanuc 30i (5-axis, G43.4 TCP / G68.2)",
    indexed: "g68.2",
    simultaneous: "g43.4",
    retract: ["G91 G28 Z0.", "G90"],
    dwell: (seconds) => `G04 P${Math.round(seconds * 1000)}`,
    throughToolCoolant: "M08",
});

export const HAAS_UMC_POST = gcodePost({
    id: "haas-umc-5axis",
    name: "Haas UMC (5-axis, G234 TCPC / G254 DWO)",
    indexed: "dwo",
    simultaneous: "g234",
    retract: ["G00 G53 Z0."],
    dwell: (seconds) => `G04 P${formatNumber(seconds, { decimals: 3, trailingDot: true })}`,
    throughToolCoolant: "M88",
});

export const GENERIC_NON_TCP_POST = gcodePost({
    id: "generic-5axis-nontcp",
    name: "Generic 5-axis (machine coordinates, no TCP)",
    indexed: "machine",
    simultaneous: "machine",
    retract: ["G91 G28 Z0.", "G90"],
    dwell: (seconds) => `G04 P${Math.round(seconds * 1000)}`,
    throughToolCoolant: "M08",
});
