// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { IPoint64 } from "clipper2-js";
import type { CamMesh } from "../../model/operation";
import type { ToolpathData, ToolpathMove, Vec3 } from "../../model/toolpath";
import { estimatePrintTime, formatPrintDuration, type PrintKinematics } from "../gcode/estimate";
import { RegionIndex } from "../geometry/lineClip";
import {
    type BedPlacement,
    bedFitProblem,
    bedPlacement,
    meshBounds,
    translateMesh,
    type WeldedMesh,
    weldMesh,
} from "../geometry/mesh";
import {
    intersection,
    islands,
    mm,
    offset,
    type Path,
    type Paths,
    bounds as pathBounds,
    pathLength,
    SCALE,
    simplifyClosed,
    union,
} from "../geometry/polygons";
import { expandPrusaMacros, type MacroValue, prusaMacroScope } from "../prusa/macro";
import {
    bedRectangle,
    configValue,
    extrusionArea,
    extrusionSpacing,
    readSlicerSettings,
    type SlicerSettings,
} from "../prusa/settings";
import { firstNumber, formatNumber, type PrusaConfig } from "../prusa/values";
import {
    concentricLoops,
    connectorInside,
    gyroidLines,
    nearestVertex,
    orderLoops,
    orderPolylines,
    rearVertex,
    rectilinearLines,
} from "./infill";
import {
    classifyLayers,
    islandPerimeters,
    type LayerRegions,
    layerSpecs,
    layerWidths,
    type PerimeterLoop,
} from "./regions";
import { sliceMesh } from "./slice";
import { planSupports, type SupportLayer } from "./support";
import { type ExtrusionRole, ToolpathWriter } from "./writer";

/**
 * The built-in slicer: a fully in-browser fallback for when PrusaSlicer is not available.
 * It reads the same PrusaSlicer config the 3MF export and the bridge use, and covers what
 * simple parts need — perimeters, top/bottom shells, sparse rectilinear/grid/gyroid/
 * concentric infill, skirt and brim, retraction and z-hop, cooling (fan and slowdown),
 * temperatures, start/end G-code macros, optional support columns — for valid G-code with
 * print-time and filament estimates. Not covered: thin walls and gap fill, bridge direction
 * and flow, overhang perimeters, ironing, multi-material, variable layer height, arc fitting,
 * travel avoidance (it retracts instead), seam painting.
 */

export interface SlicePrintOptions {
    readonly placement?: BedPlacement;
    readonly toolId?: string;
    readonly label?: string;
    /** Preset names for the macros and the header (`print_preset`, …). */
    readonly presetNames?: { readonly print?: string; readonly filament?: string; readonly printer?: string };
    /** `input_filename_base` for macros. */
    readonly inputName?: string;
    /** Extra macro variables. */
    readonly variables?: Readonly<Record<string, MacroValue>>;
    readonly now?: Date;
}

export interface PrintStats {
    readonly layers: number;
    readonly seconds: number;
    readonly filamentMm: number;
    readonly filamentCm3: number;
    readonly filamentGrams: number;
    readonly filamentCost: number;
}

export interface SlicedLayer {
    readonly index: number;
    readonly z: number;
    readonly height: number;
    readonly slices: Paths;
    readonly perimeters: readonly PerimeterLoop[];
    readonly fill: Paths;
    readonly top: Paths;
    readonly bridge: Paths;
    readonly solid: Paths;
    readonly sparse: Paths;
    readonly support: SupportLayer;
}

export interface SliceResult {
    readonly toolpath: ToolpathData;
    readonly layers: readonly SlicedLayer[];
    readonly stats: PrintStats;
    readonly warnings: readonly string[];
    /** How the mesh was moved onto the bed. */
    readonly translation: Vec3;
    readonly skirt: Paths;
    readonly brim: Paths;
}

const isWelded = (mesh: CamMesh | WeldedMesh): mesh is WeldedMesh => "triangles" in mesh;

export function printerKinematics(settings: SlicerSettings): PrintKinematics {
    const a = settings.accelerations;
    return {
        acceleration: Math.min(settings.printer.maxAccelerationExtruding, a.default || a.perimeter || 1e9),
        travelAcceleration: Math.min(settings.printer.maxAccelerationTravel, a.travel || a.default || 1e9),
        jerk: settings.printer.jerkXY,
        rapidSpeed: settings.speeds.travel,
        maxSpeedXY: Number.isFinite(settings.printer.maxFeedrateXY)
            ? settings.printer.maxFeedrateXY
            : undefined,
        maxSpeedZ: Number.isFinite(settings.printer.maxFeedrateZ) ? settings.printer.maxFeedrateZ : undefined,
    };
}

