// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { fail } from "../lang/values";

/**
 * B-spline curve math for the spline built-ins (`evaluateSpline`, `approximateSpline`,
 * `evApproximateBSplineCurve` / `Surface`), unit-agnostic: control points are plain
 * coordinate arrays of any dimension. Knot vectors are full (`points + degree + 1`
 * knots); a periodic spline repeats its first `degree` control points at the end, as
 * Onshape's `BSplineCurve` does. Algorithms follow Piegl & Tiller, "The NURBS Book".
 */

export interface BSplineData {
    readonly degree: number;
    readonly knots: readonly number[];
    readonly points: readonly (readonly number[])[];
    /** Present for a rational spline. */
    readonly weights?: readonly number[];
    readonly periodic: boolean;
}

/** The knot span index containing `u` (clamped to the valid range). */
export function findSpan(spline: BSplineData, u: number): number {
    const { degree: p, knots } = spline;
    const n = spline.points.length - 1;
    if (u >= knots[n + 1]) return n;
    if (u <= knots[p]) return p;
    let low = p;
    let high = n + 1;
    let mid = Math.floor((low + high) / 2);
    while (u < knots[mid] || u >= knots[mid + 1]) {
        if (u < knots[mid]) high = mid;
        else low = mid;
        mid = Math.floor((low + high) / 2);
    }
    return mid;
}

/** Nonzero basis functions at `u` and their derivatives up to `count`: `ders[k][j]` is N^(k)_{span-p+j}. */
export function basisDerivatives(
    knots: readonly number[],
    degree: number,
    span: number,
    u: number,
    count: number,
): number[][] {
    const p = degree;
    const ndu = Array.from({ length: p + 1 }, () => new Array<number>(p + 1).fill(0));
    const left = new Array<number>(p + 1).fill(0);
    const right = new Array<number>(p + 1).fill(0);
    ndu[0][0] = 1;
    for (let j = 1; j <= p; j++) {
        left[j] = u - knots[span + 1 - j];
        right[j] = knots[span + j] - u;
        let saved = 0;
        for (let r = 0; r < j; r++) {
            ndu[j][r] = right[r + 1] + left[j - r];
            const temp = ndu[j][r] === 0 ? 0 : ndu[r][j - 1] / ndu[j][r];
            ndu[r][j] = saved + right[r + 1] * temp;
            saved = left[j - r] * temp;
        }
        ndu[j][j] = saved;
    }
    const ders = Array.from({ length: count + 1 }, () => new Array<number>(p + 1).fill(0));
    for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];
    const a = [new Array<number>(p + 1).fill(0), new Array<number>(p + 1).fill(0)];
    for (let r = 0; r <= p; r++) {
        let s1 = 0;
        let s2 = 1;
        a[0][0] = 1;
        for (let k = 1; k <= Math.min(count, p); k++) {
            let d = 0;
            const rk = r - k;
            const pk = p - k;
            if (r >= k) {
                a[s2][0] = ndu[pk + 1][rk] === 0 ? 0 : a[s1][0] / ndu[pk + 1][rk];
                d = a[s2][0] * ndu[rk][pk];
            }
            const j1 = rk >= -1 ? 1 : -rk;
            const j2 = r - 1 <= pk ? k - 1 : p - r;
            for (let j = j1; j <= j2; j++) {
                a[s2][j] = ndu[pk + 1][rk + j] === 0 ? 0 : (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j];
                d += a[s2][j] * ndu[rk + j][pk];
            }
            if (r <= pk) {
                a[s2][k] = ndu[pk + 1][r] === 0 ? 0 : -a[s1][k - 1] / ndu[pk + 1][r];
                d += a[s2][k] * ndu[r][pk];
            }
            ders[k][r] = d;
            [s1, s2] = [s2, s1];
        }
    }
    let factor = p;
    for (let k = 1; k <= count; k++) {
        for (let j = 0; j <= p; j++) ders[k][j] *= factor;
        factor *= p - k;
    }
    return ders;
}

