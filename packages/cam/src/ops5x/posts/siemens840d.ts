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
    spindleRpm,
    toolDescription,
    words,
} from "./format";
import { axisByAxisXYZ } from "./frames";
import { mergedOptions, planOptionsOf } from "./gcodeFamily";
import { type PlannedToolpath, planProgram } from "./plan";

/**
 * Siemens Sinumerik 840D: TRAORI for simultaneous 5-axis (rotary angles under ORIAXES, or
 * the tool vector A3= B3= C3= under ORIWKS/ORIVECT with option `orientation: "vector"`),
 * CYCLE800 (axis by axis X-Y-Z, swivel data record option `swivelData`, default "TC1") for
 * 3+2, D1 length offsets, SUPA retracts.
 */

const NUMBER: NumberStyle = { decimals: 3 };
const FEED: NumberStyle = { decimals: 1 };
const COOLANT_ON: Record<string, string> = { flood: "M8", mist: "M7", air: "M7", throughTool: "M8" };

class SiemensWriter {
    private readonly lines: string[] = [];
    private readonly modal = new ModalWords();
    private readonly rotaryNames: { name: string; index: number }[];

    constructor(
        private readonly program: CamProgram,
        kinematics: FiveAxisKinematics | undefined,
        private readonly options: Readonly<Record<string, unknown>>,
    ) {
        this.rotaryNames = (kinematics?.joints ?? [])
            .map((joint, index) => ({ name: joint.name, index }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    private block(...parts: (string | undefined | false)[]): void {
        const text = words(...parts);
        if (text.length > 0) this.lines.push(text);
    }

    private comment(text: string): void {
        this.lines.push(`; ${text.replace(/[\r\n]/g, " ")}`);
    }

    text(): string {
        return `${this.lines.join("\n")}\n`;
    }

    private xyz(point: Vec3, force = false): string[] {
        return (["X", "Y", "Z"] as const).map((address, i) =>
            this.modal.word(address, formatNumber(point[i], NUMBER), force),
        );
    }

    private rotary(angles: readonly number[] | undefined): string[] {
        if (angles === undefined) return [];
        return this.rotaryNames.map(({ name, index }) =>
            this.modal.word(name, formatNumber(angles[index], NUMBER)),
        );
    }

    /** Rapid rotary positioning (nothing when already there). */
    private positionRotaries(angles: readonly number[] | undefined): void {
        const axes = this.rotary(angles);
        if (axes.some((word) => word !== "")) this.block("G0", ...axes);
    }

    private code(group: string, code: string): string {
        return this.modal.word(group, code) === "" ? "" : code;
    }

    private feed(value: number): string {
        return this.modal.word("F", formatNumber(value, FEED));
    }

    header(): void {
        this.comment(`PROGRAM ${this.program.name}`);
        this.comment(`MACHINE: ${this.program.machine.name}`);
        for (const tool of this.program.tools.values())
            this.comment(`T${tool.number} ${toolDescription(tool)}`);
        this.block("G17 G90 G40 G71 G94");
    }

    footer(): void {
        this.block("M5");
        this.block("M30");
    }

    toolpath(plan: PlannedToolpath): void {
        const { path, tool } = plan;
        this.modal.reset("X", "Y", "Z", "MOTION", "PLANE", "F");
        if (path.label) this.comment(path.label);
        if (plan.toolChange) {
            this.block(`T${tool.number}`);
            this.block("M6");
        }
        this.block("D1");
        const rpm = spindleRpm(path, tool);
        if (rpm !== undefined) this.block(`S${Math.round(rpm)} M3`);
        const coolant = COOLANT_ON[coolantOf(path, tool)];
        if (coolant) this.block(coolant);
        this.block("G54");
        if (plan.mode === "3axis") {
            this.positionRotaries(plan.angles);
            this.planar(plan.moves, (p) => p);
        } else if (plan.mode === "indexed") {
            const frame = plan.frame!;
            const [a, b, c] = axisByAxisXYZ(frame).map((value) => formatNumber(value, NUMBER));
            const record = option(this.options, "swivelData", "TC1");
            this.block(`CYCLE800(1,"${record}",0,57,0,0,0,${a},${b},${c},0,0,0,-1,100,1)`);
            this.planar(plan.moves, (p) => wcsToFrame(frame, [0, 0, 0], p));
            this.block("CYCLE800()");
            this.modal.reset(...this.rotaryNames.map(({ name }) => name));
        } else {
            this.simultaneous(plan);
        }
        if (coolant) this.block("M9");
        this.block("G0 SUPA Z0 D0");
    }

    private approach(point: Vec3, extra: string[] = []): void {
        const [x, y] = this.xyz(point, true);
        this.block(this.code("MOTION", "G0"), x, y, ...extra);
        this.block(this.modal.word("Z", formatNumber(point[2], NUMBER), true));
    }

    private planar(moves: readonly ToolpathMove[], map: (point: Vec3) => Vec3): void {
        let at: Vec3 | undefined;
        for (const move of moves) {
            if (move.kind === "rapid" || move.kind === "linear") {
                const to = map(move.to);
                if (at === undefined) this.approach(to);
                const axes = this.xyz(to);
                at = to;
                if (axes.every((word) => word === "")) continue;
                if (move.kind === "rapid") this.block(this.code("MOTION", "G0"), ...axes);
                else this.block(this.code("MOTION", "G1"), ...axes, this.feed(move.feed));
            } else if (move.kind === "arc") {
                const start = at ?? move.to;
                const normal = { XY: 2, ZX: 1, YZ: 0 }[move.plane];
                const center = (["I", "J", "K"] as const)
                    .map((address, i) => ({ address, i }))
                    .filter(({ i }) => i !== normal)
                    .map(({ address, i }) => `${address}${formatNumber(move.center[i] - start[i], NUMBER)}`);
                this.block(
                    this.code("PLANE", { XY: "G17", ZX: "G18", YZ: "G19" }[move.plane]),
                    this.code("MOTION", move.clockwise ? "G2" : "G3"),
                    ...this.xyz(move.to),
                    ...center,
                    this.feed(move.feed),
                );
                at = move.to;
            } else if (move.kind === "dwell") {
                this.block(`G4 F${formatNumber(move.seconds, NUMBER)}`);
            } else if (move.kind === "comment") {
                this.comment(move.text);
            } else if (move.kind === "raw") {
                this.block(move.code);
            }
        }
    }

    private simultaneous(plan: PlannedToolpath): void {
        const vector = option<string>(this.options, "orientation", "angles") === "vector";
        this.positionRotaries(plan.angles);
        this.block("TRAORI");
        this.block("G54");
        this.block(vector ? "ORIWKS ORIVECT" : "ORIAXES");
        const orientation = (axis: Vec3, angles: readonly number[]): string[] =>
            vector
                ? (["A3", "B3", "C3"] as const).map((address, i) =>
                      this.modal.word(`${address}=`, formatNumber(axis[i], { decimals: 6 })),
                  )
                : this.rotary(angles);
        let positioned = false;
        for (const entry of plan.blocks) {
            if (entry.kind === "dwell") this.block(`G4 F${formatNumber(entry.seconds, NUMBER)}`);
            else if (entry.kind === "comment") this.comment(entry.text);
            else if (entry.kind === "raw") this.block(entry.code);
            else {
                const { tip, axis, angles } = entry.point;
                if (!positioned) {
                    this.approach(tip, orientation(axis, angles));
                    positioned = true;
                }
                const axes = [...this.xyz(tip), ...orientation(axis, angles)];
                if (axes.every((word) => word === "")) continue;
                if (entry.kind === "rapid") this.block(this.code("MOTION", "G0"), ...axes);
                else this.block(this.code("MOTION", "G1"), ...axes, this.feed(entry.feed ?? 0));
            }
        }
        this.block("TRAFOOF");
    }
}

export const SIEMENS_840D_POST: PostProcessor = {
    id: "siemens-840d-5axis",
    name: "Siemens 840D (5-axis, TRAORI / CYCLE800)",
    machineKinds: ["mill"],
    extension: ".mpf",
    post(program: CamProgram, options?: Readonly<Record<string, unknown>>): Result<string> {
        const merged = mergedOptions(program, options);
        const plan = planProgram(program, planOptionsOf(merged, true));
        if (!plan.isOk) return Result.err(plan.error);
        const writer = new SiemensWriter(program, plan.value.kinematics, merged);
        writer.header();
        for (const toolpath of plan.value.toolpaths) writer.toolpath(toolpath);
        writer.footer();
        return Result.ok(writer.text());
    },
};
