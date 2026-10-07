// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamLoop } from "../model/operation";
import type { Vec3 } from "../model/toolpath";

/**
 * 2D geometry → `CamLoop`s, the polylines 2D operations cut along: a sketch's lines, arcs
 * and circles chained end to end, a flat pattern's outline, holes and bend lines. Arcs are
 * discretized so no chord strays more than `tolerance` from the arc; loops are mapped from
 * their plane (u, v) into the setup's WCS by the caller's `toWcs`, then oriented — outer
 * loops counter-clockwise, holes clockwise — by nesting depth in WCS XY.
 */

export type Point2 = readonly [number, number];

/** A planar segment in its own (u, v) plane: a line, or an arc with a signed sweep (radians, + = CCW). */
export type PlaneSegment =
    | { readonly kind: "line"; readonly a: Point2; readonly b: Point2 }
    | {
          readonly kind: "arc";
          readonly center: Point2;
          readonly radius: number;
          readonly start: number;
          readonly sweep: number;
      };

export interface PlaneChain {
    readonly segments: readonly PlaneSegment[];
    readonly closed: boolean;
}

export const DEFAULT_LOOP_TOLERANCE = 0.01;

function arcPoint(segment: Extract<PlaneSegment, { kind: "arc" }>, t: number): Point2 {
    const angle = segment.start + segment.sweep * t;
    return [
        segment.center[0] + segment.radius * Math.cos(angle),
        segment.center[1] + segment.radius * Math.sin(angle),
    ];
}

export function segmentStart(segment: PlaneSegment): Point2 {
    return segment.kind === "line" ? segment.a : arcPoint(segment, 0);
}

export function segmentEnd(segment: PlaneSegment): Point2 {
    return segment.kind === "line" ? segment.b : arcPoint(segment, 1);
}

export function reverseSegment(segment: PlaneSegment): PlaneSegment {
    if (segment.kind === "line") return { kind: "line", a: segment.b, b: segment.a };
    return { ...segment, start: segment.start + segment.sweep, sweep: -segment.sweep };
}

/** A full circle as a closed one-segment chain. */
export function circleSegment(center: Point2, radius: number): PlaneSegment {
    return { kind: "arc", center, radius, start: 0, sweep: Math.PI * 2 };
}

/** The circular arc through three points, or undefined when they are collinear. */
export function arcThrough(a: Point2, mid: Point2, b: Point2): PlaneSegment | undefined {
    const d = 2 * (a[0] * (mid[1] - b[1]) + mid[0] * (b[1] - a[1]) + b[0] * (a[1] - mid[1]));
    if (Math.abs(d) < 1e-12) return undefined;
    const a2 = a[0] * a[0] + a[1] * a[1];
    const m2 = mid[0] * mid[0] + mid[1] * mid[1];
    const b2 = b[0] * b[0] + b[1] * b[1];
    const center: Point2 = [
        (a2 * (mid[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - mid[1])) / d,
        (a2 * (b[0] - mid[0]) + m2 * (a[0] - b[0]) + b2 * (mid[0] - a[0])) / d,
    ];
    const radius = Math.hypot(a[0] - center[0], a[1] - center[1]);
    const angle = (p: Point2) => Math.atan2(p[1] - center[1], p[0] - center[0]);
    const ccw = (mid[0] - a[0]) * (b[1] - mid[1]) - (mid[1] - a[1]) * (b[0] - mid[0]) > 0;
    const start = angle(a);
    let sweep = angle(b) - start;
    if (ccw && sweep <= 0) sweep += Math.PI * 2;
    if (!ccw && sweep >= 0) sweep -= Math.PI * 2;
    return { kind: "arc", center, radius, start, sweep };
}

const close = (p: Point2, q: Point2, tolerance: number) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tolerance;

/**
 * Chains loose segments end to end (either direction), within `tolerance`: each chain
 * grows from both ends until no unused segment touches it; closed when its ends meet.
 */
export function chainSegments(segments: readonly PlaneSegment[], tolerance = 1e-4): PlaneChain[] {
    const used = new Array<boolean>(segments.length).fill(false);
    const chains: PlaneChain[] = [];
    const take = (point: Point2, atEnd: boolean): PlaneSegment | undefined => {
        for (let i = 0; i < segments.length; i++) {
            if (used[i]) continue;
            const segment = segments[i];
            const s = segmentStart(segment);
            const e = segmentEnd(segment);
            if (atEnd ? close(s, point, tolerance) : close(e, point, tolerance)) {
                used[i] = true;
                return segment;
            }
            if (atEnd ? close(e, point, tolerance) : close(s, point, tolerance)) {
                used[i] = true;
                return reverseSegment(segment);
            }
        }
        return undefined;
    };
    for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        const chain: PlaneSegment[] = [segments[i]];
        const isClosed = () => close(segmentEnd(chain[chain.length - 1]), segmentStart(chain[0]), tolerance);
        if (isClosed()) {
            chains.push({ segments: chain, closed: true });
            continue;
        }
        for (let next = take(segmentEnd(chain[chain.length - 1]), true); next !== undefined; ) {
            chain.push(next);
            if (isClosed()) break;
            next = take(segmentEnd(chain[chain.length - 1]), true);
        }
        if (!isClosed()) {
            for (let previous = take(segmentStart(chain[0]), false); previous !== undefined; ) {
                chain.unshift(previous);
                if (isClosed()) break;
                previous = take(segmentStart(chain[0]), false);
            }
        }
        chains.push({ segments: chain, closed: isClosed() });
    }
    return chains;
}

