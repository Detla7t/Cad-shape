// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type ISurface, Result, XYZ, type XYZLike } from "@chili3d/core";
import type { Vec3 } from "../model/toolpath";
import { add, distance, distanceToSegment, dot, normalize, scale, sub } from "./vec";

/**
 * Kernel faces and edges seen as sampled geometry: points and unit outward normals at UV
 * parameters, the face's own UV window, projections, and edges as oriented polylines.
 */

export function vec(point: XYZLike): Vec3 {
    return [point.x, point.y, point.z];
}

export function xyz(point: Vec3): XYZ {
    return new XYZ(point[0], point[1], point[2]);
}

export interface SurfacePoint {
    readonly point: Vec3;
    /** Unit outward normal (the face's orientation applied). */
    readonly normal: Vec3;
    readonly u: number;
    readonly v: number;
}

export interface UvBounds {
    readonly u1: number;
    readonly u2: number;
    readonly v1: number;
    readonly v2: number;
}

/** A face with its surface, evaluated in the face's own coordinates (WCS for operation faces). */
export class FaceSampler {
    readonly surface: ISurface;
    private bounds?: UvBounds;

    constructor(readonly face: IFace) {
        this.surface = face.surface();
    }

    dispose(): void {
        this.surface.dispose();
    }

    /** Point and normal at (u, v). */
    at(u: number, v: number): SurfacePoint {
        const [point, normal] = this.face.normal(u, v);
        return { point: vec(point), normal: normalize(vec(normal)), u, v };
    }

    /** The surface point nearest `point`, with its normal (undefined when the projection fails). */
    project(point: Vec3): SurfacePoint | undefined {
        const nearest = this.surface.nearestPoint(xyz(point));
        if (nearest === undefined) return undefined;
        const uv = this.surface.parameter(nearest[0], 1e-3);
        if (uv === undefined) return undefined;
        return this.at(uv.u, uv.v);
    }

    /**
     * The point of the surface on the line through `point` along `direction` (unit), near
     * `point`: Newton steps along the line against the tangent plane.
     */
    intersectLine(point: Vec3, direction: Vec3, iterations = 6): SurfacePoint | undefined {
        let on = this.project(point);
        let line = point;
        for (let i = 0; i < iterations && on !== undefined; i++) {
            const denominator = dot(direction, on.normal);
            if (Math.abs(denominator) < 1e-9) return on;
            const t = dot(sub(on.point, line), on.normal) / denominator;
            line = add(line, scale(direction, t));
            if (Math.abs(t) < 1e-9) break;
            on = this.project(line);
        }
        return on;
    }

    /** Whether a point lies on the face (inside its boundary). */
    contains(point: Vec3, tolerance = 1e-3): boolean {
        return this.face.containsPoint(xyz(point), true, tolerance);
    }

    /**
     * The face's UV window (`BRepTools::UVBounds`), recovered from its triangulation, whose
     * UVs the mesher normalizes to that window. Periodic directions are unwrapped.
     */
    uvBounds(): Result<UvBounds> {
        if (this.bounds) return Result.ok(this.bounds);
        const mesh = this.face.mesh.faces;
        if (mesh === undefined || mesh.position.length < 9)
            return Result.err("The face has no triangulation");
        const count = mesh.position.length / 3;
        const extremes = [0, 0, 0, 0];
        for (let i = 1; i < count; i++) {
            if (mesh.uv[2 * i] < mesh.uv[2 * extremes[0]]) extremes[0] = i;
            if (mesh.uv[2 * i] > mesh.uv[2 * extremes[1]]) extremes[1] = i;
            if (mesh.uv[2 * i + 1] < mesh.uv[2 * extremes[2] + 1]) extremes[2] = i;
            if (mesh.uv[2 * i + 1] > mesh.uv[2 * extremes[3] + 1]) extremes[3] = i;
        }
        const parameterOf = (index: number) =>
            this.surface.parameter(
                new XYZ(mesh.position[3 * index], mesh.position[3 * index + 1], mesh.position[3 * index + 2]),
                1e-2,
            );
        const hasUv = mesh.uv[2 * extremes[1]] - mesh.uv[2 * extremes[0]] > 0.5;
        let u1 = Number.POSITIVE_INFINITY;
        let u2 = Number.NEGATIVE_INFINITY;
        let v1 = Number.POSITIVE_INFINITY;
        let v2 = Number.NEGATIVE_INFINITY;
        if (hasUv) {
            const p = extremes.map(parameterOf);
            if (p.some((uv) => uv === undefined))
                return Result.err("The face's triangulation is off its surface");
            [u1, u2, v1, v2] = [p[0]!.u, p[1]!.u, p[2]!.v, p[3]!.v];
            if (this.surface.isUPeriodic() && u2 <= u1 + 1e-9) u2 += this.surface.uPeriod();
            if (this.surface.isVPeriodic() && v2 <= v1 + 1e-9) v2 += this.surface.vPeriod();
        } else {
            for (let i = 0; i < count; i++) {
                const uv = parameterOf(i);
                if (uv === undefined) continue;
                u1 = Math.min(u1, uv.u);
                u2 = Math.max(u2, uv.u);
                v1 = Math.min(v1, uv.v);
                v2 = Math.max(v2, uv.v);
            }
            if (!Number.isFinite(u1)) return Result.err("The face's triangulation is off its surface");
        }
        this.bounds = { u1, u2, v1, v2 };
        return Result.ok(this.bounds);
    }
}

