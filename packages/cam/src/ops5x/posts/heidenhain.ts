// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { CamProgram, PostProcessor } from "../../model/post";
import type { ToolpathMove, Vec3 } from "../../model/toolpath";
import type { FiveAxisKinematics } from "../kinematics";
import { arcPoints, wcsToFrame } from "../moves";
import {
    coolantOf,
    formatNumber,
    ModalWords,
    type NumberStyle,
    option,
    spindleRpm,
    toolDescription,
} from "./format";
import { spatialAngles } from "./frames";
import { mergedOptions, planOptionsOf } from "./gcodeFamily";
import { type PlannedToolpath, planProgram } from "./plan";

/**
 * Heidenhain TNC conversational (Klartext): numbered blocks, `L` moves with signed
 * coordinates, M128 tool centre point management for simultaneous 5-axis (rotary angles, or
 * `LN` blocks with the tool vector TX TY TZ under option `orientation: "vector"`), PLANE
 * SPATIAL (TURN, retract MAX) for 3+2, CC/C for XY arcs.
 */

const COORD: NumberStyle = { decimals: 3, fixed: true, plusSign: true };
const VECTOR: NumberStyle = { decimals: 7, fixed: true, plusSign: true };
const COOLANT_ON: Record<string, string> = { flood: "M8", mist: "M7", air: "M7", throughTool: "M8" };

function feedWord(feed: number): string {
    return `F${Math.max(1, Math.round(feed))}`;
}

class HeidenhainWriter {
    private readonly lines: string[] = [];
    private readonly modal = new ModalWords();
    private readonly rotaryNames: { name: string; index: number }[];
    private readonly name: string;

    constructor(
        private readonly program: CamProgram,
        kinematics: FiveAxisKinematics | undefined,
        private readonly options: Readonly<Record<string, unknown>>,
    ) {
        this.rotaryNames = (kinematics?.joints ?? [])
            .map((joint, index) => ({ name: joint.name, index }))
            .sort((a, b) => a.name.localeCompare(b.name));
        this.name = program.name.replace(/[^A-Za-z0-9_]/g, "_") || "PROGRAM";
    }

    private block(text: string): void {
        this.lines.push(`${this.lines.length} ${text}`);
    }

    private parts(...parts: string[]): void {
        const text = parts.filter((part) => part.length > 0).join(" ");
        if (text.length > 0) this.block(text);
    }

    text(): string {
        return `${this.lines.join("\n")}\n`;
    }

    private xyz(point: Vec3, force = false): string[] {
        return (["X", "Y", "Z"] as const).map((address, i) =>
            this.modal.word(address, formatNumber(point[i], COORD), force),
        );
    }

    private rotary(angles: readonly number[] | undefined): string[] {
        if (angles === undefined) return [];
        return this.rotaryNames.map(({ name, index }) =>
            this.modal.word(name, formatNumber(angles[index], COORD)),
        );
    }

    private feed(value: number): string {
        return this.modal.word("F", feedWord(value).slice(1));
    }

    /** An `L` block; rapids at FMAX (non-modal, so the feed stays). */
    private line(axes: string[], rapid: boolean, feed?: number): void {
        if (axes.every((word) => word === "")) return;
        this.parts("L", ...axes, "R0", rapid ? "FMAX" : this.feed(feed ?? 0));
    }

    header(): void {
        this.block(`BEGIN PGM ${this.name} MM`);
        this.block(`; MACHINE: ${this.program.machine.name}`);
        for (const tool of this.program.tools.values())
            this.block(`; T${tool.number} ${toolDescription(tool)}`);
    }

    footer(): void {
        this.block("M5");
        this.block("M30");
        this.block(`END PGM ${this.name} MM`);
    }

    toolpath(plan: PlannedToolpath): void {
        const { path, tool } = plan;
        this.modal.reset("X", "Y", "Z", "F");
        if (path.label) this.block(`; ${path.label}`);
        const rpm = spindleRpm(path, tool);
        const speed = rpm === undefined ? "" : ` S${Math.round(rpm)}`;
        if (plan.toolChange || speed)
            this.block(`TOOL CALL ${plan.toolChange ? `${tool.number} ` : ""}Z${speed}`);
        this.block("L Z+0.000 R0 FMAX M91");
        this.modal.reset("Z");
        this.block("M3");
        const coolant = COOLANT_ON[coolantOf(path, tool)];
        if (coolant) this.block(coolant);
        if (plan.mode === "3axis") {
            this.line(this.rotary(plan.angles), true);
            this.planar(plan.moves, (p) => p);
        } else if (plan.mode === "indexed") {
            const frame = plan.frame!;
            const [a, b, c] = spatialAngles(frame).map((value) => formatNumber(value, COORD));
            this.block(`PLANE SPATIAL SPA${a} SPB${b} SPC${c} TURN MB MAX FMAX`);
            this.planar(plan.moves, (p) => wcsToFrame(frame, [0, 0, 0], p));
            this.block("PLANE RESET TURN MB MAX FMAX");
            this.modal.reset(...this.rotaryNames.map(({ name }) => name));
        } else {
            this.simultaneous(plan);
        }
        if (coolant) this.block("M9");
        this.block("L Z+0.000 R0 FMAX M91");
    }

