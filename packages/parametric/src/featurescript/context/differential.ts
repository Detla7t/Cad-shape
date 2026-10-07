// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type ISurface, type ITrimmedCurve, XYZ, type XYZLike } from "@chili3d/core";
import { fail } from "../lang/values";
import { type Vec3, vec } from "../std/geometry";
import { type FaceDomain, quadrature, surfaceParameters } from "./faceDomain";
import { MM_PER_METER } from "./fsContext";
import { curveTypeOf } from "./queries";

/**
 * Local differential geometry of faces and edges: principal curvatures, curvature
 * frames, tangent planes, arc-length parameters and face-relative edge orientation.
 * Inputs and positions are kernel millimetres; curvatures come back per meter.
 */

export const toVec = (p: XYZLike): Vec3 => [p.x, p.y, p.z];
export const toMeters = (p: XYZLike): Vec3 => [p.x / MM_PER_METER, p.y / MM_PER_METER, p.z / MM_PER_METER];

// ------------------------------------------------------------------ Surfaces

export interface SurfaceDerivatives {
    readonly point: XYZ;
    readonly su: Vec3;
    readonly sv: Vec3;
    readonly suu: Vec3;
    readonly suv: Vec3;
    readonly svv: Vec3;
}

/** Second-order derivatives; by central differences of the first where the surface is not C2. */
export function surfaceDerivatives(surface: ISurface, u: number, v: number): SurfaceDerivatives {
    if (surface.isCNu(2) && surface.isCNv(2)) {
        const d = surface.d2(u, v);
        return {
            point: d.point,
            su: toVec(d.d1u),
            sv: toVec(d.d1v),
            suu: toVec(d.d2u),
            suv: toVec(d.d2uv),
            svv: toVec(d.d2v),
        };
    }
    const h = 1e-5;
    const d = surface.d1(u, v);
    const du0 = surface.d1(u - h, v);
    const du1 = surface.d1(u + h, v);
    const dv0 = surface.d1(u, v - h);
    const dv1 = surface.d1(u, v + h);
    const diff = (a: XYZ, b: XYZ): Vec3 => vec.scale(vec.sub(toVec(b), toVec(a)), 1 / (2 * h));
    return {
        point: d.point,
        su: toVec(d.d1u),
        sv: toVec(d.d1v),
        suu: diff(du0.d1u, du1.d1u),
        suv: diff(du0.d1v, du1.d1v),
        svv: diff(dv0.d1v, dv1.d1v),
    };
}

/** The face's outward unit normal at (u, v) (the surface normal, flipped on a reversed face). */
export function outwardNormal(domain: FaceDomain, su: Vec3, sv: Vec3): Vec3 {
    const n = vec.cross(su, sv);
    if (vec.norm(n) < 1e-300) fail("The face has no normal at this parameter");
    return vec.scale(vec.normalize(n), domain.reversed ? -1 : 1);
}

export interface FaceCurvature {
    /** Point in millimetres. */
    readonly point: Vec3;
    readonly normal: Vec3;
    /** Principal curvatures per meter, positive where the face bends away from its normal (convex). */
    readonly minCurvature: number;
    readonly maxCurvature: number;
    readonly minDirection: Vec3;
    readonly maxDirection: Vec3;
}

/** Principal curvatures and directions at surface parameters (u, v), Onshape's sign convention. */
export function faceCurvature(domain: FaceDomain, u: number, v: number): FaceCurvature {
    const d = surfaceDerivatives(domain.surface, u, v);
    const n = outwardNormal(domain, d.su, d.sv);
    const E = vec.dot(d.su, d.su);
    const F = vec.dot(d.su, d.sv);
    const G = vec.dot(d.sv, d.sv);
    const L = vec.dot(d.suu, n);
    const M = vec.dot(d.suv, n);
    const N = vec.dot(d.svv, n);
    const det = E * G - F * F;
    if (det < 1e-300) fail("The face is singular at this parameter");
    // k: eigenvalues of the shape operator S = I⁻¹ II (negative on a convex face); Onshape reports -k.
    const s11 = (G * L - F * M) / det;
    const s12 = (G * M - F * N) / det;
    const s21 = (E * M - F * L) / det;
    const s22 = (E * N - F * M) / det;
    const H = (s11 + s22) / 2;
    // ((k1 - k2) / 2)² straight from S, free of the cancellation in H² - K at an umbilic.
    const root = Math.sqrt(Math.max(0, ((s11 - s22) / 2) ** 2 + s12 * s21));
    const k1 = H - root; // largest Onshape curvature
    const direction = (k: number): Vec3 | undefined => {
        const a = [L - k * E, M - k * F];
        const b = [M - k * F, N - k * G];
        const [du, dv] = Math.hypot(a[0], a[1]) >= Math.hypot(b[0], b[1]) ? [-a[1], a[0]] : [b[1], -b[0]];
        const t = vec.add(vec.scale(d.su, du), vec.scale(d.sv, dv));
        return vec.norm(t) > 1e-12 * (vec.norm(d.su) + vec.norm(d.sv)) ? vec.normalize(t) : undefined;
    };
    // At an umbilic every direction is principal.
    const umbilic = root <= 1e-12 * Math.max(Math.abs(H), 1e-300) || root === 0;
    const maxDirection =
        (!umbilic ? direction(k1) : undefined) ?? vec.normalize(vec.norm(d.su) > 1e-300 ? d.su : d.sv);
    const minDirection = vec.normalize(vec.cross(n, maxDirection));
    return {
        point: toVec(d.point),
        normal: n,
        // `|| 0`: a flat direction reads 0, not -0.
        minCurvature: -(H + root) * MM_PER_METER || 0,
        maxCurvature: -k1 * MM_PER_METER || 0,
        minDirection,
        maxDirection,
    };
}

