// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MachineKind } from "../model/machine";
import type { NcDialectId } from "./program";

/**
 * What the reader needs to know about a controller family: which machine kind it drives,
 * how a dwell's P is timed, what its M codes mean (coolant, beam/torch/wire on and off,
 * printer extrusion modes), how a tool change is spelled, and which posts write it. The
 * dialect of a program is detected from its text (`detectNcDialect`) unless chosen.
 */

export type DwellUnits =
    /** P in milliseconds, X/U in seconds (Fanuc). */
    | "fanuc"
    /** P with a decimal point in seconds, without one in milliseconds (Haas). */
    | "haas"
    /** P in seconds (LinuxCNC, Mach3, GRBL, cutting tables). */
    | "seconds"
    /** F in seconds (Siemens G4 F). */
    | "siemens"
    /** P milliseconds, S seconds (Marlin, Klipper, Prusa). */
    | "printer";

export type NcCoolant = "flood" | "mist" | "air" | "throughTool";

export interface NcDialect {
    readonly id: NcDialectId;
    readonly name: string;
    readonly machineKind: MachineKind;
    readonly family: "mill" | "printer" | "cutting" | "wire" | "conversational";
    readonly dwell: DwellUnits;
    /** M code → coolant on; `off` codes switch it off. */
    readonly coolantOn: Readonly<Record<number, NcCoolant>>;
    readonly coolantOff: readonly number[];
    /** Beam/torch/jet on and off (cutting); wire thread/cut (wire EDM). */
    readonly beamOn?: readonly number[];
    readonly beamOff?: readonly number[];
    /** M codes known to the dialect that do nothing to the path (torch height control, …). */
    readonly passive?: readonly number[];
    /** A manual change (no changer): a "Tool change: Tn" comment and M0 change the tool. */
    readonly manualToolChange?: boolean;
    /** Siemens: G70/G71 (G700/G710) are inch/metric. */
    readonly siemensUnits?: boolean;
    /** Posts writing this dialect (the first is its own). */
    readonly posts: readonly string[];
}

const MILL_COOLANT: Readonly<Record<number, NcCoolant>> = { 7: "mist", 8: "flood" };

const mill = (
    id: NcDialectId,
    name: string,
    dwell: DwellUnits,
    posts: string[],
    extra: Partial<NcDialect> = {},
): NcDialect => ({
    id,
    name,
    machineKind: "mill",
    family: "mill",
    dwell,
    coolantOn: MILL_COOLANT,
    coolantOff: [9],
    posts,
    ...extra,
});

const printer = (id: NcDialectId, name: string, posts: string[]): NcDialect => ({
    id,
    name,
    machineKind: "printer",
    family: "printer",
    dwell: "printer",
    coolantOn: {},
    coolantOff: [],
    posts,
});

export const NC_DIALECTS: readonly NcDialect[] = [
    mill("fanuc", "Fanuc", "fanuc", ["fanuc", "fanuc-30i-5axis", "generic-5axis-nontcp"]),
    mill("haas", "Haas", "haas", ["haas", "haas-umc-5axis"], {
        coolantOn: { 7: "mist", 8: "flood", 83: "air", 88: "throughTool" },
        coolantOff: [9, 84, 89],
    }),
    mill("linuxcnc", "LinuxCNC", "seconds", ["linuxcnc"]),
    mill("mach3", "Mach3 / Mach4", "seconds", ["mach3"]),
    mill("grbl", "GRBL", "seconds", ["grbl"], { manualToolChange: true }),
    mill("siemens", "Siemens (ISO subset)", "siemens", ["siemens-840d-5axis"], { siemensUnits: true }),
    printer("marlin", "Marlin", ["marlin"]),
    printer("klipper", "Klipper", ["klipper"]),
    printer("prusa", "Prusa", ["prusa"]),
    {
        id: "plasma",
        name: "Plasma (EIA)",
        machineKind: "plasma",
        family: "cutting",
        dwell: "seconds",
        coolantOn: {},
        coolantOff: [],
        beamOn: [3, 4, 7],
        beamOff: [5, 8],
        passive: [50, 51, 52, 53, 65, 66],
        posts: ["plasma"],
    },
    {
        id: "waterjet",
        name: "Waterjet",
        machineKind: "waterjet",
        family: "cutting",
        dwell: "seconds",
        coolantOn: {},
        coolantOff: [],
        beamOn: [3, 4],
        beamOff: [5],
        posts: ["waterjet"],
    },
    {
        id: "laser",
        name: "Laser",
        machineKind: "laser",
        family: "cutting",
        dwell: "seconds",
        coolantOn: { 7: "air", 8: "air" },
        coolantOff: [9],
        beamOn: [3, 4],
        beamOff: [5],
        posts: ["laser-generic", "laser-grbl"],
    },
    {
        id: "wire",
        name: "Wire EDM (ISO)",
        machineKind: "wireEdm",
        family: "wire",
        dwell: "seconds",
        coolantOn: {},
        coolantOff: [],
        beamOn: [60],
        beamOff: [50],
        passive: [80, 81, 82, 83, 84, 85, 86, 87, 88, 89],
        posts: ["wire-iso"],
    },
    {
        id: "heidenhain",
        name: "Heidenhain conversational",
        machineKind: "mill",
        family: "conversational",
        dwell: "seconds",
        coolantOn: MILL_COOLANT,
        coolantOff: [9],
        posts: ["heidenhain-tnc-5axis"],
    },
];

