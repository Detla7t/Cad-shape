// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { PrusaConfig } from "./values";
import { serializeStrings } from "./values";

/**
 * PrusaSlicer's INI files, in their three shapes:
 *
 * - a config bundle (a vendor bundle such as `PrusaResearch.ini`, or File → Export → Config
 *   Bundle): `[vendor]`, `[printer_model:MK4]` and `[print:…]` / `[filament:…]` /
 *   `[printer:…]` preset sections, presets inheriting from others through
 *   `inherits = *parent*; other` (parents applied left to right, then the preset's own keys;
 *   `*name*` presets are abstract building blocks, not shown);
 * - a single exported config (File → Export → Config): bare `key = value` lines holding the
 *   merged print, filament and printer settings, named by `print_settings_id`,
 *   `filament_settings_id` and `printer_settings_id`;
 * - the commented form PrusaSlicer embeds in G-code footers and in a 3MF's
 *   `Metadata/Slic3r_PE.config` (`; key = value`).
 */

export type PrusaPresetKind = "print" | "filament" | "printer";

export interface PrusaIniSection {
    /** `print`, `filament`, `printer`, `printer_model`, `vendor`, `presets`, … */
    readonly type: string;
    /** The part after the colon (empty for `[vendor]`). */
    readonly name: string;
    readonly values: Record<string, string>;
}

export interface PrusaIniFile {
    /** Keys before the first section (a single exported config keeps everything here). */
    readonly root: Record<string, string>;
    readonly sections: readonly PrusaIniSection[];
}