/** The parameter range a spline is defined on. */
export function domainOf(spline: BSplineData): [number, number] {
    return [spline.knots[spline.degree], spline.knots[spline.points.length]];
}

/** A periodic spline's parameter wrapped into its domain. */
function wrapped(spline: BSplineData, u: number): number {
    if (!spline.periodic) return u;
    const [a, b] = domainOf(spline);
    const period = b - a;
    if (period <= 0) return u;
    const t = (((u - a) % period) + period) % period;
    return a + t;
}

/** The point and its first `count` derivatives at `u` (rational splines by the quotient rule). */
export function evaluateDerivatives(spline: BSplineData, u: number, count: number): number[][] {
    const { degree: p, points, weights } = spline;
    const x = wrapped(spline, u);
    const span = findSpan(spline, x);
    const ders = basisDerivatives(spline.knots, p, span, x, count);
    const dim = points[0].length;
    // Homogeneous derivatives: A^(k) = sum N^(k) w P, W^(k) = sum N^(k) w.
    const a: number[][] = [];
    const w: number[] = [];
    for (let k = 0; k <= count; k++) {
        const ak = new Array<number>(dim).fill(0);
        let wk = 0;
        for (let j = 0; j <= p; j++) {
            const i = span - p + j;
            const weight = weights?.[i] ?? 1;
            const b = ders[k][j] * weight;
            wk += b;
            for (let c = 0; c < dim; c++) ak[c] += b * points[i][c];
        }
        a.push(ak);
        w.push(wk);
    }
    if (weights === undefined) return a;
    const result: number[][] = [];
    for (let k = 0; k <= count; k++) {
        const v = [...a[k]];
        for (let i = 1; i <= k; i++) {
            const binom = binomial(k, i);
            for (let c = 0; c < dim; c++) v[c] -= binom * w[i] * result[k - i][c];
        }
        result.push(v.map((c) => c / w[0]));
    }
    return result;
}

function binomial(n: number, k: number): number {
    let result = 1;
    for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
    return result;
}

// ------------------------------------------------------------------ Fitting

export interface FitTarget {
    readonly positions: readonly (readonly number[])[];
    readonly startDerivative?: readonly number[];
    readonly start2ndDerivative?: readonly number[];
    readonly endDerivative?: readonly number[];
    readonly end2ndDerivative?: readonly number[];
}

export interface FitOptions {
    readonly degree: number;
    readonly tolerance: number;
    readonly periodic: boolean;
    /** Strictly increasing parameters of the target positions; chord length when absent. */
    readonly parameters?: readonly number[];
    readonly maxControlPoints: number;
    /** Indices of positions to interpolate exactly (non-periodic only). */
    readonly interpolateIndices?: readonly number[];
}

export interface FitResult {
    readonly curves: BSplineData[];
    /** True when the fit interpolates every target position. */
    readonly interpolated: boolean;
}

/**
 * A family of splines approximating `targets` within `tolerance` at the target positions,
 * sharing one knot vector (so corresponding positions sit at equal parameters). The
 * control point count grows until every target fits, or the limit is reached.
 */
export function approximateSplines(targets: readonly FitTarget[], options: FitOptions): FitResult {
    if (targets.length === 0) return { curves: [], interpolated: false };
    const count = targets[0].positions.length;
    if (count < 2) fail("approximateSpline needs at least two positions");
    if (targets.some((target) => target.positions.length !== count))
        fail("approximateSpline: every target needs the same number of positions");
    return options.periodic ? fitPeriodic(targets, options) : fitOpen(targets, options);
}

const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((c, i) => c - b[i]));

