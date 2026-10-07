// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import {
    type MachineProfileData,
    machineProfiles,
    type PrinterData,
    registerMachineProfile,
} from "../../model/machine";
import type { ToolData } from "../../model/tool";
import { type PrusaBundle, type PrusaPreset, type PrusaPresetKind, quotedName } from "./ini";
import { evaluatePrusaCondition, prusaMacroScope } from "./macro";
import { bedRectangle } from "./settings";
import {
    escapeString,
    firstNumber,
    formatNumber,
    type PrusaConfig,
    parsePoints,
    parseStrings,
    serializePoints,
    unescapeString,
} from "./values";

/**
 * The PrusaSlicer preset library: print, filament and printer presets from config bundles,
 * printer presets mapped to CAM machine profiles (registered in the machine library), the
 * compatibility rules between them, and the merged config of one print job.
 */

const libraries: Record<PrusaPresetKind, Map<string, PrusaPreset>> = {
    print: new Map(),
    filament: new Map(),
    printer: new Map(),
};

/** What a printer machine profile's `post.options` carries (the printer posts read it too). */
export interface PrinterPostOptions {
    /** The PrusaSlicer printer preset name. */
    readonly printerPreset?: string;
    /** The printer preset's resolved config (serialized values). */
    readonly printerConfig?: PrusaConfig;
    readonly defaultPrint?: string;
    readonly defaultFilament?: string;
    /** Plain-text start/end G-code overriding the preset's. */
    readonly startGcode?: string;
    readonly endGcode?: string;
    /** URL of the local PrusaSlicer bridge (`scripts/prusa-slicer-bridge.mjs`). */
    readonly prusaSlicerBridgeUrl?: string;
    // Post-processor options (machine options, overridable per post call):
    /** mm/min for travels that carry no feed (default: the machine's rapid feed). */
    readonly travelFeed?: number;
    /** M73 progress lines (default: on for Prusa, off for Marlin and Klipper). */
    readonly progress?: boolean;
    /** Prusa M862.3/M862.1 printer and nozzle checks: "auto" adds them when the program has none. */
    readonly printerChecks?: "auto" | boolean;
    /** Klipper SET_PRINT_STATS_INFO layer lines (default on). */
    readonly layerInfo?: boolean;
}

export function printerPostOptions(machine: MachineProfileData): PrinterPostOptions {
    return (machine.post.options ?? {}) as PrinterPostOptions;
}

/** Adds a bundle's presets; its printers become machine profiles unless `machines` is false. */
export function registerPrusaBundle(
    bundle: PrusaBundle,
    options: { readonly machines?: boolean } = {},
): MachineProfileData[] {
    for (const preset of bundle.prints.values()) libraries.print.set(preset.name, preset);
    for (const preset of bundle.filaments.values()) libraries.filament.set(preset.name, preset);
    for (const preset of bundle.printers.values()) libraries.printer.set(preset.name, preset);
    if (options.machines === false) return [];
    const machines: MachineProfileData[] = [];
    for (const preset of bundle.printers.values()) {
        if (preset.abstract || (preset.config["printer_technology"] ?? "FFF") !== "FFF") continue;
        const machine = machineFromPrinterPreset(preset, bundle);
        registerMachineProfile(machine);
        machines.push(machine);
    }
    return machines;
}

export function prusaPreset(kind: PrusaPresetKind, name: string): PrusaPreset | undefined {
    return libraries[kind].get(name);
}

/** Whether a print or filament preset may be used with a printer (and a print, for filaments). */
export function isPresetCompatible(
    preset: PrusaPreset,
    printerName: string,
    printerConfig: PrusaConfig,
    printConfig?: PrusaConfig,
): boolean {
    if (preset.kind === "printer") return true;
    const listed = parseStrings(preset.config["compatible_printers"] ?? "");
    if (listed.length > 0) {
        if (!listed.includes(printerName)) return false;
    } else {
        const condition = unescapeString(preset.config["compatible_printers_condition"] ?? "");
        if (!evaluatePrusaCondition(condition, prusaMacroScope(printerConfig)).value) return false;
    }
    if (preset.kind === "filament" && printConfig) {
        const prints = parseStrings(preset.config["compatible_prints"] ?? "");
        const name = printConfig["print_settings_id"] ?? "";
        if (prints.length > 0) return prints.includes(name);
        const condition = unescapeString(preset.config["compatible_prints_condition"] ?? "");
        return evaluatePrusaCondition(condition, prusaMacroScope(printConfig)).value;
    }
    return true;
}

/** Visible presets of a kind, optionally only those compatible with a machine, by name. */
export function prusaPresets(kind: PrusaPresetKind, machine?: MachineProfileData): PrusaPreset[] {
    const all = [...libraries[kind].values()].filter((preset) => !preset.abstract);
    const result =
        machine === undefined
            ? all
            : all.filter((preset) =>
                  isPresetCompatible(preset, printerPresetName(machine), printerConfigOf(machine)),
              );
    return result.sort((a, b) => a.name.localeCompare(b.name));
}

