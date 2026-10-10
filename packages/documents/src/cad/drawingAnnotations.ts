// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Drawing,
    type DrawingEntity,
    type DrawingLayer,
    normalizeDegrees,
    type Point2,
} from "@chili3d/drawing";
import { SHEET_LAYERS } from "./sheetDrawing";

/**
 * Annotations on a drawing sheet — notes and linear dimensions — as plain drawing
 * entities on their own layers, so a DXF reader anywhere shows them, and the sheet's
 * properties (its size, scale and title block fields), kept in the DXF's leading
 * comments so the sheet can be regenerated from them.
 */

export const ANNOTATION_LAYERS = {
    notes: { name: "NOTES", aci: 3, color: "#1a7f37" },
    dimensions: { name: "DIMENSIONS", aci: 5, color: "#1651b0" },
    template: { name: "TEMPLATE", aci: 8, color: "#808080" },
} as const satisfies Record<string, DrawingLayer>;

export const NOTE_HEIGHT = 2.5;
export const DIMENSION_TEXT_HEIGHT = 2.5;
const ARROW = 2;

/** The layers that belong to the sheet itself, not to the model's views. */
const SHEET_LAYER_NAMES = new Set<string>([
    SHEET_LAYERS.frame.name,
    SHEET_LAYERS.title.name,
    SHEET_LAYERS.text.name,
    ANNOTATION_LAYERS.template.name,
]);
const ANNOTATION_LAYER_NAMES = new Set<string>([
    ANNOTATION_LAYERS.notes.name,
    ANNOTATION_LAYERS.dimensions.name,
]);

export function noteEntity(position: Point2, text: string, height = NOTE_HEIGHT): DrawingEntity {
    return { kind: "text", layer: ANNOTATION_LAYERS.notes.name, position, height, rotation: 0, text };
}

/**
 * A linear dimension between `a` and `b`: extension lines out to a dimension line `offset`
 * away (its side chosen by the sign), arrowheads, and the label above the line's middle,
 * rotated with it.
 */
export function dimensionEntities(a: Point2, b: Point2, offset: number, label: string): DrawingEntity[] {
    const layer = ANNOTATION_LAYERS.dimensions.name;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return [];
    const ux = dx / length;
    const uy = dy / length;
    // The normal, pointing to the side the dimension line sits on.
    const nx = -uy * Math.sign(offset || 1);
    const ny = ux * Math.sign(offset || 1);
    const gap = Math.abs(offset);
    const line = (p: Point2, q: Point2): DrawingEntity => ({ kind: "line", layer, a: p, b: q });
    const shift = (p: Point2, along: number, across: number): Point2 => [
        p[0] + ux * along + nx * across,
        p[1] + uy * along + ny * across,
    ];
    const a2 = shift(a, 0, gap);
    const b2 = shift(b, 0, gap);
    const angle = (Math.atan2(uy, ux) * 180) / Math.PI;
    const upright = normalizeDegrees(angle > 90 || angle <= -90 ? angle + 180 : angle);
    const middle = shift(a, length / 2, gap + DIMENSION_TEXT_HEIGHT * 0.9);
    return [
        line(shift(a, 0, 1), shift(a, 0, gap + 1.5)),
        line(shift(b, 0, 1), shift(b, 0, gap + 1.5)),
        line(a2, b2),
        line(a2, shift(a2, ARROW, ARROW / 3)),
        line(a2, shift(a2, ARROW, -ARROW / 3)),
        line(b2, shift(b2, -ARROW, ARROW / 3)),
        line(b2, shift(b2, -ARROW, -ARROW / 3)),
        {
            kind: "text",
            layer,
            position: middle,
            height: DIMENSION_TEXT_HEIGHT,
            rotation: upright,
            text: label,
        },
    ];
}

/** `drawing` plus `entities`, with their layer declared. */
export function withEntities(
    drawing: Drawing,
    entities: readonly DrawingEntity[],
    layer: DrawingLayer,
): Drawing {
    const layers = drawing.layers.some((candidate) => candidate.name === layer.name)
        ? drawing.layers
        : [...drawing.layers, layer];
    return { ...drawing, layers, entities: [...drawing.entities, ...entities] };
}

export interface SheetParts {
    /** The frame, the title block, a template's art. */
    readonly sheet: DrawingEntity[];
    /** The model's views. */
    readonly views: DrawingEntity[];
    /** Notes and dimensions. */
    readonly annotations: DrawingEntity[];
}

export function splitSheet(drawing: Drawing): SheetParts {
    const parts: SheetParts = { sheet: [], views: [], annotations: [] };
    for (const entity of drawing.entities) {
        if (SHEET_LAYER_NAMES.has(entity.layer)) parts.sheet.push(entity);
        else if (ANNOTATION_LAYER_NAMES.has(entity.layer)) parts.annotations.push(entity);
        else parts.views.push(entity);
    }
    return parts;
}

/** The layers of `drawing` that `entities` use. */
export function layersUsed(drawing: Drawing, entities: readonly DrawingEntity[]): DrawingLayer[] {
    const used = new Set(entities.map((entity) => entity.layer));
    return drawing.layers.filter((layer) => used.has(layer.name));
}

/** The `key=value` comments at the head of a DXF file — the sheet's properties. */
export function readSheetProperties(dxf: string): Record<string, string> {
    const properties: Record<string, string> = {};
    const lines = dxf.split(/\r?\n/);
    for (let i = 0; i + 1 < lines.length; i += 2) {
        const code = lines[i].trim();
        if (code === "0" && lines[i + 1].trim() === "SECTION") break;
        if (code !== "999") continue;
        const at = lines[i + 1].indexOf("=");
        if (at > 0) properties[lines[i + 1].slice(0, at)] = lines[i + 1].slice(at + 1);
    }
    return properties;
}

/** `1:4` → 0.25, `2:1` → 2; undefined for anything else. */
export function parseScale(text: string | undefined): number | undefined {
    const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(text ?? "");
    if (match === null) return undefined;
    const [, a, b] = match;
    const scale = Number(a) / Number(b);
    return Number.isFinite(scale) && scale > 0 ? scale : undefined;
}
