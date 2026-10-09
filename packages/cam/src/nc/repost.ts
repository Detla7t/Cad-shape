// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import { type MachineKind, type MachineProfileData, machineProfiles } from "../model/machine";
import { type CamProgram, type PostProcessor, postProcessor } from "../model/post";
import type { SetupData } from "../model/setup";
import type { ToolData, ToolKind } from "../model/tool";
import type { ToolpathData } from "../model/toolpath";
import type { NcProgram, NcToolInfo } from "./program";

/**
 * Re-posting: a read program's toolpaths written again by any post — a Fanuc program for a
 * LinuxCNC mill, a plasma program for a waterjet. The toolpaths go as they were read, less
 * the reference returns the reader drew (the target post adds its own); tools come from the
 * program's T numbers and the tool table in its comments. The machine is the program's when
 * the post is for its kind, else a library profile the post is for.
 */

export interface RepostOptions {
    /** The program's machine; a library profile of the post's kind is used when it does not fit. */
    readonly machine?: MachineProfileData;
    /** Post options (the post's own defaults otherwise). */
    readonly options?: Readonly<Record<string, unknown>>;
    /** Program name (the `O` number when numeric). */
    readonly name?: string;
}

export interface RepostResult {
    readonly text: string;
    readonly post: PostProcessor;
    readonly machine: MachineProfileData;
}

const TOOL_KINDS: readonly [RegExp, ToolKind][] = [
    [/\bBALL\b/i, "ballEndmill"],
    [/\bBULL\b|\bCORNER RAD/i, "bullNose"],
    [/\bSPOT\b|\bCENTER DRILL\b/i, "spotDrill"],
    [/\bDRILL\b/i, "drill"],
    [/\bTAP\b/i, "tap"],
    [/\bCHAMFER\b/i, "chamfer"],
    [/\bV-?BIT\b/i, "vBit"],
    [/\bENGRAV/i, "engraver"],
    [/\bSLOT\b/i, "slotCutter"],
    [/\bTHREAD\b/i, "threadMill"],
];

/** A machine profile the post writes for: the given one when it fits, else one from the library. */
export function machineForPost(post: PostProcessor, machine?: MachineProfileData): MachineProfileData {
    if (machine !== undefined && post.machineKinds.includes(machine.kind)) return machine;
    const library = post.machineKinds.flatMap((kind) => machineProfiles(kind));
    const own = library.find((profile) => profile.post.id === post.id);
    if (own !== undefined) return own;
    if (library[0] !== undefined) return library[0];
    const kind: MachineKind = post.machineKinds[0] ?? "mill";
    return {
        id: `repost-${kind}`,
        name: `${post.name} machine`,
        kind,
        linearAxes: [],
        maxFeed: 10000,
        rapidFeed: 10000,
        post: { id: post.id },
    };
}

function toolFor(
    number: number,
    info: NcToolInfo | undefined,
    machine: MachineProfileData,
    path: ToolpathData,
): ToolData {
    const id = `T${number}`;
    const rpm = path.spindleRpm;
    const cutting = { feed: 1000, ...(rpm === undefined ? {} : { spindleRpm: rpm }) };
    switch (machine.kind) {
        case "plasma":
        case "waterjet":
        case "laser":
            return {
                id,
                number,
                name: info?.description || "Cutting head",
                kind: "jet",
                diameter: machine.cutting?.kerf ?? 1,
                cutting,
            };
        case "wireEdm":
            return {
                id,
                number,
                name: "Wire",
                kind: "wire",
                diameter: machine.wire?.wireDiameter ?? 0.25,
                cutting,
            };
        case "printer":
            return {
                id,
                number,
                name: "Nozzle",
                kind: "nozzle",
                diameter: machine.printer?.nozzleDiameter ?? 0.4,
                cutting,
            };
        default: {
            const description = info?.description ?? "";
            const kind = TOOL_KINDS.find(([pattern]) => pattern.test(description))?.[1] ?? "flatEndmill";
            return {
                id,
                number,
                name: description || `Tool ${number}`,
                kind,
                diameter: info?.diameter ?? 6,
                ...(info?.cornerRadius === undefined || info.cornerRadius <= 0
                    ? {}
                    : { cornerRadius: info.cornerRadius }),
                cutting,
            };
        }
    }
}

/** The program as a CAM program for `machine`: toolpaths without home moves, tools by T number. */
export function ncCamProgram(
    program: NcProgram,
    machine: MachineProfileData,
    name = program.name ?? "Program",
): CamProgram {
    const tools = new Map<string, ToolData>();
    const toolpaths: ToolpathData[] = program.toolpaths.map((path) => {
        // A program that never named its tool still needs one: T1.
        const number = path.toolNumber > 0 ? path.toolNumber : 1;
        const toolpath: ToolpathData = {
            ...path.toolpath,
            toolId: `T${number}`,
            moves: path.toolpath.moves.filter((_, index) => !path.homeMoves.has(index)),
        };
        if (!tools.has(toolpath.toolId)) {
            const info = program.tools.find((tool) => tool.number === number);
            tools.set(toolpath.toolId, toolFor(number, info, machine, toolpath));
        }
        return toolpath;
    });
    const programName = program.programNumber ?? name;
    const setup: SetupData = {
        id: "nc-program",
        name,
        machineId: machine.id,
        wcs: { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
        stock: { kind: "box", margin: { x: 0, y: 0, zTop: 0, zBottom: 0 } },
        partIds: [],
        operations: [],
        programName,
    };
    return { name, machine, setup, tools, toolpaths };
}

/** Writes a read program again with the post `postId`. */
export function repostNcProgram(
    program: NcProgram,
    postId: string,
    options: RepostOptions = {},
): Result<RepostResult> {
    const post = postProcessor(postId);
    if (post === undefined) return Result.err(`There is no post "${postId}"`);
    if (program.toolpaths.length === 0) return Result.err("The program has no toolpaths to post");
    const machine = machineForPost(post, options.machine);
    const camProgram = ncCamProgram(program, machine, options.name ?? program.name ?? "Program");
    const text = post.post(camProgram, options.options);
    if (!text.isOk) return Result.err(text.error);
    return Result.ok({ text: text.value, post, machine });
}
