// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A 2D drawing — what the DXF and SVG writers (`dxf.ts`, `svg.ts`) put on paper: lines,
 * arcs, circles and single-line text, each on a named layer, in millimetres unless `units`
 * says inches. Flat patterns and sketches (`@chili3d/parametric`) and fabrication
 * templates (`@chili3d/fabrication`) are converted to one; the writers never see the model
 * they came from.
 */

export type Point2 = readonly [number, number];

export interface DrawingLayer {
    readonly name: string;
    /** AutoCAD color index: 1 red, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta, 7 black/white. */
    readonly aci: number;
    /** CSS color for SVG. */
    readonly color: string;
    readonly dashed?: boolean;
}

/**
 * What every entity carries: its layer, and an optional colour of its own (a CSS hex colour,
 * DXF group 62) that overrides the layer's; without one it is drawn ByLayer.
 */
interface DrawingEntityBase {
    readonly layer: string;
    readonly color?: string;
}

export type DrawingEntity =
    | (DrawingEntityBase & { readonly kind: "line"; readonly a: Point2; readonly b: Point2 })
    | (DrawingEntityBase & {
          readonly kind: "arc";
          readonly center: Point2;
          readonly radius: number;
          /** Degrees in [0, 360); the arc runs counter-clockwise from start to end. */
          readonly startAngle: number;
          readonly endAngle: number;
      })
    | (DrawingEntityBase & { readonly kind: "circle"; readonly center: Point2; readonly radius: number })
    | (DrawingEntityBase & {
          readonly kind: "text";
          /** The middle of the text. */
          readonly position: Point2;
          readonly height: number;
          /** Degrees, counter-clockwise. */
          readonly rotation: number;
          readonly text: string;
      });

export type DrawingUnits = "mm" | "inch";

export interface Drawing {
    readonly layers: readonly DrawingLayer[];
    readonly entities: readonly DrawingEntity[];
    /** Unit of every coordinate and length; millimetres when absent. */
    readonly units?: DrawingUnits;
}

export const MM_PER_INCH = 25.4;

/** Millimetres per drawing unit. */
export function unitScale(units: DrawingUnits | undefined): number {
    return units === "inch" ? MM_PER_INCH : 1;
}

/** The drawing in other units: coordinates, radii and text heights scale, angles stay. */
export function convertDrawing(drawing: Drawing, units: DrawingUnits): Drawing {
    const factor = unitScale(drawing.units) / unitScale(units);
    if (factor === 1) return { ...drawing, units };
    const p = (point: Point2): Point2 => [point[0] * factor, point[1] * factor];
    const entities = drawing.entities.map((entity): DrawingEntity => {
        switch (entity.kind) {
            case "line":
                return { ...entity, a: p(entity.a), b: p(entity.b) };
            case "arc":
            case "circle":
                return { ...entity, center: p(entity.center), radius: entity.radius * factor };
            case "text":
                return { ...entity, position: p(entity.position), height: entity.height * factor };
            default:
                return entity;
        }
    });
    return { ...drawing, units, entities };
}

/** Angle normalized to [0, 360). */
export function normalizeDegrees(angle: number): number {
    const a = angle % 360;
    const normalized = a < 0 ? a + 360 : a;
    // Snap values that only differ from a whole turn by rounding.
    return Math.abs(normalized - 360) < 1e-12 ? 0 : normalized;
}

export const degreesOf = (radians: number) => (radians * 180) / Math.PI;

/** Counter-clockwise sweep of an arc entity, in degrees (0, 360]. */
export function arcSweep(startAngle: number, endAngle: number): number {
    const sweep = normalizeDegrees(endAngle - startAngle);
    return sweep === 0 ? 360 : sweep;
}

/**
 * The arc entity through three points (start, a point on the arc, end) — direction
 * independent: a clockwise arc becomes the counter-clockwise arc from its end to its
 * start. Undefined when the points are collinear.
 */
