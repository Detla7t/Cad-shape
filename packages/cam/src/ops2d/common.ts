// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MachineProfileData } from "../model/machine";
import type { CamOperationContext, CamParameterSpec } from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolData } from "../model/tool";
import type { ToolpathData } from "../model/toolpath";
import { stockTop } from "./geometry";
import type { MoveBuilder } from "./moves";
import type { ParamReader } from "./params";

/** Feeds and speeds of an operation: its parameters first, then the tool's cutting data. */
export interface Feeds {
    readonly feed: number;
    readonly plunge: number;
    readonly ramp: number;
    readonly rpm?: number;
    readonly coolant?: ToolpathData["coolant"];
}

export function feedsOf(p: ParamReader, tool: ToolData, machine?: MachineProfileData): Feeds {
    const cap = (f: number) =>
        machine !== undefined && machine.maxFeed > 0 ? Math.min(f, machine.maxFeed) : f;
    const feed = cap(p.num("feed", tool.cutting.feed));
    const plunge = cap(p.num("plungeFeed", tool.cutting.plungeFeed ?? feed / 3));
    const ramp = cap(p.num("rampFeed", tool.cutting.rampFeed ?? (feed + plunge) / 2));
    const rpm = p.optionalNum("spindleRpm") ?? tool.cutting.spindleRpm;
    const coolant = p.pick(
        "coolant",
        ["off", "flood", "mist", "air", "throughTool"] as const,
        tool.cutting.coolant ?? "off",
    );
    return { feed, plunge, ramp, ...(rpm !== undefined ? { rpm } : {}), coolant };
}

/** Feed and speed defaults from a tool, for `defaults()`. */
export function feedDefaults(tool?: ToolData): Record<string, unknown> {
    if (tool === undefined) return {};
    const feed = tool.cutting.feed;
    return {
        feed,
        plungeFeed: tool.cutting.plungeFeed ?? Math.round(feed / 3),
        ...(tool.cutting.spindleRpm !== undefined ? { spindleRpm: tool.cutting.spindleRpm } : {}),
        coolant: tool.cutting.coolant ?? "off",
    };
}

export const FEED_PARAMETERS: readonly CamParameterSpec[] = [
    { key: "feed", label: "Cutting feed", kind: "number", min: 0, description: "mm/min" },
    { key: "plungeFeed", label: "Plunge feed", kind: "number", min: 0, description: "mm/min" },
    { key: "spindleRpm", label: "Spindle speed", kind: "number", min: 0, description: "rpm" },
    {
        key: "coolant",
        label: "Coolant",
        kind: "enum",
        options: [
            { value: "off", label: "Off" },
            { value: "flood", label: "Flood" },
            { value: "mist", label: "Mist" },
            { value: "air", label: "Air" },
            { value: "throughTool", label: "Through tool" },
        ],
    },
];

/** Safe heights of a milling operation (absolute Z). */
export interface Heights {
    /** Rapids between features stay at or above this. */
    readonly clearance: number;
    /** Rapids between passes of one feature. */
    readonly retract: number;
    /** Top of the cut: material starts here. */
    readonly top: number;
}

export function heightsOf(p: ParamReader, context: CamOperationContext, top = stockTop(context)): Heights {
    const t = p.optionalNum("top") ?? top;
    const base = Math.max(t, stockTop(context));
    return {
        top: t,
        clearance: base + Math.max(0, p.num("clearance", 10)),
        retract: base + Math.max(0, p.num("retract", 2)),
    };
}

export const HEIGHT_PARAMETERS: readonly CamParameterSpec[] = [
    {
        key: "top",
        label: "Top",
        kind: "length",
        description: "Z where the material starts (empty: the stock top)",
    },
    {
        key: "clearance",
        label: "Clearance height",
        kind: "length",
        min: 0,
        description: "Above the stock top",
    },
    { key: "retract", label: "Retract height", kind: "length", min: 0, description: "Above the stock top" },
];

/**
 * Cutting levels from `top` down to `bottom`, at most `stepdown` apart and evenly spaced;
 * the last level is `bottom`. A final `finishStep` (when set) is taken as its own level.
 */
export function depthLevels(top: number, bottom: number, stepdown: number, finishStep = 0): number[] {
    const total = top - bottom;
    if (total <= 1e-9) return [];
    const step = stepdown > 1e-6 ? stepdown : total;
    const finish = finishStep > 1e-9 && finishStep < total ? finishStep : 0;
    const rough = total - finish;
    const n = Math.max(1, Math.ceil(rough / step - 1e-9));
    const levels: number[] = [];
    for (let i = 1; i <= n; i++) levels.push(top - (rough * i) / n);
    if (finish > 0) levels.push(bottom);
    levels[levels.length - 1] = bottom;
    return levels;
}

/** The toolpath record of a finished builder. */
export function toolpathOf(
    builder: MoveBuilder,
    operation: CamOperationData,
    context: CamOperationContext,
    feeds?: Feeds,
): ToolpathData {
    return builder.build({
        toolId: context.tool.id,
        label: operation.name,
        ...(feeds?.rpm !== undefined ? { spindleRpm: feeds.rpm } : {}),
        ...(feeds?.coolant !== undefined ? { coolant: feeds.coolant } : {}),
    });
}

export const LEAD_OPTIONS = [
    { value: "arc", label: "Arc" },
    { value: "line", label: "Line" },
    { value: "none", label: "None" },
] as const;
