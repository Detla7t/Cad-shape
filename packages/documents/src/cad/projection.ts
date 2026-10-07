// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ICircle, type IEdge, type IShape, ShapeTypes, type XYZLike } from "@chili3d/core";
import type { Drawing, DrawingEntity, DrawingLayer, Point2 } from "@chili3d/parametric";

/**
 * A multiview drawing of solids, millimetres: front, top and right views (plus an
 * isometric one) laid out in first- or third-angle projection.
 *
 * Each view projects the solids' own edges, so lines and circles facing the viewer stay
 * exact (other curves are sampled), and sorts them into VISIBLE and HIDDEN (dashed) with
 * the kernel's hidden-line removal (`IShape.hlr`, OCCT `HLRBRep_Algo`). The HLR result
 * itself cannot be drawn directly: its edges carry only 2D curves, which the kernel
 * binding does not expose, so its edge end points decide visibility. An edge visible only
 * in part counts as visible, and silhouettes of curved faces that are not model edges (the
 * sides of a cylinder seen from the side) are not drawn.
 *
 * Note: the kernel's `hlr` (cpp/src/shape.cpp) runs `HLRBRep_Algo::Update()` but not
 * `Hide()`, so today it reports every edge as visible and the HIDDEN layer stays empty;
 * adding `algo->Hide()` there (and rebuilding the wasm) turns the sorting on as is.
 */

export type ViewName = "front" | "top" | "right" | "left" | "back" | "bottom" | "iso";

interface ViewFrame {
    /** From the part toward the viewer. */
    readonly normal: XYZLike;
    /** The view's x axis; y = normal × x. */
    readonly xDir: XYZLike;
}

const s3 = 1 / Math.sqrt(3);
const s2 = 1 / Math.sqrt(2);

const VIEWS: Record<ViewName, ViewFrame> = {
    front: { normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } },
    back: { normal: { x: 0, y: 1, z: 0 }, xDir: { x: -1, y: 0, z: 0 } },
    top: { normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
    bottom: { normal: { x: 0, y: 0, z: -1 }, xDir: { x: 1, y: 0, z: 0 } },
    right: { normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } },
    left: { normal: { x: -1, y: 0, z: 0 }, xDir: { x: 0, y: -1, z: 0 } },
    iso: { normal: { x: s3, y: -s3, z: s3 }, xDir: { x: s2, y: s2, z: 0 } },
};

export type ProjectionAngle = "third" | "first";

export interface ProjectionOptions {
    /** Third-angle (ANSI: top above, right view right of the front) or first-angle (ISO). */
    readonly angle?: ProjectionAngle;
    /** Add an isometric view at the top right (default true). */
    readonly iso?: boolean;
    /** Draw hidden edges, dashed (default true). */
    readonly hidden?: boolean;
    /** Space between views, mm (default 20). */
    readonly gap?: number;
    /** Chord tolerance of sampled curves, mm (default 0.05). */
    readonly tolerance?: number;
}

export const PROJECTION_LAYERS = {
    visible: { name: "VISIBLE", aci: 7, color: "#000000" },
    hidden: { name: "HIDDEN", aci: 8, color: "#808080", dashed: true },
} as const satisfies Record<string, DrawingLayer>;

const dot = (a: XYZLike, b: XYZLike) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: XYZLike, b: XYZLike): XYZLike => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
});

const degrees = (radians: number) => {
    const value = ((radians * 180) / Math.PI) % 360;
    return value < 0 ? value + 360 : value;
};