/** Slices a mesh (WCS = bed frame, mm) with a merged PrusaSlicer config. */
export function slicePrint(
    mesh: CamMesh | WeldedMesh,
    config: PrusaConfig,
    options: SlicePrintOptions = {},
): Result<SliceResult> {
    const settings = readSlicerSettings(config);
    const welded = isWelded(mesh) ? mesh : weldMesh(mesh);
    const meshBox = meshBounds(welded.vertices);
    if (meshBox === undefined || welded.triangles.length === 0)
        return Result.err("nothing to slice: the parts have no triangles");
    const bedRect = bedRectangle(settings.printer.bedShape);
    const bed = { min: bedRect.min, max: bedRect.max, maxHeight: settings.printer.maxPrintHeight };
    const translation = bedPlacement(meshBox, bed, options.placement, firstLayerMargin(settings));
    const placed = translateMesh(welded, ...translation);
    const placedBox = meshBounds(placed.vertices);
    if (placedBox === undefined) return Result.err("nothing to slice");
    const fit = bedFitProblem(placedBox, bed);
    if (fit) return Result.err(`cannot print: ${fit}`);

    const warnings: string[] = [];
    const specs = layerSpecs(placedBox.max[2], settings.firstLayerHeight, settings.layerHeight);
    if (specs.length === 0) return Result.err("nothing to slice: the parts are flat");
    const cuts = cutLayers(placed, specs, settings);
    if (cuts.openChains > 0) {
        warnings.push(`the mesh is not closed: ${cuts.openChains} open slice chains were dropped`);
    }
    const layers: LayerRegions[] = specs.map((spec, i) => {
        const slices = cuts.regions[i];
        const widths = layerWidths(settings, i);
        const islandRegions = islands(slices).map((island) =>
            islandPerimeters(
                island,
                settings.perimeters,
                widths,
                spec.height,
                configValue(config, "infill_overlap"),
            ),
        );
        return {
            spec,
            slices,
            islands: islandRegions,
            fill: union(islandRegions.flatMap((r) => r.fill)),
            top: [],
            bridge: [],
            solid: [],
            sparse: [],
        };
    });
    if (layers.every((layer) => layer.slices.length === 0))
        return Result.err("nothing to slice: no layer has area");
    classifyLayers(layers, settings);
    const supports = planSupports(layers, settings);

    const plan = new PrintPlanner(settings, config, layers, supports, options, warnings);
    const moves = plan.write();
    const kinematics = printerKinematics(settings);
    const estimate = estimatePrintTime(moves, kinematics);
    const filamentMm = plan.writer.filament;
    const filamentCm3 = (filamentMm * Math.PI * settings.filament.diameter ** 2) / 4 / 1000;
    const filamentGrams = filamentCm3 * settings.filament.density;
    const stats: PrintStats = {
        layers: layers.length,
        seconds: estimate.seconds,
        filamentMm,
        filamentCm3,
        filamentGrams,
        filamentCost: (filamentGrams / 1000) * settings.filament.cost,
    };
    const footer: ToolpathMove[] = [
        { kind: "comment", text: `filament used [mm] = ${filamentMm.toFixed(2)}` },
        { kind: "comment", text: `filament used [cm3] = ${filamentCm3.toFixed(2)}` },
        { kind: "comment", text: `filament used [g] = ${filamentGrams.toFixed(2)}` },
        { kind: "comment", text: `filament cost = ${stats.filamentCost.toFixed(2)}` },
        { kind: "comment", text: `total layers count = ${layers.length}` },
        {
            kind: "comment",
            text: `estimated printing time (normal mode) = ${formatPrintDuration(estimate.seconds)}`,
        },
    ];
    return Result.ok({
        toolpath: {
            toolId: options.toolId ?? `nozzle-${formatNumber(settings.printer.nozzleDiameter)}`,
            label: options.label ?? "Slice",
            moves: [...moves, ...footer],
        },
        layers: layers.map((layer, i) => ({
            index: i,
            z: layer.spec.top,
            height: layer.spec.height,
            slices: layer.slices,
            perimeters: layer.islands.flatMap((island) => island.loops),
            fill: layer.fill,
            top: layer.top,
            bridge: layer.bridge,
            solid: layer.solid,
            sparse: layer.sparse,
            support: supports[i],
        })),
        stats,
        warnings,
        translation,
        skirt: plan.skirt,
        brim: plan.brim,
    });
}

