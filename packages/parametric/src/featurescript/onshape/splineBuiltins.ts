// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ICircle, IEdge, IEllipse, IFace, IWire } from "@chili3d/core";
import {
    approximateSplines,
    type BSplineData,
    conicArc,
    evaluateDerivatives,
    type FitTarget,
    solveLinear,
} from "../context/bspline";
import { edgeCurve, toVec } from "../context/differential";
import {
    denormalize,
    type FaceDomain,
    faceDomain,
    normalize,
    surfaceParameters,
} from "../context/faceDomain";
import { entityShape, FsContext, MM_PER_METER } from "../context/fsContext";
import { curveTypeOf, resolveQuery } from "../context/queries";
import {
    expectArray,
    expectNumber,
    FsArray,
    FsMap,
    FsQuantity,
    type FsValue,
    fail,
    fsArray,
    fsMap,
} from "../lang/values";
import { type Vec3, vec } from "../std/geometry";
import type { StdBridge } from "./bridge";
import type { BuiltinRegistry } from "./registry";

/**
 * The spline built-ins: evaluating a `BSplineCurve` with derivatives, fitting splines to
 * points (`approximateSpline`), and B-spline representations of edges and faces
 * (exact for lines and conic arcs, fitted within tolerance otherwise). Std splines carry
 * length control points; the math runs on plain meters.
 */
export function installSplineBuiltins(define: BuiltinRegistry, bridge: StdBridge): void {
    define("evaluateSpline", (args) => {
        const definition = localMap(bridge, args[0], "evaluateSpline");
        const spline = readSpline(definition.field("spline"));
        const count = definition.field("nDerivatives") ?? 0;
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 10)
            fail("evaluateSpline: nDerivatives must be an integer from 0 to 10");
        const parameters = expectArray(definition.field("parameters"), "parameters").items.map((u) =>
            expectNumber(u, "A spline parameter"),
        );
        const values = parameters.map((u) => evaluateDerivatives(spline, u, count));
        return fsArray(
            Array.from({ length: count + 1 }, (_, k) =>
                fsArray(values.map((derivatives) => fsArray(derivatives[k]))),
            ),
        );
    });

    define("approximateSpline", (args) => {
        FsContext.of(args[0]);
        const definition = localMap(bridge, args[1], "approximateSpline");
        const degree = definition.field("degree");
        if (typeof degree !== "number" || !Number.isInteger(degree) || degree < 1)
            fail("approximateSpline: degree must be a positive integer");
        const tolerance = meters(definition.field("tolerance"), "tolerance");
        if (!(tolerance >= 1e-8)) fail("approximateSpline: tolerance must be at least 1e-8 meters");
        const targets = expectArray(definition.field("targets"), "targets").items.map(readTarget);
        const parameters = definition.field("parameters");
        const indices = definition.field("interpolateIndices");
        const maxControlPoints = definition.field("maxControlPoints");
        const result = approximateSplines(targets, {
            degree,
            tolerance,
            periodic: definition.field("isPeriodic") === true,
            parameters:
                parameters === undefined
                    ? undefined
                    : expectArray(parameters, "parameters").items.map((u) => expectNumber(u, "A parameter")),
            maxControlPoints: typeof maxControlPoints === "number" ? maxControlPoints : 10000,
            interpolateIndices:
                indices === undefined
                    ? undefined
                    : expectArray(indices, "interpolateIndices").items.map((i) =>
                          expectNumber(i, "An index"),
                      ),
        });
        return fsArray(result.curves.map((curve) => stdSpline(bridge, curve, true)));
    });

    define("evApproximateBSplineCurve", (args) => {
        const context = FsContext.of(args[0]);
        const definition = localMap(bridge, args[1], "evApproximateBSplineCurve");
        const ref = resolveQuery(context, definition.field("edge")).find(
            (candidate) => candidate.kind === "EDGE",
        );
        if (ref === undefined) fail("evApproximateBSplineCurve: the query does not resolve to an edge");
        const tolerance = toleranceOf(definition, 1e-6) * MM_PER_METER;
        const spline = edgeSpline(
            entityShape(ref) as IEdge,
            definition.field("forceCubic") === true,
            definition.field("forceNonRational") === true,
            tolerance,
        );
        return stdSpline(bridge, scaled(spline, 1 / MM_PER_METER), true);
    });

    define("evApproximateBSplineSurface", (args) => {
        const context = FsContext.of(args[0]);
        const definition = localMap(bridge, args[1], "evApproximateBSplineSurface");
        const ref = resolveQuery(context, definition.field("face")).find(
            (candidate) => candidate.kind === "FACE",
        );
        if (ref === undefined) fail("evApproximateBSplineSurface: the query does not resolve to a face");
        const tolerance = toleranceOf(definition, 1e-6) * MM_PER_METER;
        const face = entityShape(ref) as IFace;
        const domain = faceDomain(face);
        try {
            const surface = surfaceSpline(domain, tolerance);
            const outer = face.outerWire();
            const loops = face.directSubShapes();
            try {
                const curves = (wire: IWire) =>
                    fsArray(
                        wire.edgeLoop().map((edge) => stdSpline(bridge, boundaryCurve(domain, edge), false)),
                    );
                const inner = loops
                    .filter((loop) => !loop.isSame(outer))
                    .map((loop) => curves(loop as IWire));
                return fsMap({
                    bSplineSurface: stdSurface(bridge, surface),
                    boundaryBSplineCurves: curves(outer),
                    innerLoopBSplineCurves: fsArray(inner),
                });
            } finally {
                outer.dispose();
                for (const loop of loops) loop.dispose();
            }
        } finally {
            domain.dispose();
        }
    });
}

