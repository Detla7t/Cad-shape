// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MachineKind, MachineProfileData } from "../model/machine";
import type { CamOperationData, SetupData } from "../model/setup";
import type { ToolData, ToolKind } from "../model/tool";

/**
 * A setup's tool library: the machine's tools, with the setup's own tools added — a setup
 * tool with a machine tool's id overrides it (a different stick-out, feeds for this job).
 */
export function setupTools(setup: SetupData, machine: MachineProfileData): ToolData[] {
    const own = new Map((setup.tools ?? []).map((tool) => [tool.id, tool]));
    const merged = (machine.tools ?? []).map((tool) => own.get(tool.id) ?? tool);
    const machineIds = new Set((machine.tools ?? []).map((tool) => tool.id));
    for (const tool of setup.tools ?? []) if (!machineIds.has(tool.id)) merged.push(tool);
    return merged;
}

const DEFAULT_TOOL_KIND: Record<MachineKind, ToolKind> = {
    mill: "flatEndmill",
    waterjet: "jet",
    plasma: "jet",
    laser: "jet",
    wireEdm: "wire",
    printer: "nozzle",
};

/** The tool a machine without tools cuts with: its kerf, wire or nozzle. */
export function defaultTool(machine: MachineProfileData): ToolData {
    const diameter =
        machine.cutting?.kerf ?? machine.wire?.wireDiameter ?? machine.printer?.nozzleDiameter ?? 6;
    return {
        id: "default",
        number: 1,
        name: "Default",
        kind: DEFAULT_TOOL_KIND[machine.kind],
        diameter,
        cutting: { feed: Math.min(machine.maxFeed, 1000), spindleRpm: machine.spindle?.maxRpm },
    };
}

/** The operation's tool: its `toolId`, else the library's first tool, else the machine's default. */
export function operationTool(
    setup: SetupData,
    machine: MachineProfileData,
    operation: Pick<CamOperationData, "toolId">,
): ToolData {
    const tools = setupTools(setup, machine);
    return tools.find((tool) => tool.id === operation.toolId) ?? tools[0] ?? defaultTool(machine);
}

/** A tool id no tool of the library uses yet. */
export function nextToolId(tools: readonly ToolData[]): string {
    const ids = new Set(tools.map((tool) => tool.id));
    for (let n = tools.length + 1; ; n++) {
        const id = `t${n}`;
        if (!ids.has(id)) return id;
    }
}

export function nextToolNumber(tools: readonly ToolData[]): number {
    return tools.reduce((max, tool) => Math.max(max, tool.number), 0) + 1;
}