/** Evaluates `f` at `count + 1` evenly spaced parameters from `t0` to `t1`. */
export function sampleRange<T>(t0: number, t1: number, count: number, f: (t: number) => T): T[] {
    const out: T[] = [];
    for (let i = 0; i <= count; i++) out.push(f(t0 + ((t1 - t0) * i) / count));
    return out;
}

/** Whether an edge runs against its curve's parameter (from its start vertex to its end vertex). */
export function edgeIsReversed(edge: IEdge): boolean {
    const first = vec(edge.pointAt(edge.firstParameter()));
    const last = vec(edge.pointAt(edge.lastParameter()));
    // A closed edge (a full circle) starts and ends at its vertex either way round: only the
    // orientation tells; an open edge's start vertex settles it.
    if (distance(first, last) < 1e-9) return edge.orientation() === "reversed";
    const start = vec(edge.startPoint());
    return distance(first, start) > distance(last, start);
}

/** Points along an edge from its start vertex to its end vertex (orientation applied), at most `step` apart. */
export function edgePolyline(edge: IEdge, step: number): Vec3[] {
    const count = Math.max(1, Math.ceil(edge.length() / Math.max(step, 1e-6)));
    const points = sampleRange(edge.firstParameter(), edge.lastParameter(), count, (t) =>
        vec(edge.pointAt(t)),
    );
    return edgeIsReversed(edge) ? points.reverse() : points;
}

/**
 * Adaptive sampling of a drive parameter: `count` even steps from `t0` to `t1`, each split
 * while the point halfway (in parameter) is more than `tolerance` off the chord. Parameters
 * that evaluate to nothing (off the face) end a run.
 */
export function sampleRuns<T extends { readonly point: Vec3 }>(
    t0: number,
    t1: number,
    count: number,
    evaluate: (t: number) => T | undefined,
    tolerance: number,
    maxDepth = 8,
): T[][] {
    const runs: T[][] = [];
    let run: T[] = [];
    let previous: { t: number; value: T } | undefined;
    const refine = (ta: number, a: T, tb: number, b: T, depth: number): void => {
        if (depth >= maxDepth) return;
        const tm = (ta + tb) / 2;
        const middle = evaluate(tm);
        if (middle === undefined || distanceToSegment(middle.point, a.point, b.point) <= tolerance) return;
        refine(ta, a, tm, middle, depth + 1);
        run.push(middle);
        refine(tm, middle, tb, b, depth + 1);
    };
    for (let i = 0; i <= count; i++) {
        const t = t0 + ((t1 - t0) * i) / count;
        const value = evaluate(t);
        if (value === undefined) {
            if (run.length > 0) runs.push(run);
            run = [];
            previous = undefined;
            continue;
        }
        if (previous) refine(previous.t, previous.value, t, value, 0);
        run.push(value);
        previous = { t, value };
    }
    if (run.length > 0) runs.push(run);
    return runs;
}

/** Length of a polyline. */
export function polylineLength(points: readonly Vec3[]): number {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
    return total;
}

/** `count + 1` points evenly spaced by arc length along a polyline. */
export function resamplePolyline(points: readonly Vec3[], count: number): Vec3[] {
    const total = polylineLength(points);
    if (points.length < 2 || total < 1e-12) return sampleRange(0, 1, count, () => points[0]);
    const out: Vec3[] = [points[0]];
    let segment = 1;
    let walked = 0;
    for (let i = 1; i < count; i++) {
        const target = (total * i) / count;
        while (
            segment < points.length - 1 &&
            walked + distance(points[segment - 1], points[segment]) < target
        ) {
            walked += distance(points[segment - 1], points[segment]);
            segment++;
        }
        const length = distance(points[segment - 1], points[segment]);
        const t = length < 1e-12 ? 0 : (target - walked) / length;
        const a = points[segment - 1];
        const b = points[segment];
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
    out.push(points[points.length - 1]);
    return out;
}
