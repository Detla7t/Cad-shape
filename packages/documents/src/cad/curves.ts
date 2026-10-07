// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * 2D curve math for drawing import: polyline bulges as arcs, NURBS evaluation (de Boor,
 * rational), ellipse and arc sampling within a chord tolerance, and the 2D affine
 * transforms block references compose.
 */

export type Vec2 = readonly [number, number];

/** (x, y) ↦ (a·x + c·y + e, b·x + d·y + f). */
export type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function apply(m: Affine, p: Vec2): Vec2 {
    return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** `outer ∘ inner`: first `inner`, then `outer`. */
export function compose(outer: Affine, inner: Affine): Affine {
    return [
        outer[0] * inner[0] + outer[2] * inner[1],
        outer[1] * inner[0] + outer[3] * inner[1],
        outer[0] * inner[2] + outer[2] * inner[3],
        outer[1] * inner[2] + outer[3] * inner[3],
        outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
        outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
    ];
}

export function translation(x: number, y: number): Affine {
    return [1, 0, 0, 1, x, y];
}

export function rotation(radians: number): Affine {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return [c, s, -s, c, 0, 0];
}

export function scaling(sx: number, sy: number): Affine {
    return [sx, 0, 0, sy, 0, 0];
}

export const determinant = (m: Affine) => m[0] * m[3] - m[1] * m[2];

/**
 * The uniform scale of `m` when it is a similarity (rotation, uniform scale, optional
 * mirror) — circles stay circles — else undefined.
 */
export function similarityScale(m: Affine): number | undefined {
    const sx = Math.hypot(m[0], m[1]);
    const sy = Math.hypot(m[2], m[3]);
    const dot = m[0] * m[2] + m[1] * m[3];
    const tolerance = 1e-9 * Math.max(1, sx, sy);
    if (Math.abs(sx - sy) > tolerance || Math.abs(dot) > tolerance * Math.max(sx, sy)) return undefined;
    return sx;
}

/** Rotation angle (radians) of the image of the x axis. */
export const angleOf = (m: Affine) => Math.atan2(m[1], m[0]);

export interface BulgeArc {
    readonly center: Vec2;
    readonly radius: number;
    /** Radians, counter-clockwise from start to end. */
    readonly startAngle: number;
    readonly endAngle: number;
}

/**
 * The arc of a polyline segment from `a` to `b` with `bulge` = tan(θ/4) (positive:
 * counter-clockwise), as a counter-clockwise arc; undefined for a straight segment.
 */
export function bulgeArc(a: Vec2, b: Vec2, bulge: number): BulgeArc | undefined {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const chord = Math.hypot(dx, dy);
    if (Math.abs(bulge) < 1e-12 || chord < 1e-12) return undefined;
    // The center sits on the chord's left normal (right for clockwise arcs).
    const offset = (1 - bulge * bulge) / (4 * bulge);
    const center: Vec2 = [(a[0] + b[0]) / 2 - dy * offset, (a[1] + b[1]) / 2 + dx * offset];
    const radius = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
    const angleA = Math.atan2(a[1] - center[1], a[0] - center[0]);
    const angleB = Math.atan2(b[1] - center[1], b[0] - center[0]);
    return bulge > 0
        ? { center, radius, startAngle: angleA, endAngle: angleB }
        : { center, radius, startAngle: angleB, endAngle: angleA };
}

/** Counter-clockwise sweep from `start` to `end` in (0, 2π]. */
export function ccwSweep(start: number, end: number): number {
    const tau = 2 * Math.PI;
    let sweep = (end - start) % tau;
    if (sweep <= 1e-12) sweep += tau;
    return sweep;
}

/** Segments for a circular arc of `radius` sweeping `sweep` radians within chord error `tolerance`. */
export function arcSegments(radius: number, sweep: number, tolerance: number): number {
    if (radius <= tolerance) return Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
    const step = 2 * Math.acos(Math.max(-1, 1 - tolerance / radius));
    return Math.min(1024, Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-6))));
}

/** Points on an ellipse `center + cos t·major + sin t·minor` for t from t0 to t1 (t1 > t0). */
export function sampleEllipse(
    center: Vec2,
    major: Vec2,
    minor: Vec2,
    t0: number,
    t1: number,
    tolerance: number,
): Vec2[] {
    const radius = Math.max(Math.hypot(major[0], major[1]), Math.hypot(minor[0], minor[1]));
    const n = arcSegments(radius, t1 - t0, tolerance);
    const points: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
        const t = t0 + ((t1 - t0) * i) / n;
        const c = Math.cos(t);
        const s = Math.sin(t);
        points.push([center[0] + c * major[0] + s * minor[0], center[1] + c * major[1] + s * minor[1]]);
    }
    return points;
}

export interface NurbsCurve {
    readonly degree: number;
    readonly knots: readonly number[];
    readonly controlPoints: readonly Vec2[];
    /** One per control point; all 1 (or absent) for a non-rational spline. */
    readonly weights?: readonly number[];
}

