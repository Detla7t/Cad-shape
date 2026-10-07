// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    areaMm2,
    difference,
    type Island,
    intersection,
    islandPaths,
    islands,
    offset,
    opening,
    type Path,
    type Paths,
    signedArea,
    union,
} from "../geometry/polygons";
import { extrusionSpacing, type SlicerSettings } from "../prusa/settings";
import { floatOrPercent } from "../prusa/values";

/**
 * Layers and their regions: the heights the part is cut at, the perimeter loops of every
 * island, the area left for infill, and which of it must be solid (within the top/bottom
 * shell count of a surface facing up or down) and which is sparse.
 */

export interface LayerSpec {
    readonly index: number;
    readonly bottom: number;
    /** The print z (nozzle height) of the layer. */
    readonly top: number;
    readonly height: number;
    /** Where the mesh is cut: the middle of the layer. */
    readonly sliceZ: number;
}

/** The first layer, then `layerHeight` layers up to `objectHeight` (a thinner last one if needed). */
export function layerSpecs(objectHeight: number, firstLayerHeight: number, layerHeight: number): LayerSpec[] {
    const specs: LayerSpec[] = [];
    if (objectHeight <= 1e-6) return specs;
    const round = (z: number) => Math.round(z * 1e6) / 1e6;
    let bottom = 0;
    let top = round(Math.min(firstLayerHeight, objectHeight));
    for (let index = 0; ; index++) {
        specs.push({ index, bottom, top, height: round(top - bottom), sliceZ: (bottom + top) / 2 });
        if (top >= objectHeight - 1e-6) break;
        bottom = top;
        top = round(Math.min(firstLayerHeight + (index + 1) * layerHeight, objectHeight));
        // A sliver under a hundredth of a millimetre is merged into the previous layer.
        if (objectHeight - top < 0.01 && top < objectHeight) top = objectHeight;
    }
    return specs;
}

export interface PerimeterLoop {
    /** Integer-unit closed path (CCW contour, CW hole). */
    readonly path: Path;
    /** 0 for the external perimeter. */
    readonly depth: number;
    readonly width: number;
    readonly hole: boolean;
}

export interface IslandRegions {
    readonly island: Island;
    readonly loops: readonly PerimeterLoop[];
    /** Inside the innermost perimeter (with the infill overlap): where infill goes. */
    readonly fill: Paths;
}

export interface LayerRegions {
    readonly spec: LayerSpec;
    /** The cut region after size compensation. */
    readonly slices: Paths;
    readonly islands: readonly IslandRegions[];
    /** Union of the islands' fill areas. */
    readonly fill: Paths;
    /** Solid infill: top surfaces, bridges over air, and internal solid shells. */
    top: Paths;
    bridge: Paths;
    solid: Paths;
    sparse: Paths;
}

export interface LayerWidths {
    readonly externalPerimeter: number;
    readonly perimeter: number;
    readonly infill: number;
    readonly solidInfill: number;
    readonly topInfill: number;
    readonly support: number;
}

/** Extrusion widths on a layer: the first layer uses its own width for everything. */
export function layerWidths(settings: SlicerSettings, index: number): LayerWidths {
    if (index === 0) {
        const w = settings.widths.firstLayer;
        return { externalPerimeter: w, perimeter: w, infill: w, solidInfill: w, topInfill: w, support: w };
    }
    const w = settings.widths;
    return {
        externalPerimeter: w.externalPerimeter,
        perimeter: w.perimeter,
        infill: w.infill,
        solidInfill: w.solidInfill,
        topInfill: w.topInfill,
        support: w.support,
    };
}

/**
 * Perimeters of one island, PrusaSlicer's way: the external loop's centre line sits half its
 * width inside the contour (the part keeps its size), each next loop one spacing further
 * (half external spacing plus half perimeter spacing after the first). The infill boundary is
 * half a spacing inside the innermost loop, minus the infill overlap.
 */
