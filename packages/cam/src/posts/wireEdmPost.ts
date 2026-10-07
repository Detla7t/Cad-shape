// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { CamParameterSpec } from "../model/operation";
import type { CamProgram, PostProcessor } from "../model/post";
import type { ToolpathMove, Vec3 } from "../model/toolpath";
import { GCodeWriter, optionOf } from "./gcodeWriter";
import { type ArcMove, arcPoints, resolvePostOptions } from "./motion";

/**
 * Wire EDM in ISO code (Fanuc-W / Mitsubishi style). The start hole is declared with G92
 * (the operator sets the wire there), the wire offset and spark gap are already in the
 * path (G40), and 4-axis tapers are XYUV moves: U and V are the upper guide's offset from
 * the lower one in the UV plane (0 for a vertical wire). The wire is threaded at
 * `cutterOn` (M60) and cut at `cutterOff` (M50) to move to another start hole; a zero dwell
 * is a stop point (M00) — secure the slug before the last cut. The generator's servo
 * controls the cutting speed, so feeds are written only on request.
 */

const WIRE_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "programNumber", label: "Program number", kind: "integer", min: 1, max: 9999 },
    { key: "threadCode", label: "Thread wire code", kind: "string" },
    { key: "cutCode", label: "Cut wire code", kind: "string" },
    { key: "outputFeed", label: "Output feeds", kind: "boolean" },
    { key: "lineNumbers", label: "Line numbers", kind: "boolean" },
    { key: "comments", label: "Comments", kind: "boolean" },
];

class WirePostError extends Error {}

export class WireEdmPost implements PostProcessor {
    readonly id = "wire-iso";
    readonly name = "Wire EDM (ISO, Fanuc-W / Mitsubishi)";
    readonly machineKinds = ["wireEdm"] as const;
    readonly extension = ".iso";
    readonly parameters = WIRE_PARAMETERS;
    readonly defaultOptions: Readonly<Record<string, unknown>> = {
        programNumber: 1001,
        threadCode: "M60",
        cutCode: "M50",
        outputFeed: false,
        lineNumbers: false,
        comments: true,
    };

    post(program: CamProgram, options?: Readonly<Record<string, unknown>>): Result<string> {
        try {
            return Result.ok(writeWireProgram(program, resolvePostOptions(this, program, options)));
        } catch (error) {
            if (error instanceof WirePostError) return Result.err(error.message);
            throw error;
        }
    }
}