interface MacroContext {
    readonly layerNum: number;
    readonly layerZ: number;
}

class PrintPlanner {
    readonly writer: ToolpathWriter;
    skirt: Paths = [];
    brim: Paths = [];
    private seamAnchors: IPoint64[] = [];
    private readonly vars: Record<string, MacroValue>;
    private fan = -1;

    constructor(
        private readonly settings: SlicerSettings,
        private readonly config: PrusaConfig,
        private readonly layers: readonly LayerRegions[],
        private readonly supports: readonly SupportLayer[],
        private readonly options: SlicePrintOptions,
        private readonly warnings: string[],
    ) {
        const p = settings.printer;
        this.writer = new ToolpathWriter({
            filamentDiameter: settings.filament.diameter,
            extrusionMultiplier: settings.filament.extrusionMultiplier,
            retractLength: p.retractLength,
            retractSpeed: p.retractSpeed,
            deretractSpeed: p.deretractSpeed,
            retractLift: p.retractLift,
            retractBeforeTravel: p.retractBeforeTravel,
            retractRestartExtra: p.retractRestartExtra,
            travelSpeed: Math.min(settings.speeds.travel, p.maxFeedrateXY),
            travelSpeedZ: Math.min(settings.speeds.travelZ, p.maxFeedrateZ),
        });
        this.planFirstLayerExtras();
        const firstLayer = union([...layers[0].slices, ...this.skirt, ...this.brim, ...supports[0].area]);
        const box = pathBounds([...firstLayer, ...this.skirt]) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        const bed = bedRectangle(p.bedShape);
        const now = options.now ?? new Date();
        const pad = (n: number) => n.toString().padStart(2, "0");
        this.vars = {
            total_layer_count: layers.length,
            max_layer_z: layers[layers.length - 1].spec.top,
            first_layer_print_min: [mm(box.minX), mm(box.minY)],
            first_layer_print_max: [mm(box.maxX), mm(box.maxY)],
            first_layer_print_size: [mm(box.maxX - box.minX), mm(box.maxY - box.minY)],
            print_bed_min: bed.min,
            print_bed_max: bed.max,
            print_bed_size: [bed.max[0] - bed.min[0], bed.max[1] - bed.min[1]],
            current_extruder: 0,
            initial_extruder: 0,
            initial_tool: 0,
            current_object_idx: 0,
            is_extruder_used: [true],
            has_wipe_tower: false,
            has_single_extruder_multi_material_priming: false,
            num_extruders: 1,
            num_objects: 1,
            num_instances: 1,
            total_toolchanges: 0,
            print_preset: options.presetNames?.print ?? "",
            filament_preset: [options.presetNames?.filament ?? ""],
            printer_preset: options.presetNames?.printer ?? "",
            physical_printer_preset: "",
            input_filename_base: options.inputName ?? "part",
            timestamp: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            day: now.getDate(),
            hour: now.getHours(),
            minute: now.getMinutes(),
            second: now.getSeconds(),
            ...options.variables,
        };
    }

    private macro(template: string, context: MacroContext, label: string): string {
        if (template.trim() === "") return "";
        const scope = prusaMacroScope(this.config, {
            ...this.vars,
            layer_num: context.layerNum,
            layer_z: context.layerZ,
        });
        const result = expandPrusaMacros(template, scope);
        for (const error of result.errors) this.warnings.push(`${label}: ${error}`);
        return result.text;
    }

    // -------------------------------------------------------------------- skirt & brim