/** De Boor evaluation of a (rational) B-spline at `u`. */
export function evaluateNurbs(curve: NurbsCurve, u: number): Vec2 {
    const { degree: p, knots, controlPoints } = curve;
    const n = controlPoints.length - 1;
    const weights = curve.weights;
    // Knot span k with knots[k] <= u < knots[k+1], clamped to the valid range [p, n].
    let k = p;
    while (k < n && u >= knots[k + 1]) k++;
    const d: [number, number, number][] = [];
    for (let j = 0; j <= p; j++) {
        const index = Math.min(Math.max(j + k - p, 0), n);
        const w = weights?.[index] ?? 1;
        const point = controlPoints[index];
        d.push([point[0] * w, point[1] * w, w]);
    }
    for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
            const i = j + k - p;
            const denominator = knots[i + p - r + 1] - knots[i];
            const alpha = denominator === 0 ? 0 : (u - knots[i]) / denominator;
            d[j] = [
                (1 - alpha) * d[j - 1][0] + alpha * d[j][0],
                (1 - alpha) * d[j - 1][1] + alpha * d[j][1],
                (1 - alpha) * d[j - 1][2] + alpha * d[j][2],
            ];
        }
    }
    const [x, y, w] = d[p];
    return w === 0 ? [x, y] : [x / w, y / w];
}

/** A clamped uniform knot vector for `count` control points of `degree`. */
export function clampedKnots(count: number, degree: number): number[] {
    const knots: number[] = [];
    const inner = count - degree;
    for (let i = 0; i <= degree; i++) knots.push(0);
    for (let i = 1; i < inner; i++) knots.push(i / inner);
    for (let i = 0; i <= degree; i++) knots.push(1);
    return knots;
}

const distanceToSegment = (p: Vec2, a: Vec2, b: Vec2) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    const t =
        length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/**
 * A polyline through a B-spline within chord error `tolerance`: each knot span is split
 * until its midpoint (and quarter points) lie within tolerance of the chord.
 */
export function sampleNurbs(curve: NurbsCurve, tolerance: number): Vec2[] {
    const { degree, knots, controlPoints } = curve;
    if (controlPoints.length === 0) return [];
    if (controlPoints.length <= degree || knots.length !== controlPoints.length + degree + 1) {
        return [...controlPoints];
    }
    const u0 = knots[degree];
    const u1 = knots[controlPoints.length];
    const points: Vec2[] = [evaluateNurbs(curve, u0)];
    const refine = (ua: number, pa: Vec2, ub: Vec2Param, depth: number) => {
        const um = (ua + ub.u) / 2;
        const pm = evaluateNurbs(curve, um);
        const q1 = evaluateNurbs(curve, (ua + um) / 2);
        const q3 = evaluateNurbs(curve, (um + ub.u) / 2);
        const flat =
            distanceToSegment(pm, pa, ub.p) <= tolerance &&
            distanceToSegment(q1, pa, ub.p) <= tolerance &&
            distanceToSegment(q3, pa, ub.p) <= tolerance;
        if (flat || depth >= 12) {
            points.push(ub.p);
            return;
        }
        refine(ua, pa, { u: um, p: pm }, depth + 1);
        refine(um, pm, ub, depth + 1);
    };
    const spans = [...new Set(knots.slice(degree, controlPoints.length + 1))].filter(
        (u) => u >= u0 && u <= u1,
    );
    for (let i = 0; i + 1 < spans.length; i++) {
        const start = points[points.length - 1];
        refine(spans[i], start, { u: spans[i + 1], p: evaluateNurbs(curve, spans[i + 1]) }, 0);
    }
    return points;
}

interface Vec2Param {
    readonly u: number;
    readonly p: Vec2;
}

/**
 * A curve through fit points (a spline stored without control points): centripetal
 * Catmull-Rom, sampled within `tolerance` — the shape AutoCAD draws differs slightly.
 */
export function sampleFitPoints(points: readonly Vec2[], closed: boolean, tolerance: number): Vec2[] {
    if (points.length < 3) return [...points];
    const at = (i: number): Vec2 => {
        if (closed) return points[((i % points.length) + points.length) % points.length];
        if (i < 0) return [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]];
        if (i >= points.length) {
            const last = points.length - 1;
            return [2 * points[last][0] - points[last - 1][0], 2 * points[last][1] - points[last - 1][1]];
        }
        return points[i];
    };
    const result: Vec2[] = [points[0]];
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
        const p0 = at(i - 1);
        const p1 = at(i);
        const p2 = at(i + 1);
        const p3 = at(i + 2);
        const length = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        const steps = Math.min(64, Math.max(2, Math.ceil(Math.sqrt(length / Math.max(tolerance, 1e-9)) / 2)));
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const t2 = t * t;
            const t3 = t2 * t;
            const w0 = -0.5 * t3 + t2 - 0.5 * t;
            const w1 = 1.5 * t3 - 2.5 * t2 + 1;
            const w2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
            const w3 = 0.5 * t3 - 0.5 * t2;
            result.push([
                w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
                w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
            ]);
        }
    }
    return result;
}
