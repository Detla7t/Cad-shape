// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Drawing,
    type DrawingEntity,
    type DrawingLayer,
    degreesOf,
    normalizeDegrees,
} from "@chili3d/drawing";
import { sampleCurve } from "./curveGeometry";
import type { SketchData, SketchEntityType } from "./sketchModel";

/**
 * A sketch as a 2D drawing in its own (u, v) plane coordinates, millimetres: its lines,
 * circles and arcs on SKETCH, and the edges it projected from other parts on EXTERNAL.
 */

export const SKETCH_DRAWING_LAYERS = {
    sketch: { name: "SKETCH", aci: 7, color: "#000000" },
    external: { name: "EXTERNAL", aci: 8, color: "#808080", dashed: true },
} as const satisfies Record<string, DrawingLayer>;

export interface SketchDrawingOptions {
    /** Include the projected external edges (default true). */
    readonly external?: boolean;
}

function entityOf(
    type: SketchEntityType,
    params: readonly number[],
    layer: string,
): DrawingEntity | undefined {
    if (["point", "bezier", "spline"].includes(type)) return undefined;
    if (type === "line") {
        const [x1, y1, x2, y2] = params;
        if (Math.hypot(x2 - x1, y2 - y1) < 1e-12) return undefined;
        return { kind: "line", layer, a: [x1, y1], b: [x2, y2] };
    }
    if (type === "circle") {
        const [cx, cy, r] = params;
        return r > 0 ? { kind: "circle", layer, center: [cx, cy], radius: r } : undefined;
    }
    // Arc: center, start, end; counter-clockwise from start to end, radius ‖start − center‖.
    const [cx, cy, sx, sy, ex, ey] = params;
    const radius = Math.hypot(sx - cx, sy - cy);
    if (radius <= 0) return undefined;
    return {
        kind: "arc",
        layer,
        center: [cx, cy],
        radius,
        startAngle: normalizeDegrees(degreesOf(Math.atan2(sy - cy, sx - cx))),
        endAngle: normalizeDegrees(degreesOf(Math.atan2(ey - cy, ex - cx))),
    };
}

export function sketchDrawing(data: SketchData, options: SketchDrawingOptions = {}): Drawing {
    const layers = SKETCH_DRAWING_LAYERS;
    const outputLayers: DrawingLayer[] = [...Object.values(layers)];
    const colorIndex = (hex: string): number => {
        const rgb = Number.parseInt(hex.slice(1), 16);
        const channels = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
        const palette = [0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080];
        let best = 7,
            distance = Infinity;
        palette.forEach((color, index) => {
            const d =
                (((color >> 16) & 255) - channels[0]) ** 2 +
                (((color >> 8) & 255) - channels[1]) ** 2 +
                ((color & 255) - channels[2]) ** 2;
            if (d < distance) {
                best = index + 1;
                distance = d;
            }
        });
        return best;
    };
    for (const layer of data.layers ?? [])
        outputLayers.push({
            name: layer.name,
            color: layer.color,
            aci: colorIndex(layer.color),
            dashed: layer.dashed,
        });
    const entities: DrawingEntity[] = [];
    for (const entity of data.entities) {
        const layer = data.layers?.find((layer) => layer.id === (entity.layer ?? "0"));
        let name = layer?.name ?? layers.sketch.name;
        const color = entity.color ?? layer?.color ?? layers.sketch.color;
        if (entity.construction || entity.dashed || entity.color) {
            name += `${entity.construction ? "_CONSTRUCTION" : entity.dashed ? "_DASHED" : ""}${entity.color ? `_${entity.color.slice(1)}` : ""}`;
            if (!outputLayers.some((layer) => layer.name === name))
                outputLayers.push({
                    name,
                    color,
                    aci: colorIndex(color),
                    dashed: entity.construction || entity.dashed || layer?.dashed,
                });
        }
        if (entity.type === "bezier" || entity.type === "spline") {
            const p = sampleCurve(entity, 0.01);
            for (let i = 1; i < p.length; i++)
                entities.push({ kind: "line", layer: name, a: p[i - 1], b: p[i] });
        }
        const drawn = entityOf(entity.type, entity.params, name);
        if (drawn !== undefined) entities.push(drawn);
    }
    if (options.external !== false) {
        for (const ref of data.externalRefs ?? []) {
            const drawn = entityOf(ref.type, ref.snapshot, layers.external.name);
            if (drawn !== undefined) entities.push(drawn);
        }
    }
    return { layers: [...new Map(outputLayers.map((layer) => [layer.name, layer])).values()], entities };
}