/** Chord-length parameters in [0, 1], averaged over the targets (closing chord included when `closed`). */
function chordParameters(targets: readonly FitTarget[], count: number, closed: boolean): number[] {
    const segments = closed ? count : count - 1;
    const lengths = new Array<number>(segments).fill(0);
    for (const target of targets) {
        const chords = Array.from({ length: segments }, (_, i) =>
            distance(target.positions[i], target.positions[(i + 1) % count]),
        );
        const total = chords.reduce((sum, chord) => sum + chord, 0);
        chords.forEach((chord, i) => {
            lengths[i] += total > 0 ? chord / total : 1 / segments;
        });
    }
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const parameters = [0];
    for (let i = 0; i < count - 1; i++)
        parameters.push(parameters[i] + (total > 0 ? lengths[i] / total : 1 / segments));
    if (!closed) parameters[count - 1] = 1;
    return parameters;
}

interface Constraint {
    readonly u: number;
    readonly order: number;
    readonly value: (target: number) => readonly number[];
}

function fitOpen(targets: readonly FitTarget[], options: FitOptions): FitResult {
    const count = targets[0].positions.length;
    const m = count - 1;
    const parameters =
        options.parameters !== undefined ? [...options.parameters] : chordParameters(targets, count, false);
    if (parameters.length !== count) fail("approximateSpline: parameters must match the positions");
    for (let i = 1; i < count; i++)
        if (!(parameters[i] > parameters[i - 1]))
            fail("approximateSpline: parameters must be strictly increasing");
    const [u0, um] = [parameters[0], parameters[m]];
    const t0 = targets[0];
    // Without explicit parameters only derivative directions count: scale them to the
    // chord-length speed, and drop a second derivative's part along the first.
    const lengths = targets.map((target) =>
        target.positions.slice(1).reduce((sum, point, i) => sum + distance(point, target.positions[i]), 0),
    );
    const derivative = (
        target: number,
        value: readonly number[] | undefined,
        second: readonly number[] | undefined,
    ) => {
        if (value === undefined) return { first: undefined, second: undefined };
        if (options.parameters !== undefined) return { first: value, second };
        const speed = (lengths[target] || 1) / (um - u0);
        const norm = Math.hypot(...value) || 1;
        const tangent = value.map((c) => c / norm);
        const first = tangent.map((c) => c * speed);
        if (second === undefined) return { first, second: undefined };
        const along = second.reduce((sum, c, i) => sum + c * tangent[i], 0);
        const scale = (speed / norm) ** 2;
        return { first, second: second.map((c, i) => (c - along * tangent[i]) * scale) };
    };
    const constraints: Constraint[] = [
        { u: u0, order: 0, value: (t) => targets[t].positions[0] },
        { u: um, order: 0, value: (t) => targets[t].positions[m] },
    ];
    const ends: [number, "start" | "end"][] = [
        [u0, "start"],
        [um, "end"],
    ];
    let startConstraints = 0;
    let endConstraints = 0;
    for (const [u, end] of ends) {
        const first = end === "start" ? t0.startDerivative : t0.endDerivative;
        const second = end === "start" ? t0.start2ndDerivative : t0.end2ndDerivative;
        const pick = (t: number) =>
            derivative(
                t,
                end === "start" ? targets[t].startDerivative : targets[t].endDerivative,
                end === "start" ? targets[t].start2ndDerivative : targets[t].end2ndDerivative,
            );
        const added = (first !== undefined ? 1 : 0) + (first !== undefined && second !== undefined ? 1 : 0);
        if (first !== undefined) constraints.push({ u, order: 1, value: (t) => pick(t).first ?? [] });
        if (first !== undefined && second !== undefined)
            constraints.push({ u, order: 2, value: (t) => pick(t).second ?? [] });
        if (end === "start") startConstraints = added;
        else endConstraints = added;
    }
    for (const index of options.interpolateIndices ?? []) {
        if (index > 0 && index < m && Number.isInteger(index))
            constraints.push({ u: parameters[index], order: 0, value: (t) => targets[t].positions[index] });
    }
    const degree = Math.max(1, Math.min(options.degree, m + startConstraints + endConstraints));
    const full = m + startConstraints + endConstraints;
    const maxPoints = Math.max(degree + 1, Math.min(options.maxControlPoints, full + 1));
    const minPoints = Math.min(maxPoints, Math.max(degree + 1, constraints.length));
    const attempt = (points: number) => {
        // Past one control point per position only full interpolation (end conditions included) remains.
        const n = points - 1 > m ? full : points - 1;
        const knots =
            n === full
                ? interpolationKnots(parameters, degree, startConstraints, endConstraints)
                : averagedKnots(parameters, degree, n);
        const curves = targets.map((_, t) =>
            solveOpen(targets[t].positions, parameters, knots, degree, n, constraints, t),
        );
        const deviation = Math.max(
            ...curves.map((curve, t) => maxDeviation(curve, targets[t].positions, parameters)),
        );
        return { curves, deviation };
    };
    const best = searchCount(minPoints, maxPoints, attempt, options.tolerance);
    return { curves: best.curves, interpolated: best.points >= full + 1 };
}