    private planFirstLayerExtras() {
        const s = this.settings;
        const first = this.layers[0];
        const w = s.widths.firstLayer;
        const spacing = extrusionSpacing(w, first.spec.height);
        if (s.brimWidth > 0) {
            const outers = first.islands.flatMap((island) => [island.island.outer]);
            const count = Math.max(1, Math.floor(s.brimWidth / spacing));
            for (let k = count - 1; k >= 0; k--) {
                this.brim.push(...offset(outers, s.brimSeparation + w / 2 + k * spacing, "round"));
            }
        }
        // min_skirt_length adds loops to a skirt; it does not make one.
        if (s.skirts > 0) {
            const hull = convexHull([...first.slices, ...this.brim, ...this.supports[0].area].flat());
            if (hull.length >= 3) {
                let filament = 0;
                for (let k = 0; k < 1000; k++) {
                    if (k >= s.skirts && filament >= s.minSkirtLength) break;
                    const loop = offset([hull], s.skirtDistance + w / 2 + k * spacing, "round");
                    if (loop.length === 0) break;
                    this.skirt.push(...loop);
                    const length = loop.reduce((sum, path) => sum + pathLength(path, true) / SCALE, 0);
                    filament += this.writer.filamentFor(length, w, first.spec.height);
                }
                // Outermost loop first, finishing next to the part.
                this.skirt.reverse();
                const bed = bedRectangle(s.printer.bedShape);
                const onBed = this.skirt.filter((loop) => {
                    const b = pathBounds([loop]);
                    return (
                        b !== undefined &&
                        b.minX >= bed.min[0] * SCALE &&
                        b.minY >= bed.min[1] * SCALE &&
                        b.maxX <= bed.max[0] * SCALE &&
                        b.maxY <= bed.max[1] * SCALE
                    );
                });
                if (onBed.length < this.skirt.length) {
                    this.warnings.push(
                        `${this.skirt.length - onBed.length} skirt loop(s) would leave the bed: dropped`,
                    );
                    this.skirt = onBed;
                }
            }
        }
    }

    // -------------------------------------------------------------------- speeds

    private speedFor(base: number, width: number, height: number, layer: number): number {
        const s = this.settings;
        let speed = base;
        if (layer === 0)
            speed = s.speeds.firstLayerSpeedIsRatio ? base * s.speeds.firstLayer : s.speeds.firstLayer;
        speed = Math.min(speed, s.speeds.maxPrint, s.printer.maxFeedrateXY);
        if (s.filament.maxVolumetricSpeed > 0) {
            speed = Math.min(speed, s.filament.maxVolumetricSpeed / extrusionArea(width, height));
        }
        return Math.max(0.1, speed);
    }

    // -------------------------------------------------------------------- program

    write(): ToolpathMove[] {
        const s = this.settings;
        const w = this.writer;
        const start = this.macro(s.gcode.start, { layerNum: 0, layerZ: s.firstLayerHeight }, "start G-code");
        const code = stripComments(start);
        const temps = s.filament;
        w.comment(`generated by Chili3d built-in slicer`);
        if (this.options.presetNames?.printer) w.comment(`printer: ${this.options.presetNames.printer}`);
        if (this.options.presetNames?.print) w.comment(`print: ${this.options.presetNames.print}`);
        if (this.options.presetNames?.filament) w.comment(`filament: ${this.options.presetNames.filament}`);
        if (s.printer.emitMachineLimits && s.printer.flavor !== "klipper") w.raw(this.machineLimits());
        const autoemit = s.printer.autoemitTemperatureCommands;
        const setsBed = /^\s*M(140|190)\b/im.test(code);
        const setsNozzle = /^\s*M(104|109)\b/im.test(code);
        if (autoemit && !setsBed)
            w.raw(`M190 S${formatNumber(temps.firstLayerBedTemperature)} ; set bed temperature and wait`);
        if (autoemit && !setsNozzle)
            w.raw(`M104 S${formatNumber(temps.firstLayerTemperature)} ; set nozzle temperature`);
        w.raw(start);
        if (autoemit && !setsNozzle)
            w.raw(`M109 S${formatNumber(temps.firstLayerTemperature)} ; wait for nozzle temperature`);
        w.raw(
            this.macro(
                s.gcode.startFilament,
                { layerNum: 0, layerZ: s.firstLayerHeight },
                "filament start G-code",
            ),
        );

        for (let i = 0; i < this.layers.length; i++) this.writeLayer(i);

        w.retract();
        w.raw("M107 ; fan off");
        const last = this.layers[this.layers.length - 1].spec;
        const end = { layerNum: this.layers.length - 1, layerZ: last.top };
        w.raw(this.macro(s.gcode.endFilament, end, "filament end G-code"));
        w.raw(this.macro(s.gcode.end, end, "end G-code"));
        return w.moves;
    }

