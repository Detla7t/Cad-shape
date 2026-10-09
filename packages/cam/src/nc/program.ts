// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MachineKind, MachineProfileData } from "../model/machine";
import type { ToolpathData, Vec3 } from "../model/toolpath";

/**
 * What the NC reader makes of a program: the machine-independent toolpaths of
 * `model/toolpath.ts` (WCS, millimetres) split at tool changes, each move mapped to the
 * line it came from, the diagnostics, and statistics. Line numbers are 1-based, as an
 * editor shows them.
 */

/** Controller dialects the reader speaks. `heidenhain` is only recognized (and refused). */
export type NcDialectId =
    | "fanuc"
    | "haas"
    | "linuxcnc"
    | "mach3"
    | "grbl"
    | "siemens"
    | "marlin"
    | "klipper"
    | "prusa"
    | "plasma"
    | "waterjet"
    | "laser"
    | "wire"
    | "heidenhain";

export type NcSeverity = "error" | "warning" | "info";

export interface NcDiagnostic {
    /** First line it applies to (1-based; 0 for the whole program). */
    readonly line: number;
    readonly severity: NcSeverity;
    readonly message: string;
    /** How many lines reported the same thing (the first is `line`). */
    readonly count: number;
}

/** One tool's run: the toolpath and, per move, where it came from. */
export interface NcToolpath {
    readonly toolpath: ToolpathData;
    /** The T number (0 when the program never says which tool is in the spindle). */
    readonly toolNumber: number;
    /** The source line of each move (parallel to `toolpath.moves`). */
    readonly lines: readonly number[];
    /**
     * Indexes of moves the controller makes on its own rather than to a programmed point:
     * reference returns (G28/G30, G53 to an unknown machine position). Re-posting drops them.
     */
    readonly homeMoves: ReadonlySet<number>;
    /** The position the toolpath starts from; undefined when the program never said. */
    readonly start?: Vec3;
}

/** A tool the program describes in its comments (`(T1 D=6. FLAT ENDMILL)`). */
export interface NcToolInfo {
    readonly number: number;
    readonly description: string;
    readonly diameter?: number;
    readonly cornerRadius?: number;
}

export interface NcBounds {
    readonly min: Vec3;
    readonly max: Vec3;
}

export interface NcStats {
    /** Feed motion length, mm (arcs and helices at their true length). */
    readonly cuttingLength: number;
    readonly rapidLength: number;
    /** Seconds at the programmed feeds (capped by the machine's `maxFeed` when known). */
    readonly cuttingTime: number;
    /** Seconds at the machine's rapid rate (`rapidFeed`, or a 5 m/min assumption). */
    readonly rapidTime: number;
    readonly dwellTime: number;
    readonly totalTime: number;
    /** No machine profile: rapids and feeds were timed with assumed limits. */
    readonly timeAssumed: boolean;
    /** Every position the program reaches (home moves excluded). */
    readonly bounds?: NcBounds;
    /** Positions of feed moves only. */
    readonly cutBounds?: NcBounds;
    /** Tool numbers in order of first use. */
    readonly tools: readonly number[];
    readonly toolChanges: number;
    /** Spindle speeds (rpm) the program runs at (power for lasers). */
    readonly spindle?: { readonly min: number; readonly max: number };
    readonly feed?: { readonly min: number; readonly max: number };
    readonly moves: number;
    /** Printers: filament fed (mm, retractions subtracted) and layer changes. */
    readonly filament?: number;
    readonly layers?: number;
}

export interface NcProgram {
    readonly dialect: NcDialectId;
    /** Whether `dialect` was detected (true) or given by the caller. */
    readonly detected: boolean;
    readonly machineKind: MachineKind;
    /** Units the program is written in (the first G20/G21; mm when it never says). Moves are always mm. */
    readonly units: "mm" | "inch";
    readonly toolpaths: readonly NcToolpath[];
    readonly diagnostics: readonly NcDiagnostic[];
    readonly stats: NcStats;
    readonly tools: readonly NcToolInfo[];
    readonly lineCount: number;
    /** `O1234` program number / name when the program has one. */
    readonly programNumber?: string;
    readonly name?: string;
}

export interface NcReadOptions {
    /** The dialect; detected from the text when absent or "auto". */
    readonly dialect?: NcDialectId | "auto";
    /**
     * The machine the program is for: rotary words become tool axes through its kinematics,
     * wire EDM U/V become upper guide positions at its UV plane, times use its feed limits.
     */
    readonly machine?: MachineProfileData;
    /** Work offset origins in machine coordinates, by code ("G54", "G55", "G54.1 P3"), mm. */
    readonly workOffsets?: Readonly<Record<string, Vec3>>;
    /** WCS position the program starts at; mills default to the reference (home) height. */
    readonly start?: Vec3;
    /** Feed in effect at the start, mm/min (printers: 3000, as firmware defaults to). */
    readonly feed?: number;
    /** WCS height of the machine's Z reference point; default: the highest programmed Z. */
    readonly homeZ?: number;
    /** Gauge lengths by T number, for head kinematics without tool centre point control. */
    readonly toolLengths?: Readonly<Record<number, number>>;
    /** Stop after this many executed blocks (macro loops); default 5 000 000. */
    readonly maxBlocks?: number;
}
