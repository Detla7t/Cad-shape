// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import type { CamMesh } from "../model/operation";
import { type ToolData, toolRadius } from "../model/tool";
import type { Vec3 } from "../model/toolpath";
import { addScaled, cross, dot, length, normalize, reject, rotateVector, scale, sub } from "./vec";

/**
 * Simple collision checks of the tool's non-cutting parts against the part mesh: the shank
 * (tool radius, from the end of the flutes to the holder) and the holder (its radius and
 * length) as capsule-like cylinders around the axis, tested at sampled toolpath points.
 */

export interface ToolAssembly {
    readonly radius: number;
    /** Length from the tip that is allowed to touch (the flutes). */
    readonly fluteLength: number;
    /** Tip to the holder face. */
    readonly stickout: number;
    readonly holderRadius: number;
    readonly holderLength: number;
}

export function toolAssembly(tool: ToolData): ToolAssembly {
    const radius = toolRadius(tool);
    const fluteLength = tool.fluteLength ?? 3 * tool.diameter;
    const stickout = Math.max(fluteLength, tool.stickout ?? fluteLength + tool.diameter);
    return {
        radius,
        fluteLength,
        stickout,
        holderRadius: (tool.holder?.diameter ?? 0) / 2,
        holderLength: tool.holder?.length ?? 0,
    };
}

export interface Collision {
    readonly part: "shank" | "holder";
    /** The part mesh point the tool comes too close to. */
    readonly point: Vec3;
    readonly distance: number;
}

/** Closest point of triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
    const ab = sub(b, a);
    const ac = sub(c, a);
    const ap = sub(p, a);
    const d1 = dot(ab, ap);
    const d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const bp = sub(p, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return addScaled(a, ab, d1 / (d1 - d3));
    const cp = sub(p, c);
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return addScaled(a, ac, d2 / (d2 - d6));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        return addScaled(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
    }
    const denominator = 1 / (va + vb + vc);
    return addScaled(addScaled(a, ab, vb * denominator), ac, vc * denominator);
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Closest points of segments p1q1 and p2q2 (Ericson 5.1.9): [on the first, on the second]. */
function closestSegmentSegment(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): [Vec3, Vec3] {
    const d1 = sub(q1, p1);
    const d2 = sub(q2, p2);
    const r = sub(p1, p2);
    const a = dot(d1, d1);
    const e = dot(d2, d2);
    const f = dot(d2, r);
    let s = 0;
    let t = 0;
    if (a <= 1e-12 && e <= 1e-12) return [p1, p2];
    if (a <= 1e-12) {
        t = clamp01(f / e);
    } else {
        const c = dot(d1, r);
        if (e <= 1e-12) {
            s = clamp01(-c / a);
        } else {
            const b = dot(d1, d2);
            const denominator = a * e - b * b;
            s = denominator > 1e-12 ? clamp01((b * f - c * e) / denominator) : 0;
            t = (b * s + f) / e;
            if (t < 0) {
                t = 0;
                s = clamp01(-c / a);
            } else if (t > 1) {
                t = 1;
                s = clamp01((b - c) / a);
            }
        }
    }
    return [addScaled(p1, d1, s), addScaled(p2, d2, t)];
}