/** Grows the control point count until the fit is within tolerance, then bisects down to the fewest that fit. */
function searchCount(
    min: number,
    max: number,
    attempt: (points: number) => { curves: BSplineData[]; deviation: number },
    tolerance: number,
): { curves: BSplineData[]; points: number } {
    let low = min - 1;
    let points = min;
    let result = attempt(points);
    while (result.deviation > tolerance && points < max) {
        low = points;
        points = Math.min(max, Math.max(points + 1, Math.ceil(points * 1.5)));
        result = attempt(points);
    }
    if (result.deviation > tolerance) return { curves: result.curves, points };
    let high = points;
    let best = result;
    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        const trial = attempt(mid);
        if (trial.deviation <= tolerance) {
            high = mid;
            best = trial;
        } else low = mid;
    }
    return { curves: best.curves, points: high };
}

/** Clamped knots for a least-squares fit with `n + 1` control points (P&T eq. 9.68–9.69). */
function averagedKnots(parameters: readonly number[], p: number, n: number): number[] {
    const m = parameters.length - 1;
    const knots = new Array<number>(n + p + 2).fill(0);
    for (let i = 0; i <= p; i++) {
        knots[i] = parameters[0];
        knots[n + 1 + i] = parameters[m];
    }
    const d = (m + 1) / (n - p + 1);
    for (let j = 1; j <= n - p; j++) {
        const i = Math.floor(j * d);
        const alpha = j * d - i;
        knots[p + j] = (1 - alpha) * parameters[Math.max(0, i - 1)] + alpha * parameters[Math.min(m, i)];
    }
    return knots;
}

/** Clamped knots for interpolation, end parameters repeated once per end derivative condition. */
function interpolationKnots(parameters: readonly number[], p: number, start: number, end: number): number[] {
    const m = parameters.length - 1;
    const extended = [
        ...new Array<number>(start).fill(parameters[0]),
        ...parameters,
        ...new Array<number>(end).fill(parameters[m]),
    ];
    const n = extended.length - 1;
    const knots = new Array<number>(n + p + 2).fill(0);
    for (let i = 0; i <= p; i++) {
        knots[i] = parameters[0];
        knots[n + 1 + i] = parameters[m];
    }
    for (let j = 1; j <= n - p; j++) {
        let sum = 0;
        for (let i = j; i < j + p; i++) sum += extended[i];
        knots[p + j] = sum / p;
    }
    return knots;
}

/** Basis row (length `count`) of the given derivative order at `u`. */
function basisRow(knots: readonly number[], p: number, count: number, u: number, order: number): number[] {
    const probe: BSplineData = { degree: p, knots, points: new Array(count).fill([0]), periodic: false };
    const span = findSpan(probe, u);
    const ders = basisDerivatives(knots, p, span, u, order);
    const row = new Array<number>(count).fill(0);
    for (let j = 0; j <= p; j++) row[span - p + j] = ders[order][j];
    return row;
}