function localMap(bridge: StdBridge, value: FsValue, what: string): FsMap {
    const local = bridge.toLocal(value);
    if (!(local instanceof FsMap)) fail(`${what} needs a definition map`);
    return local;
}

/** A length (or plain number) in meters. */
function meters(value: FsValue, what: string): number {
    if (value instanceof FsQuantity) return value.value;
    if (typeof value === "number") return value;
    fail(`${what} must be a length`);
}

function toleranceOf(definition: FsMap, fallback: number): number {
    const tolerance = definition.field("tolerance");
    return tolerance === undefined ? fallback : meters(tolerance, "tolerance");
}

/** A point or vector of lengths (or plain numbers) as plain numbers. */
function coordinates(value: FsValue, what: string): number[] {
    return expectArray(value, what).items.map((item) => meters(item, what));
}

function readSpline(value: FsValue): BSplineData {
    if (!(value instanceof FsMap)) fail("evaluateSpline needs a BSplineCurve");
    const degree = expectNumber(value.field("degree"), "degree");
    const points = expectArray(value.field("controlPoints"), "controlPoints").items.map((p) =>
        coordinates(p, "A control point"),
    );
    const knots = expectArray(value.field("knots"), "knots").items.map((k) => expectNumber(k, "A knot"));
    const weights =
        value.field("isRational") === true
            ? expectArray(value.field("weights"), "weights").items.map((w) => expectNumber(w, "A weight"))
            : undefined;
    if (points.length <= degree || knots.length !== points.length + degree + 1)
        fail("evaluateSpline: the spline's knots do not match its control points");
    return { degree, knots, points, weights, periodic: value.field("isPeriodic") === true };
}

function readTarget(value: FsValue): FitTarget {
    if (!(value instanceof FsMap)) fail("An approximation target must be a map");
    const optional = (field: string) => {
        const v = value.field(field);
        return v === undefined ? undefined : coordinates(v, field);
    };
    return {
        positions: expectArray(value.field("positions"), "positions").items.map((p) =>
            coordinates(p, "A position"),
        ),
        startDerivative: optional("startDerivative"),
        start2ndDerivative: optional("start2ndDerivative"),
        endDerivative: optional("endDerivative"),
        end2ndDerivative: optional("end2ndDerivative"),
    };
}

/** A std `BSplineCurve` (control points in meters, as lengths when `lengths`). */
function stdSpline(bridge: StdBridge, spline: BSplineData, lengths: boolean): FsMap {
    return fsMap(
        {
            degree: spline.degree,
            dimension: spline.points[0].length,
            isRational: spline.weights !== undefined,
            isPeriodic: spline.periodic,
            controlPoints: fsArray(
                spline.points.map((p) => (lengths ? bridge.lengthVector(p) : new FsArray([...p], "Vector"))),
            ),
            weights: spline.weights === undefined ? undefined : fsArray([...spline.weights]),
            knots: new FsArray([...spline.knots], "KnotArray"),
        },
        "BSplineCurve",
    );
}

