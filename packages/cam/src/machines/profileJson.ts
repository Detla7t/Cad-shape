// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { MachineKind, MachineProfileData } from "../model/machine";
import type { ToolData, ToolKind } from "../model/tool";

/**
 * Machine profiles as files: export writes the profile JSON as is, import checks what a
 * hand-edited or foreign file must have before the studio trusts it (ids, kinds, axes,
 * feeds, the post, the tools), and accepts one profile or an array of them.
 */

export const MACHINE_KINDS: readonly MachineKind[] = [
    "mill",
    "waterjet",
    "plasma",
    "laser",
    "wireEdm",
    "printer",
];

export const TOOL_KINDS: readonly ToolKind[] = [
    "flatEndmill",
    "ballEndmill",
    "bullNose",
    "chamfer",
    "vBit",
    "drill",
    "spotDrill",
    "tap",
    "threadMill",
    "engraver",
    "slotCutter",
    "jet",
    "wire",
    "nozzle",
];

const LINEAR_AXES = ["X", "Y", "Z", "U", "V", "W"];
const ROTARY_AXES = ["A", "B", "C"];

/** The file a profile exports to (pretty JSON). */
export function exportMachineProfiles(profiles: readonly MachineProfileData[]): string {
    return `${JSON.stringify(profiles.length === 1 ? profiles[0] : profiles, null, 4)}\n`;
}

export function machineProfileFileName(profile: MachineProfileData): string {
    return `${profile.id.replace(/[^\w.-]+/g, "_")}.machine.json`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Reads one profile or an array of profiles from a file's text. */
export function importMachineProfiles(text: string): Result<MachineProfileData[]> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return Result.err(`Not a JSON file: ${error instanceof Error ? error.message : String(error)}`);
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const profiles: MachineProfileData[] = [];
    for (const [index, item] of items.entries()) {
        const checked = checkMachineProfile(item);
        if (!checked.isOk)
            return Result.err(items.length > 1 ? `Profile ${index + 1}: ${checked.error}` : checked.error);
        profiles.push(checked.value);
    }
    if (profiles.length === 0) return Result.err("The file holds no machine profile");
    return Result.ok(profiles);
}

/** Checks a value is a usable machine profile. */
export function checkMachineProfile(value: unknown): Result<MachineProfileData> {
    if (!isObject(value)) return Result.err("A machine profile is a JSON object");
    if (!isString(value["id"])) return Result.err("The profile has no id");
    if (!isString(value["name"])) return Result.err("The profile has no name");
    if (!MACHINE_KINDS.includes(value["kind"] as MachineKind)) {
        return Result.err(
            `Unknown machine kind "${String(value["kind"])}" (one of ${MACHINE_KINDS.join(", ")})`,
        );
    }
    const axes = value["linearAxes"];
    if (!Array.isArray(axes) || axes.length === 0) return Result.err("The profile has no linear axes");
    for (const axis of axes) {
        if (!isObject(axis) || !LINEAR_AXES.includes(axis["name"] as string))
            return Result.err("A linear axis has no valid name (X Y Z U V W)");
        if (!isNumber(axis["min"]) || !isNumber(axis["max"]) || axis["min"] > axis["max"]) {
            return Result.err(`Axis ${String(axis["name"])} needs min ≤ max`);
        }
    }
    for (const axis of (value["rotaryAxes"] as unknown[] | undefined) ?? []) {
        if (!isObject(axis) || !ROTARY_AXES.includes(axis["name"] as string))
            return Result.err("A rotary axis has no valid name (A B C)");
        const direction = axis["direction"];
        if (!Array.isArray(direction) || direction.length !== 3 || !direction.every(isNumber)) {
            return Result.err(`Rotary axis ${String(axis["name"])} needs a direction [x, y, z]`);
        }
        if (axis["carrier"] !== "table" && axis["carrier"] !== "head") {
            return Result.err(`Rotary axis ${String(axis["name"])} needs a carrier (table or head)`);
        }
    }
    if (!isNumber(value["maxFeed"]) || value["maxFeed"] <= 0)
        return Result.err("The profile needs a positive maxFeed");
    if (!isNumber(value["rapidFeed"]) || value["rapidFeed"] <= 0)
        return Result.err("The profile needs a positive rapidFeed");
    const post = value["post"];
    if (!isObject(post) || !isString(post["id"]))
        return Result.err("The profile names no post-processor (post.id)");
    const tools = value["tools"];
    if (tools !== undefined) {
        if (!Array.isArray(tools)) return Result.err("tools must be an array");
        for (const tool of tools) {
            const checked = checkTool(tool);
            if (!checked.isOk) return Result.err(checked.error);
        }
    }
    return Result.ok(value as unknown as MachineProfileData);
}

/** Checks a value is a usable tool. */
export function checkTool(value: unknown): Result<ToolData> {
    if (!isObject(value)) return Result.err("A tool is a JSON object");
    const name = isString(value["name"]) ? value["name"] : String(value["id"] ?? "?");
    if (!isString(value["id"])) return Result.err(`Tool "${name}" has no id`);
    if (!isNumber(value["number"])) return Result.err(`Tool "${name}" has no number`);
    if (!TOOL_KINDS.includes(value["kind"] as ToolKind))
        return Result.err(`Tool "${name}" has an unknown kind "${String(value["kind"])}"`);
    if (!isNumber(value["diameter"]) || value["diameter"] <= 0)
        return Result.err(`Tool "${name}" needs a positive diameter`);
    const cutting = value["cutting"];
    if (!isObject(cutting) || !isNumber(cutting["feed"]))
        return Result.err(`Tool "${name}" needs cutting.feed`);
    return Result.ok(value as unknown as ToolData);
}
