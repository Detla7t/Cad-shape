// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    firstBool,
    firstNumber,
    floatOrPercent,
    type PrusaConfig,
    parseNumbers,
    parsePoints,
    parseStrings,
    percent,
    unescapeString,
} from "./values";

/**
 * Typed print, filament and printer settings, read from a (merged) PrusaSlicer config by the
 * built-in slicer. Keys and meanings are PrusaSlicer's, so one config drives both slicers;
 * keys a config lacks take `DEFAULT_PRUSA_CONFIG`'s value (PrusaSlicer-like defaults).
 * Speeds are mm/s here, as in PrusaSlicer; widths and heights mm.
 */

export const DEFAULT_PRUSA_CONFIG: PrusaConfig = {
    printer_technology: "FFF",
    // print
    layer_height: "0.2",
    first_layer_height: "0.2",
    perimeters: "2",
    top_solid_layers: "5",
    bottom_solid_layers: "4",
    top_solid_min_thickness: "0.7",
    bottom_solid_min_thickness: "0.5",
    fill_density: "15%",
    fill_pattern: "grid",
    top_fill_pattern: "monotonic",
    bottom_fill_pattern: "monotonic",
    fill_angle: "45",
    infill_overlap: "10%",
    solid_infill_below_area: "0",
    external_perimeters_first: "0",
    seam_position: "aligned",
    seam_gap: "15%",
    extrusion_width: "0.45",
    first_layer_extrusion_width: "0.42",
    perimeter_extrusion_width: "0.45",
    external_perimeter_extrusion_width: "0.45",
    infill_extrusion_width: "0.45",
    solid_infill_extrusion_width: "0.45",
    top_infill_extrusion_width: "0.4",
    support_material_extrusion_width: "0.35",
    skirts: "1",
    skirt_distance: "2",
    skirt_height: "1",
    min_skirt_length: "4",
    brim_width: "0",
    brim_separation: "0",
    perimeter_speed: "45",
    external_perimeter_speed: "25",
    infill_speed: "80",
    solid_infill_speed: "80",
    top_solid_infill_speed: "40",
    support_material_speed: "50",
    support_material_interface_speed: "100%",
    bridge_speed: "30",
    travel_speed: "150",
    travel_speed_z: "12",
    first_layer_speed: "20",
    max_print_speed: "200",
    default_acceleration: "1000",
    perimeter_acceleration: "800",
    infill_acceleration: "1250",
    first_layer_acceleration: "800",
    travel_acceleration: "1250",
    support_material: "0",
    support_material_auto: "1",
    support_material_threshold: "55",
    support_material_contact_distance: "0.2",
    support_material_spacing: "2",
    support_material_angle: "0",
    support_material_interface_layers: "2",
    support_material_interface_spacing: "0.2",
    support_material_xy_spacing: "60%",
    support_material_buildplate_only: "0",
    elefant_foot_compensation: "0.2",
    xy_size_compensation: "0",
    only_retract_when_crossing_perimeters: "0",
    gcode_resolution: "0.0125",
    gcode_comments: "0",
    // filament
    filament_type: "PLA",
    filament_diameter: "1.75",
    filament_density: "1.24",
    filament_cost: "25",
    extrusion_multiplier: "1",
    temperature: "210",
    first_layer_temperature: "215",
    bed_temperature: "60",
    first_layer_bed_temperature: "60",
    cooling: "1",
    fan_always_on: "1",
    min_fan_speed: "100",
    max_fan_speed: "100",
    bridge_fan_speed: "100",
    disable_fan_first_layers: "1",
    fan_below_layer_time: "100",
    slowdown_below_layer_time: "10",
    min_print_speed: "15",
    filament_max_volumetric_speed: "15",
    start_filament_gcode: "",
    end_filament_gcode: "",
    // printer
    bed_shape: "0x0,200x0,200x200,0x200",
    max_print_height: "200",
    nozzle_diameter: "0.4",
    gcode_flavor: "marlin2",
    use_relative_e_distances: "1",
    retract_length: "0.8",
    retract_speed: "35",
    deretract_speed: "0",
    retract_lift: "0.2",
    retract_before_travel: "1.5",
    retract_layer_change: "1",
    retract_restart_extra: "0",
    autoemit_temperature_commands: "1",
    machine_limits_usage: "time_estimate_only",
    machine_max_feedrate_x: "200",
    machine_max_feedrate_y: "200",
    machine_max_feedrate_z: "12",
    machine_max_feedrate_e: "120",
    machine_max_acceleration_extruding: "1250",
    machine_max_acceleration_travel: "1250",
    machine_max_acceleration_x: "1000",
    machine_max_acceleration_y: "1000",
    machine_max_acceleration_z: "200",
    machine_max_acceleration_e: "5000",
    machine_max_acceleration_retracting: "1250",
    machine_max_jerk_x: "8",
    machine_max_jerk_y: "8",
    machine_max_jerk_z: "0.4",
    machine_max_jerk_e: "4.5",
    start_gcode: "G28 ; home all axes\\nG1 Z5 F5000 ; lift nozzle",
    end_gcode: "M104 S0 ; turn off temperature\\nG28 X0 ; home X axis\\nM84 ; disable motors",
    before_layer_gcode: "",
    layer_gcode: "",
    printer_notes: "",
    printer_model: "",
};