    private machineLimits(): string {
        const v = (key: string, fallback: number) =>
            formatNumber(firstNumber(configValue(this.config, key), fallback));
        return [
            `M201 X${v("machine_max_acceleration_x", 1000)} Y${v("machine_max_acceleration_y", 1000)} Z${v("machine_max_acceleration_z", 200)} E${v("machine_max_acceleration_e", 5000)} ; max accelerations, mm/s²`,
            `M203 X${v("machine_max_feedrate_x", 200)} Y${v("machine_max_feedrate_y", 200)} Z${v("machine_max_feedrate_z", 12)} E${v("machine_max_feedrate_e", 120)} ; max feedrates, mm/s`,
            `M204 P${v("machine_max_acceleration_extruding", 1250)} R${v("machine_max_acceleration_retracting", 1250)} T${v("machine_max_acceleration_travel", 1250)} ; accelerations, mm/s²`,
            `M205 X${v("machine_max_jerk_x", 8)} Y${v("machine_max_jerk_y", 8)} Z${v("machine_max_jerk_z", 0.4)} E${v("machine_max_jerk_e", 4.5)} ; jerk limits, mm/s`,
        ].join("\n");
    }

    private writeLayer(i: number) {
        const s = this.settings;
        const w = this.writer;
        const layer = this.layers[i];
        const spec = layer.spec;
        const context = { layerNum: i, layerZ: spec.top };
        const header: ToolpathMove[] = [];
        const begin = w.moves.length;
        w.comment("LAYER_CHANGE");
        w.comment(`Z:${formatNumber(spec.top, 3)}`);
        w.comment(`HEIGHT:${formatNumber(spec.height, 3)}`);
        w.raw(this.macro(s.gcode.beforeLayer, context, "before layer change G-code"));
        w.layerZ(spec.top, s.printer.retractLayerChange && i > 0);
        w.raw(this.macro(s.gcode.layer, context, "layer change G-code"));
        if (i === 1) {
            if (s.filament.temperature !== s.filament.firstLayerTemperature) {
                header.push({
                    kind: "raw",
                    code: `M104 S${formatNumber(s.filament.temperature)} ; nozzle temperature`,
                });
            }
            if (s.filament.bedTemperature !== s.filament.firstLayerBedTemperature) {
                header.push({
                    kind: "raw",
                    code: `M140 S${formatNumber(s.filament.bedTemperature)} ; bed temperature`,
                });
            }
        }
        const widths = layerWidths(s, i);
        const h = spec.height;
        if (i < s.skirtHeight && this.skirt.length > 0) {
            w.setRole("Skirt/Brim");
            const speed = this.speedFor(s.speeds.perimeter, widths.perimeter, h, i);
            for (const loop of orderLoops(this.skirt, this.position(), (path, from) =>
                nearestVertex(path, from),
            )) {
                w.extrudePath(loop.points, true, widths.perimeter, h, speed);
            }
        }
        if (i === 0 && this.brim.length > 0) {
            w.setRole("Skirt/Brim");
            const speed = this.speedFor(s.speeds.perimeter, widths.perimeter, h, i);
            for (const loop of orderLoops(this.brim, this.position(), (path, from) =>
                nearestVertex(path, from),
            )) {
                w.extrudePath(loop.points, true, widths.perimeter, h, speed);
            }
        }
        const anchors: IPoint64[] = [];
        const remaining = [...layer.islands];
        while (remaining.length > 0) {
            const at = this.position();
            let best = 0;
            let bestSq = Number.POSITIVE_INFINITY;
            remaining.forEach((island, k) => {
                const v = island.island.outer[nearestVertex(island.island.outer, at)];
                const d = (v.x - at.x) ** 2 + (v.y - at.y) ** 2;
                if (d < bestSq) {
                    bestSq = d;
                    best = k;
                }
            });
            const island = remaining.splice(best, 1)[0];
            this.writePerimeters(island.loops, i, anchors);
            this.writeInfill(island.fill, layer, i);
        }
        this.seamAnchors = anchors;
        this.writeSupport(this.supports[i], i, spec.top);

        const moves = w.moves.splice(begin);
        const time = layerTime(moves);
        this.slowDown(moves, time);
        const fan = this.fanFor(i, time);
        if (fan !== this.fan) {
            header.push({
                kind: "raw",
                code: fan <= 0 ? "M107" : `M106 S${Math.round((Math.min(100, fan) * 255) / 100)}`,
            });
            this.fan = fan;
        }
        // Layer-change lines first, then this layer's fan and temperatures, then its extrusions.
        const changeEnd = moves.findIndex((m) => m.kind === "comment" && m.text.startsWith("TYPE:"));
        const split = changeEnd < 0 ? moves.length : changeEnd;
        w.moves.push(...moves.slice(0, split), ...header, ...moves.slice(split));
    }