export function islandPerimeters(
    island: Island,
    perimeters: number,
    widths: LayerWidths,
    height: number,
    infillOverlapText: string | undefined,
): IslandRegions {
    const region = islandPaths(island);
    const loops: PerimeterLoop[] = [];
    const sExt = extrusionSpacing(widths.externalPerimeter, height);
    const s = extrusionSpacing(widths.perimeter, height);
    let inset = widths.externalPerimeter / 2;
    let lastInset = 0;
    let lastSpacing = 0;
    for (let k = 0; k < perimeters; k++) {
        const ring = offset(region, -inset);
        if (ring.length === 0) break;
        for (const path of ring) {
            loops.push({
                path,
                depth: k,
                width: k === 0 ? widths.externalPerimeter : widths.perimeter,
                hole: signedArea(path) < 0,
            });
        }
        lastInset = inset;
        lastSpacing = k === 0 ? sExt : s;
        inset += k === 0 ? (sExt + s) / 2 : s;
    }
    const sSolid = extrusionSpacing(widths.solidInfill, height);
    let fill: Paths;
    if (perimeters === 0) fill = region;
    else if (loops.length === 0) fill = [];
    else {
        const overlap = floatOrPercent(infillOverlapText, lastSpacing / 2 + sSolid / 2, 0);
        const boundary = lastInset + lastSpacing / 2 - overlap;
        // Narrow leftovers (less than ~a solid line wide) cannot hold a fill line.
        const narrow = (sSolid * 0.85) / 2;
        fill = offset(offset(region, -(boundary + narrow)), narrow);
    }
    return { island, loops, fill };
}

/** Areas narrower than this fraction of a spacing are dropped from exposure maps. */
const SLIVER = 0.25;

/**
 * Classifies every layer's fill area into top, bridge, internal solid and sparse:
 * a point is solid when the part's surface faces down within `bottomSolidLayers` below it
 * (or the bed) or up within `topSolidLayers` above it (or the top). Minimum shell thicknesses
 * raise the layer counts.
 */
export function classifyLayers(layers: readonly LayerRegions[], settings: SlicerSettings): void {
    const n = layers.length;
    const h = settings.layerHeight;
    const topCount = Math.max(settings.topSolidLayers, Math.ceil(settings.topSolidMinThickness / h - 1e-6));
    const bottomCount = Math.max(
        settings.bottomSolidLayers,
        Math.ceil(settings.bottomSolidMinThickness / h - 1e-6),
    );
    const sliver = (index: number) => extrusionSpacing(layerWidths(settings, index).solidInfill, h) * SLIVER;
    const downFacing: Paths[] = [];
    const upFacing: Paths[] = [];
    for (let i = 0; i < n; i++) {
        const below = i === 0 ? [] : layers[i - 1].slices;
        const above = i === n - 1 ? [] : layers[i + 1].slices;
        downFacing.push(i === 0 ? layers[0].slices : opening(difference(layers[i].slices, below), sliver(i)));
        upFacing.push(
            i === n - 1 ? layers[i].slices : opening(difference(layers[i].slices, above), sliver(i)),
        );
    }
    for (let i = 0; i < n; i++) {
        const layer = layers[i];
        if (layer.fill.length === 0) continue;
        const exposed: Paths = [];
        for (let j = Math.max(0, i - bottomCount + 1); j <= i && bottomCount > 0; j++)
            exposed.push(...downFacing[j]);
        for (let j = i; j < Math.min(n, i + topCount) && topCount > 0; j++) exposed.push(...upFacing[j]);
        const solidAll = exposed.length > 0 ? intersection(layer.fill, union(exposed)) : [];
        layer.top = topCount > 0 ? intersection(solidAll, upFacing[i]) : [];
        layer.bridge =
            i > 0 && bottomCount > 0 ? difference(intersection(solidAll, downFacing[i]), layer.top) : [];
        layer.solid = difference(difference(solidAll, layer.top), layer.bridge);
        let sparse = difference(layer.fill, solidAll);
        if (settings.infillDensity >= 0.9999) {
            layer.solid = union(layer.solid, sparse);
            sparse = [];
        } else if (settings.solidInfillBelowArea > 0 && sparse.length > 0) {
            const small: Paths = [];
            const kept: Paths = [];
            for (const island of islands(sparse)) {
                const paths = islandPaths(island);
                (areaMm2(paths) < settings.solidInfillBelowArea ? small : kept).push(...paths);
            }
            if (small.length > 0) layer.solid = union(layer.solid, small);
            sparse = kept;
        }
        layer.sparse = settings.infillDensity <= 0 ? [] : sparse;
    }
}