/**
 * The second fundamental form as a world-space matrix, per meter:
 * -κmin dmin dminᵀ - κmax dmax dmaxᵀ (Onshape's definition).
 */
export function secondFundamentalForm(curvature: FaceCurvature): number[][] {
    const { minCurvature: a, maxCurvature: b, minDirection: p, maxDirection: q } = curvature;
    return [0, 1, 2].map((i) => [0, 1, 2].map((j) => -a * p[i] * p[j] - b * q[i] * q[j]));
}

/** Surface parameter increments (du, dv) per millimetre along a tangent direction. */
export function parameterDirection(su: Vec3, sv: Vec3, direction: Vec3): [number, number] {
    const a = vec.dot(su, su);
    const b = vec.dot(su, sv);
    const c = vec.dot(sv, sv);
    const det = a * c - b * b;
    if (det < 1e-300) return [0, 0];
    const p = vec.dot(direction, su);
    const q = vec.dot(direction, sv);
    return [(c * p - b * q) / det, (a * q - b * p) / det];
}

// ------------------------------------------------------------------ Edges

/** The edge's 3D curve, or a failure for a degenerate edge. */
export function edgeCurve(edge: IEdge): ITrimmedCurve {
    try {
        return edge.curve;
    } catch {
        fail("The edge is degenerate");
    }
}

/** Kernel parameter of a normalized edge parameter, measured by arc length when asked. */
export function edgeParameter(edge: IEdge, t: number, arcLength: boolean): number {
    const t0 = edge.firstParameter();
    const t1 = edge.lastParameter();
    const linear = t0 + (t1 - t0) * t;
    const type = curveTypeOf(edge);
    // Lines and circles run at constant speed.
    if (!arcLength || type === "LINE" || type === "CIRCLE" || type === "ARC") return linear;
    const curve = edgeCurve(edge);
    const speed = (u: number) => curve.d1(u).vec.length();
    const lengthTo = (u: number) =>
        quadrature(t0, u, 8).reduce((sum, node) => sum + node.w * speed(node.t), 0);
    const total = lengthTo(t1);
    if (!(total > 0)) return linear;
    let u = linear;
    for (let i = 0; i < 30; i++) {
        const step = (lengthTo(u) - t * total) / Math.max(speed(u), 1e-300);
        u = Math.min(t1, Math.max(t0, u - step));
        if (Math.abs(step) < 1e-12 * Math.max(1, Math.abs(t1 - t0))) break;
    }
    return u;
}

/** Normalized (arc length when asked) parameter of a kernel edge parameter. */
export function normalizedEdgeParameter(edge: IEdge, u: number, arcLength: boolean): number {
    const t0 = edge.firstParameter();
    const t1 = edge.lastParameter();
    if (t1 === t0) return 0;
    const type = curveTypeOf(edge);
    if (!arcLength || type === "LINE" || type === "CIRCLE" || type === "ARC") return (u - t0) / (t1 - t0);
    const curve = edgeCurve(edge);
    const lengthTo = (x: number) =>
        quadrature(t0, x, 8).reduce((sum, node) => sum + node.w * curve.d1(node.t).vec.length(), 0);
    const total = lengthTo(t1);
    return total > 0 ? lengthTo(u) / total : (u - t0) / (t1 - t0);
}

export interface CurveDerivatives {
    readonly point: Vec3;
    readonly d1: Vec3;
    readonly d2: Vec3;
    readonly d3: Vec3;
}

