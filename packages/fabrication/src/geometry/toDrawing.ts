// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Drawing, DrawingEntity, DrawingLayer } from "@chili3d/drawing";
import type { FlatPattern, Segment } from "./types";

export interface PatternLayers {
    readonly outline: DrawingLayer;
    readonly bend: DrawingLayer;
}

/**
 * Onshape's sketch DXF export puts the cut outline on `ModelSketch_Visible`; using the same
 * name keeps files from Chili3d interchangeable with an existing library of Onshape exports.
 */
export const ONSHAPE_LAYERS: PatternLayers = {
    outline: { name: "ModelSketch_Visible", aci: 7, color: "#1f2937" },
    bend: { name: "Bend", aci: 1, color: "#d9480f", dashed: true },
};

export interface ToDrawingOptions {
    readonly layers?: PatternLayers;
    /** Include fold lines (on the bend layer); off by default, like Onshape's export. */
    readonly bendLines?: boolean;
}

function entity(segment: Segment, layer: string): DrawingEntity {
    return segment.kind === "line"
        ? { kind: "line", layer, a: segment.a, b: segment.b }
        : {
              kind: "arc",
              layer,
              center: segment.center,
              radius: segment.radius,
              startAngle: segment.startAngle,
              endAngle: segment.endAngle,
          };
}

/** The pattern as a drawing for the DXF/SVG writers of `@chili3d/drawing`. */
export function toDrawing(pattern: FlatPattern, options: ToDrawingOptions = {}): Drawing {
    const layers = options.layers ?? ONSHAPE_LAYERS;
    const withBends = options.bendLines === true;
    return {
        units: pattern.units,
        layers: withBends ? [layers.outline, layers.bend] : [layers.outline],
        entities: pattern.parts.flatMap((part) => [
            ...part.outline.map((s) => entity(s, layers.outline.name)),
            ...(withBends ? part.bendLines.map((s) => entity(s, layers.bend.name)) : []),
        ]),
    };
}