const byId = new Map(NC_DIALECTS.map((dialect) => [dialect.id, dialect]));

export function ncDialect(id: NcDialectId): NcDialect {
    return byId.get(id) ?? byId.get("fanuc")!;
}

/** The dialects a reader can be asked for (Heidenhain is only recognized). */
export function ncDialects(): NcDialect[] {
    return NC_DIALECTS.filter((dialect) => dialect.family !== "conversational");
}

/** The dialect whose posts include `postId` (the dialect a posted program reads back in). */
export function dialectOfPost(postId: string): NcDialectId | undefined {
    return NC_DIALECTS.find((dialect) => dialect.posts.includes(postId))?.id;
}

const SLICER =
    /generated by\s+(PrusaSlicer|SuperSlicer|OrcaSlicer|Slic3r|Cura|Cura_SteamEngine|BambuStudio|Simplify3D|ideaMaker|KISSlicer|Chili3d — (Marlin|Prusa|Klipper) post)/i;

/** How much text detection looks at. */
const SAMPLE = 256 * 1024;

/**
 * The dialect a program is most likely written in, from its comments and headers (slicer
 * and post signatures) and the codes it uses. Plain ISO mill code with nothing specific
 * is Fanuc.
 */
export function detectNcDialect(text: string): NcDialectId {
    const sample = text.length > SAMPLE ? text.slice(0, SAMPLE) : text;
    if (/^\s*\d*\s*BEGIN\s+PGM\b/im.test(sample)) return "heidenhain";
    const slicer = SLICER.exec(sample);
    if (slicer !== null) {
        const post = slicer[2]?.toLowerCase();
        if (post === "prusa") return "prusa";
        if (post === "klipper") return "klipper";
        if (post === "marlin") return "marlin";
        if (
            /^\s*(SET_PRINT_STATS_INFO|PRINT_START|START_PRINT|EXCLUDE_OBJECT|BED_MESH|SET_PRESSURE_ADVANCE)\b/im.test(
                sample,
            )
        )
            return "klipper";
        if (/gcode_flavor\s*=\s*klipper|;FLAVOR:\s*Klipper/i.test(text.slice(-SAMPLE) + sample))
            return "klipper";
        if (
            /^\s*M862\.[13]\b|printer_model\s*=\s*(MK|MINI|XL|CORE)|;\s*PrusaSlicer|M73 P\d+ R\d+/im.test(
                sample,
            )
        )
            return /^\s*M862\.[13]\b/im.test(sample) || /printer_model\s*=\s*\w/.test(text.slice(-SAMPLE))
                ? "prusa"
                : "marlin";
        return "marlin";
    }
    const scores = new Map<NcDialectId, number>();
    const add = (id: NcDialectId, points: number) => scores.set(id, (scores.get(id) ?? 0) + points);
    const has = (pattern: RegExp) => pattern.test(sample);
    // Printers: extrusion and temperatures.
    if (has(/^\s*G[01]\b[^;\n]*\bE-?\d/im)) add("marlin", 3);
    if (has(/^\s*M(104|109|140|190|106|107|82|83)\b/im)) add("marlin", 3);
    if (
        has(/^\s*(SET_PRINT_STATS_INFO|PRINT_START|START_PRINT|EXCLUDE_OBJECT_DEFINE|BED_MESH_CALIBRATE)\b/im)
    )
        add("klipper", 8);
    if (has(/^\s*M862\.[13]\b/im)) add("prusa", 8);
    // Wire EDM: tapers, threading, a declared start hole.
    if (has(/\bWIRE\b/i) && has(/\(.*\bWIRE\b/i)) add("wire", 3);
    if (has(/^\s*(N\d+\s*)?G0?[0-3]\b[^(\n]*\b[UV]-?[\d.]/im)) add("wire", 4);
    if (has(/^\s*(N\d+\s*)?M(60|50)\b/im)) add("wire", 3);
    if (has(/^\s*(N\d+\s*)?G92\s+X-?[\d.]+\s+Y-?[\d.]+/im) && !has(/\bE-?\d/)) add("wire", 2);
    // Siemens.
    if (has(/\b(TRAORI|TRAFOOF|CYCLE\d+\s*\(|SUPA|ORIAXES|ORIWKS|MSG\s*\(|G710|G700)\b/i)) add("siemens", 8);
    if (has(/^\s*(N\d+\s*)?.*\bG71\b/im) && has(/^\s*;/m)) add("siemens", 3);
    if (has(/^\s*(N\d+\s*)?(D\d+|T\d+|G4\s+F[\d.]+)\s*$/im)) add("siemens", 1);
    // LinuxCNC.
    if (has(/^\s*o(\d+|<[^>]+>)\s+(sub|call|if|while|do|repeat)\b/im)) add("linuxcnc", 8);
    if (has(/#<[^>]+>/)) add("linuxcnc", 4);
    if (has(/\((MSG|DEBUG|PRINT),/i)) add("linuxcnc", 3);
    if (has(/\bG(33\.1|64\s+P|43\.1|92\.1|59\.[123])\b/i)) add("linuxcnc", 3);
    if (has(/^\s*M2\s*$/m)) add("linuxcnc", 1);
    // Haas.
    if (has(/\bHAAS\b/i)) add("haas", 6);
    if (has(/^\s*(N\d+\s*)?O\d{5}\b/m)) add("haas", 3);
    if (has(/\bG(187|103|254|255|234|154)\b/)) add("haas", 4);
    if (has(/\bM(88|89|97)\b/)) add("haas", 2);
    if (has(/\bG53\s+G0?0\s+Z0\b|\bG0?0\s+G53\s+Z0\b/)) add("haas", 1);
    if (has(/\bG0?4\s+P\d+\.\d*/)) add("haas", 1);
    // Mach3.
    if (has(/\bMACH ?[34]\b/i)) add("mach3", 6);
    if (has(/\bG91\.1\b/)) add("mach3", 2);
    // GRBL.
    if (has(/^\s*\$[A-Z0-9]/im)) add("grbl", 6);
    if (has(/\bGRBL\b/i)) add("grbl", 6);
    if (has(/\(\s*Tool change:?\s*T\d+/i)) add("grbl", 3);
    // Fanuc.
    if (has(/\bFANUC\b/i)) add("fanuc", 6);
    if (has(/^\s*(N\d+\s*)?O\d{4}\b/m)) add("fanuc", 2);
    if (has(/\bG(68\.2|53\.1|43\.4|28\s+G91|91\s+G28)\b/)) add("fanuc", 2);
    if (has(/\bM98\s*P\d+/)) add("fanuc", 1);
    // A mill without a tool changer, no tape marks: hobby controllers.
    const toolChange = has(/\bM0?6\b/);
    const spindle = has(/\bS\d+\s*M0?3\b|\bM0?3\s*S\d+/);
    if (spindle && !toolChange && !has(/^\s*%/m)) add("grbl", 3);
    // 2D cutting: torch/jet/beam codes without tools or spindle speeds.
    if (has(/\bPLASMA\b/i)) add("plasma", 6);
    if (has(/^\s*(N\d+\s*)?M0?7\s*$/m) && has(/^\s*(N\d+\s*)?M0?8\s*$/m) && !toolChange && !spindle)
        add("plasma", 3);
    if (has(/^\s*(N\d+\s*)?M5[01]\s*$/m)) add("plasma", 2);
    if (has(/\bWATER ?JET\b/i)) add("waterjet", 6);
    if (has(/\bLASER\b/i)) add("laser", 6);
    if (has(/\$32\s*=\s*1/)) add("laser", 6);
    if (!toolChange && !spindle && has(/^\s*(N\d+\s*)?M0?3\s*$/m)) add("waterjet", 2);
    if (!toolChange && has(/\bM0?[34]\s+S\d+/) && !has(/\bZ-?[\d.]/)) add("laser", 3);
    if (has(/\(\s*Kerf\b/i)) {
        add("plasma", 1);
        add("waterjet", 1);
        add("laser", 1);
    }
    let best: NcDialectId = "fanuc";
    let bestScore = 0;
    for (const [id, score] of scores) {
        if (score > bestScore) {
            best = id;
            bestScore = score;
        }
    }
    return best;
}