function scaled(spline: BSplineData, factor: number): BSplineData {
    return { ...spline, points: spline.points.map((p) => p.map((c) => c * factor)) };
}

/** An edge as a B-spline (mm): exact lines and conic arcs, a cubic fit otherwise. */
function edgeSpline(
    edge: IEdge,
    forceCubic: boolean,
    forceNonRational: boolean,
    tolerance: number,
): BSplineData {
    const curve = edgeCurve(edge);
    const t0 = edge.firstParameter();
    const t1 = edge.lastParameter();
    const type = curveTypeOf(edge);
    if (type === "LINE") {
        const [a, b] = [toVec(edge.pointAt(t0)), toVec(edge.pointAt(t1))];
        if (!forceCubic) return { degree: 1, knots: [0, 0, 1, 1], points: [a, b], periodic: false };
        const at = (s: number) => vec.add(a, vec.scale(vec.sub(b, a), s));
        return {
            degree: 3,
            knots: [0, 0, 0, 0, 1, 1, 1, 1],
            points: [a, at(1 / 3), at(2 / 3), b],
            periodic: false,
        };
    }
    if (!forceCubic && !forceNonRational) {
        const basis = curve.basisCurve;
        if (basis.curveType === "circle") {
            const circle = basis as ICircle;
            const axes = [toVec(circle.xAxis), toVec(circle.yAxis)];
            return conicArc(toVec(circle.center), axes[0], axes[1], circle.radius, circle.radius, t0, t1);
        }
        if (basis.curveType === "ellipse") {
            const ellipse = basis as IEllipse;
            const axes = [toVec(ellipse.xAxis), toVec(ellipse.yAxis)];
            return conicArc(
                toVec(ellipse.center),
                axes[0],
                axes[1],
                ellipse.majorRadius,
                ellipse.minorRadius,
                t0,
                t1,
            );
        }
    }
    return fitEdge(edge, t0, t1, tolerance);
}

/** A cubic non-rational spline through dense samples, refined until the midpoints are within tolerance. */
function fitEdge(edge: IEdge, t0: number, t1: number, tolerance: number): BSplineData {
    for (let samples = 64; ; samples *= 2) {
        const parameters = Array.from({ length: samples + 1 }, (_, i) => i / samples);
        const positions = parameters.map((s) => toVec(edge.pointAt(t0 + (t1 - t0) * s)));
        const { curves } = approximateSplines([{ positions }], {
            degree: 3,
            tolerance: tolerance / 2,
            periodic: false,
            parameters,
            maxControlPoints: 10000,
        });
        const spline = curves[0];
        const worst = Math.max(
            ...parameters.slice(1).map((s, i) => {
                const mid = (s + parameters[i]) / 2;
                const p = evaluateDerivatives(spline, mid, 0)[0];
                return vec.norm(vec.sub(p as Vec3, toVec(edge.pointAt(t0 + (t1 - t0) * mid))));
            }),
        );
        if (worst <= tolerance || samples >= 1024) return spline;
    }
}

interface SurfaceSpline {
    readonly uDegree: number;
    readonly vDegree: number;
    readonly uKnots: number[];
    readonly vKnots: number[];
    /** Rows along u, columns along v (mm). */
    readonly points: number[][][];
}

/**
 * A tensor-product spline interpolating the face's surface over its UV box (normalized
 * to [0, 1]²): bilinear for a plane, else cubic on a grid refined until the cell
 * centers are within tolerance.
 */