const ccwSweep = (from: number, to: number) => (((to - from) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** A view's projection of one edge, before visibility. */
type Projected =
    | { readonly kind: "line"; readonly a: Point2; readonly b: Point2 }
    | {
          readonly kind: "arc";
          readonly center: Point2;
          readonly radius: number;
          /** Radians, counter-clockwise; `full` for a whole circle. */
          readonly start: number;
          readonly end: number;
          readonly full: boolean;
      }
    | { readonly kind: "polyline"; readonly points: readonly Point2[] };

function projectEdge(edge: IEdge, frame: ViewFrame, tolerance: number): Projected | undefined {
    const yDir = cross(frame.normal, frame.xDir);
    const to2d = (p: XYZLike): Point2 => [dot(p, frame.xDir), dot(p, yDir)];
    let curveType: string;
    let circle: ICircle | undefined;
    try {
        const basis = edge.curve.basisCurve;
        curveType = basis.curveType;
        if (curveType === "circle") circle = basis as ICircle;
    } catch {
        return undefined; // degenerate edge (a cone apex, a sphere pole)
    }
    const [start, end] = edge.ends().map(to2d);
    if (curveType === "line") {
        return Math.hypot(end[0] - start[0], end[1] - start[1]) < 1e-9
            ? undefined
            : { kind: "line", a: start, b: end };
    }
    const first = edge.firstParameter();
    const last = edge.lastParameter();
    if (circle !== undefined && Math.abs(Math.abs(dot(circle.axis, frame.normal)) - 1) < 1e-9) {
        const center = to2d(circle.center);
        const full = Math.hypot(end[0] - start[0], end[1] - start[1]) < 1e-9;
        const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
        const a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
        const mid = to2d(edge.pointAt((first + last) / 2));
        const am = Math.atan2(mid[1] - center[1], mid[0] - center[0]);
        // Counter-clockwise from start to end when the midpoint lies on that side.
        const forward = ccwSweep(a0, am) <= ccwSweep(a0, a1);
        return {
            kind: "arc",
            center,
            radius: circle.radius,
            start: forward ? a0 : a1,
            end: forward ? a1 : a0,
            full,
        };
    }
    const length = edge.length();
    const count = Math.min(512, Math.max(4, Math.ceil(Math.sqrt(length / Math.max(tolerance, 1e-6)) * 2)));
    const points: Point2[] = [];
    for (let i = 0; i <= count; i++) points.push(to2d(edge.pointAt(first + ((last - first) * i) / count)));
    return { kind: "polyline", points };
}

const distanceToSegment = (p: Point2, a: Point2, b: Point2) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    const t =
        length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/** Whether the HLR's visible edges (as end-point pairs) show `projected`. */
function isVisible(projected: Projected, visible: readonly [Point2, Point2][], tolerance: number): boolean {
    if (projected.kind === "line") {
        const { a, b } = projected;
        return visible.some(
            ([p, q]) =>
                distanceToSegment(p, a, b) <= tolerance &&
                distanceToSegment(q, a, b) <= tolerance &&
                Math.hypot(q[0] - p[0], q[1] - p[1]) > tolerance,
        );
    }
    if (projected.kind === "arc") {
        const { center, radius } = projected;
        const onArc = (p: Point2) => {
            if (Math.abs(Math.hypot(p[0] - center[0], p[1] - center[1]) - radius) > tolerance) return false;
            if (projected.full) return true;
            const angle = Math.atan2(p[1] - center[1], p[0] - center[0]);
            return ccwSweep(projected.start, angle) <= ccwSweep(projected.start, projected.end) + 1e-6;
        };
        return visible.some(([p, q]) => onArc(p) && onArc(q));
    }
    const near = (p: Point2) =>
        projected.points.some(
            (point, i) => i > 0 && distanceToSegment(p, projected.points[i - 1], point) <= tolerance,
        );
    return visible.some(([p, q]) => near(p) && near(q));
}

function toEntities(projected: Projected, layer: string): DrawingEntity[] {
    if (projected.kind === "line") return [{ kind: "line", layer, a: projected.a, b: projected.b }];
    if (projected.kind === "arc") {
        const { center, radius } = projected;
        return projected.full
            ? [{ kind: "circle", layer, center, radius }]
            : [
                  {
                      kind: "arc",
                      layer,
                      center,
                      radius,
                      startAngle: degrees(projected.start),
                      endAngle: degrees(projected.end),
                  },
              ];
    }
    const out: DrawingEntity[] = [];
    for (let i = 1; i < projected.points.length; i++) {
        const a = projected.points[i - 1];
        const b = projected.points[i];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) out.push({ kind: "line", layer, a, b });
    }
    return out;
}

/** Equal for the same drawn geometry (the coincident edges of a front and a back face). */
function geometryKey(entity: DrawingEntity): string {
    const r = (v: number) => (Math.round(v * 1e4) / 1e4 + 0).toFixed(4);
    const p = (point: Point2) => `${r(point[0])},${r(point[1])}`;
    switch (entity.kind) {
        case "line":
            return `l:${[p(entity.a), p(entity.b)].sort().join(";")}`;
        case "circle":
            return `c:${p(entity.center)}:${r(entity.radius)}`;
        case "arc":
            return `a:${p(entity.center)}:${r(entity.radius)}:${r(entity.startAngle)}:${r(entity.endAngle)}`;
        case "text":
            return `t:${p(entity.position)}:${entity.text}`;
    }
}

/** The edges of `shapes` seen along `view`, in the view's 2D coordinates, as visible and hidden lines. */
export function projectView(
    shapes: readonly IShape[],
    view: ViewName,
    options: { tolerance?: number; hidden?: boolean } = {},
): DrawingEntity[] {
    const frame = VIEWS[view];
    const tolerance = options.tolerance ?? 0.05;
    const visibleEntities: DrawingEntity[] = [];
    const hiddenEntities: DrawingEntity[] = [];
    for (const shape of shapes) {
        const hlr = shape.hlr({ x: 0, y: 0, z: 0 }, frame.normal, frame.xDir);
        const visible: [Point2, Point2][] = [];
        try {
            for (const edge of hlr.findSubShapes(ShapeTypes.edge) as IEdge[]) {
                const [a, b] = edge.ends();
                visible.push([
                    [a.x, a.y],
                    [b.x, b.y],
                ]);
                edge.dispose();
            }
        } finally {
            hlr.dispose();
        }
        for (const edge of shape.findSubShapes(ShapeTypes.edge) as IEdge[]) {
            try {
                const projected = projectEdge(edge, frame, tolerance);
                if (projected === undefined) continue;
                if (isVisible(projected, visible, Math.max(tolerance, 1e-4))) {
                    visibleEntities.push(...toEntities(projected, PROJECTION_LAYERS.visible.name));
                } else if (options.hidden !== false) {
                    hiddenEntities.push(...toEntities(projected, PROJECTION_LAYERS.hidden.name));
                }
            } finally {
                edge.dispose();
            }
        }
    }
    return withoutOverlaps(visibleEntities, hiddenEntities, tolerance);
}

type Line = Extract<DrawingEntity, { kind: "line" }>;

/**
 * Edges that project onto each other are drawn once, a visible one before a hidden one; a
 * line lying on a longer line of the same or higher visibility (a circle seen edge-on along
 * a face's edge) is dropped.
 */
function withoutOverlaps(
    visible: readonly DrawingEntity[],
    hidden: readonly DrawingEntity[],
    tolerance: number,
): DrawingEntity[] {
    const isLine = (entity: DrawingEntity): entity is Line => entity.kind === "line";
    const length = (line: Line) => Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]);
    const visibleLines = visible.filter(isLine);
    const allLines = [...visibleLines, ...hidden.filter(isLine)];
    const liesOn = (line: Line, other: Line) =>
        other !== line &&
        length(other) > length(line) + tolerance &&
        distanceToSegment(line.a, other.a, other.b) <= tolerance &&
        distanceToSegment(line.b, other.a, other.b) <= tolerance;
    const seen = new Set<string>();
    const result: DrawingEntity[] = [];
    for (const [entity, candidates] of [
        ...visible.map((entity) => [entity, visibleLines] as const),
        ...hidden.map((entity) => [entity, allLines] as const),
    ]) {
        const key = geometryKey(entity);
        if (seen.has(key)) continue;
        if (isLine(entity) && candidates.some((other) => liesOn(entity, other))) continue;
        seen.add(key);
        result.push(entity);
    }
    return result;
}