    private position(): IPoint64 {
        return { x: Math.round(this.writer.x * SCALE), y: Math.round(this.writer.y * SCALE) };
    }

    private seamFor(
        loop: Path,
        from: IPoint64,
        external: boolean,
        anchors: IPoint64[],
        islandSeam?: IPoint64,
    ): number {
        switch (this.settings.seamPosition) {
            case "nearest":
                return nearestVertex(loop, from);
            case "rear":
                return rearVertex(loop);
            case "random":
                return Math.floor(pseudoRandom(loop.length * 7919 + anchors.length) * loop.length);
            default: {
                if (!external && islandSeam) return nearestVertex(loop, islandSeam);
                if (this.seamAnchors.length === 0) return rearVertex(loop);
                const first = loop[0];
                let anchor = this.seamAnchors[0];
                let bestSq = Number.POSITIVE_INFINITY;
                for (const a of this.seamAnchors) {
                    const d = (a.x - first.x) ** 2 + (a.y - first.y) ** 2;
                    if (d < bestSq) {
                        bestSq = d;
                        anchor = a;
                    }
                }
                return nearestVertex(loop, anchor);
            }
        }
    }

    private writePerimeters(loops: readonly PerimeterLoop[], layerIndex: number, anchors: IPoint64[]) {
        if (loops.length === 0) return;
        const s = this.settings;
        const w = this.writer;
        const depths = [...new Set(loops.map((loop) => loop.depth))].sort((a, b) =>
            s.externalPerimetersFirst ? a - b : b - a,
        );
        let islandSeam: IPoint64 | undefined;
        // The external loop's seam guides the inner loops' (aligned seams).
        const externalContours = loops.filter((loop) => loop.depth === 0 && !loop.hole);
        if (externalContours.length > 0) {
            const loop = externalContours[0].path;
            islandSeam = loop[this.seamFor(loop, this.position(), true, anchors)];
        }
        for (const depth of depths) {
            const ring = loops.filter((loop) => loop.depth === depth);
            const external = depth === 0;
            const role: ExtrusionRole = external ? "External perimeter" : "Perimeter";
            const width = ring[0].width;
            const h = this.layers[layerIndex].spec.height;
            const base = external ? s.speeds.externalPerimeter : s.speeds.perimeter;
            const speed = this.speedFor(base, width, h, layerIndex);
            const simplified = ring.map((loop) => simplifyClosed([loop.path], s.resolution)[0] ?? loop.path);
            const ordered = orderLoops(simplified, this.position(), (path, from) =>
                this.seamFor(path, from, external, anchors, islandSeam),
            );
            w.setRole(role);
            for (const loop of ordered) {
                if (external) anchors.push(loop.points[0]);
                w.extrudePath(loop.points, true, width, h, speed, { seamGap: s.seamGap });
            }
        }
    }

    private writeInfill(fill: Paths, layer: LayerRegions, layerIndex: number) {
        if (fill.length === 0) return;
        const s = this.settings;
        const widths = layerWidths(s, layerIndex);
        const h = layer.spec.height;
        const odd = layerIndex % 2 === 1;
        const solidAngle = s.infillAngle + (odd ? 90 : 0);
        const parts: { region: Paths; role: ExtrusionRole; width: number; speed: number }[] = [
            {
                region: layer.bridge,
                role: "Bridge infill",
                width: widths.solidInfill,
                speed: s.speeds.bridge,
            },
            {
                region: layer.solid,
                role: "Solid infill",
                width: widths.solidInfill,
                speed: s.speeds.solidInfill,
            },
            {
                region: layer.top,
                role: "Top solid infill",
                width: widths.topInfill,
                speed: s.speeds.topSolidInfill,
            },
        ];
        for (const part of parts) {
            if (part.region.length === 0) continue;
            const region = intersection(fill, part.region);
            if (region.length === 0) continue;
            const spacing = extrusionSpacing(part.width, h);
            this.writeFillRegion(
                region,
                part.role,
                part.width,
                h,
                this.speedFor(part.speed, part.width, h, layerIndex),
                {
                    pattern: s.solidPattern,
                    angle: solidAngle,
                    pitch: spacing,
                    spacing,
                    z: layer.spec.top,
                },
            );
        }
        if (layer.sparse.length > 0) {
            const region = intersection(fill, layer.sparse);
            if (region.length === 0) return;
            const width = widths.infill;
            const spacing = extrusionSpacing(width, h);
            const density = s.infillDensity;
            const pattern = s.infillPattern;
            this.writeFillRegion(
                region,
                "Internal infill",
                width,
                h,
                this.speedFor(s.speeds.infill, width, h, layerIndex),
                {
                    pattern,
                    angle: pattern === "grid" ? s.infillAngle : s.infillAngle + (odd ? 90 : 0),
                    pitch: pattern === "grid" ? (2 * spacing) / density : spacing / density,
                    spacing,
                    density,
                    z: layer.spec.top,
                },
            );
        }
    }

