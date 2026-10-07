// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { StockToolData } from "@chili3d/rs";
import type { ToolData } from "../model/tool";

/**
 * A CAM tool as the stock simulator's profile: end mills flat, ball and bull nose; chamfer
 * mills, V-bits, engravers and spot drills cones of their tip angle; drills their point.
 * Slot cutters, thread mills and taps cut as the cylinder of their diameter (a Z-map has no
 * undercuts). The flutes are the tool's flute length, the holder its holder at the
 * stick-out (else the overall length, as the 3D strategies read it). Jets, wires and nozzles
 * remove no stock this way.
 */
export function stockToolFor(tool: ToolData): Result<StockToolData> {
    if (!(tool.diameter > 0)) return Result.err(`Tool "${tool.name}" has no diameter`);
    const base = {
        diameter: tool.diameter,
        fluteLength: tool.fluteLength !== undefined && tool.fluteLength > 0 ? tool.fluteLength : undefined,
        holder: holderOf(tool),
    };
    switch (tool.kind) {
        case "flatEndmill":
        case "slotCutter":
        case "threadMill":
        case "tap":
            return Result.ok({ ...base, kind: "flat" });
        case "ballEndmill":
            return Result.ok({ ...base, kind: "ball" });
        case "bullNose":
            return Result.ok({ ...base, kind: "bull", cornerRadius: tool.cornerRadius ?? 0 });
        case "chamfer":
        case "vBit":
        case "engraver":
        case "spotDrill":
            return Result.ok({ ...base, kind: "cone", angle: tool.tipAngle ?? 90 });
        case "drill":
            return Result.ok({ ...base, kind: "drill", angle: tool.tipAngle ?? 118 });
        default:
            return Result.err(`Tool "${tool.name}" (${tool.kind}) does not mill stock`);
    }
}

function holderOf(tool: ToolData): StockToolData["holder"] {
    const holder = tool.holder;
    const stickout = tool.stickout ?? tool.overallLength;
    if (holder === undefined || stickout === undefined || !(stickout > 0) || !(holder.diameter > 0)) {
        return undefined;
    }
    return { diameter: holder.diameter, length: holder.length > 0 ? holder.length : 40, stickout };
}