export type InfillPattern = "rectilinear" | "grid" | "gyroid" | "concentric";

/** PrusaSlicer patterns the built-in slicer draws with one of its own. */
export function slicerPattern(name: string): InfillPattern {
    const n = name.trim().toLowerCase();
    if (n === "gyroid") return "gyroid";
    if (n === "concentric") return "concentric";
    if (["rectilinear", "alignedrectilinear", "line", "monotonic", "monotoniclines", "zigzag"].includes(n)) {
        return "rectilinear";
    }
    return "grid";
}

/** Slic3r's extrusion cross-section: a rectangle with semicircular sides (mm²). */
export function extrusionArea(width: number, height: number): number {
    return height * (width - height * (1 - Math.PI / 4));
}

/** Centre distance of adjacent extrusions of this width and height. */
export function extrusionSpacing(width: number, height: number): number {
    return width - height * (1 - Math.PI / 4);
}

export interface ExtrusionWidths {
    readonly firstLayer: number;
    readonly perimeter: number;
    readonly externalPerimeter: number;
    readonly infill: number;
    readonly solidInfill: number;
    readonly topInfill: number;
    readonly support: number;
}

export interface SlicerSettings {
    readonly layerHeight: number;
    readonly firstLayerHeight: number;
    readonly perimeters: number;
    readonly topSolidLayers: number;
    readonly bottomSolidLayers: number;
    readonly topSolidMinThickness: number;
    readonly bottomSolidMinThickness: number;
    /** 0…1. */
    readonly infillDensity: number;
    readonly infillPattern: InfillPattern;
    readonly solidPattern: InfillPattern;
    readonly infillAngle: number;
    /** mm of overlap between infill and the innermost perimeter. */
    readonly infillOverlap: number;
    readonly solidInfillBelowArea: number;
    readonly externalPerimetersFirst: boolean;
    readonly seamPosition: "aligned" | "nearest" | "rear" | "random";
    readonly seamGap: number;
    readonly widths: ExtrusionWidths;
    readonly skirts: number;
    readonly skirtDistance: number;
    readonly skirtHeight: number;
    readonly minSkirtLength: number;
    readonly brimWidth: number;
    readonly brimSeparation: number;
    readonly speeds: {
        readonly perimeter: number;
        readonly externalPerimeter: number;
        readonly infill: number;
        readonly solidInfill: number;
        readonly topSolidInfill: number;
        readonly support: number;
        readonly supportInterface: number;
        readonly bridge: number;
        readonly travel: number;
        readonly travelZ: number;
        /** mm/s, or a fraction of each feature's speed when `firstLayerSpeedIsRatio`. */
        readonly firstLayer: number;
        readonly firstLayerSpeedIsRatio: boolean;
        readonly maxPrint: number;
    };
    readonly accelerations: {
        readonly default: number;
        readonly perimeter: number;
        readonly infill: number;
        readonly firstLayer: number;
        readonly travel: number;
    };
    readonly supports: {
        readonly enabled: boolean;
        readonly thresholdAngle: number;
        readonly contactDistance: number;
        readonly spacing: number;
        readonly angle: number;
        readonly interfaceLayers: number;
        readonly interfaceSpacing: number;
        readonly xyGap: number;
        readonly buildPlateOnly: boolean;
    };
    readonly elephantFootCompensation: number;
    readonly xySizeCompensation: number;
    readonly onlyRetractWhenCrossingPerimeters: boolean;
    readonly resolution: number;
    readonly filament: {
        readonly type: string;
        readonly diameter: number;
        /** g/cm³. */
        readonly density: number;
        /** Money per kg. */
        readonly cost: number;
        readonly extrusionMultiplier: number;
        readonly temperature: number;
        readonly firstLayerTemperature: number;
        readonly bedTemperature: number;
        readonly firstLayerBedTemperature: number;
        readonly maxVolumetricSpeed: number;
    };
    readonly cooling: {
        readonly enabled: boolean;
        readonly fanAlwaysOn: boolean;
        /** 0…100 %. */
        readonly minFanSpeed: number;
        readonly maxFanSpeed: number;
        readonly bridgeFanSpeed: number;
        readonly disableFanFirstLayers: number;
        readonly fanBelowLayerTime: number;
        readonly slowdownBelowLayerTime: number;
        readonly minPrintSpeed: number;
    };
    readonly printer: {
        readonly bedShape: [number, number][];
        readonly maxPrintHeight: number;
        readonly nozzleDiameter: number;
        readonly flavor: string;
        readonly retractLength: number;
        readonly retractSpeed: number;
        readonly deretractSpeed: number;
        readonly retractLift: number;
        readonly retractBeforeTravel: number;
        readonly retractLayerChange: boolean;
        readonly retractRestartExtra: number;
        readonly autoemitTemperatureCommands: boolean;
        readonly emitMachineLimits: boolean;
        readonly maxFeedrateXY: number;
        readonly maxFeedrateZ: number;
        readonly maxAccelerationExtruding: number;
        readonly maxAccelerationTravel: number;
        readonly jerkXY: number;
    };
    readonly gcode: {
        readonly start: string;
        readonly end: string;
        readonly startFilament: string;
        readonly endFilament: string;
        readonly beforeLayer: string;
        readonly layer: string;
    };
}

