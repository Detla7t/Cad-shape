// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ToolData } from "./tool";

/**
 * Machine profiles: what a machine can do and how its programs are written. Every length is
 * in millimetres, every angle in degrees, feeds in mm/min, speeds in rpm.
 *
 * A profile is plain JSON (`MachineProfileData`) so a library, a document and an imported
 * file all hold the same shape; the machine's controller dialect lives in its post-processor
 * (`post.id`, see `post.ts`), not here.
 */

/** The families of machines CAM programs are made for. */
export type MachineKind =
    /** Milling machines and routers, 3 to 5 axes. */
    | "mill"
    /** Abrasive waterjets: 2D (and tilting-head 5-axis) cutting with a kerf. */
    | "waterjet"
    /** Plasma tables: 2D cutting, pierce delays, torch height control. */
    | "plasma"
    /** Laser cutters: 2D cutting/engraving with a kerf. */
    | "laser"
    /** Wire EDM: 2-axis contours, 4-axis (XYUV) tapers. */
    | "wireEdm"
    /** FDM 3D printers, sliced by the additive module (or PrusaSlicer). */
    | "printer";

export type LinearAxisName = "X" | "Y" | "Z" | "U" | "V" | "W";
export type RotaryAxisName = "A" | "B" | "C";

export interface LinearAxisData {
    readonly name: LinearAxisName;
    readonly min: number;
    readonly max: number;
}

export interface RotaryAxisData {
    readonly name: RotaryAxisName;
    /** Rotation axis direction in the machine frame (A ≈ X, B ≈ Y, C ≈ Z for most machines). */
    readonly direction: readonly [number, number, number];
    /** Degrees; omit both for continuous rotation. */
    readonly min?: number;
    readonly max?: number;
    /** Whether the axis tilts the table (work) or the head (tool). */
    readonly carrier: "table" | "head";
}

/**
 * How the rotary axes are chained, for 5-axis inverse kinematics: the pivot of the head
 * (tool tip to the rotation centre) or the table's rotation centre in the machine frame.
 */
export interface KinematicsData {
    readonly type: "table-table" | "head-head" | "head-table";
    /** Rotary axes from the machine base outwards, e.g. ["A", "C"] for a trunnion with a C table. */
    readonly chain: readonly RotaryAxisName[];
    /** Head pivot length (spindle nose to the rotary centre), for head kinematics. */
    readonly pivotLength?: number;
    /** Table rotation centre in machine coordinates, for table kinematics. */
    readonly tableCenter?: readonly [number, number, number];
    /** The controller handles tool-tip compensation (G43.4 / TRAORI / M128): post tool-tip coordinates. */
    readonly toolCenterPointControl?: boolean;
}

/** Thermal/abrasive cutting (waterjet, plasma, laser). */
export interface CuttingData {
    /** Width of the cut; toolpaths offset half of it from the part. */
    readonly kerf: number;
    readonly pierceDelay?: number;
    readonly pierceHeight?: number;
    readonly cutHeight?: number;
    /** Plasma torch height control available (and enabled by default). */
    readonly torchHeightControl?: boolean;
    /** Waterjet abrasive flow, kg/min. */
    readonly abrasiveRate?: number;
}

/** Wire EDM. */
export interface WireData {
    readonly wireDiameter: number;
    /** Spark gap (overburn) added to the wire radius for the offset. */
    readonly sparkGap: number;
    /** Largest taper angle the U/V axes reach. */
    readonly maxTaper: number;
    /** Height of the programmed (XY) plane and of the UV plane above the table. */
    readonly programPlaneHeight: number;
    readonly uvPlaneHeight: number;
}

/** FDM printers. */
export interface PrinterData {
    readonly bed: { readonly x: number; readonly y: number; readonly shape?: "rectangle" | "circle" };
    readonly maxHeight: number;
    readonly nozzleDiameter: number;
    readonly filamentDiameter: number;
    /** G-code dialect the printer firmware speaks. */
    readonly flavor: "marlin" | "prusa" | "klipper" | "reprapfirmware";
    /** PrusaSlicer printer preset this profile corresponds to (for its bundles and CLI). */
    readonly prusaSlicerPreset?: string;
}

export interface MachineProfileData {
    /** Stable id, e.g. "haas-vf2" or "prusa-mk4". */
    readonly id: string;
    readonly name: string;
    readonly vendor?: string;
    readonly kind: MachineKind;
    readonly linearAxes: readonly LinearAxisData[];
    readonly rotaryAxes?: readonly RotaryAxisData[];
    readonly kinematics?: KinematicsData;
    readonly spindle?: { readonly minRpm: number; readonly maxRpm: number; readonly powerKw?: number };
    readonly maxFeed: number;
    readonly rapidFeed: number;
    readonly cutting?: CuttingData;
    readonly wire?: WireData;
    readonly printer?: PrinterData;
    /** The post-processor writing this machine's programs, and its options. */
    readonly post: { readonly id: string; readonly options?: Readonly<Record<string, unknown>> };
    /** Tools the machine carries by default (a mill's carousel, a waterjet's nozzle). */
    readonly tools?: readonly ToolData[];
}

/** How many axes a profile can interpolate together: 3 for a plain mill, 5 for a trunnion. */
export function simultaneousAxes(profile: MachineProfileData): number {
    return (
        profile.linearAxes.filter((axis) => axis.name === "X" || axis.name === "Y" || axis.name === "Z")
            .length + (profile.rotaryAxes?.length ?? 0)
    );
}

const profiles = new Map<string, MachineProfileData>();

/** Adds a profile to the library (a later registration with the same id replaces it). */
export function registerMachineProfile(profile: MachineProfileData): void {
    profiles.set(profile.id, profile);
}

export function machineProfile(id: string): MachineProfileData | undefined {
    return profiles.get(id);
}

/** The library, optionally of one kind, by name. */
export function machineProfiles(kind?: MachineKind): MachineProfileData[] {
    return [...profiles.values()]
        .filter((profile) => kind === undefined || profile.kind === kind)
        .sort((a, b) => a.name.localeCompare(b.name));
}
