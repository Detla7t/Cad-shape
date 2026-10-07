// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A toolpath: the machine-independent motion of one operation, in the setup's work
 * coordinate system (WCS), millimetres. Post-processors turn programs of toolpaths into
 * controller code; previews draw them; simulation replays them.
 *
 * Positions are of the tool tip (the programmed point). A 5-axis move also carries the tool
 * axis (unit vector from the tip towards the spindle, in WCS); the post solves the rotary
 * angles from it with the machine's kinematics. Without an axis the tool points along +Z.
 */

export type Vec3 = readonly [number, number, number];

export type ToolpathMove =
    /**
     * Positioning at rapid traverse. `feed` (mm/min) caps it where the machine travels at a
     * programmed speed rather than full rapid (a printer's travel speed); mills ignore it.
     */
    | { readonly kind: "rapid"; readonly to: Vec3; readonly axis?: Vec3; readonly feed?: number }
    /** Cutting move at `feed` (mm/min). */
    | { readonly kind: "linear"; readonly to: Vec3; readonly feed: number; readonly axis?: Vec3 }
    /**
     * Circular move in a principal plane, ending at `to`, around `center` (absolute WCS);
     * `clockwise` as seen from the plane's positive normal. A helix changes the normal coordinate.
     */
    | {
          readonly kind: "arc";
          readonly to: Vec3;
          readonly center: Vec3;
          readonly clockwise: boolean;
          readonly plane: "XY" | "ZX" | "YZ";
          readonly feed: number;
      }
    /** Wire EDM taper: the upper guide's (UV plane) position for the same instant as `to`. */
    | { readonly kind: "taper"; readonly to: Vec3; readonly upper: Vec3; readonly feed: number }
    | { readonly kind: "dwell"; readonly seconds: number }
    /** Mill drilling cycle at one hole (posts may expand it into moves). */
    | {
          readonly kind: "drill";
          readonly at: Vec3;
          readonly depth: number;
          readonly retract: number;
          readonly cycle: "drill" | "peck" | "chipBreak" | "tap" | "bore";
          readonly peck?: number;
          readonly dwell?: number;
          readonly feed: number;
      }
    /** Waterjet/plasma/laser beam on (after the pierce) and off. */
    | { readonly kind: "cutterOn"; readonly pierceDelay?: number }
    | { readonly kind: "cutterOff" }
    /** Printer extrusion: a linear move that also feeds `extrude` mm of filament (relative). */
    | { readonly kind: "extrude"; readonly to: Vec3; readonly extrude: number; readonly feed: number }
    /** Controller-specific code passed through verbatim (a printer's start G-code). */
    | { readonly kind: "raw"; readonly code: string }
    | { readonly kind: "comment"; readonly text: string };

export interface ToolpathData {
    /** The tool every move of this toolpath is cut with. */
    readonly toolId: string;
    readonly spindleRpm?: number;
    readonly coolant?: "off" | "flood" | "mist" | "air" | "throughTool";
    readonly moves: readonly ToolpathMove[];
    /** A note the post writes before the moves (the operation's name). */
    readonly label?: string;
}

/** The point a move ends at, if it moves. */
export function moveEnd(move: ToolpathMove): Vec3 | undefined {
    switch (move.kind) {
        case "rapid":
        case "linear":
        case "arc":
        case "taper":
        case "extrude":
            return move.to;
        case "drill":
            return move.at;
        default:
            return undefined;
    }
}

/** Total cutting length and rapid length, mm (arcs as chords — good enough for estimates). */
export function toolpathLength(path: ToolpathData): { cutting: number; rapid: number } {
    let cutting = 0;
    let rapid = 0;
    let at: Vec3 | undefined;
    for (const move of path.moves) {
        const end = moveEnd(move);
        if (end === undefined) continue;
        if (at !== undefined) {
            const d = Math.hypot(end[0] - at[0], end[1] - at[1], end[2] - at[2]);
            if (move.kind === "rapid") rapid += d;
            else cutting += d;
        }
        at = end;
    }
    return { cutting, rapid };
}