function writeWireProgram(program: CamProgram, options: Readonly<Record<string, unknown>>): string {
    const w = new GCodeWriter({
        format: { decimals: 4, forceDecimal: true },
        feedFormat: { decimals: 2, forceDecimal: true },
        comments: optionOf(options, "comments", true) ? "parens" : "none",
        uppercaseComments: true,
        lineNumbers: optionOf(options, "lineNumbers", false)
            ? { start: 10, increment: 10, max: 9999 }
            : false,
    });
    const moves = program.toolpaths.flatMap((path) => [
        ...(path.label ? [{ kind: "comment", text: path.label } as const] : []),
        ...path.moves,
    ]);
    const tapers = moves.some((move) => move.kind === "taper");
    const outputFeed = optionOf(options, "outputFeed", false);
    const feed = (value: number) => (outputFeed ? w.feed(value) : undefined);

    w.raw("%");
    const name = program.setup.programName ?? program.name;
    const number = /^\d+$/.test(name) ? Number(name) : optionOf(options, "programNumber", 1001);
    const label = w.commentText(/^\d+$/.test(name) ? program.name : name);
    w.raw(`O${String(number).padStart(4, "0")}${label ? ` ${label}` : ""}`);
    const wire = program.machine.wire;
    if (wire !== undefined) {
        w.comment(`Wire D=${w.num(wire.wireDiameter)} spark gap ${w.num(wire.sparkGap)} in the path`);
        if (tapers) {
            w.comment(
                `Program plane Z=${w.num(wire.programPlaneHeight)} UV plane Z=${w.num(wire.uvPlaneHeight)}`,
            );
        }
    }
    w.block("G90", "G40");
    w.block("G21");

    let position: Vec3 | undefined;
    let wireIn = false;
    let started = false;
    // The first threading happens at setup, by the operator: M60 only re-threads after a cut.
    let hasCutBefore = false;
    const uv = (upper: Vec3 | undefined, to: Vec3) =>
        tapers
            ? [
                  w.axis("U", upper === undefined ? 0 : upper[0] - to[0]),
                  w.axis("V", upper === undefined ? 0 : upper[1] - to[1]),
              ]
            : [];
    const start = (to: Vec3) => {
        // The start hole: the operator has the wire there; declare it instead of moving.
        w.block(
            "G92",
            w.axis("X", to[0], true),
            w.axis("Y", to[1], true),
            ...(tapers ? [w.axis("U", 0, true), w.axis("V", 0, true)] : []),
        );
        position = to;
        started = true;
    };

    const arc = (move: ArcMove) => {
        const from = position!;
        w.block(
            w.motion(move.clockwise ? "G2" : "G3"),
            w.axis("X", move.to[0]),
            w.axis("Y", move.to[1]),
            ...uv(undefined, move.to),
            w.word("I", move.center[0] - from[0]),
            w.word("J", move.center[1] - from[1]),
            feed(move.feed),
        );
        position = move.to;
    };

    const emit = (move: ToolpathMove): void => {
        switch (move.kind) {
            case "rapid":
                if (!started) {
                    start(move.to);
                    return;
                }
                if (wireIn)
                    throw new WirePostError(
                        "The wire must be cut (cutterOff) before a rapid to another start hole",
                    );
                w.block(
                    w.motion("G0"),
                    w.axis("X", move.to[0]),
                    w.axis("Y", move.to[1]),
                    ...uv(undefined, move.to),
                );
                position = move.to;
                return;
            case "linear":
            case "taper": {
                if (!started) start(position ?? [0, 0, 0]);
                const upper = move.kind === "taper" ? move.upper : undefined;
                const words = [w.axis("X", move.to[0]), w.axis("Y", move.to[1]), ...uv(upper, move.to)];
                if (words.some((word) => word !== undefined))
                    w.block(w.motion("G1"), ...words, feed(move.feed));
                position = move.to;
                return;
            }
            case "arc":
                if (position === undefined) throw new WirePostError("An arc cannot start a wire program");
                if (move.plane !== "XY") {
                    for (const point of arcPoints(position, move, 0.001)) {
                        w.block(
                            w.motion("G1"),
                            w.axis("X", point[0]),
                            w.axis("Y", point[1]),
                            ...uv(undefined, point),
                            feed(move.feed),
                        );
                        position = point;
                    }
                    return;
                }
                arc(move);
                return;
            case "cutterOn":
                if (!wireIn) {
                    if (!started && position !== undefined) start(position);
                    const code = optionOf(options, "threadCode", "M60");
                    if (code !== "" && started && hasCutBefore) w.block(code);
                    wireIn = true;
                }
                return;
            case "cutterOff":
                if (wireIn) {
                    const code = optionOf(options, "cutCode", "M50");
                    if (code !== "") w.block(code);
                    wireIn = false;
                    hasCutBefore = true;
                }
                return;
            case "dwell":
                if (move.seconds <= 0) w.block("M00");
                else w.block("G4", `P${w.num(move.seconds)}`);
                return;
            case "comment":
                w.comment(move.text);
                return;
            case "raw":
                w.raw(move.code);
                return;
            default:
                throw new WirePostError(`Wire EDM cannot write ${move.kind} moves`);
        }
    };
    for (const move of moves) emit(move);
    if (wireIn) {
        const code = optionOf(options, "cutCode", "M50");
        if (code !== "") w.block(code);
    }
    w.block("M02");
    w.raw("%");
    return w.toString();
}