export function arcThroughPoints(
    layer: string,
    a: Point2,
    mid: Point2,
    b: Point2,
): Extract<DrawingEntity, { kind: "arc" }> | undefined {
    const ax = a[0];
    const ay = a[1];
    const bx = mid[0];
    const by = mid[1];
    const cx = b[0];
    const cy = b[1];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-12) return undefined;
    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    const c2 = cx * cx + cy * cy;
    const center: Point2 = [
        (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d,
        (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d,
    ];
    const radius = Math.hypot(ax - center[0], ay - center[1]);
    const angleOf = (p: Point2) =>
        normalizeDegrees(degreesOf(Math.atan2(p[1] - center[1], p[0] - center[0])));
    // d > 0: a → mid → b turns counter-clockwise.
    const ccw = d > 0;
    return {
        kind: "arc",
        layer,
        center,
        radius,
        startAngle: angleOf(ccw ? a : b),
        endAngle: angleOf(ccw ? b : a),
    };
}

export interface DrawingBounds {
    readonly min: Point2;
    readonly max: Point2;
}

/** Axis-aligned bounds of everything drawn (text approximately); undefined when empty. */
export function drawingBounds(drawing: Drawing): DrawingBounds | undefined {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const add = (x: number, y: number) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    };
    for (const entity of drawing.entities) {
        if (entity.kind === "line") {
            add(entity.a[0], entity.a[1]);
            add(entity.b[0], entity.b[1]);
        } else if (entity.kind === "circle") {
            add(entity.center[0] - entity.radius, entity.center[1] - entity.radius);
            add(entity.center[0] + entity.radius, entity.center[1] + entity.radius);
        } else if (entity.kind === "arc") {
            const point = (deg: number) => {
                const rad = (deg * Math.PI) / 180;
                add(
                    entity.center[0] + entity.radius * Math.cos(rad),
                    entity.center[1] + entity.radius * Math.sin(rad),
                );
            };
            const sweep = arcSweep(entity.startAngle, entity.endAngle);
            point(entity.startAngle);
            point(entity.startAngle + sweep);
            for (const axis of [0, 90, 180, 270]) {
                if (normalizeDegrees(axis - entity.startAngle) < sweep) point(axis);
            }
        } else {
            const half = (entity.text.length * entity.height * 0.6) / 2;
            add(entity.position[0] - half, entity.position[1] - half);
            add(entity.position[0] + half, entity.position[1] + half);
        }
    }
    if (!Number.isFinite(minX)) return undefined;
    return { min: [minX, minY], max: [maxX, maxY] };
}

/** A coordinate as written to a file: nanometre precision, no exponent, no trailing zeros. */
export function formatNumber(value: number): string {
    const text = (Math.round(value * 1e9) / 1e9).toFixed(9).replace(/\.?0+$/, "");
    return text === "-0" ? "0" : text;
}

// ------------------------------------------------------------------ Colours and export selection

/** The colour of an entity with neither its own colour nor a known layer. */
export const DEFAULT_DRAWING_COLOR = "#000000";

/**
 * A colour as a comparable key: lowercase `#rrggbb` (`#RGB` expands, surrounding space
 * goes); anything else (a CSS name) is only trimmed and lowercased.
 */
export function normalizeColor(color: string): string {
    const text = color.trim().toLowerCase();
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
    if (short !== null) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
    return text;
}

/** The AutoCAD colour index (1–8) nearest a hex colour; black and white are both 7. */
export function nearestAci(color: string): number {
    const match = /^#([0-9a-f]{6})$/.exec(normalizeColor(color));
    if (match === null) return 7;
    const rgb = Number.parseInt(match[1], 16);
    const channels = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
    const palette: readonly [number, number][] = [
        [1, 0xff0000],
        [2, 0xffff00],
        [3, 0x00ff00],
        [4, 0x00ffff],
        [5, 0x0000ff],
        [6, 0xff00ff],
        [7, 0xffffff],
        [7, 0x000000],
        [8, 0x808080],
    ];
    let best = 7;
    let distance = Number.POSITIVE_INFINITY;
    for (const [aci, value] of palette) {
        const d =
            (((value >> 16) & 255) - channels[0]) ** 2 +
            (((value >> 8) & 255) - channels[1]) ** 2 +
            ((value & 255) - channels[2]) ** 2;
        if (d < distance) {
            best = aci;
            distance = d;
        }
    }
    return best;
}