export interface ParseIniOptions {
    /** Lines are `; key = value` (G-code footer, 3MF config): strip the comment marker. */
    readonly commented?: boolean;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parsePrusaIni(text: string, options: ParseIniOptions = {}): PrusaIniFile {
    const root: Record<string, string> = {};
    const sections: PrusaIniSection[] = [];
    let current = root;
    for (const rawLine of text.split(/\r?\n/)) {
        let line = rawLine.trim();
        if (options.commented) {
            if (!line.startsWith(";")) continue;
            line = line.slice(1).trim();
        } else if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
        if (!options.commented && line.startsWith("[") && line.endsWith("]")) {
            const header = line.slice(1, -1);
            const colon = header.indexOf(":");
            const section: PrusaIniSection = {
                type: (colon < 0 ? header : header.slice(0, colon)).trim(),
                name: colon < 0 ? "" : header.slice(colon + 1).trim(),
                values: {},
            };
            sections.push(section);
            current = section.values;
            continue;
        }
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        if (!KEY.test(key)) continue;
        current[key] = line.slice(eq + 1).trim();
    }
    return { root, sections };
}

/** A resolved preset: its own keys over every ancestor's, without `inherits`. */
export interface PrusaPreset {
    readonly kind: PrusaPresetKind;
    readonly name: string;
    /** `*name*` presets only exist to be inherited from. */
    readonly abstract: boolean;
    readonly config: PrusaConfig;
    /** The bundle (vendor) the preset came from. */
    readonly vendor?: string;
}

export interface PrusaBundle {
    readonly vendor?: Readonly<Record<string, string>>;
    /** `[printer_model:…]` sections by model id. */
    readonly printerModels: ReadonlyMap<string, Readonly<Record<string, string>>>;
    readonly prints: ReadonlyMap<string, PrusaPreset>;
    readonly filaments: ReadonlyMap<string, PrusaPreset>;
    readonly printers: ReadonlyMap<string, PrusaPreset>;
    /** Problems found while resolving (missing parents, cycles); presets still resolve. */
    readonly warnings: readonly string[];
}

const PRESET_KINDS: readonly PrusaPresetKind[] = ["print", "filament", "printer"];

export const isAbstractPresetName = (name: string) =>
    name.length > 1 && name.startsWith("*") && name.endsWith("*");

/** Parses a config bundle and resolves every preset's inheritance chain. */
export function parsePrusaBundle(text: string): Result<PrusaBundle> {
    const file = parsePrusaIni(text);
    const presetSections = file.sections.filter((s) => PRESET_KINDS.includes(s.type as PrusaPresetKind));
    if (presetSections.length === 0) {
        return Result.err(
            "no [print:…], [filament:…] or [printer:…] sections — not a PrusaSlicer config bundle",
        );
    }
    const vendorSection = file.sections.find((s) => s.type === "vendor");
    const vendor = vendorSection?.values["name"];
    const printerModels = new Map<string, Record<string, string>>();
    for (const section of file.sections) {
        if (section.type === "printer_model") printerModels.set(section.name, section.values);
    }
    const warnings: string[] = [];
    const resolved: Record<PrusaPresetKind, Map<string, PrusaPreset>> = {
        print: new Map(),
        filament: new Map(),
        printer: new Map(),
    };
    for (const kind of PRESET_KINDS) {
        const own = new Map<string, Record<string, string>>();
        for (const section of presetSections)
            if (section.type === kind) own.set(section.name, section.values);
        const cache = new Map<string, Record<string, string>>();
        const resolve = (name: string, stack: readonly string[]): Record<string, string> => {
            const cached = cache.get(name);
            if (cached) return cached;
            const values = own.get(name);
            if (!values) {
                warnings.push(`${kind} "${stack[stack.length - 1]}" inherits a missing "${name}"`);
                return {};
            }
            if (stack.includes(name)) {
                warnings.push(`${kind} inheritance cycle: ${[...stack, name].join(" → ")}`);
                return {};
            }
            const merged: Record<string, string> = {};
            for (const parent of parseInherits(values["inherits"])) {
                Object.assign(merged, resolve(parent, [...stack, name]));
            }
            Object.assign(merged, values);
            delete merged["inherits"];
            cache.set(name, merged);
            return merged;
        };
        for (const name of own.keys()) {
            resolved[kind].set(name, {
                kind,
                name,
                abstract: isAbstractPresetName(name),
                config: resolve(name, []),
                vendor,
            });
        }
    }
    return Result.ok({
        vendor: vendorSection?.values,
        printerModels,
        prints: resolved.print,
        filaments: resolved.filament,
        printers: resolved.printer,
        warnings,
    });
}

/** `inherits = *common*; *PLA*` → parent names (quotes allowed). */
export function parseInherits(value: string | undefined): string[] {
    if (value === undefined) return [];
    return value
        .split(";")
        .map((name) => name.trim().replace(/^"(.*)"$/, "$1"))
        .filter((name) => name !== "");
}

/**
 * Which presets a key belongs to, for splitting a merged config (a single exported .ini, a
 * G-code footer) back into its print, filament and printer parts. Keys not listed are print
 * settings, as most are.
 */
const FILAMENT_KEYS = new Set([
    "bed_temperature",
    "bridge_fan_speed",
    "chamber_minimal_temperature",
    "chamber_temperature",
    "compatible_prints",
    "compatible_prints_condition",
    "cooling",
    "disable_fan_first_layers",
    "end_filament_gcode",
    "extrusion_multiplier",
    "fan_always_on",
    "fan_below_layer_time",
    "first_layer_bed_temperature",
    "first_layer_temperature",
    "full_fan_speed_layer",
    "idle_temperature",
    "inherits",
    "max_fan_speed",
    "min_fan_speed",
    "min_print_speed",
    "slowdown_below_layer_time",
    "start_filament_gcode",
    "temperature",
]);

const PRINTER_KEYS = new Set([
    "autoemit_temperature_commands",
    "bed_custom_model",
    "bed_custom_texture",
    "bed_shape",
    "before_layer_gcode",
    "between_objects_gcode",
    "binary_gcode",
    "color_change_gcode",
    "cooling_tube_length",
    "cooling_tube_retraction",
    "default_filament_profile",
    "default_print_profile",
    "deretract_speed",
    "end_gcode",
    "extruder_colour",
    "extruder_offset",
    "gcode_flavor",
    "high_current_on_filament_swap",
    "host_type",
    "layer_gcode",
    "max_layer_height",
    "max_print_height",
    "min_layer_height",
    "nozzle_diameter",
    "nozzle_high_flow",
    "pause_print_gcode",
    "printer_model",
    "printer_notes",
    "printer_settings_id",
    "printer_technology",
    "printer_variant",
    "remaining_times",
    "retract_before_travel",
    "retract_before_wipe",
    "retract_layer_change",
    "retract_length",
    "retract_length_toolchange",
    "retract_lift",
    "retract_lift_above",
    "retract_lift_below",
    "retract_restart_extra",
    "retract_restart_extra_toolchange",
    "retract_speed",
    "silent_mode",
    "single_extruder_multi_material",
    "start_gcode",
    "template_custom_gcode",
    "thumbnails",
    "thumbnails_format",
    "toolchange_gcode",
    "travel_lift_before_obstacle",
    "travel_max_lift",
    "travel_ramping_lift",
    "travel_slope",
    "use_firmware_retraction",
    "use_relative_e_distances",
    "use_volumetric_e",
    "variable_layer_height",
    "wipe",
    "z_offset",
]);

export function presetKindOfKey(key: string): PrusaPresetKind {
    if (key.startsWith("filament_") && key !== "filament_settings_id") return "filament";
    if (key === "filament_settings_id") return "filament";
    if (FILAMENT_KEYS.has(key)) return "filament";
    if (key.startsWith("machine_") || key.startsWith("printer_") || PRINTER_KEYS.has(key)) return "printer";
    if (key.startsWith("wipe_tower") || key === "print_settings_id") return "print";
    return "print";
}

const IDENTITY_KEYS = new Set(["print_settings_id", "filament_settings_id", "printer_settings_id"]);

/**
 * Splits a single exported config (or a 3MF/G-code config) into its three presets, named by
 * its `*_settings_id` keys (or `fallbackName`).
 */
export function presetsFromConfig(
    config: PrusaConfig,
    fallbackName = "Imported",
): Record<PrusaPresetKind, PrusaPreset> {
    const parts: Record<PrusaPresetKind, Record<string, string>> = { print: {}, filament: {}, printer: {} };
    for (const [key, value] of Object.entries(config)) {
        if (IDENTITY_KEYS.has(key) || key.endsWith("_cummulative") || key === "inherits") continue;
        parts[presetKindOfKey(key)][key] = value;
    }
    const filamentName = (config["filament_settings_id"] ?? "").replace(/^"([^"]*)".*$/, "$1");
    const name = (kind: PrusaPresetKind, value: string | undefined) =>
        value !== undefined && value.trim() !== "" ? value.trim() : `${fallbackName} ${kind}`;
    return {
        print: {
            kind: "print",
            name: name("print", config["print_settings_id"]),
            abstract: false,
            config: parts.print,
        },
        filament: {
            kind: "filament",
            name: name("filament", filamentName),
            abstract: false,
            config: parts.filament,
        },
        printer: {
            kind: "printer",
            name: name("printer", config["printer_settings_id"]),
            abstract: false,
            config: parts.printer,
        },
    };
}

