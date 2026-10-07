// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { arcSegment, arcStepAngle, limitArcSweep, lineSegment, type Path2, type PathSegment } from "./path";
import { removeDuplicatePoints } from "./polygon";
import {
    add,
    cross,
    distance,
    dot,
    fromAngle,
    midpoint,
    normalize,
    type Point2,
    perpLeft,
    scale,
    sub,
} from "./vec";

/**
 * Arcs ⇄ polygons. Polygon booleans and offsets work on polylines, so arcs are flattened
 * within a chord tolerance going in (`arcPoints`, `circlePoints`) and re-fitted coming out
 * (`fitArcs`): runs of vertices on one circle become a single arc again, which keeps
 * programs small (one G2/G3 instead of hundreds of G1) and the surface finish smooth.
 */

/** Default chord tolerance for flattening arcs, mm. */
export const ARC_TOLERANCE = 0.002;
/** Default tolerance for re-fitting arcs to polylines, mm. */
export const FIT_TOLERANCE = 0.01;

/** Points along an arc (both ends included), `sweep` signed: positive counter-clockwise. */
export function arcPoints(
    center: Point2,
    radius: number,
    startAngle: number,
    sweep: number,
    tolerance = ARC_TOLERANCE,
): Point2[] {
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / arcStepAngle(radius, tolerance)));
    const out: Point2[] = [];
    for (let i = 0; i <= n; i++) out.push(add(center, fromAngle(startAngle + (sweep * i) / n, radius)));
    return out;
}

/** A full circle as a polygon (counter-clockwise unless `ccw` is false). */
export function circlePoints(
    center: Point2,
    radius: number,
    tolerance = ARC_TOLERANCE,
    ccw = true,
): Point2[] {
    const n = Math.max(8, Math.ceil((2 * Math.PI) / arcStepAngle(radius, tolerance)));
    const out: Point2[] = [];
    for (let i = 0; i < n; i++) out.push(add(center, fromAngle(((ccw ? 2 : -2) * Math.PI * i) / n, radius)));
    return out;
}