function surfaceSpline(domain: FaceDomain, tolerance: number): SurfaceSpline {
    const sample = (s: number, t: number) => {
        const { u, v } = denormalize(domain, s, t);
        return toVec(domain.surface.value(u, v));
    };
    for (let cells = domain.planar ? 1 : 4; ; cells *= 2) {
        const degree = Math.min(3, cells);
        const parameters = Array.from({ length: cells + 1 }, (_, i) => i / cells);
        const knots = interpolationKnots(parameters, degree);
        const grid = parameters.map((s) => parameters.map((t) => sample(s, t)));
        // Interpolate along v for every row, then along u for every column of the result.
        const basis = basisMatrix(parameters, knots, degree);
        const rows = grid.map((row) =>
            solveLinear(
                basis,
                row.map((p) => [...p]),
            ),
        );
        const columns = parameters.map((_, j) =>
            solveLinear(
                basis,
                rows.map((row) => row[j]),
            ),
        );
        const points = parameters.map((_, i) => parameters.map((__, j) => columns[j][i]));
        const spline: SurfaceSpline = {
            uDegree: degree,
            vDegree: degree,
            uKnots: knots,
            vKnots: knots,
            points,
        };
        if (domain.planar || cells >= 64) return spline;
        let worst = 0;
        for (let i = 0; i < cells; i++)
            for (let j = 0; j < cells; j++) {
                const s = (i + 0.5) / cells;
                const t = (j + 0.5) / cells;
                worst = Math.max(
                    worst,
                    vec.norm(vec.sub(evaluateSurface(spline, s, t) as Vec3, sample(s, t))),
                );
            }
        if (worst <= tolerance) return spline;
    }
}

function interpolationKnots(parameters: readonly number[], degree: number): number[] {
    const n = parameters.length - 1;
    const knots = [...new Array<number>(degree + 1).fill(0)];
    for (let j = 1; j <= n - degree; j++) {
        let sum = 0;
        for (let i = j; i < j + degree; i++) sum += parameters[i];
        knots.push(sum / degree);
    }
    knots.push(...new Array<number>(degree + 1).fill(1));
    return knots;
}

function basisMatrix(parameters: readonly number[], knots: readonly number[], degree: number): number[][] {
    const count = parameters.length;
    return parameters.map((u) => {
        const unit = Array.from({ length: count }, (_, i) =>
            Array.from({ length: count }, (__, j) => (i === j ? 1 : 0)),
        );
        const spline: BSplineData = { degree, knots, points: unit, periodic: false };
        return evaluateDerivatives(spline, u, 0)[0];
    });
}

function evaluateSurface(spline: SurfaceSpline, s: number, t: number): number[] {
    const along = spline.points.map(
        (row) =>
            evaluateDerivatives(
                { degree: spline.vDegree, knots: spline.vKnots, points: row, periodic: false },
                t,
                0,
            )[0],
    );
    return evaluateDerivatives(
        { degree: spline.uDegree, knots: spline.uKnots, points: along, periodic: false },
        s,
        0,
    )[0];
}

function stdSurface(bridge: StdBridge, spline: SurfaceSpline): FsMap {
    return fsMap(
        {
            uDegree: spline.uDegree,
            vDegree: spline.vDegree,
            isRational: false,
            isUPeriodic: false,
            isVPeriodic: false,
            controlPoints: new FsArray(
                spline.points.map((row) =>
                    fsArray(row.map((p) => bridge.lengthVector(p.map((c) => c / MM_PER_METER)))),
                ),
                "ControlPointMatrix",
            ),
            uKnots: new FsArray([...spline.uKnots], "KnotArray"),
            vKnots: new FsArray([...spline.vKnots], "KnotArray"),
        },
        "BSplineSurface",
    );
}

/** A boundary edge as a polyline in the surface spline's normalized parameter space. */
function boundaryCurve(domain: FaceDomain, edge: IEdge): BSplineData {
    const t0 = edge.firstParameter();
    const t1 = edge.lastParameter();
    const reversed = edge.orientation() === "reversed";
    const count = curveTypeOf(edge) === "LINE" ? 1 : 32;
    const points = Array.from({ length: count + 1 }, (_, i) => {
        const s = reversed ? 1 - i / count : i / count;
        const uv = surfaceParameters(domain.surface, edge.pointAt(t0 + (t1 - t0) * s));
        return normalize(domain, uv.u, uv.v);
    });
    const knots = [0, ...Array.from({ length: count + 1 }, (_, i) => i / count), 1];
    edge.dispose();
    return { degree: 1, knots, points, periodic: false };
}
