// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { MachineProfileData } from "../model/machine";
import {
    type CamOperationContext,
    type CamOperationHandler,
    type CamParameterSpec,
    registerCamOperation,
} from "../model/operation";
import type { CamOperationData } from "../model/setup";
import type { ToolpathData, ToolpathMove } from "../model/toolpath";
import { DEFAULT_BRIDGE_URL, gcodeToolpath, sliceWithBridge } from "./bridge";
import { estimatePrintTime } from "./gcode/estimate";
import { printerGcodeStats } from "./gcode/parse";
import { isCompletePrinterProgram } from "./posts";
import {
    type PrusaJobSettings,
    printerConfigOf,
    printerPostOptions,
    prusaPreset,
    prusaPresets,
    resolvePrusaJob,
} from "./prusa/library";
import { prusaJobIni, prusaProjectFiles, prusaProjectObjects, zipProject } from "./prusa/project3mf";
import { readSlicerSettings } from "./prusa/settings";
import { printerKinematics, type SliceResult, slicePrint } from "./slicer/slicer";

/**
 * The printer operations of a CAM setup: "slice" (the built-in slicer) and "prusaSlicer"
 * (PrusaSlicer through the local bridge). Both take the same job settings — print and
 * filament presets plus the common overrides — so switching between them keeps the job.
 */

export const SLICE_OPERATION = "slice";
export const PRUSA_SLICER_OPERATION = "prusaSlicer";

/** Panel parameter → PrusaSlicer option. Empty parameters keep the preset's value. */
const OVERRIDES: readonly { key: string; option: string; format?: (value: unknown) => string | undefined }[] =
    [
        { key: "layerHeight", option: "layer_height" },
        { key: "firstLayerHeight", option: "first_layer_height" },
        { key: "perimeters", option: "perimeters" },
        { key: "topSolidLayers", option: "top_solid_layers" },
        { key: "bottomSolidLayers", option: "bottom_solid_layers" },
        { key: "infillDensity", option: "fill_density", format: (v) => `${Number(v)}%` },
        { key: "infillPattern", option: "fill_pattern" },
        { key: "supports", option: "support_material", format: (v) => (v ? "1" : "0") },
        { key: "supportThreshold", option: "support_material_threshold" },
        { key: "brimWidth", option: "brim_width" },
        { key: "skirts", option: "skirts" },
        { key: "seamPosition", option: "seam_position" },
        {
            key: "externalPerimetersFirst",
            option: "external_perimeters_first",
            format: (v) => (v ? "1" : "0"),
        },
    ];

const isSet = (value: unknown) => value !== undefined && value !== null && value !== "";

/** The job settings an operation's parameters describe. */
export function jobSettingsFromParams(params: Readonly<Record<string, unknown>>): PrusaJobSettings {
    const overrides: Record<string, string | number | boolean> = {};
    for (const entry of OVERRIDES) {
        const value = params[entry.key];
        if (!isSet(value)) continue;
        const text = entry.format ? entry.format(value) : value;
        if (text !== undefined) overrides[entry.option] = text as string | number | boolean;
    }
    if (params["supports"] === true) overrides["support_material_auto"] = "1";
    const extra = params["overrides"];
    if (extra && typeof extra === "object") Object.assign(overrides, extra);
    const placement = params["placement"];
    return {
        print: isSet(params["printPreset"]) ? String(params["printPreset"]) : undefined,
        filament: isSet(params["filamentPreset"]) ? String(params["filamentPreset"]) : undefined,
        overrides,
        placement: placement === "keep" || placement === "center" ? placement : "auto",
    };
}

function presetOptions(kind: "print" | "filament"): { value: string; label: string }[] {
    return prusaPresets(kind).map((preset) => ({ value: preset.name, label: preset.name }));
}

const PATTERNS = [
    { value: "rectilinear", label: "Rectilinear" },
    { value: "grid", label: "Grid" },
    { value: "gyroid", label: "Gyroid" },
    { value: "concentric", label: "Concentric" },
];

const PRUSA_ONLY_PATTERNS = [
    { value: "honeycomb", label: "Honeycomb (PrusaSlicer)" },
    { value: "cubic", label: "Cubic (PrusaSlicer)" },
    { value: "adaptivecubic", label: "Adaptive cubic (PrusaSlicer)" },
    { value: "lightning", label: "Lightning (PrusaSlicer)" },
];

