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

export type DrawingEntity =
    | { readonly kind: "line"; readonly layer: string; readonly a: Point2; readonly b: Point2 }
    | {
          readonly kind: "arc";
          readonly layer: string;
          readonly center: Point2;
          readonly radius: number;
          /** Degrees in [0, 360); the arc runs counter-clockwise from start to end. */
          readonly startAngle: number;
          readonly endAngle: number;
      }
    | { readonly kind: "circle"; readonly layer: string; readonly center: Point2; readonly radius: number }
    | {
          readonly kind: "text";
          readonly layer: string;
          /** The middle of the text. */
          readonly position: Point2;
          readonly height: number;
          /** Degrees, counter-clockwise. */
          readonly rotation: number;
          readonly text: string;
      };

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

/**
 * The drawing with only the named layers: their entities, in order, and their layer records
 * (an unknown name is ignored). Export dialogs use it to leave construction or notes out.
 */
export function filterDrawingLayers(drawing: Drawing, names: readonly string[]): Drawing {
    const wanted = new Set(names);
    return {
        ...drawing,
        layers: drawing.layers.filter((layer) => wanted.has(layer.name)),
        entities: drawing.entities.filter((entity) => wanted.has(entity.layer)),
    };
}
