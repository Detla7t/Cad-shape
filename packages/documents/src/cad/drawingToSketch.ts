// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, Plane } from "@chili3d/core";
import { type Drawing, type SketchData, type SketchEntityData, SketchNode } from "@chili3d/parametric";

/**
 * A 2D drawing (millimetres) as sketch geometry on the XY plane: lines, arcs and circles
 * one to one. Endpoints closer than `SNAP_TOLERANCE` are merged so imported outlines close
 * into profiles (a DXF stores each entity on its own, with float noise at the joints);
 * texts and dimension, leader and fill geometry stay out of the sketch.
 */

/** Endpoints closer than this (mm) become one point. */
export const SNAP_TOLERANCE = 1e-4;
/** Arcs sweeping less than this (radians) are drawn as their chord: the kernel rejects them. */
const MIN_ARC_SWEEP = 2e-3;
/** Shorter lines and smaller radii are dropped (the kernel's distance precision is 1e-7 mm). */
const MIN_LENGTH = 1e-6;

/** DXF entity types whose geometry annotates rather than shapes the part. */
const ANNOTATION_SOURCES = new Set(["DIMENSION", "LEADER", "SOLID", "TRACE", "TEXT", "MTEXT", "ATTRIB"]);

export interface DrawingSketchOptions {
    /** Also convert dimension/leader/fill geometry (default false). */
    readonly annotations?: boolean;
}

export interface DrawingSketchResult {
    readonly data: SketchData;
    /** Drawing entities that did not become sketch entities (texts, annotations, degenerate). */
    readonly omitted: number;
}

class PointSnapper {
    private readonly cells = new Map<string, [number, number][]>();

    constructor(private readonly tolerance: number) {}

    snap(x: number, y: number): [number, number] {
        const cx = Math.floor(x / this.tolerance);
        const cy = Math.floor(y / this.tolerance);
        for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
                for (const point of this.cells.get(`${cx + i},${cy + j}`) ?? []) {
                    if (Math.hypot(point[0] - x, point[1] - y) <= this.tolerance) return point;
                }
            }
        }
        const point: [number, number] = [x, y];
        const key = `${cx},${cy}`;
        const list = this.cells.get(key);
        if (list === undefined) this.cells.set(key, [point]);
        else list.push(point);
        return point;
    }
}

export function drawingToSketchData(
    drawing: Drawing,
    sources: readonly string[] = [],
    options: DrawingSketchOptions = {},
): DrawingSketchResult {
    const snapper = new PointSnapper(SNAP_TOLERANCE);
    const entities: SketchEntityData[] = [];
    let omitted = 0;
    let id = 1;
    drawing.entities.forEach((entity, index) => {
        if (options.annotations !== true && ANNOTATION_SOURCES.has(sources[index] ?? "")) {
            omitted++;
            return;
        }
        if (entity.kind === "line") {
            const a = snapper.snap(entity.a[0], entity.a[1]);
            const b = snapper.snap(entity.b[0], entity.b[1]);
            if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_LENGTH) {
                omitted++;
                return;
            }
            entities.push({ id: id++, type: "line", params: [a[0], a[1], b[0], b[1]] });
        } else if (entity.kind === "circle") {
            if (!(entity.radius >= MIN_LENGTH)) {
                omitted++;
                return;
            }
            entities.push({
                id: id++,
                type: "circle",
                params: [entity.center[0], entity.center[1], entity.radius],
            });
        } else if (entity.kind === "arc") {
            const { center, radius } = entity;
            if (!(radius >= MIN_LENGTH)) {
                omitted++;
                return;
            }
            const a0 = (entity.startAngle * Math.PI) / 180;
            const a1 = (entity.endAngle * Math.PI) / 180;
            const s = snapper.snap(center[0] + radius * Math.cos(a0), center[1] + radius * Math.sin(a0));
            const e = snapper.snap(center[0] + radius * Math.cos(a1), center[1] + radius * Math.sin(a1));
            let sweep = (a1 - a0) % (2 * Math.PI);
            if (sweep < 0) sweep += 2 * Math.PI;
            if (sweep < MIN_ARC_SWEEP || sweep > 2 * Math.PI - MIN_ARC_SWEEP) {
                if (sweep > Math.PI) {
                    entities.push({ id: id++, type: "circle", params: [center[0], center[1], radius] });
                } else if (Math.hypot(e[0] - s[0], e[1] - s[1]) >= MIN_LENGTH) {
                    entities.push({ id: id++, type: "line", params: [s[0], s[1], e[0], e[1]] });
                } else {
                    omitted++;
                }
                return;
            }
            entities.push({ id: id++, type: "arc", params: [center[0], center[1], s[0], s[1], e[0], e[1]] });
        } else {
            omitted++;
        }
    });
    return { data: { entities, constraints: [], entityIdSeq: id }, omitted };
}

/** Adds a sketch on the XY plane holding `drawing`'s geometry to `document`. */
export function addDrawingSketch(
    document: IDocument,
    name: string,
    drawing: Drawing,
    sources: readonly string[] = [],
    options: DrawingSketchOptions = {},
): { sketch: SketchNode; omitted: number } {
    const { data, omitted } = drawingToSketchData(drawing, sources, options);
    const sketch = new SketchNode({ document, plane: Plane.XY, data });
    sketch.name = name;
    document.modelManager.addNode(sketch);
    return { sketch, omitted };
}