function jobParameters(prusaSlicer: boolean): CamParameterSpec[] {
    const preset = "Empty: the print preset's value";
    return [
        { key: "printPreset", label: "Print settings", kind: "enum", options: presetOptions("print") },
        { key: "filamentPreset", label: "Filament", kind: "enum", options: presetOptions("filament") },
        {
            key: "layerHeight",
            label: "Layer height",
            kind: "length",
            min: 0.03,
            max: 1.2,
            description: preset,
        },
        {
            key: "firstLayerHeight",
            label: "First layer height",
            kind: "length",
            min: 0.05,
            max: 1.2,
            description: preset,
        },
        { key: "perimeters", label: "Perimeters", kind: "integer", min: 0, max: 20, description: preset },
        {
            key: "topSolidLayers",
            label: "Top solid layers",
            kind: "integer",
            min: 0,
            max: 50,
            description: preset,
        },
        {
            key: "bottomSolidLayers",
            label: "Bottom solid layers",
            kind: "integer",
            min: 0,
            max: 50,
            description: preset,
        },
        {
            key: "infillDensity",
            label: "Infill density %",
            kind: "number",
            min: 0,
            max: 100,
            description: preset,
        },
        {
            key: "infillPattern",
            label: "Infill pattern",
            kind: "enum",
            options: prusaSlicer ? [...PATTERNS, ...PRUSA_ONLY_PATTERNS] : PATTERNS,
            description: preset,
        },
        { key: "supports", label: "Supports", kind: "boolean" },
        {
            key: "supportThreshold",
            label: "Support overhang angle",
            kind: "angle",
            min: 1,
            max: 89,
            visibleWhen: { key: "supports", values: [true] },
            description: "Overhangs flatter than this (from horizontal) get support",
        },
        { key: "brimWidth", label: "Brim width", kind: "length", min: 0, max: 50, description: preset },
        { key: "skirts", label: "Skirt loops", kind: "integer", min: 0, max: 20, description: preset },
        {
            key: "placement",
            label: "Placement",
            kind: "enum",
            options: [
                { value: "auto", label: "As modelled if it fits, else centred" },
                { value: "keep", label: "As modelled" },
                { value: "center", label: "Centre of the bed" },
            ],
        },
    ];
}

/** Defaults: the printer's default (or first compatible) presets; overrides empty. */
function jobDefaults(machine: MachineProfileData): Record<string, unknown> {
    const options = printerPostOptions(machine);
    const pick = (kind: "print" | "filament", preferred: string | undefined) => {
        if (preferred && prusaPreset(kind, preferred)) return preferred;
        return prusaPresets(kind, machine)[0]?.name;
    };
    return {
        printPreset: pick("print", options.defaultPrint),
        filamentPreset: pick("filament", options.defaultFilament),
        supports: false,
        placement: "auto",
    };
}

const warningMoves = (warnings: readonly string[]): ToolpathMove[] =>
    warnings.map((text) => ({ kind: "comment", text: `warning: ${text}` }));

/** Slices a setup's parts with the built-in slicer (the full result, with layers and stats). */
export function sliceSetup(
    context: CamOperationContext,
    settings: PrusaJobSettings,
    label = "Slice",
): Result<SliceResult> {
    const job = resolvePrusaJob(context.machine, settings);
    if (!job.isOk) return Result.err(job.error);
    const result = slicePrint(context.partMesh(), job.value.config, {
        placement: settings.placement,
        toolId: context.tool.id,
        label,
        presetNames: {
            print: job.value.printPreset,
            filament: job.value.filamentPreset,
            printer: job.value.printerPreset,
        },
        inputName: context.setup.programName ?? context.setup.name,
    });
    if (!result.isOk) return result;
    const warnings = [...job.value.warnings, ...result.value.warnings];
    return Result.ok({
        ...result.value,
        warnings,
        toolpath: {
            ...result.value.toolpath,
            moves: [...warningMoves(warnings), ...result.value.toolpath.moves],
        },
    });
}