/** The circle through three points (undefined when they are collinear). */
export function circleThrough(
    a: Point2,
    b: Point2,
    c: Point2,
): { center: Point2; radius: number } | undefined {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-14) return undefined;
    const a2 = a[0] * a[0] + a[1] * a[1];
    const b2 = b[0] * b[0] + b[1] * b[1];
    const c2 = c[0] * c[0] + c[1] * c[1];
    const center: Point2 = [
        (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
        (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
    ];
    return { center, radius: distance(center, a) };
}

/** A fitted circle when the points form a full circle within `tolerance`. */
export function fitCircle(
    points: readonly Point2[],
    tolerance = FIT_TOLERANCE,
): { center: Point2; radius: number } | undefined {
    const n = points.length;
    if (n < 6) return undefined;
    const circle =
        leastSquaresCircle(points, 0, n - 1) ??
        circleThrough(points[0], points[Math.floor(n / 3)], points[Math.floor((2 * n) / 3)]);
    if (circle === undefined) return undefined;
    const ring = [...points, points[0]];
    const sign = crossSign(ring, 0);
    if (!arcRunFits(ring, 0, ring.length - 1, circle.center, circle.radius, tolerance, sign, true))
        return undefined;
    return circle;
}

function crossSign(points: readonly Point2[], i: number): number {
    return Math.sign(cross(sub(points[i + 1], points[i]), sub(points[i + 2], points[i + 1])));
}

function arcRunFits(
    points: readonly Point2[],
    i: number,
    j: number,
    center: Point2,
    radius: number,
    tolerance: number,
    sign: number,
    fullCircle = false,
): boolean {
    if (sign === 0) return false;
    let swept = 0;
    for (let k = i; k <= j; k++) {
        if (Math.abs(distance(points[k], center) - radius) > tolerance) return false;
        if (k === j) break;
        const a = points[k];
        const b = points[k + 1];
        // The chord must stay within the tolerance too (rejects polygons inscribed in a circle).
        const chord = distance(a, b);
        if (chord > 2 * radius) return false;
        const sagitta = radius - Math.sqrt(Math.max(0, radius * radius - (chord * chord) / 4));
        if (sagitta > tolerance) return false;
        if (k + 2 <= j && Math.sign(cross(sub(b, a), sub(points[k + 2], b))) !== sign) return false;
        const turn = Math.atan2(cross(sub(a, center), sub(b, center)), dot(sub(a, center), sub(b, center)));
        if (Math.sign(turn) !== sign && Math.abs(turn) > 1e-12) return false;
        swept += Math.abs(turn);
    }
    return fullCircle ? Math.abs(swept - 2 * Math.PI) < 1e-6 : swept < 2 * Math.PI - 1e-9;
}

/**
 * The center on the perpendicular bisector of `a`–`b` closest to `estimate`, so the arc's
 * start and end radii agree exactly (controllers check that).
 */
function balancedCenter(a: Point2, b: Point2, estimate: Point2): Point2 {
    const m = midpoint(a, b);
    const n = normalize(perpLeft(sub(b, a)));
    return add(m, scale(n, dot(sub(estimate, m), n)));
}

/** Least-squares (Kåsa) circle through points[i..j]. */
function leastSquaresCircle(
    points: readonly Point2[],
    i: number,
    j: number,
): { center: Point2; radius: number } | undefined {
    const n = j - i + 1;
    let mx = 0;
    let my = 0;
    for (let k = i; k <= j; k++) {
        mx += points[k][0];
        my += points[k][1];
    }
    mx /= n;
    my /= n;
    let suu = 0;
    let suv = 0;
    let svv = 0;
    let suuu = 0;
    let svvv = 0;
    let suvv = 0;
    let svuu = 0;
    for (let k = i; k <= j; k++) {
        const u = points[k][0] - mx;
        const v = points[k][1] - my;
        suu += u * u;
        suv += u * v;
        svv += v * v;
        suuu += u * u * u;
        svvv += v * v * v;
        suvv += u * v * v;
        svuu += v * u * u;
    }
    const det = suu * svv - suv * suv;
    if (Math.abs(det) < 1e-18 * Math.max(1, suu * svv)) return undefined;
    const bu = (suuu + suvv) / 2;
    const bv = (svvv + svuu) / 2;
    const uc = (bu * svv - bv * suv) / det;
    const vc = (suu * bv - suv * bu) / det;
    const radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
    return Number.isFinite(radius) ? { center: [uc + mx, vc + my], radius } : undefined;
}

export interface FitArcsOptions {
    /** Largest distance of a vertex (and of a chord's middle) from the fitted circle, mm. */
    readonly tolerance?: number;
    /** Fewest polyline segments an arc replaces. */
    readonly minSegments?: number;
    /** Circles larger than this are treated as straight runs. */
    readonly maxRadius?: number;
    readonly minRadius?: number;
    /** Largest sweep of one emitted arc (radians, default 180°). */
    readonly maxSweep?: number;
}

/**
 * Lines and arcs through a polyline: every run of at least `minSegments` segments whose
 * vertices and chords lie within `tolerance` of one circle (turning one way) becomes an arc
 * between the run's end vertices; the rest stay lines; collinear lines merge. The vertices
 * the path passes through are kept, so the result is continuous. An open polyline keeps its
 * start; a closed one starts at a segment boundary (a vertex where an arc or a line ends),
 * so no arc is split by the seam.
 */
export function fitArcs(points: readonly Point2[], closed: boolean, options: FitArcsOptions = {}): Path2 {
    const tolerance = options.tolerance ?? FIT_TOLERANCE;
    const maxSweep = options.maxSweep ?? Math.PI;
    const clean = removeDuplicatePoints(points, closed, 1e-7);
    if (clean.length < 2) return { segments: [], closed: false };
    if (!closed)
        return {
            segments: limitArcSweep(mergeLines(fitRun(clean, options), tolerance), maxSweep),
            closed: false,
        };
    if (clean.length < 3) return { segments: [lineSegment(clean[0], clean[1])], closed: false };

    const minRadius = options.minRadius ?? 0.02;
    const maxRadius = options.maxRadius ?? 5000;
    const circle = fitCircle(clean, tolerance);
    if (circle !== undefined && circle.radius <= maxRadius && circle.radius >= minRadius) {
        const ccw = crossSign([...clean, clean[0], clean[1]], 0) > 0;
        const start = clean[0];
        const center = circle.center;
        const opposite = sub(scale(center, 2), start);
        const half = [arcSegment(start, opposite, center, ccw), arcSegment(opposite, start, center, ccw)];
        return { segments: limitArcSweep(half, maxSweep), closed: true };
    }
    // Fit once, restart the loop where the first fitted segment ends (a true boundary), refit.
    const first = fitRun([...clean, clean[0]], options);
    const seam = first.length > 1 ? clean.indexOf(first[0].to) : -1;
    const rotated = seam > 0 ? [...clean.slice(seam), ...clean.slice(0, seam)] : clean;
    const segments = mergeLines(seam > 0 ? fitRun([...rotated, rotated[0]], options) : first, tolerance);
    return { segments: limitArcSweep(segments, maxSweep), closed: true };
}

/** Greedy arc/line fit of an open run of points. */
function fitRun(pts: readonly Point2[], options: FitArcsOptions): PathSegment[] {
    const tolerance = options.tolerance ?? FIT_TOLERANCE;
    const minSegments = options.minSegments ?? 3;
    const maxRadius = options.maxRadius ?? 5000;
    const minRadius = options.minRadius ?? 0.02;
    const segments: PathSegment[] = [];
    let i = 0;
    const fits = (j: number) => {
        if (j >= pts.length) return undefined;
        const sign = crossSign(pts, i);
        const circle =
            leastSquaresCircle(pts, i, j) ?? circleThrough(pts[i], pts[Math.floor((i + j) / 2)], pts[j]);
        if (circle === undefined || circle.radius > maxRadius || circle.radius < minRadius) return undefined;
        const center = balancedCenter(pts[i], pts[j], circle.center);
        const radius = distance(center, pts[i]);
        return arcRunFits(pts, i, j, center, radius, tolerance, sign) ? { center, ccw: sign > 0 } : undefined;
    };
    while (i < pts.length - 1) {
        let best: { j: number; center: Point2; ccw: boolean } | undefined;
        if (i + minSegments < pts.length) {
            // Grow geometrically, then bisect between the last fitting and first failing run.
            let good = i + minSegments;
            const fit = fits(good);
            if (fit !== undefined) {
                best = { j: good, ...fit };
                let step = minSegments;
                let bad = -1;
                while (bad < 0) {
                    const next = Math.min(pts.length - 1, good + step);
                    if (next === good) break;
                    const f = fits(next);
                    if (f === undefined) bad = next;
                    else {
                        good = next;
                        best = { j: good, ...f };
                        step *= 2;
                    }
                }
                while (bad > 0 && bad - good > 1) {
                    const mid = Math.floor((good + bad) / 2);
                    const f = fits(mid);
                    if (f === undefined) bad = mid;
                    else {
                        good = mid;
                        best = { j: good, ...f };
                    }
                }
            }
        }
        if (best !== undefined) {
            segments.push(arcSegment(pts[i], pts[best.j], best.center, best.ccw));
            i = best.j;
        } else {
            segments.push(lineSegment(pts[i], pts[i + 1]));
            i++;
        }
    }
    return segments;
}

/** Merges consecutive lines whose shared vertex lies within `tolerance` of the joined line. */
function mergeLines(segments: readonly PathSegment[], tolerance: number): PathSegment[] {
    const out: PathSegment[] = [];
    for (const segment of segments) {
        const last = out[out.length - 1];
        if (last?.kind === "line" && segment.kind === "line") {
            const d = sub(segment.to, last.from);
            const len = Math.hypot(d[0], d[1]);
            const off = len < 1e-12 ? 0 : Math.abs(cross(d, sub(last.to, last.from))) / len;
            const forward = dot(sub(last.to, last.from), sub(segment.to, segment.from)) > 0;
            if (off <= tolerance / 10 && forward) {
                out[out.length - 1] = lineSegment(last.from, segment.to);
                continue;
            }
        }
        out.push(segment);
    }
    return out;
}