/** Constrained least squares through the KKT system, with a vanishing smoothing term for unconstrained control points. */
function solveOpen(
    positions: readonly (readonly number[])[],
    parameters: readonly number[],
    knots: readonly number[],
    p: number,
    n: number,
    constraints: readonly Constraint[],
    target: number,
): BSplineData {
    const size = n + 1;
    const dim = positions[0].length;
    const rows = parameters.map((u) => basisRow(knots, p, size, u, 0));
    const constraintRows = constraints.map((c) => basisRow(knots, p, size, c.u, c.order));
    const values = constraints.map((c) => c.value(target));
    const points = solveKkt(rows, positions, constraintRows, values, size, dim, false);
    return { degree: p, knots, points, periodic: false };
}

/**
 * min sum |rows_k P - data_k|^2 + eps |second differences of P|^2 subject to
 * constraintRows P = values, for each coordinate (one shared matrix).
 */
function solveKkt(
    rows: readonly number[][],
    data: readonly (readonly number[])[],
    constraintRows: readonly number[][],
    values: readonly (readonly number[])[],
    size: number,
    dim: number,
    periodic: boolean,
): number[][] {
    const total = size + constraintRows.length;
    const matrix = Array.from({ length: total }, () => new Array<number>(total).fill(0));
    const rhs = Array.from({ length: total }, () => new Array<number>(dim).fill(0));
    rows.forEach((row, k) => {
        for (let i = 0; i < size; i++) {
            if (row[i] === 0) continue;
            for (let j = 0; j < size; j++) matrix[i][j] += row[i] * row[j];
            for (let c = 0; c < dim; c++) rhs[i][c] += row[i] * data[k][c];
        }
    });
    let trace = 0;
    for (let i = 0; i < size; i++) trace += matrix[i][i];
    const eps = 1e-13 * (trace / size || 1);
    const differences = periodic ? size : size - 2;
    for (let s = 0; s < differences; s++) {
        const idx = [s, (s + 1) % size, (s + 2) % size];
        const coef = [1, -2, 1];
        for (let a = 0; a < 3; a++)
            for (let b = 0; b < 3; b++) matrix[idx[a]][idx[b]] += eps * coef[a] * coef[b];
    }
    if (!periodic && size < 3) for (let i = 0; i < size; i++) matrix[i][i] += eps;
    constraintRows.forEach((row, r) => {
        for (let i = 0; i < size; i++) {
            matrix[size + r][i] = row[i];
            matrix[i][size + r] = row[i];
        }
        for (let c = 0; c < dim; c++) rhs[size + r][c] = values[r][c] ?? 0;
    });
    const solution = solveLinear(matrix, rhs);
    return solution.slice(0, size);
}

/** Gaussian elimination with partial pivoting, several right-hand sides. */
export function solveLinear(matrix: number[][], rhs: number[][]): number[][] {
    const n = matrix.length;
    const a = matrix.map((row) => [...row]);
    const b = rhs.map((row) => [...row]);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
        if (Math.abs(a[pivot][col]) < 1e-300) fail("approximateSpline: the fit is singular");
        [a[col], a[pivot]] = [a[pivot], a[col]];
        [b[col], b[pivot]] = [b[pivot], b[col]];
        for (let r = col + 1; r < n; r++) {
            const f = a[r][col] / a[col][col];
            if (f === 0) continue;
            for (let j = col; j < n; j++) a[r][j] -= f * a[col][j];
            for (let c = 0; c < b[r].length; c++) b[r][c] -= f * b[col][c];
        }
    }
    const x = b.map((row) => row.map(() => 0));
    for (let r = n - 1; r >= 0; r--) {
        for (let c = 0; c < b[r].length; c++) {
            let sum = b[r][c];
            for (let j = r + 1; j < n; j++) sum -= a[r][j] * x[j][c];
            x[r][c] = sum / a[r][r];
        }
    }
    return x;
}

function maxDeviation(
    curve: BSplineData,
    positions: readonly (readonly number[])[],
    parameters: readonly number[],
): number {
    let worst = 0;
    parameters.forEach((u, k) => {
        worst = Math.max(worst, distance(evaluateDerivatives(curve, u, 0)[0], positions[k]));
    });
    return worst;
}