export const sliceOperation: CamOperationHandler = {
    type: SLICE_OPERATION,
    label: "Slice (built-in)",
    category: "additive",
    machineKinds: ["printer"],
    selects: ["body"],
    defaults: (machine) => jobDefaults(machine),
    parameters: () => jobParameters(false),
    generate(operation: CamOperationData, context: CamOperationContext) {
        const result = sliceSetup(context, jobSettingsFromParams(operation.params), operation.name);
        return result.isOk ? Result.ok(result.value.toolpath) : Result.err(result.error);
    },
};

/** Slices a setup's parts with PrusaSlicer through the bridge at `url`. */
export async function sliceSetupWithPrusaSlicer(
    context: CamOperationContext,
    settings: PrusaJobSettings,
    options: {
        readonly url?: string;
        readonly arrange?: boolean;
        readonly label?: string;
        readonly signal?: AbortSignal;
    } = {},
): Promise<Result<ToolpathData>> {
    const job = resolvePrusaJob(context.machine, settings);
    if (!job.isOk) return Result.err(job.error);
    const project = prusaProjectFiles(prusaProjectObjects(context, settings), job.value, {
        placement: settings.placement,
        title: context.setup.programName ?? context.setup.name,
    });
    if (!project.isOk) return Result.err(project.error);
    const model = await zipProject(project.value.files);
    const url = options.url || printerPostOptions(context.machine).prusaSlicerBridgeUrl || DEFAULT_BRIDGE_URL;
    const sliced = await sliceWithBridge(
        url,
        { model, modelName: "job.3mf", config: prusaJobIni(job.value), arrange: options.arrange },
        options.signal,
    );
    if (!sliced.isOk) return Result.err(sliced.error);
    return Result.ok(
        gcodeToolpath(sliced.value.gcode, context.tool.id, options.label ?? "PrusaSlicer").toolpath,
    );
}

export const prusaSlicerOperation: CamOperationHandler = {
    type: PRUSA_SLICER_OPERATION,
    label: "PrusaSlicer (local)",
    category: "additive",
    machineKinds: ["printer"],
    selects: ["body"],
    defaults: (machine) => ({
        ...jobDefaults(machine),
        bridgeUrl: printerPostOptions(machine).prusaSlicerBridgeUrl ?? DEFAULT_BRIDGE_URL,
        arrange: false,
    }),
    parameters: () => [
        ...jobParameters(true),
        {
            key: "bridgeUrl",
            label: "Bridge URL",
            kind: "string",
            description: 'Where "node scripts/prusa-slicer-bridge.mjs" listens',
        },
        { key: "arrange", label: "Let PrusaSlicer arrange", kind: "boolean" },
    ],
    generate(operation: CamOperationData, context: CamOperationContext) {
        return sliceSetupWithPrusaSlicer(context, jobSettingsFromParams(operation.params), {
            url:
                typeof operation.params["bridgeUrl"] === "string" ? operation.params["bridgeUrl"] : undefined,
            arrange: operation.params["arrange"] === true,
            label: operation.name,
        });
    },
};

export interface ToolpathPrintStats {
    readonly seconds: number;
    readonly filamentMm: number;
    readonly layers: number;
}

/** Print time, filament and layers of a printer toolpath (either slicer's). */
export function toolpathPrintStats(toolpath: ToolpathData, machine: MachineProfileData): ToolpathPrintStats {
    if (isCompletePrinterProgram(toolpath.moves)) {
        const code = toolpath.moves.map((move) => (move.kind === "raw" ? move.code : "")).join("\n");
        const stats = printerGcodeStats(code);
        return { seconds: stats.seconds ?? 0, filamentMm: stats.filamentMm ?? 0, layers: stats.layers ?? 0 };
    }
    const estimate = estimatePrintTime(
        toolpath.moves,
        printerKinematics(readSlicerSettings(printerConfigOf(machine))),
    );
    return {
        seconds: estimate.seconds,
        filamentMm: toolpath.moves.reduce(
            (sum, move) => sum + (move.kind === "extrude" ? move.extrude : 0),
            0,
        ),
        layers: toolpath.moves.filter((move) => move.kind === "comment" && move.text === "LAYER_CHANGE")
            .length,
    };
}

export function registerPrinterOperations(): void {
    registerCamOperation(sliceOperation);
    registerCamOperation(prusaSlicerOperation);
}
