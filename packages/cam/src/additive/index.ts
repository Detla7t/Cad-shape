// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger, Result } from "@chili3d/core";
import type { MachineProfileData } from "../model/machine";
import { registerPrinterOperations } from "./operations";
import { registerPrinterPosts } from "./posts";
import { BUILTIN_PRUSA_BUNDLE } from "./prusa/builtinProfiles";
import { type PrusaBundle, parsePrusaBundle, parsePrusaConfigText } from "./prusa/ini";
import { registerPrusaBundle } from "./prusa/library";

/**
 * 3D printing: PrusaSlicer profiles and projects, the local PrusaSlicer bridge client, the
 * built-in slicer, printer posts and the printer operations. Importing the CAM package
 * registers the built-in printer profiles, the posts and the operations.
 *
 * Only the module's API is exported here; geometry and value helpers stay internal (import
 * them from their files) so their generic names cannot collide with other CAM modules.
 */

export {
    type BridgeSliceRequest,
    type BridgeSliceResult,
    bridgeHealth,
    DEFAULT_BRIDGE_URL,
    gcodeToolpath,
    sliceWithBridge,
} from "./bridge";
export {
    DEFAULT_PRINT_KINEMATICS,
    estimatePrintTime,
    formatPrintDuration,
    type PrintKinematics,
    type PrintTimeEstimate,
} from "./gcode/estimate";
export {
    type GcodeStats,
    type ParsedGcode,
    parsePrinterGcode,
    printerGcodeStats,
    printerPreviewMoves,
} from "./gcode/parse";
export type { BedPlacement } from "./geometry/mesh";
export {
    jobSettingsFromParams,
    PRUSA_SLICER_OPERATION,
    prusaSlicerOperation,
    registerPrinterOperations,
    SLICE_OPERATION,
    sliceOperation,
    sliceSetup,
    sliceSetupWithPrusaSlicer,
    type ToolpathPrintStats,
    toolpathPrintStats,
} from "./operations";
export {
    isCompletePrinterProgram,
    KLIPPER_POST,
    MARLIN_POST,
    PRUSA_POST,
    registerPrinterPosts,
} from "./posts";
export { BUILTIN_PRUSA_BUNDLE } from "./prusa/builtinProfiles";
export {
    type PrusaBundle,
    type PrusaIniFile,
    type PrusaIniSection,
    type PrusaPreset,
    type PrusaPresetKind,
    parsePrusaBundle,
    parsePrusaConfigText,
    parsePrusaIni,
    presetsFromConfig,
    serializePrusaCommentedConfig,
    serializePrusaIni,
} from "./prusa/ini";
export {
    isPresetCompatible,
    machineForPrinterPreset,
    machineFromPrinterPreset,
    type PrinterPostOptions,
    type PrusaJob,
    type PrusaJobSettings,
    printerConfigOf,
    printerFlavor,
    printerPostOptions,
    printerPresetName,
    prusaPreset,
    prusaPresets,
    registerPrusaBundle,
    resolvePrusaJob,
    serializePrusaOption,
} from "./prusa/library";
export {
    evaluatePrusaCondition,
    expandPrusaMacros,
    type MacroResult,
    type MacroScope,
    type MacroValue,
    prusaMacroScope,
} from "./prusa/macro";
export {
    exportPrusaProject,
    type PrusaProject,
    type PrusaProjectObject,
    type PrusaProjectOptions,
    prusaJobIni,
    prusaProjectFiles,
    prusaProjectObjects,
    writePrusaProject,
} from "./prusa/project3mf";
export {
    DEFAULT_PRUSA_CONFIG,
    extrusionArea,
    extrusionSpacing,
    type InfillPattern,
    readSlicerSettings,
    type SlicerSettings,
} from "./prusa/settings";
export type { PrusaConfig } from "./prusa/values";
export {
    type PrintStats,
    printerKinematics,
    type SlicedLayer,
    type SlicePrintOptions,
    type SliceResult,
    slicePrint,
} from "./slicer/slicer";
export type { ExtrusionRole } from "./slicer/writer";

/**
 * Imports PrusaSlicer settings — a vendor or exported config bundle, a single exported .ini,
 * or a 3MF / G-code config block — into the preset library; its printers become machine
 * profiles.
 */
export function importPrusaConfig(
    text: string,
    name = "Imported",
): Result<{ bundle: PrusaBundle; machines: MachineProfileData[] }> {
    const bundle = parsePrusaConfigText(text, name);
    if (!bundle.isOk) return Result.err(bundle.error);
    return Result.ok({ bundle: bundle.value, machines: registerPrusaBundle(bundle.value) });
}

let registered = false;

/** Registers the built-in printer profiles, the printer posts and operations (once). */
export function registerAdditive(): void {
    if (registered) return;
    registered = true;
    registerPrinterPosts();
    registerPrinterOperations();
    const bundle = parsePrusaBundle(BUILTIN_PRUSA_BUNDLE);
    if (!bundle.isOk) {
        Logger.error(`CAM: built-in printer profiles: ${bundle.error}`);
        return;
    }
    for (const warning of bundle.value.warnings) Logger.warn(`CAM: built-in printer profiles: ${warning}`);
    registerPrusaBundle(bundle.value);
}

registerAdditive();