function fitPeriodic(targets: readonly FitTarget[], options: FitOptions): FitResult {
    // A closed path's last position repeats its first: drop it.
    let count = targets[0].positions.length;
    const closes = targets.every(
        (target) =>
            distance(target.positions[0], target.positions[count - 1]) <=
            1e-9 * Math.max(1, Math.hypot(...target.positions[0])),
    );
    if (closes) count--;
    if (count < 3) fail("approximateSpline: a periodic spline needs at least three distinct positions");
    const unique = targets.map((target) => target.positions.slice(0, count));
    let parameters: number[];
    if (options.parameters !== undefined) {
        const given = options.parameters;
        const span = closes ? given[given.length - 1] - given[0] : given[given.length - 1] - given[0];
        parameters = given.slice(0, count).map((u) => (span > 0 ? (u - given[0]) / span : 0));
    } else {
        parameters = chordParameters(
            unique.map((positions) => ({ positions })),
            count,
            true,
        );
    }
    const degree = Math.max(1, Math.min(options.degree, count - 1));
    const maxPoints = Math.max(degree + 1, Math.min(count, options.maxControlPoints - degree));
    const attempt = (points: number) => {
        const knots = Array.from({ length: points + 2 * degree + 1 }, (_, j) => (j - degree) / points);
        const curves = unique.map((positions) => solvePeriodic(positions, parameters, knots, degree, points));
        const deviation = Math.max(...curves.map((curve, t) => maxDeviation(curve, unique[t], parameters)));
        return { curves, deviation };
    };
    const minPoints = Math.min(maxPoints, Math.max(degree + 1, 4));
    const best = searchCount(minPoints, maxPoints, attempt, options.tolerance);
    return { curves: best.curves, interpolated: best.points >= count };
}

function solvePeriodic(
    positions: readonly (readonly number[])[],
    parameters: readonly number[],
    knots: readonly number[],
    p: number,
    n: number,
): BSplineData {
    const dim = positions[0].length;
    const all = n + p;
    const rows = parameters.map((u) => {
        const full = basisRow(knots, p, all, u, 0);
        const folded = new Array<number>(n).fill(0);
        full.forEach((value, i) => {
            folded[i % n] += value;
        });
        return folded;
    });
    const unique = solveKkt(rows, positions, [], [], n, dim, true);
    const points = [...unique, ...unique.slice(0, p)];
    return { degree: p, knots, points, periodic: true };
}

// ------------------------------------------------------------------ Exact conics

/**
 * A circular (or, with distinct radii, elliptical) arc as a rational quadratic spline:
 * `center + cos(t) * xAxis * rx + sin(t) * yAxis * ry` for t from `start` to `end`.
 */
export function conicArc(
    center: readonly number[],
    xAxis: readonly number[],
    yAxis: readonly number[],
    rx: number,
    ry: number,
    start: number,
    end: number,
): BSplineData {
    const sweep = end - start;
    const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const delta = sweep / segments;
    const w = Math.cos(delta / 2);
    const at = (t: number, scale = 1) =>
        center.map((c, i) => c + scale * (Math.cos(t) * xAxis[i] * rx + Math.sin(t) * yAxis[i] * ry));
    const points: number[][] = [];
    const weights: number[] = [];
    const knots = [0, 0, 0];
    for (let s = 0; s < segments; s++) {
        const a = start + s * delta;
        if (s === 0) {
            points.push(at(a));
            weights.push(1);
        }
        // The middle control point sits where the end tangents meet: at the mid angle, 1/cos out.
        points.push(at(a + delta / 2, 1 / w));
        weights.push(w);
        points.push(at(a + delta));
        weights.push(1);
        if (s < segments - 1) knots.push((s + 1) / segments, (s + 1) / segments);
    }
    knots.push(1, 1, 1);
    return { degree: 2, knots, points, weights, periodic: false };
}