/**
 * Reads any PrusaSlicer config text: a bundle (sections), a single exported .ini, or the
 * commented form of a 3MF / G-code footer.
 */
export function parsePrusaConfigText(text: string, fallbackName = "Imported"): Result<PrusaBundle> {
    const plain = parsePrusaIni(text);
    if (plain.sections.some((s) => PRESET_KINDS.includes(s.type as PrusaPresetKind)))
        return parsePrusaBundle(text);
    let config: Record<string, string> = plain.root;
    if (Object.keys(config).length === 0) config = parsePrusaIni(text, { commented: true }).root;
    if (Object.keys(config).length === 0) return Result.err("no PrusaSlicer settings found");
    const presets = presetsFromConfig(config, fallbackName);
    return Result.ok({
        printerModels: new Map(),
        prints: new Map([[presets.print.name, presets.print]]),
        filaments: new Map([[presets.filament.name, presets.filament]]),
        printers: new Map([[presets.printer.name, presets.printer]]),
        warnings: [],
    });
}

/** Options PrusaSlicer would not know (Chili3d's own bookkeeping in bundles). */
export const isChiliKey = (key: string) => key.startsWith("chili3d_");

/** A plain INI (what `prusa-slicer --load` reads), keys sorted. */
export function serializePrusaIni(config: PrusaConfig, header = "generated by Chili3d"): string {
    const lines = [`# ${header}`];
    for (const key of Object.keys(config).sort()) {
        if (isChiliKey(key)) continue;
        lines.push(`${key} = ${config[key]}`);
    }
    return `${lines.join("\n")}\n`;
}

/**
 * The commented form of a 3MF's `Metadata/Slic3r_PE.config`. PrusaSlicer reads it from the
 * last line upwards and stops at the first line that is not `; key = value` with a key of
 * three or more `[A-Za-z0-9_]` and a line of at least ten characters, and it never reads the
 * first line — so the header comes first and only lines satisfying those rules are written.
 */
export function serializePrusaCommentedConfig(config: PrusaConfig, header: string): string {
    const lines = [`; ${header}`, ""];
    for (const key of Object.keys(config).sort()) {
        if (isChiliKey(key) || !/^[A-Za-z][A-Za-z0-9_]{2,}$/.test(key)) continue;
        const line = `; ${key} = ${config[key].replace(/[\r\n]/g, "")}`;
        // A shorter line would end PrusaSlicer's scan and hide every key above it.
        if (line.length >= 10) lines.push(line);
    }
    return `${lines.join("\n")}\n`;
}

/** `filament_settings_id`-style string vector for one name. */
export const quotedName = (name: string) => serializeStrings([name]);