    private writeFillRegion(
        region: Paths,
        role: ExtrusionRole,
        width: number,
        height: number,
        speed: number,
        fill: {
            pattern: "rectilinear" | "grid" | "gyroid" | "concentric";
            angle: number;
            pitch: number;
            spacing: number;
            density?: number;
            z: number;
        },
    ) {
        const w = this.writer;
        // Line centres stay a little under half a spacing inside the region's edge.
        const clip = offset(region, -0.4 * fill.spacing);
        if (clip.length === 0) return;
        let paths: { points: Path; closed: boolean }[];
        if (fill.pattern === "concentric") {
            paths = orderLoops(concentricLoops(region, fill.pitch), this.position(), (path, from) =>
                nearestVertex(path, from),
            );
        } else {
            let lines: Paths;
            if (fill.pattern === "gyroid") {
                lines = gyroidLines(clip, fill.z, fill.spacing, fill.density ?? 1, fill.angle);
            } else if (fill.pattern === "grid") {
                lines = [
                    ...rectilinearLines(clip, fill.angle, fill.pitch),
                    ...rectilinearLines(clip, fill.angle + 90, fill.pitch),
                ];
            } else lines = rectilinearLines(clip, fill.angle, fill.pitch);
            // Connectors run along the clip boundary, well inside the region.
            const inside = new RegionIndex(region);
            paths = orderPolylines(
                lines,
                this.position(),
                fill.pattern === "gyroid"
                    ? undefined
                    : { maxDistanceMm: fill.pitch * 3, isInside: (a, b) => connectorInside(inside, a, b) },
            );
        }
        if (paths.length === 0) return;
        w.setRole(role);
        const noRetractRegion = this.settings.onlyRetractWhenCrossingPerimeters
            ? new RegionIndex(offset(region, 0.05))
            : undefined;
        for (const path of paths) {
            let noRetract = false;
            if (noRetractRegion) {
                const from = this.position();
                noRetract =
                    noRetractRegion.contains(from) && connectorInside(noRetractRegion, from, path.points[0]);
            }
            w.extrudePath(path.points, path.closed, width, height, speed, { noRetract });
        }
    }

    private writeSupport(support: SupportLayer, layerIndex: number, z: number) {
        const s = this.settings;
        const h = this.layers[layerIndex].spec.height;
        const width = layerWidths(s, layerIndex).support;
        const spacing = extrusionSpacing(width, h);
        if (support.area.length > 0) {
            this.writeFillRegion(
                support.area,
                "Support material",
                width,
                h,
                this.speedFor(s.speeds.support, width, h, layerIndex),
                {
                    pattern: "rectilinear",
                    angle: s.supports.angle,
                    pitch: s.supports.spacing + spacing,
                    spacing,
                    z,
                },
            );
        }
        if (support.interface.length > 0) {
            this.writeFillRegion(
                support.interface,
                "Support material interface",
                width,
                h,
                this.speedFor(s.speeds.supportInterface, width, h, layerIndex),
                {
                    pattern: "rectilinear",
                    angle: s.supports.angle + 90,
                    pitch: s.supports.interfaceSpacing + spacing,
                    spacing,
                    z,
                },
            );
        }
    }

    // -------------------------------------------------------------------- cooling

