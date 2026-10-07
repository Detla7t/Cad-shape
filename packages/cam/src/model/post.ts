// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Result } from "@chili3d/core";
import type { MachineKind, MachineProfileData } from "./machine";
import type { SetupData } from "./setup";
import type { ToolData } from "./tool";
import type { ToolpathData } from "./toolpath";

/**
 * Post-processors turn a program (the toolpaths of one setup, in order) into the text a
 * controller runs: Fanuc/Haas/LinuxCNC/GRBL G-code for mills, EIA for plasma and waterjet
 * tables, ISO for wire EDM, Marlin/Prusa G-code for printers.
 */
export interface CamProgram {
    readonly name: string;
    readonly machine: MachineProfileData;
    readonly setup: SetupData;
    /** Every tool the toolpaths use, by id. */
    readonly tools: ReadonlyMap<string, ToolData>;
    readonly toolpaths: readonly ToolpathData[];
}

export interface PostProcessor {
    readonly id: string;
    readonly name: string;
    readonly machineKinds: readonly MachineKind[];
    /** File extension of its output, with the dot: ".nc", ".gcode", ".iso". */
    readonly extension: string;
    post(program: CamProgram, options?: Readonly<Record<string, unknown>>): Result<string>;
}

const posts = new Map<string, PostProcessor>();

export function registerPostProcessor(post: PostProcessor): void {
    posts.set(post.id, post);
}

export function postProcessor(id: string): PostProcessor | undefined {
    return posts.get(id);
}

export function postProcessors(kind?: MachineKind): PostProcessor[] {
    return [...posts.values()]
        .filter((post) => kind === undefined || post.machineKinds.includes(kind))
        .sort((a, b) => a.name.localeCompare(b.name));
}