interface Box {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

function boundsOf(entities: readonly DrawingEntity[]): Box {
    const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const add = (x: number, y: number) => {
        box.minX = Math.min(box.minX, x);
        box.minY = Math.min(box.minY, y);
        box.maxX = Math.max(box.maxX, x);
        box.maxY = Math.max(box.maxY, y);
    };
    for (const entity of entities) {
        if (entity.kind === "line") {
            add(...entity.a);
            add(...entity.b);
        } else if (entity.kind === "circle" || entity.kind === "arc") {
            add(entity.center[0] - entity.radius, entity.center[1] - entity.radius);
            add(entity.center[0] + entity.radius, entity.center[1] + entity.radius);
        } else {
            add(...entity.position);
        }
    }
    if (!Number.isFinite(box.minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return box;
}

function moved(entities: readonly DrawingEntity[], dx: number, dy: number): DrawingEntity[] {
    const at = (p: Point2): Point2 => [p[0] + dx, p[1] + dy];
    return entities.map((entity): DrawingEntity => {
        if (entity.kind === "line") return { ...entity, a: at(entity.a), b: at(entity.b) };
        if (entity.kind === "text") return { ...entity, position: at(entity.position) };
        return { ...entity, center: at(entity.center) };
    });
}

/**
 * Front, top and right views (plus an isometric one) of `shapes`, laid out in first- or
 * third-angle projection with aligned views, as one drawing in millimetres.
 */
export function projectionDrawing(shapes: readonly IShape[], options: ProjectionOptions = {}): Drawing {
    const gap = options.gap ?? 20;
    const viewOptions = { tolerance: options.tolerance ?? 0.05, hidden: options.hidden };
    const front = projectView(shapes, "front", viewOptions);
    const top = projectView(shapes, "top", viewOptions);
    const right = projectView(shapes, "right", viewOptions);
    const f = boundsOf(front);
    const t = boundsOf(top);
    const r = boundsOf(right);
    const third = (options.angle ?? "third") === "third";
    const entities: DrawingEntity[] = [...front];
    // The top view shares the front's x range; the right view shares its height.
    entities.push(...moved(top, 0, third ? f.maxY + gap - t.minY : f.minY - gap - t.maxY));
    entities.push(...moved(right, third ? f.maxX + gap - r.minX : f.minX - gap - r.maxX, 0));
    if (options.iso !== false) {
        const iso = projectView(shapes, "iso", { ...viewOptions, hidden: false });
        const i = boundsOf(iso);
        const placed = boundsOf(entities);
        entities.push(...moved(iso, placed.maxX + gap - i.minX, placed.maxY - i.maxY));
    }
    const used = new Set(entities.map((entity) => entity.layer));
    return { layers: Object.values(PROJECTION_LAYERS).filter((layer) => used.has(layer.name)), entities };
}