/** The chain as points in its plane: arcs within `tolerance`; a closed chain does not repeat its start. */
export function chainPoints(chain: PlaneChain, tolerance = DEFAULT_LOOP_TOLERANCE): Point2[] {
    const points: Point2[] = [];
    for (const segment of chain.segments) {
        points.push(segmentStart(segment));
        if (segment.kind !== "arc") continue;
        const step = segment.radius > tolerance ? 2 * Math.acos(1 - tolerance / segment.radius) : Math.PI / 2;
        const count = Math.min(4096, Math.max(2, Math.ceil(Math.abs(segment.sweep) / step)));
        for (let i = 1; i < count; i++) points.push(arcPoint(segment, i / count));
    }
    if (!chain.closed && chain.segments.length > 0)
        points.push(segmentEnd(chain.segments[chain.segments.length - 1]));
    return points;
}

/** Signed area of a closed polygon in XY: positive when counter-clockwise. */
export function signedArea(points: readonly (readonly [number, number])[]): number {
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
    }
    return area / 2;
}

export function pointInPolygon(
    p: readonly [number, number],
    polygon: readonly (readonly [number, number])[],
): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** Loops mapped into WCS, before orientation. */
export interface MappedLoop {
    points: [number, number][];
    closed: boolean;
    z: number;
    role: CamLoop["role"];
}

/**
 * Maps plane chains into WCS loops. `toWcs` takes a plane (u, v) to WCS; the loop's `z` is
 * the mean WCS z of its points (exact when the plane is parallel to the WCS XY).
 */
export function mapChains(
    chains: readonly PlaneChain[],
    toWcs: (p: Point2) => Vec3,
    role: CamLoop["role"],
    tolerance = DEFAULT_LOOP_TOLERANCE,
): MappedLoop[] {
    return chains.map((chain) => {
        const points3 = chainPoints(chain, tolerance).map(toWcs);
        const z = points3.length === 0 ? 0 : points3.reduce((sum, p) => sum + p[2], 0) / points3.length;
        return { points: points3.map((p) => [p[0], p[1]]), closed: chain.closed, z, role };
    });
}

/**
 * Orients closed loops by nesting: even depth (outer) counter-clockwise, odd depth (a hole)
 * clockwise. A role of "outline" or "hole" forces the side when the source knows (a flat
 * pattern's outline comes first); otherwise depth decides and the loop keeps its role.
 */
export function orientLoops(loops: readonly MappedLoop[]): CamLoop[] {
    const closed = loops.filter((loop) => loop.closed && loop.points.length >= 3);
    return loops.map((loop) => {
        if (!loop.closed || loop.points.length < 3) {
            return { points: loop.points, closed: loop.closed, role: loop.role, z: loop.z };
        }
        let hole: boolean;
        if (loop.role === "outline") hole = false;
        else if (loop.role === "hole") hole = true;
        else {
            const probe = loop.points[0];
            const depth = closed.filter(
                (other) =>
                    other !== loop &&
                    Math.abs(signedArea(other.points)) > Math.abs(signedArea(loop.points)) &&
                    pointInPolygon(probe, other.points),
            ).length;
            hole = depth % 2 === 1;
        }
        const ccw = signedArea(loop.points) > 0;
        const points = ccw === !hole ? loop.points : [...loop.points].reverse();
        return { points, closed: true, role: loop.role, z: loop.z };
    });
}