const slug = (text: string) =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

/** The firmware dialect a printer preset implies. */
export function printerFlavor(config: PrusaConfig): PrinterData["flavor"] {
    const flavor = (config["gcode_flavor"] ?? "marlin2").trim();
    if (flavor === "klipper") return "klipper";
    if (flavor === "reprapfirmware") return "reprapfirmware";
    const notes = unescapeString(config["printer_notes"] ?? "");
    if (/PRINTER_VENDOR_PRUSA3D/.test(notes)) return "prusa";
    return "marlin";
}

const POSTS: Record<PrinterData["flavor"], string> = {
    marlin: "marlin",
    prusa: "prusa",
    klipper: "klipper",
    reprapfirmware: "marlin",
};

/** A CAM machine profile for a PrusaSlicer printer preset. */
export function machineFromPrinterPreset(preset: PrusaPreset, bundle?: PrusaBundle): MachineProfileData {
    const config = preset.config;
    const shape = parsePoints(config["bed_shape"]);
    const rect = bedRectangle(shape);
    const width = rect.max[0] - rect.min[0];
    const depth = rect.max[1] - rect.min[1];
    const maxHeight = firstNumber(config["max_print_height"], 200);
    const nozzle = firstNumber(config["nozzle_diameter"], 0.4);
    const defaultFilament = parseStrings(config["default_filament_profile"] ?? "")[0];
    const filamentPreset = defaultFilament
        ? (bundle?.filaments.get(defaultFilament) ?? libraries.filament.get(defaultFilament))
        : undefined;
    const filamentDiameter = firstNumber(filamentPreset?.config["filament_diameter"], 1.75);
    const flavor = printerFlavor(config);
    const maxFeed =
        60 *
        Math.min(
            firstNumber(config["machine_max_feedrate_x"], 200),
            firstNumber(config["machine_max_feedrate_y"], 200),
        );
    const tool: ToolData = {
        id: `nozzle-${formatNumber(nozzle)}`,
        number: 0,
        name: `${formatNumber(nozzle)} mm nozzle`,
        kind: "nozzle",
        diameter: nozzle,
        cutting: { feed: 60 * 60 },
    };
    const options: PrinterPostOptions = {
        printerPreset: preset.name,
        printerConfig: config,
        defaultPrint: unescapeString(config["default_print_profile"] ?? "") || undefined,
        defaultFilament: defaultFilament || undefined,
    };
    const round = shape.length > 8;
    return {
        id: config["chili3d_machine_id"]?.trim() || `prusaslicer-${slug(preset.name)}`,
        name: preset.name,
        vendor: config["chili3d_vendor"]?.trim() || bundle?.vendor?.["name"] || preset.vendor,
        kind: "printer",
        linearAxes: [
            { name: "X", min: rect.min[0], max: rect.max[0] },
            { name: "Y", min: rect.min[1], max: rect.max[1] },
            { name: "Z", min: 0, max: maxHeight },
        ],
        maxFeed,
        rapidFeed: maxFeed,
        printer: {
            bed: { x: width, y: depth, shape: round ? "circle" : "rectangle" },
            maxHeight,
            nozzleDiameter: nozzle,
            filamentDiameter,
            flavor,
            prusaSlicerPreset: preset.name,
        },
        post: { id: POSTS[flavor], options: options as Readonly<Record<string, unknown>> },
        tools: [tool],
    };
}

const FLAVOR_GCODE: Record<PrinterData["flavor"], string> = {
    marlin: "marlin2",
    prusa: "marlin2",
    klipper: "klipper",
    reprapfirmware: "reprapfirmware",
};

/**
 * The printer config of a machine: its preset's (start/end G-code replaced by the machine's
 * own when it has them), or one derived from the machine's printer data.
 */
export function printerConfigOf(machine: MachineProfileData): PrusaConfig {
    const options = printerPostOptions(machine);
    let config: Record<string, string>;
    if (options.printerConfig && typeof options.printerConfig === "object")
        config = { ...options.printerConfig };
    else {
        const printer = machine.printer;
        const x = machine.linearAxes.find((axis) => axis.name === "X");
        const y = machine.linearAxes.find((axis) => axis.name === "Y");
        const x0 = x?.min ?? 0;
        const y0 = y?.min ?? 0;
        const x1 = x?.max ?? printer?.bed.x ?? 200;
        const y1 = y?.max ?? printer?.bed.y ?? 200;
        config = {
            printer_technology: "FFF",
            bed_shape: serializePoints([
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
            ]),
            max_print_height: formatNumber(printer?.maxHeight ?? 200),
            nozzle_diameter: formatNumber(printer?.nozzleDiameter ?? 0.4),
            gcode_flavor: FLAVOR_GCODE[printer?.flavor ?? "marlin"],
            printer_notes: printer?.flavor === "prusa" ? "PRINTER_VENDOR_PRUSA3D" : "",
        };
    }
    if (options.startGcode !== undefined) config["start_gcode"] = escapeString(options.startGcode);
    if (options.endGcode !== undefined) config["end_gcode"] = escapeString(options.endGcode);
    return config;
}

