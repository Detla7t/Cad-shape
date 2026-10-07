// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Drawing,
    type DrawingEntity,
    type DrawingLayer,
    degreesOf,
    normalizeDegrees,
} from "../drawing/drawing";
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
    const entities: DrawingEntity[] = [];
    for (const entity of data.entities) {
        const drawn = entityOf(entity.type, entity.params, layers.sketch.name);
        if (drawn !== undefined) entities.push(drawn);
    }
    if (options.external !== false) {
        for (const ref of data.externalRefs ?? []) {
            const drawn = entityOf(ref.type, ref.snapshot, layers.external.name);
            if (drawn !== undefined) entities.push(drawn);
        }
    }
    return { layers: Object.values(layers), entities };
}