    /** Slows a short layer's extrusions down to `slowdown_below_layer_time`. */
    private slowDown(moves: ToolpathMove[], time: number) {
        const c = this.settings.cooling;
        if (!c.enabled || c.slowdownBelowLayerTime <= 0 || time >= c.slowdownBelowLayerTime || time <= 0)
            return;
        const factor = time / c.slowdownBelowLayerTime;
        const floor = c.minPrintSpeed * 60;
        let at: Vec3 | undefined;
        for (let k = 0; k < moves.length; k++) {
            const move = moves[k];
            if (move.kind === "extrude") {
                // Only real extrusions slow down (not retractions, which do not move).
                const moved = at !== undefined && Math.hypot(move.to[0] - at[0], move.to[1] - at[1]) > 1e-9;
                if (moved && move.extrude > 0 && move.feed > floor) {
                    moves[k] = { ...move, feed: Math.max(floor, move.feed * factor) };
                }
            }
            if (move.kind === "extrude" || move.kind === "rapid") at = move.to;
        }
    }

    /** PrusaSlicer's fan rule: off for the first layers, then min…max as layers get short. */
    private fanFor(layerIndex: number, time: number): number {
        const c = this.settings.cooling;
        if (layerIndex < c.disableFanFirstLayers) return 0;
        let fan = c.fanAlwaysOn ? c.minFanSpeed : 0;
        if (c.enabled && time < c.fanBelowLayerTime) {
            if (time < c.slowdownBelowLayerTime) fan = c.maxFanSpeed;
            else {
                const t =
                    (time - c.slowdownBelowLayerTime) / (c.fanBelowLayerTime - c.slowdownBelowLayerTime);
                fan = Math.round(t * c.minFanSpeed + (1 - t) * c.maxFanSpeed);
            }
        }
        return fan;
    }
}

/** How far skirt and brim reach beyond the parts on the first layer (mm). */
export function firstLayerMargin(settings: SlicerSettings): number {
    const w = settings.widths.firstLayer;
    const skirt = settings.skirts > 0 ? settings.skirtDistance + settings.skirts * w + w : 0;
    const brim = settings.brimWidth > 0 ? settings.brimWidth + settings.brimSeparation + w : 0;
    return skirt + brim;
}

/** Seconds a layer's moves take at their feeds (no acceleration). */
function layerTime(moves: readonly ToolpathMove[]): number {
    let time = 0;
    let at: Vec3 | undefined;
    for (const move of moves) {
        if (move.kind !== "extrude" && move.kind !== "rapid") continue;
        const feed = (move.feed ?? 0) / 60;
        if (at && feed > 0) {
            const d = Math.hypot(move.to[0] - at[0], move.to[1] - at[1], move.to[2] - at[2]);
            time += d > 1e-9 ? d / feed : move.kind === "extrude" ? Math.abs(move.extrude) / feed : 0;
        }
        at = move.to;
    }
    return time;
}

/** G-code with `;` comments removed (to look for commands). */
function stripComments(code: string): string {
    return code
        .split("\n")
        .map((line) => line.replace(/;.*$/, ""))
        .join("\n");
}

function pseudoRandom(seed: number): number {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
}

/** Convex hull (Andrew's monotone chain) of integer points, counter-clockwise. */
export function convexHull(points: readonly IPoint64[]): Path {
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    if (sorted.length < 3) return sorted;
    const cross = (o: IPoint64, a: IPoint64, b: IPoint64) =>
        (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: IPoint64[] = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
            lower.pop();
        lower.push(p);
    }
    const upper: IPoint64[] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
            upper.pop();
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    return [...lower, ...upper];
}

/** Cuts every layer and applies the XY size and elephant-foot compensations. */
function cutLayers(
    mesh: WeldedMesh,
    specs: readonly { sliceZ: number }[],
    settings: SlicerSettings,
): { regions: Paths[]; openChains: number } {
    let openChains = 0;
    const regions = sliceMesh(
        mesh,
        specs.map((spec) => spec.sliceZ),
    ).map((cut, i) => {
        openChains += cut.openChains;
        let region = simplifyClosed(cut.region, settings.resolution / 2);
        if (settings.xySizeCompensation !== 0) region = offset(region, settings.xySizeCompensation);
        if (i === 0 && settings.elephantFootCompensation > 0) {
            // Shrink the first layer, but never make it vanish.
            const shrunk = offset(region, -settings.elephantFootCompensation);
            if (shrunk.length > 0) region = shrunk;
        }
        return region;
    });
    return { regions, openChains };
}