/** The first item of a per-extruder string option (`"; filament start\n";"…"`), unescaped. */
function firstString(value: string | undefined): string {
    if (value === undefined) return "";
    const text = value.trim();
    return text.startsWith('"') ? (parseStrings(text)[0] ?? "") : unescapeString(text);
}

/** A config value with the default filled in. */
export function configValue(config: PrusaConfig, key: string): string | undefined {
    return config[key] ?? DEFAULT_PRUSA_CONFIG[key];
}

/** A speed that may be a percentage of another (`external_perimeter_speed = 50%`). */
function speed(config: PrusaConfig, key: string, base: number): number {
    return floatOrPercent(configValue(config, key), base, base);
}

export function readSlicerSettings(config: PrusaConfig): SlicerSettings {
    const get = (key: string) => configValue(config, key);
    const num = (key: string, fallback = 0) => firstNumber(get(key), fallback);
    const bool = (key: string) => firstBool(get(key), false);
    const nozzle = num("nozzle_diameter", 0.4);
    const layerHeight = Math.max(0.01, num("layer_height", 0.2));
    const firstLayerHeight = Math.max(
        0.01,
        floatOrPercent(get("first_layer_height"), layerHeight, layerHeight),
    );
    const auto = 1.125 * nozzle;
    const defaultWidth = floatOrPercent(get("extrusion_width"), nozzle, auto);
    const width = (key: string) => floatOrPercent(get(key), nozzle, defaultWidth);
    const perimeterSpeed = num("perimeter_speed", 45);
    const infillSpeed = num("infill_speed", 80);
    const solidInfillSpeed = speed(config, "solid_infill_speed", infillSpeed);
    const supportSpeed = num("support_material_speed", 50);
    const firstLayerSpeedText = (get("first_layer_speed") ?? "20").trim();
    const perimeterWidth = width("perimeter_extrusion_width");
    const pattern = (get("fill_pattern") ?? "grid").trim();
    const solid = (get("top_fill_pattern") ?? "monotonic").trim();
    const seam = (get("seam_position") ?? "aligned").trim();
    return {
        layerHeight,
        firstLayerHeight,
        perimeters: Math.max(0, Math.round(num("perimeters", 2))),
        topSolidLayers: Math.max(0, Math.round(num("top_solid_layers", 5))),
        bottomSolidLayers: Math.max(0, Math.round(num("bottom_solid_layers", 4))),
        topSolidMinThickness: num("top_solid_min_thickness", 0),
        bottomSolidMinThickness: num("bottom_solid_min_thickness", 0),
        infillDensity: Math.min(1, Math.max(0, percent(get("fill_density"), 0.15))),
        infillPattern: slicerPattern(pattern),
        solidPattern: slicerPattern(solid) === "concentric" ? "concentric" : "rectilinear",
        infillAngle: num("fill_angle", 45),
        infillOverlap: floatOrPercent(get("infill_overlap"), perimeterWidth, 0),
        solidInfillBelowArea: num("solid_infill_below_area", 0),
        externalPerimetersFirst: bool("external_perimeters_first"),
        seamPosition: seam === "nearest" || seam === "rear" || seam === "random" ? seam : "aligned",
        seamGap: floatOrPercent(get("seam_gap"), nozzle, 0),
        widths: {
            firstLayer: width("first_layer_extrusion_width"),
            perimeter: perimeterWidth,
            externalPerimeter: width("external_perimeter_extrusion_width"),
            infill: width("infill_extrusion_width"),
            solidInfill: width("solid_infill_extrusion_width"),
            topInfill: width("top_infill_extrusion_width"),
            support: width("support_material_extrusion_width"),
        },
        skirts: Math.max(0, Math.round(num("skirts", 1))),
        skirtDistance: num("skirt_distance", 2),
        skirtHeight: Math.max(1, Math.round(num("skirt_height", 1))),
        minSkirtLength: num("min_skirt_length", 0),
        brimWidth: num("brim_width", 0),
        brimSeparation: num("brim_separation", 0),
        speeds: {
            perimeter: perimeterSpeed,
            externalPerimeter: speed(config, "external_perimeter_speed", perimeterSpeed),
            infill: infillSpeed,
            solidInfill: solidInfillSpeed,
            topSolidInfill: speed(config, "top_solid_infill_speed", solidInfillSpeed),
            support: supportSpeed,
            supportInterface: speed(config, "support_material_interface_speed", supportSpeed),
            bridge: num("bridge_speed", 30),
            travel: num("travel_speed", 150),
            travelZ: num("travel_speed_z", 0) || num("machine_max_feedrate_z", 12),
            firstLayer: firstLayerSpeedText.endsWith("%")
                ? Number.parseFloat(firstLayerSpeedText) / 100
                : Number.parseFloat(firstLayerSpeedText) || 20,
            firstLayerSpeedIsRatio: firstLayerSpeedText.endsWith("%"),
            maxPrint: num("max_print_speed", 0) || Number.POSITIVE_INFINITY,
        },
        accelerations: {
            default: num("default_acceleration", 0),
            perimeter: num("perimeter_acceleration", 0),
            infill: num("infill_acceleration", 0),
            firstLayer: num("first_layer_acceleration", 0),
            travel: num("travel_acceleration", 0),
        },
        supports: {
            enabled: bool("support_material"),
            thresholdAngle: num("support_material_threshold", 0) || 55,
            contactDistance: num("support_material_contact_distance", 0.2),
            spacing: Math.max(0.5, num("support_material_spacing", 2)),
            angle: num("support_material_angle", 0),
            interfaceLayers: Math.max(0, Math.round(num("support_material_interface_layers", 2))),
            interfaceSpacing: num("support_material_interface_spacing", 0.2),
            xyGap: floatOrPercent(get("support_material_xy_spacing"), perimeterWidth, 0.6 * perimeterWidth),
            buildPlateOnly: bool("support_material_buildplate_only"),
        },
        elephantFootCompensation: num("elefant_foot_compensation", 0),
        xySizeCompensation: num("xy_size_compensation", 0),
        onlyRetractWhenCrossingPerimeters: bool("only_retract_when_crossing_perimeters"),
        resolution: Math.max(0.001, num("gcode_resolution", 0.0125)),
        filament: {
            type: unescapeString((get("filament_type") ?? "PLA").split(";")[0]),
            diameter: num("filament_diameter", 1.75),
            density: num("filament_density", 1.24),
            cost: num("filament_cost", 0),
            extrusionMultiplier: num("extrusion_multiplier", 1),
            temperature: num("temperature", 210),
            firstLayerTemperature: num("first_layer_temperature", 0) || num("temperature", 210),
            bedTemperature: num("bed_temperature", 60),
            firstLayerBedTemperature: num("first_layer_bed_temperature", 0) || num("bed_temperature", 60),
            maxVolumetricSpeed: num("filament_max_volumetric_speed", 0),
        },
        cooling: {
            enabled: bool("cooling"),
            fanAlwaysOn: bool("fan_always_on"),
            minFanSpeed: num("min_fan_speed", 35),
            maxFanSpeed: num("max_fan_speed", 100),
            bridgeFanSpeed: num("bridge_fan_speed", 100),
            disableFanFirstLayers: Math.round(num("disable_fan_first_layers", 1)),
            fanBelowLayerTime: num("fan_below_layer_time", 60),
            slowdownBelowLayerTime: num("slowdown_below_layer_time", 5),
            minPrintSpeed: num("min_print_speed", 10),
        },
        printer: {
            bedShape: parsePoints(get("bed_shape")),
            maxPrintHeight: num("max_print_height", 200),
            nozzleDiameter: nozzle,
            flavor: (get("gcode_flavor") ?? "marlin2").trim(),
            retractLength: num("retract_length", 0),
            retractSpeed: num("retract_speed", 35),
            deretractSpeed: num("deretract_speed", 0) || num("retract_speed", 35),
            retractLift: num("retract_lift", 0),
            retractBeforeTravel: num("retract_before_travel", 2),
            retractLayerChange: bool("retract_layer_change"),
            retractRestartExtra: num("retract_restart_extra", 0),
            autoemitTemperatureCommands: firstBool(get("autoemit_temperature_commands"), true),
            emitMachineLimits: (get("machine_limits_usage") ?? "").trim() === "emit_to_gcode",
            maxFeedrateXY: Math.min(
                ...[num("machine_max_feedrate_x", 0), num("machine_max_feedrate_y", 0)].map(
                    (v) => v || Number.POSITIVE_INFINITY,
                ),
            ),
            maxFeedrateZ: num("machine_max_feedrate_z", 0) || Number.POSITIVE_INFINITY,
            maxAccelerationExtruding: num("machine_max_acceleration_extruding", 0) || 1250,
            maxAccelerationTravel:
                num("machine_max_acceleration_travel", 0) ||
                num("machine_max_acceleration_extruding", 0) ||
                1250,
            jerkXY: num("machine_max_jerk_x", 0) || 8,
        },
        gcode: {
            start: unescapeString(get("start_gcode") ?? ""),
            end: unescapeString(get("end_gcode") ?? ""),
            startFilament: firstString(get("start_filament_gcode")),
            endFilament: firstString(get("end_filament_gcode")),
            beforeLayer: unescapeString(get("before_layer_gcode") ?? ""),
            layer: unescapeString(get("layer_gcode") ?? ""),
        },
    };
}

/** The bed rectangle (bounding box of `bed_shape`). */
export function bedRectangle(points: readonly (readonly [number, number])[]): {
    min: [number, number];
    max: [number, number];
} {
    if (points.length === 0) return { min: [0, 0], max: [200, 200] };
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

/** First value of a per-extruder vector option (helper for UI summaries). */
export const firstOf = (config: PrusaConfig, key: string) => parseNumbers(configValue(config, key))[0];
