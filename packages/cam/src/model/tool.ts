// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Cutting tools as plain JSON. Millimetres and degrees; feeds in mm/min, speeds in rpm.
 * Non-mill machines have a "tool" too, so every toolpath names one: a waterjet nozzle or
 * plasma torch (its kerf), a wire (its diameter), a printer nozzle.
 */
export type ToolKind =
    | "flatEndmill"
    | "ballEndmill"
    | "bullNose"
    | "chamfer"
    | "vBit"
    | "drill"
    | "spotDrill"
    | "tap"
    | "threadMill"
    | "engraver"
    | "slotCutter"
    | "jet"
    | "wire"
    | "nozzle";

export interface ToolData {
    readonly id: string;
    /** Pocket/turret number the post calls it by (T5). */
    readonly number: number;
    readonly name: string;
    readonly kind: ToolKind;
    readonly diameter: number;
    /** Bull nose corner radius; a ball is diameter / 2. */
    readonly cornerRadius?: number;
    /** Included angle of chamfer mills, V-bits, drills (118/135°) and spot drills. */
    readonly tipAngle?: number;
    readonly fluteLength?: number;
    readonly overallLength?: number;
    /** Stick-out from the holder: what collision checks use. */
    readonly stickout?: number;
    readonly holder?: { readonly diameter: number; readonly length: number };
    readonly flutes?: number;
    /** Thread pitch for taps and thread mills. */
    readonly pitch?: number;
    readonly cutting: ToolCuttingData;
}

export interface ToolCuttingData {
    readonly spindleRpm?: number;
    readonly feed: number;
    readonly plungeFeed?: number;
    readonly rampFeed?: number;
    /** Default axial depth per pass. */
    readonly stepdown?: number;
    /** Default radial engagement, mm. */
    readonly stepover?: number;
    readonly coolant?: "off" | "flood" | "mist" | "air" | "throughTool";
}

/** The radius that touches a vertical wall (what 2D offsets use). */
export function toolRadius(tool: ToolData): number {
    return tool.diameter / 2;
}

/** The corner radius of the tip: 0 for flat, diameter / 2 for ball. */
export function tipRadius(tool: ToolData): number {
    if (tool.kind === "ballEndmill") return tool.diameter / 2;
    if (tool.kind === "bullNose") return tool.cornerRadius ?? 0;
    return 0;
}