/** Where segment pq crosses triangle abc, if it does (Möller–Trumbore). */
function segmentHitsTriangle(p: Vec3, q: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 | undefined {
    const direction = sub(q, p);
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const h = cross(direction, e2);
    const det = dot(e1, h);
    if (Math.abs(det) < 1e-14) return undefined;
    const s = sub(p, a);
    const u = dot(s, h) / det;
    if (u < 0 || u > 1) return undefined;
    const qv = cross(s, e1);
    const v = dot(direction, qv) / det;
    if (v < 0 || u + v > 1) return undefined;
    const t = dot(e2, qv) / det;
    return t >= 0 && t <= 1 ? addScaled(p, direction, t) : undefined;
}

/** Distance from segment pq to triangle abc, and the triangle's closest point. */
export function segmentTriangleDistance(
    p: Vec3,
    q: Vec3,
    a: Vec3,
    b: Vec3,
    c: Vec3,
): { distance: number; point: Vec3 } {
    const hit = segmentHitsTriangle(p, q, a, b, c);
    if (hit) return { distance: 0, point: hit };
    let best = { distance: Number.POSITIVE_INFINITY, point: a };
    const consider = (from: Vec3, to: Vec3) => {
        const d = length(sub(from, to));
        if (d < best.distance) best = { distance: d, point: to };
    };
    consider(p, closestOnTriangle(p, a, b, c));
    consider(q, closestOnTriangle(q, a, b, c));
    for (const [e0, e1] of [
        [a, b],
        [b, c],
        [c, a],
    ] as const) {
        const [onSegment, onEdge] = closestSegmentSegment(p, q, e0, e1);
        consider(onSegment, onEdge);
    }
    return best;
}

/** A uniform grid over a mesh's triangles for proximity queries. */
export class TriangleGrid {
    private readonly min: Vec3;
    private readonly cell: number;
    private readonly dims: [number, number, number];
    private readonly cells = new Map<number, number[]>();
    private readonly stamp: Uint32Array;
    private query = 0;

    constructor(private readonly mesh: CamMesh) {
        const p = mesh.positions;
        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                min[k] = Math.min(min[k], p[i + k]);
                max[k] = Math.max(max[k], p[i + k]);
            }
        }
        const triangles = mesh.indices.length / 3;
        if (triangles === 0) {
            this.min = [0, 0, 0];
            this.cell = 1;
            this.dims = [1, 1, 1];
            this.stamp = new Uint32Array(0);
            return;
        }
        const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
        this.cell = Math.max(diagonal / Math.max(8, Math.cbrt(triangles) * 2), 1e-3);
        this.min = min;
        this.dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((max[k] - min[k]) / this.cell) + 1)) as [
            number,
            number,
            number,
        ];
        this.stamp = new Uint32Array(triangles);
        for (let t = 0; t < triangles; t++) {
            const [a, b, c] = this.triangle(t);
            const lo = [0, 1, 2].map((k) => Math.min(a[k], b[k], c[k])) as unknown as Vec3;
            const hi = [0, 1, 2].map((k) => Math.max(a[k], b[k], c[k])) as unknown as Vec3;
            this.forCells(lo, hi, (key) => {
                let list = this.cells.get(key);
                if (list === undefined) {
                    list = [];
                    this.cells.set(key, list);
                }
                list.push(t);
            });
        }
    }

    private triangle(t: number): [Vec3, Vec3, Vec3] {
        const { positions: p, indices } = this.mesh;
        const vertex = (i: number): Vec3 => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
        return [vertex(indices[3 * t]), vertex(indices[3 * t + 1]), vertex(indices[3 * t + 2])];
    }

    private forCells(lo: Vec3, hi: Vec3, visit: (key: number) => void): void {
        const range = [0, 1, 2].map((k) => [
            Math.max(0, Math.floor((lo[k] - this.min[k]) / this.cell)),
            Math.min(this.dims[k] - 1, Math.floor((hi[k] - this.min[k]) / this.cell)),
        ]);
        for (let i = range[0][0]; i <= range[0][1]; i++) {
            for (let j = range[1][0]; j <= range[1][1]; j++) {
                for (let k = range[2][0]; k <= range[2][1]; k++) {
                    visit(i + this.dims[0] * (j + this.dims[1] * k));
                }
            }
        }
    }

    /** The first triangle point closer than `threshold` to segment pq, if any. */
    within(p: Vec3, q: Vec3, threshold: number): { distance: number; point: Vec3 } | undefined {
        if (this.stamp.length === 0) return undefined;
        this.query++;
        const lo: Vec3 = [
            Math.min(p[0], q[0]) - threshold,
            Math.min(p[1], q[1]) - threshold,
            Math.min(p[2], q[2]) - threshold,
        ];
        const hi: Vec3 = [
            Math.max(p[0], q[0]) + threshold,
            Math.max(p[1], q[1]) + threshold,
            Math.max(p[2], q[2]) + threshold,
        ];
        let found: { distance: number; point: Vec3 } | undefined;
        this.forCells(lo, hi, (key) => {
            if (found) return;
            for (const t of this.cells.get(key) ?? []) {
                if (this.stamp[t] === this.query) continue;
                this.stamp[t] = this.query;
                const [a, b, c] = this.triangle(t);
                const result = segmentTriangleDistance(p, q, a, b, c);
                if (result.distance < threshold) {
                    found = result;
                    return;
                }
            }
        });
        return found;
    }
}