/**
 * The colour an entity is drawn in, normalized (`normalizeColor`): its own colour, else its
 * layer's (ByLayer), else `DEFAULT_DRAWING_COLOR`.
 */
export function effectiveColor(entity: DrawingEntity, drawing: Pick<Drawing, "layers">): string {
    const color =
        entity.color ??
        drawing.layers.find((layer) => layer.name === entity.layer)?.color ??
        DEFAULT_DRAWING_COLOR;
    return normalizeColor(color);
}

export interface DrawingColor {
    /** The normalized colour (`normalizeColor`), the key a `DrawingSelection` lists. */
    readonly color: string;
    /** How many entities are drawn in it. */
    readonly count: number;
}

/** The colours the drawing's entities are drawn in (`effectiveColor`), in first-seen order. */
export function drawingColors(drawing: Drawing): DrawingColor[] {
    const layerColors = new Map(drawing.layers.map((layer) => [layer.name, layer.color]));
    const counts = new Map<string, number>();
    for (const entity of drawing.entities) {
        const color = normalizeColor(entity.color ?? layerColors.get(entity.layer) ?? DEFAULT_DRAWING_COLOR);
        counts.set(color, (counts.get(color) ?? 0) + 1);
    }
    return [...counts].map(([color, count]) => ({ color, count }));
}

/**
 * What an export keeps. Each list, when present, keeps only entities that match one of its
 * values; the lists combine with AND. Absent lists keep everything.
 */
export interface DrawingSelection {
    /** Layer names. */
    readonly layers?: readonly string[];
    /** Effective colours (`effectiveColor`); any CSS hex spelling, compared normalized. */
    readonly colors?: readonly string[];
}

/**
 * The drawing with only the selected entities, in order: on a selected layer AND drawn in a
 * selected colour. Layer records stay for selected layers, except one whose entities the
 * colour filter removed entirely (an empty layer before the filter stays). The one filter
 * every export path applies — sketch export, the export dialog and the drawing viewer.
 */
export function filterDrawing(drawing: Drawing, selection: DrawingSelection): Drawing {
    const layers = selection.layers === undefined ? undefined : new Set(selection.layers);
    const colors = selection.colors === undefined ? undefined : new Set(selection.colors.map(normalizeColor));
    if (layers === undefined && colors === undefined) return drawing;
    const layerColors = new Map(drawing.layers.map((layer) => [layer.name, layer.color]));
    const used = new Set<string>();
    const removedByColor = new Set<string>();
    const entities = drawing.entities.filter((entity) => {
        if (layers !== undefined && !layers.has(entity.layer)) return false;
        if (colors !== undefined) {
            const color = normalizeColor(
                entity.color ?? layerColors.get(entity.layer) ?? DEFAULT_DRAWING_COLOR,
            );
            if (!colors.has(color)) {
                removedByColor.add(entity.layer);
                return false;
            }
        }
        used.add(entity.layer);
        return true;
    });
    return {
        ...drawing,
        layers: drawing.layers.filter(
            (layer) =>
                (layers === undefined || layers.has(layer.name)) &&
                (used.has(layer.name) || !removedByColor.has(layer.name)),
        ),
        entities,
    };
}

/**
 * The drawing with only the named layers: their entities, in order, and their layer records
 * (an unknown name is ignored). Export dialogs use it to leave construction or notes out.
 */
export function filterDrawingLayers(drawing: Drawing, names: readonly string[]): Drawing {
    return filterDrawing(drawing, { layers: names });
}
