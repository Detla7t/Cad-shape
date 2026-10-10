// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type Drawing,
    type DrawingEntity,
    type DrawingLayer,
    drawingBounds,
    type Point2,
} from "@chili3d/drawing";

/**
 * A drawing sheet the way Onshape's "Create Drawing" starts one: a bordered sheet with a
 * title block in the lower right (title, drawn by/date, scale, sheet, size, drawing number,
 * revision, the "unless otherwise specified" note), and the model's views placed in the
 * drawing area at a standard scale. Everything is millimetres on the sheet.
 */

export interface SheetSize {
    readonly name: string;
    readonly width: number;
    readonly height: number;
}

/** ISO A4 landscape (millimetre documents) and ANSI A landscape (inch documents). */
export const SHEET_SIZES = {
    A4: { name: "A4", width: 297, height: 210 },
    ansiA: { name: "A", width: 279.4, height: 215.9 },
} as const satisfies Record<string, SheetSize>;

export const SHEET_LAYERS = {
    frame: { name: "FRAME", aci: 7, color: "#000000" },
    title: { name: "TITLE", aci: 7, color: "#000000" },
    text: { name: "TEXT", aci: 7, color: "#000000" },
} as const satisfies Record<string, DrawingLayer>;

/** The standard drawing scales, reductions and enlargements, as "1:2" and "2:1". */
const SCALES = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100];

export function scaleLabel(scale: number): string {
    return scale >= 1 ? `${Math.round(scale)}:1` : `1:${Math.round(1 / scale)}`;
}

/** The largest standard scale at which `width × height` fits in `areaWidth × areaHeight`. */
export function fittingScale(width: number, height: number, areaWidth: number, areaHeight: number): number {
    for (const scale of SCALES) if (width * scale <= areaWidth && height * scale <= areaHeight) return scale;
    return SCALES[SCALES.length - 1];
}

const MARGIN = 10;
const BLOCK_WIDTH = 150;
const BLOCK_HEIGHT = 40;
const TEXT = 2.5;
const SMALL = 1.8;

export interface SheetOptions {
    readonly size?: SheetSize;
    readonly title?: string;
    readonly drawnBy?: string;
    readonly date?: string;
    readonly number?: string;
    readonly revision?: string;
    readonly units?: "mm" | "inch";
}

function scaled(entity: DrawingEntity, scale: number, dx: number, dy: number): DrawingEntity {
    const at = (p: Point2): Point2 => [p[0] * scale + dx, p[1] * scale + dy];
    switch (entity.kind) {
        case "line":
            return { ...entity, a: at(entity.a), b: at(entity.b) };
        case "arc":
            return { ...entity, center: at(entity.center), radius: entity.radius * scale };
        case "circle":
            return { ...entity, center: at(entity.center), radius: entity.radius * scale };
        case "text":
            return { ...entity, position: at(entity.position), height: entity.height * scale };
    }
}

const line = (layer: string, a: Point2, b: Point2): DrawingEntity => ({ kind: "line", layer, a, b });
const text = (layer: string, position: Point2, height: number, value: string): DrawingEntity => ({
    kind: "text",
    layer,
    position,
    height,
    rotation: 0,
    text: value,
});

/**
 * The sheet with `views` (a model-space drawing, millimetres) placed at the largest standard
 * scale that fits the drawing area, centred; without views, an empty sheet. The frame is the
 * sheet's border inset by the margin; the title block sits in its lower right corner.
 */
export function sheetDrawing(views: Drawing | undefined, options: SheetOptions = {}): Drawing {
    return sheetLayout(views, options).drawing;
}

/** A sheet size by its name (`A4`, `A`); undefined for an unknown one. */
export function sheetSizeNamed(name: string | undefined): SheetSize | undefined {
    return Object.values(SHEET_SIZES).find((size) => size.name === name);
}