/** Derivatives up to third order; by central differences where the curve is not smooth enough. */
export function curveDerivatives(curve: ITrimmedCurve, u: number): CurveDerivatives {
    if (curve.isCN(3)) {
        const d = curve.d3(u);
        return { point: toVec(d.point), d1: toVec(d.vec1), d2: toVec(d.vec2), d3: toVec(d.vec3) };
    }
    const d = curve.isCN(2) ? curve.d2(u) : undefined;
    const h = 1e-5 * Math.max(1, Math.abs(curve.lastParameter() - curve.firstParameter()));
    const first = (x: number) => toVec(curve.d1(x).vec);
    const d1 = first(u);
    const d2 = d === undefined ? vec.scale(vec.sub(first(u + h), first(u - h)), 1 / (2 * h)) : toVec(d.vec2);
    const second = (x: number) =>
        curve.isCN(2) ? toVec(curve.d2(x).vec2) : vec.scale(vec.sub(first(x + h), first(x - h)), 1 / (2 * h));
    const d3 = vec.scale(vec.sub(second(u + h), second(u - h)), 1 / (2 * h));
    return { point: toVec(curve.d1(u).point), d1, d2, d3 };
}

export interface CurvatureFrame {
    readonly point: Vec3;
    readonly tangent: Vec3;
    readonly normal: Vec3;
    readonly binormal: Vec3;
    /** Per meter. */
    readonly curvature: number;
}

/** The Frenet frame at kernel parameter u, the tangent along `sign`. */
export function curvatureFrame(curve: ITrimmedCurve, u: number, sign: 1 | -1): CurvatureFrame {
    const d = curveDerivatives(curve, u);
    const speed = vec.norm(d.d1);
    if (speed < 1e-300) fail("The edge has no tangent at this parameter");
    const tangent = vec.scale(d.d1, sign / speed);
    // dT/ds = (C'' - (C''·T)T) / |C'|^2, independent of direction.
    const along = vec.dot(d.d2, tangent);
    const k = vec.scale(vec.sub(d.d2, vec.scale(tangent, along)), 1 / (speed * speed));
    const curvature = vec.norm(k);
    const normal = curvature > 1e-12 / speed ? vec.scale(k, 1 / curvature) : vec.perpendicular(tangent);
    return {
        point: d.point,
        tangent,
        normal,
        binormal: vec.cross(tangent, normal),
        curvature: curvature > 1e-12 / speed ? curvature * MM_PER_METER : 0,
    };
}

/** d(κN)/ds — the third derivative with respect to arc length — per square meter. */
export function curvatureDerivative(curve: ITrimmedCurve, u: number, sign: 1 | -1): Vec3 {
    const { d1: a, d2: b, d3: c } = curveDerivatives(curve, u);
    const v2 = vec.dot(a, a);
    if (v2 < 1e-300) fail("The edge has no tangent at this parameter");
    const ab = vec.dot(a, b);
    // K(t) = (b v² - (a·b) a) / v⁴;  dK/ds = (dK/dt) / v.
    const numerator = vec.sub(vec.scale(b, v2), vec.scale(a, ab));
    const dNumerator = vec.sub(
        vec.add(vec.scale(c, v2), vec.scale(b, ab)),
        vec.scale(a, vec.dot(b, b) + vec.dot(a, c)),
    );
    const dK = vec.sub(vec.scale(dNumerator, 1 / (v2 * v2)), vec.scale(numerator, (4 * ab) / (v2 * v2 * v2)));
    return vec.scale(dK, (sign / Math.sqrt(v2)) * MM_PER_METER * MM_PER_METER);
}

/**
 * +1 when walking the edge along its curve keeps `face` on the left (face normal up),
 * else -1: probes a point just off the edge, inside the face's surface, on the left.
 */
export function faceSide(edge: IEdge, face: IFace, domain: FaceDomain, u: number): 1 | -1 {
    const curve = edgeCurve(edge);
    const d = curve.d1(u);
    const uv = surfaceParameters(domain.surface, d.point);
    const s = domain.surface.d1(uv.u, uv.v);
    const su = toVec(s.d1u);
    const sv = toVec(s.d1v);
    const n = outwardNormal(domain, su, sv);
    const left = vec.cross(n, toVec(d.vec));
    if (vec.norm(left) < 1e-300) return 1;
    const step = 1e-4 * Math.max(edge.length(), 1e-3);
    const [du, dv] = parameterDirection(su, sv, vec.normalize(left));
    const inside = (k: number) => {
        const q = domain.surface.value(uv.u + k * step * du, uv.v + k * step * dv);
        return face.containsPoint(q, false, 1e-7);
    };
    if (inside(1)) return 1;
    return inside(-1) ? -1 : 1;
}

/** A point (mm) as a kernel XYZ. */
export const toXYZ = (p: Vec3) => new XYZ(p[0], p[1], p[2]);