/** Whether the shank or holder of a tool at `tip` along `axis` comes within `clearance` of the mesh. */
export function toolCollision(
    grid: TriangleGrid,
    tip: Vec3,
    axis: Vec3,
    assembly: ToolAssembly,
    clearance: number,
): Collision | undefined {
    const a = normalize(axis);
    const at = (distance: number) => addScaled(tip, a, distance);
    if (assembly.stickout > assembly.fluteLength + 1e-9) {
        const hit = grid.within(at(assembly.fluteLength), at(assembly.stickout), assembly.radius + clearance);
        if (hit) return { part: "shank", ...hit };
    }
    if (assembly.holderLength > 0 && assembly.holderRadius > 0) {
        const hit = grid.within(
            at(assembly.stickout),
            at(assembly.stickout + assembly.holderLength),
            assembly.holderRadius + clearance,
        );
        if (hit) return { part: "holder", ...hit };
    }
    return undefined;
}

export interface TiltAwayOptions {
    /** Largest tilt from the requested axis, degrees. */
    readonly maxTilt: number;
    /** Tilt increment, degrees. Default 1. */
    readonly step?: number;
    /** Preferred tilt direction (e.g. the feed direction for lead); tried after "away from the obstacle". */
    readonly lead?: Vec3;
    readonly clearance: number;
}

/**
 * Checks a tool position and, on a collision, tilts the axis away (from the obstacle, then
 * towards ± `lead` and sideways) in steps up to `maxTilt`, re-placing the tip for each axis
 * with `place`. Fails naming the point when no tilt clears it.
 */
export function avoidCollision(
    grid: TriangleGrid,
    assembly: ToolAssembly,
    axis: Vec3,
    place: (axis: Vec3) => Vec3,
    options: TiltAwayOptions,
): Result<{ axis: Vec3; tip: Vec3; tilted: number }> {
    const tip = place(axis);
    const collision = toolCollision(grid, tip, axis, assembly, options.clearance);
    if (collision === undefined) return Result.ok({ axis, tip, tilted: 0 });
    const a = normalize(axis);
    const directions: Vec3[] = [];
    const away = reject(sub(addScaled(tip, a, assembly.stickout), collision.point), a);
    if (length(away) > 1e-9) directions.push(normalize(away));
    if (options.lead && length(reject(options.lead, a)) > 1e-9) {
        const lead = normalize(reject(options.lead, a));
        const side = cross(a, lead);
        directions.push(lead, scale(lead, -1), side, scale(side, -1));
    }
    const step = options.step ?? 1;
    for (let angle = step; angle <= options.maxTilt + 1e-9; angle += step) {
        for (const direction of directions) {
            const tilted = rotateVector(a, cross(a, direction), angle);
            const placed = place(tilted);
            if (toolCollision(grid, placed, tilted, assembly, options.clearance) === undefined) {
                return Result.ok({ axis: tilted, tip: placed, tilted: angle });
            }
        }
    }
    const p = collision.point.map((value) => value.toFixed(3)).join(", ");
    const t = tip.map((value) => value.toFixed(3)).join(", ");
    return Result.err(
        `The tool ${collision.part} hits the part at (${p}) with the tip at (${t}); tilting up to ${options.maxTilt}° does not clear it`,
    );
}