/** The sheet, and the scale its views were placed at (1 for an empty sheet). */
export function sheetLayout(
    views: Drawing | undefined,
    options: SheetOptions = {},
): { drawing: Drawing; scale: number } {
    const size = options.size ?? SHEET_SIZES.A4;
    const left = MARGIN;
    const bottom = MARGIN;
    const right = size.width - MARGIN;
    const top = size.height - MARGIN;
    const entities: DrawingEntity[] = [
        line(SHEET_LAYERS.frame.name, [left, bottom], [right, bottom]),
        line(SHEET_LAYERS.frame.name, [right, bottom], [right, top]),
        line(SHEET_LAYERS.frame.name, [right, top], [left, top]),
        line(SHEET_LAYERS.frame.name, [left, top], [left, bottom]),
    ];
    // Title block: a 150 × 40 grid in the lower right, like the ISO 7200 strip Onshape draws.
    const blockLeft = right - BLOCK_WIDTH;
    const blockTop = bottom + BLOCK_HEIGHT;
    const rowHeight = BLOCK_HEIGHT / 4;
    const column = (fraction: number) => blockLeft + BLOCK_WIDTH * fraction;
    const titleLayer = SHEET_LAYERS.title.name;
    entities.push(
        line(titleLayer, [blockLeft, bottom], [blockLeft, blockTop]),
        line(titleLayer, [blockLeft, blockTop], [right, blockTop]),
        line(titleLayer, [blockLeft, blockTop - rowHeight], [right, blockTop - rowHeight]),
        line(titleLayer, [blockLeft, blockTop - 2 * rowHeight], [right, blockTop - 2 * rowHeight]),
        line(titleLayer, [column(0.5), bottom], [column(0.5), blockTop - rowHeight]),
        line(titleLayer, [column(0.5), blockTop - 2 * rowHeight], [column(0.5), blockTop]),
        line(titleLayer, [column(0.75), bottom], [column(0.75), blockTop - rowHeight]),
    );
    // Text positions are mid-points: each label is centred in its cell.
    const label = (x: number, y: number, value: string) => text(SHEET_LAYERS.text.name, [x, y], SMALL, value);
    const value = (x: number, y: number, content: string) =>
        text(SHEET_LAYERS.text.name, [x, y], TEXT, content);
    const scale = views === undefined ? 1 : placeViews(views, left, blockTop + 5, right, top, entities);
    const today = options.date ?? new Date().toISOString().slice(0, 10);
    const row = (index: number, fraction: number) => blockTop - rowHeight * (index + fraction);
    entities.push(
        label(column(0.25), row(0, 0.3), "TITLE"),
        value(column(0.25), row(0, 1.4), options.title ?? "Drawing"),
        label(column(0.75), row(0, 0.3), "DRAWN"),
        value(column(0.75), row(0, 1.4), `${options.drawnBy ?? ""} ${today}`.trim()),
        label(column(0.25), row(2, 0.3), "DWG NO."),
        value(column(0.25), row(2, 1.4), options.number ?? "----"),
        label(column(0.625), row(2, 0.3), "SCALE"),
        value(column(0.625), row(2, 1.4), scaleLabel(scale)),
        label(column(0.875), row(2, 0.3), "SHEET"),
        value(column(0.875), row(2, 1.4), "1 of 1"),
        label(column(0.625), row(3, 0.9), `SIZE ${size.name}`),
        label(column(0.875), row(3, 0.9), `REV ${options.revision ?? "-"}`),
        label(
            left + (blockLeft - left) / 2,
            bottom + 4,
            options.units === "inch"
                ? "UNLESS OTHERWISE SPECIFIED, DIMENSIONS ARE IN INCHES"
                : "UNLESS OTHERWISE SPECIFIED, DIMENSIONS ARE IN MILLIMETERS",
        ),
    );
    const used = new Set(entities.map((entity) => entity.layer));
    const layers: DrawingLayer[] = [
        ...(views?.layers ?? []),
        ...Object.values(SHEET_LAYERS).filter((layer) => used.has(layer.name)),
    ];
    return { drawing: { layers, entities }, scale };
}

/** Places the views scaled and centred in the area; returns the scale used. */
function placeViews(
    views: Drawing,
    left: number,
    bottom: number,
    right: number,
    top: number,
    entities: DrawingEntity[],
): number {
    const bounds = drawingBounds(views);
    if (bounds === undefined) return 1;
    const inset = 8;
    const areaWidth = right - left - 2 * inset;
    const areaHeight = top - bottom - 2 * inset;
    const width = bounds.max[0] - bounds.min[0];
    const height = bounds.max[1] - bounds.min[1];
    const scale = fittingScale(width, height, areaWidth, areaHeight);
    const dx = left + inset + (areaWidth - width * scale) / 2 - bounds.min[0] * scale;
    const dy = bottom + inset + (areaHeight - height * scale) / 2 - bounds.min[1] * scale;
    for (const entity of views.entities) entities.push(scaled(entity, scale, dx, dy));
    return scale;
}