export function printerPresetName(machine: MachineProfileData): string {
    return printerPostOptions(machine).printerPreset ?? machine.printer?.prusaSlicerPreset ?? machine.name;
}

/** What a print job uses: presets by name and option overrides (PrusaSlicer keys). */
export interface PrusaJobSettings {
    /** Print preset name; default: the printer's default print profile, else the first compatible. */
    readonly print?: string;
    readonly filament?: string;
    /** Option overrides over the merged presets (serialized text, or numbers/booleans). */
    readonly overrides?: Readonly<Record<string, string | number | boolean | undefined>>;
    /** Per-object option overrides (the 3MF's object settings), by object index. */
    readonly objectSettings?: readonly (Readonly<Record<string, string | number | boolean>> | undefined)[];
    /** Object names for the 3MF (default: the parts' node names). */
    readonly objectNames?: readonly string[];
    readonly placement?: "auto" | "keep" | "center";
}

export interface PrusaJob {
    /** The merged config: print, then filament, then printer, then ids, then overrides. */
    readonly config: PrusaConfig;
    readonly printPreset?: string;
    readonly filamentPreset?: string;
    readonly printerPreset: string;
    readonly warnings: readonly string[];
}

/** Serializes an override value the way PrusaSlicer writes options. */
export function serializePrusaOption(value: string | number | boolean): string {
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "number") return formatNumber(value);
    return value;
}

function pickPreset(
    kind: "print" | "filament",
    requested: string | undefined,
    fallback: string | undefined,
    printerName: string,
    printer: PrusaConfig,
    print: PrusaConfig | undefined,
    warnings: string[],
): PrusaPreset | undefined {
    if (requested) {
        const preset = libraries[kind].get(requested);
        if (preset) {
            if (!isPresetCompatible(preset, printerName, printer, print)) {
                warnings.push(`${kind} preset "${requested}" is not marked compatible with "${printerName}"`);
            }
            return preset;
        }
        warnings.push(`unknown ${kind} preset "${requested}"`);
    }
    if (fallback) {
        const preset = libraries[kind].get(fallback);
        if (preset && isPresetCompatible(preset, printerName, printer, print)) return preset;
    }
    return [...libraries[kind].values()]
        .filter((preset) => !preset.abstract && isPresetCompatible(preset, printerName, printer, print))
        .sort((a, b) => a.name.localeCompare(b.name))[0];
}

/** Resolves the presets of a job on a machine into one PrusaSlicer config. */
export function resolvePrusaJob(
    machine: MachineProfileData,
    settings: PrusaJobSettings = {},
): Result<PrusaJob> {
    if (machine.kind !== "printer") return Result.err(`"${machine.name}" is not a 3D printer`);
    const warnings: string[] = [];
    const printer = printerConfigOf(machine);
    const printerName = printerPresetName(machine);
    const options = printerPostOptions(machine);
    const print = pickPreset(
        "print",
        settings.print,
        options.defaultPrint,
        printerName,
        printer,
        undefined,
        warnings,
    );
    const printConfig = print ? { ...print.config, print_settings_id: print.name } : undefined;
    const filament = pickPreset(
        "filament",
        settings.filament,
        options.defaultFilament,
        printerName,
        printer,
        printConfig,
        warnings,
    );
    if (!print) warnings.push("no print preset: PrusaSlicer defaults apply");
    if (!filament) warnings.push("no filament preset: PrusaSlicer defaults apply");
    const config: Record<string, string> = {
        printer_technology: "FFF",
        ...(print?.config ?? {}),
        ...(filament?.config ?? {}),
        ...printer,
    };
    for (const key of [
        "compatible_printers",
        "compatible_printers_condition",
        "compatible_prints",
        "compatible_prints_condition",
        "inherits",
        "renamed_from",
        "default_print_profile",
        "default_filament_profile",
    ]) {
        delete config[key];
    }
    config["print_settings_id"] = print?.name ?? "";
    config["filament_settings_id"] = quotedName(filament?.name ?? "");
    config["printer_settings_id"] = printerName;
    for (const [key, value] of Object.entries(settings.overrides ?? {})) {
        if (value !== undefined) config[key] = serializePrusaOption(value);
    }
    return Result.ok({
        config,
        printPreset: print?.name,
        filamentPreset: filament?.name,
        printerPreset: printerName,
        warnings,
    });
}

/** The registered printer machine whose preset has this name. */
export function machineForPrinterPreset(name: string): MachineProfileData | undefined {
    return machineProfiles("printer").find((machine) => printerPresetName(machine) === name);
}