    private approach(point: Vec3, extra: string[] = []): void {
        const [x, y] = this.xyz(point, true);
        this.parts("L", x, y, ...extra, "R0", "FMAX");
        this.parts("L", this.modal.word("Z", formatNumber(point[2], COORD), true), "R0", "FMAX");
    }

    private planar(moves: readonly ToolpathMove[], map: (point: Vec3) => Vec3): void {
        let at: Vec3 | undefined;
        for (const move of moves) {
            if (move.kind === "rapid" || move.kind === "linear") {
                const to = map(move.to);
                if (at === undefined) this.approach(to);
                at = to;
                this.line(
                    this.xyz(to),
                    move.kind === "rapid",
                    move.kind === "linear" ? move.feed : undefined,
                );
            } else if (move.kind === "arc") {
                const start = at ?? move.to;
                if (move.plane === "XY" && Math.abs(move.to[2] - start[2]) < 1e-9) {
                    this.parts(
                        "CC",
                        `X${formatNumber(move.center[0], COORD)}`,
                        `Y${formatNumber(move.center[1], COORD)}`,
                    );
                    const [x, y] = this.xyz(move.to, true);
                    this.parts("C", x, y, move.clockwise ? "DR-" : "DR+", "R0", this.feed(move.feed));
                } else {
                    // Helices and arcs outside XY: straight moves.
                    for (const point of arcPoints(start, move, 0.005))
                        this.line(this.xyz(point), false, move.feed);
                }
                at = move.to;
            } else if (move.kind === "dwell") {
                this.block(`CYCL DEF 9.0 DWELL TIME`);
                this.block(`CYCL DEF 9.1 DWELL ${formatNumber(move.seconds, { decimals: 3 })}`);
            } else if (move.kind === "comment") {
                this.block(`; ${move.text}`);
            } else if (move.kind === "raw") {
                this.block(move.code);
            }
        }
    }

    private simultaneous(plan: PlannedToolpath): void {
        const vector = option<string>(this.options, "orientation", "angles") === "vector";
        this.line(this.rotary(plan.angles), true);
        this.block("M128");
        let positioned = false;
        for (const entry of plan.blocks) {
            if (entry.kind === "dwell") {
                this.block(`CYCL DEF 9.0 DWELL TIME`);
                this.block(`CYCL DEF 9.1 DWELL ${formatNumber(entry.seconds, { decimals: 3 })}`);
            } else if (entry.kind === "comment") {
                this.block(`; ${entry.text}`);
            } else if (entry.kind === "raw") {
                this.block(entry.code);
            } else {
                const { tip, axis, angles } = entry.point;
                if (!positioned) {
                    this.approach(tip, vector ? [] : this.rotary(angles));
                    positioned = true;
                }
                const rapid = entry.kind === "rapid";
                if (vector) {
                    const coordinates = this.xyz(tip, true);
                    const tool = (["TX", "TY", "TZ"] as const).map(
                        (address, i) => `${address}${formatNumber(axis[i], VECTOR)}`,
                    );
                    this.parts(
                        "LN",
                        ...coordinates,
                        ...tool,
                        "R0",
                        rapid ? "FMAX" : this.feed(entry.feed ?? 0),
                    );
                } else {
                    this.line([...this.xyz(tip), ...this.rotary(angles)], rapid, entry.feed);
                }
            }
        }
        this.block("M129");
    }
}

export const HEIDENHAIN_TNC_POST: PostProcessor = {
    id: "heidenhain-tnc-5axis",
    name: "Heidenhain TNC (5-axis, M128 / PLANE SPATIAL)",
    machineKinds: ["mill"],
    extension: ".h",
    post(program: CamProgram, options?: Readonly<Record<string, unknown>>): Result<string> {
        const merged = mergedOptions(program, options);
        const plan = planProgram(program, planOptionsOf(merged, true));
        if (!plan.isOk) return Result.err(plan.error);
        const writer = new HeidenhainWriter(program, plan.value.kinematics, merged);
        writer.header();
        for (const toolpath of plan.value.toolpaths) writer.toolpath(toolpath);
        writer.footer();
        return Result.ok(writer.text());
    },
};
