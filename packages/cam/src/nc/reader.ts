// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ToolpathData, Vec3 } from "../model/toolpath";
import { detectNcDialect, ncDialect } from "./dialects";
import { type BuiltToolpath, NcReader, type ReaderResult } from "./interpreter";
import type { NcDiagnostic, NcProgram, NcReadOptions, NcToolpath } from "./program";
import { ncStats } from "./stats";

/**
 * Reads an NC program (G-code) into machine-independent toolpaths: the dialect is detected
 * unless given, the program runs through the interpreter, and the result carries the
 * toolpaths split at tool changes with each move's source line, diagnostics and statistics.
 *
 * Where the machine's home is in the work offset is unknown, so reference returns (G28,
 * G53 Z0) and an unknown start height are drawn at the highest programmed Z: the program
 * runs with a provisional home height far above anything programmed, and the moves at it
 * are lowered once the highest programmed Z is known (or, when one of them went through a
 * tilted plane, the program runs once more with it).
 */
export function readNcProgram(text: string, options: NcReadOptions = {}): NcProgram {
    const requested = options.dialect;
    const detected = requested === undefined || requested === "auto";
    const dialectId = detected ? detectNcDialect(text) : requested;
    let result = new NcReader(text, dialectId, options, PROVISIONAL_HOME).run();
    let homeDiagnostic: NcDiagnostic | undefined;
    if (result.homeUsed && options.homeZ === undefined) {
        const homeZ = Number.isFinite(result.maxProgrammedZ) ? result.maxProgrammedZ : 0;
        if (result.homeInFrames) result = new NcReader(text, dialectId, options, homeZ).run();
        else lowerHome(result, homeZ - PROVISIONAL_HOME);
        if (result.toolpaths.some((path) => path.homeMoves.size > 0)) {
            homeDiagnostic = {
                line: 0,
                severity: "info",
                message: `Reference returns (G28/G53 …) are drawn at the highest programmed Z (${formatZ(homeZ)}): the machine's home in this work offset is unknown`,
                count: 1,
            };
        }
    }
    const dialect = ncDialect(dialectId);
    const toolpaths = programToolpaths(result);
    return {
        dialect: dialectId,
        detected,
        machineKind: dialect.machineKind,
        units: result.units ?? "mm",
        toolpaths,
        diagnostics:
            homeDiagnostic === undefined ? result.diagnostics : [homeDiagnostic, ...result.diagnostics],
        stats: ncStats(toolpaths, {
            machine: options.machine,
            printer: dialect.family === "printer",
            spindle: result.spindle,
            layers: result.layers,
        }),
        tools: result.tools,
        lineCount: result.lineCount,
        ...(result.programNumber === undefined ? {} : { programNumber: result.programNumber }),
        ...(result.name === undefined ? {} : { name: result.name }),
    };
}

function formatZ(z: number): string {
    return `Z${Number(z.toFixed(3))}`;
}

/** Above any programmed height: no programmed point coincides with it. */
const PROVISIONAL_HOME = 1e6;

const shiftZ = (point: Vec3, dz: number): Vec3 => [point[0], point[1], point[2] + dz];

/**
 * Moves the moves at the provisional home height by `dz`, then drops the rapids that end
 * up going nowhere (a retract to the height the program was already at).
 */
function lowerHome(result: ReaderResult, dz: number): void {
    for (const { path, index } of result.homeRelative) {
        const move = path.moves[index];
        switch (move.kind) {
            case "rapid":
            case "linear":
            case "extrude":
            case "taper":
                path.moves[index] = { ...move, to: shiftZ(move.to, dz) };
                break;
            case "arc":
                path.moves[index] = { ...move, to: shiftZ(move.to, dz), center: shiftZ(move.center, dz) };
                break;
            default:
                break;
        }
    }
    for (const path of result.toolpaths) {
        if (path.startAtHome && path.start !== undefined) path.start = shiftZ(path.start, dz);
        dropStillRapids(path);
    }
}

function dropStillRapids(path: BuiltToolpath): void {
    let at = path.start;
    let axis: Vec3 | undefined;
    const keep: number[] = [];
    path.moves.forEach((move, index) => {
        if (
            move.kind === "rapid" &&
            at !== undefined &&
            samePoint(at, move.to) &&
            sameDirection(axis, move.axis)
        ) {
            return;
        }
        keep.push(index);
        if ("to" in move) at = move.to;
        if (move.kind === "rapid" || move.kind === "linear") axis = move.axis;
    });
    if (keep.length === path.moves.length) return;
    const homes = new Set<number>();
    keep.forEach((index, next) => {
        if (path.homeMoves.has(index)) homes.add(next);
    });
    path.moves = keep.map((index) => path.moves[index]);
    path.lines = keep.map((index) => path.lines[index]);
    path.homeMoves = homes;
}

const samePoint = (a: Vec3, b: Vec3) =>
    Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9;

function sameDirection(a: Vec3 | undefined, b: Vec3 | undefined): boolean {
    if (a === undefined || b === undefined) return a === b;
    return Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12 && Math.abs(a[2] - b[2]) < 1e-12;
}

/** The reader's toolpaths as program toolpaths: `toolId` is "T<number>". */
export function programToolpaths(result: ReaderResult): NcToolpath[] {
    return result.toolpaths.map((built) => {
        const toolpath: ToolpathData = {
            toolId: `T${built.toolNumber}`,
            moves: built.moves,
            ...(built.spindleRpm === undefined ? {} : { spindleRpm: built.spindleRpm }),
            ...(built.coolant === undefined ? {} : { coolant: built.coolant }),
            ...(built.label === undefined ? {} : { label: built.label }),
        };
        return {
            toolpath,
            toolNumber: built.toolNumber,
            lines: built.lines,
            homeMoves: built.homeMoves,
            ...(built.start === undefined ? {} : { start: built.start }),
        };
    });
}

/** Every move of a program with its toolpath and line, in order (what playback walks). */
export function programMoves(program: NcProgram): { path: number; index: number; line: number }[] {
    const out: { path: number; index: number; line: number }[] = [];
    program.toolpaths.forEach((path, pathIndex) => {
        path.lines.forEach((line, index) => {
            out.push({ path: pathIndex, index, line });
        });
    });
    return out;
}
