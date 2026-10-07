// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IEdge,
    type IFace,
    type IShape,
    type ISurface,
    type ITrimmedCurve,
    ShapeTypes,
    XYZ,
} from "@chili3d/core";
import { fail } from "../lang/values";

/**
 * A face's parameter space: the (u, v) bounding box of the trimmed face — what Onshape's
 * normalized face parameters (`evFaceTangentPlane`'s `vector(0.5, 0.5)`) are relative
 * to — plus exact integration over the trimmed face by Green's theorem along its
 * boundary edges.
 *
 * The box comes from the face triangulation, whose node parameters the mesher reports
 * normalized to the face's UV bounds: two nodes projected onto the surface fix the
 * affine map back to true parameters (periodic directions unwrapped through it). Lengths
 * are kernel millimetres.
 */

export interface ParameterRange {
    readonly min: number;
    readonly max: number;
    readonly periodic: boolean;
    readonly period: number;
    /** A periodic direction the face spans completely (it has a seam). */
    readonly closed: boolean;
}

export interface FaceDomain {
    readonly face: IFace;
    readonly surface: ISurface;
    readonly reversed: boolean;
    readonly planar: boolean;
    readonly u: ParameterRange;
    readonly v: ParameterRange;
    dispose(): void;
}

/** Gauss–Legendre nodes and weights on [0, 1]. */
const GAUSS = gaussLegendre(6);

function gaussLegendre(n: number): { x: number[]; w: number[] } {
    const x: number[] = [];
    const w: number[] = [];
    for (let i = 1; i <= n; i++) {
        let t = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
        let derivative = 0;
        for (let iteration = 0; iteration < 100; iteration++) {
            let p0 = 1;
            let p1 = t;
            for (let k = 2; k <= n; k++) {
                const p2 = ((2 * k - 1) * t * p1 - (k - 1) * p0) / k;
                p0 = p1;
                p1 = p2;
            }
            derivative = (n * (t * p1 - p0)) / (t * t - 1);
            const step = p1 / derivative;
            t -= step;
            if (Math.abs(step) < 1e-16) break;
        }
        x.push((1 - t) / 2);
        w.push(1 / ((1 - t * t) * derivative * derivative));
    }
    return { x, w };
}

/** Composite Gauss–Legendre nodes over [a, b] split into `panels`. */
export function quadrature(a: number, b: number, panels: number): { t: number; w: number }[] {
    const nodes: { t: number; w: number }[] = [];
    const h = (b - a) / panels;
    for (let p = 0; p < panels; p++) {
        for (let i = 0; i < GAUSS.x.length; i++)
            nodes.push({ t: a + h * (p + GAUSS.x[i]), w: h * GAUSS.w[i] });
    }
    return nodes;
}

/** Surface parameters of a point on (or within `tolerance` mm of) the surface. */
export function surfaceParameters(surface: ISurface, point: XYZ, tolerance = 1e-2): { u: number; v: number } {
    const uv = surface.parameter(point, tolerance) ?? surface.parameter(point, 1);
    if (uv === undefined) fail("The point does not lie on the face's surface");
    return uv;
}

/** `value` moved by whole periods into (center - period/2, center + period/2]. */
export function unwrap(value: number, center: number, period: number): number {
    const half = period / 2;
    return center + half - ((((center + half - value) % period) + period) % period);
}

export function faceDomain(face: IFace): FaceDomain {
    const surface = face.surface();
    try {
        const planar = surface.isPlanar();
        const periodicU = surface.isUPeriodic();
        const periodicV = surface.isVPeriodic();
        const periodU = periodicU ? surface.uPeriod() : 0;
        const periodV = periodicV ? surface.vPeriod() : 0;
        const box = meshBox(face, surface, periodU, periodV) ?? boundaryBox(face, surface, periodU, periodV);
        const range = (min: number, max: number, periodic: boolean, period: number): ParameterRange => ({
            min,
            max,
            periodic,
            period,
            closed: periodic && max - min > period * (1 - 1e-6),
        });
        return {
            face,
            surface,
            reversed: face.orientation() === "reversed",
            planar,
            u: range(box.u0, box.u1, periodicU, periodU),
            v: range(box.v0, box.v1, periodicV, periodV),
            dispose: () => surface.dispose(),
        };
    } catch (error) {
        surface.dispose();
        throw error;
    }
}

interface UvBox {
    u0: number;
    u1: number;
    v0: number;
    v1: number;
}

/** The face's UV box from its triangulation (node parameters normalized to the box). */
function meshBox(face: IFace, surface: ISurface, periodU: number, periodV: number): UvBox | undefined {
    const mesh = face.mesh.faces;
    const uv = mesh?.uv;
    const position = mesh?.position;
    if (uv === undefined || position === undefined || uv.length < 4) return undefined;
    const count = uv.length / 2;
    const point = (i: number) => new XYZ(position[3 * i], position[3 * i + 1], position[3 * i + 2]);
    const fit = (axis: 0 | 1, period: number): [number, number] | undefined => {
        // Nodes away from the other direction's ends dodge surface singularities (poles, apices).
        const other = 1 - axis;
        const order = Array.from({ length: count }, (_, i) => i).sort(
            (a, b) => Math.abs(uv[2 * a + other] - 0.5) - Math.abs(uv[2 * b + other] - 0.5),
        );
        const band = order.slice(0, Math.max(2, Math.ceil(count / 2)));
        let a = band[0];
        let b = band[0];
        for (const i of band) {
            if (uv[2 * i + axis] < uv[2 * a + axis]) a = i;
            if (uv[2 * i + axis] > uv[2 * b + axis]) b = i;
        }
        const span = uv[2 * b + axis] - uv[2 * a + axis];
        if (!(span > 1e-6)) return undefined;
        const pa = surfaceParameters(surface, point(a), 1);
        const pb = surfaceParameters(surface, point(b), 1);
        const ta = axis === 0 ? pa.u : pa.v;
        const tb = axis === 0 ? pb.u : pb.v;
        let delta = tb - ta;
        if (period > 0) {
            delta = ((delta % period) + period) % period;
            if (delta < 1e-9 * period) delta = span > 0.5 ? period : 0;
        }
        const scale = delta / span;
        const start = ta - scale * uv[2 * a + axis];
        return [start, start + scale];
    };
    const u = fit(0, periodU);
    const v = fit(1, periodV);
    if (u === undefined || v === undefined) return undefined;
    return { u0: u[0], u1: u[1], v0: v[0], v1: v[1] };
}

/** Fallback: the box of the boundary edges' parameters, sampled. */
function boundaryBox(face: IFace, surface: ISurface, periodU: number, periodV: number): UvBox {
    const box: UvBox = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
    let reference: { u: number; v: number } | undefined;
    for (const edge of face.findSubShapes(ShapeTypes.edge) as IEdge[]) {
        try {
            const first = edge.firstParameter();
            const last = edge.lastParameter();
            for (let i = 0; i <= 16; i++) {
                const uv = surfaceParameters(surface, edge.pointAt(first + ((last - first) * i) / 16));
                reference ??= uv;
                const u = periodU > 0 ? unwrap(uv.u, reference.u, periodU) : uv.u;
                const v = periodV > 0 ? unwrap(uv.v, reference.v, periodV) : uv.v;
                box.u0 = Math.min(box.u0, u);
                box.u1 = Math.max(box.u1, u);
                box.v0 = Math.min(box.v0, v);
                box.v1 = Math.max(box.v1, v);
            }
        } finally {
            edge.dispose();
        }
    }
    if (!Number.isFinite(box.u0)) fail("The face has no parameter range");
    return box;
}

/** A normalized face parameter (0..1 over the face's UV box) as surface parameters. */
export function denormalize(domain: FaceDomain, s: number, t: number): { u: number; v: number } {
    return {
        u: domain.u.min + (domain.u.max - domain.u.min) * s,
        v: domain.v.min + (domain.v.max - domain.v.min) * t,
    };
}

/** Surface parameters as a normalized face parameter. */
export function normalize(domain: FaceDomain, u: number, v: number): [number, number] {
    const su = domain.u.max - domain.u.min;
    const sv = domain.v.max - domain.v.min;
    const uu = domain.u.periodic ? unwrap(u, (domain.u.min + domain.u.max) / 2, domain.u.period) : u;
    const vv = domain.v.periodic ? unwrap(v, (domain.v.min + domain.v.max) / 2, domain.v.period) : v;
    return [su > 0 ? (uu - domain.u.min) / su : 0, sv > 0 ? (vv - domain.v.min) / sv : 0];
}

export interface SurfaceSample {
    readonly point: XYZ;
    readonly du: XYZ;
    readonly dv: XYZ;
}

/**
 * Integrates `g(u, v)` (`components` values per sample) over the trimmed face in its
 * parameter space: ∮ G dv along the oriented boundary, with G(u, v) the integral of g
 * along u from an anchor (Green's theorem). Equals ∫∫ g du dv for a forward face and its
 * negation for a reversed one — so a flux integrand `F · (Su × Sv)` comes out as the
 * outward flux either way. A seam edge of a face closed in u sits at both ends of the
 * u range: its occurrence running up the right side carries G(u_max), the other none.
 */
export function integrateFace(
    domain: FaceDomain,
    integrand: (sample: SurfaceSample) => number[],
    components: number,
): number[] {
    const { edges, shapes } = orientedEdges(domain.face);
    try {
        return boundaryIntegral(domain, edges, integrand, components);
    } finally {
        for (const shape of shapes) shape.dispose();
    }
}

function boundaryIntegral(
    domain: FaceDomain,
    edges: readonly OrientedEdge[],
    integrand: (sample: SurfaceSample) => number[],
    components: number,
): number[] {
    const { surface, u: ur, v: vr } = domain;
    const result = new Array<number>(components).fill(0);
    const seamU = ur.closed ? seamParameter(domain, edges) : undefined;
    const anchor = seamU ?? (ur.min + ur.max) / 2;
    const uCenter = seamU === undefined ? anchor : seamU + ur.period / 2;
    const vCenter = (vr.min + vr.max) / 2;
    const span = Math.max(ur.max - ur.min, 1e-12);
    const inner = (u: number, v: number): number[] => {
        const sum = new Array<number>(components).fill(0);
        if (u === anchor) return sum;
        const panels = domain.planar ? 1 : Math.max(1, Math.ceil(Math.abs(u - anchor) / (span / 12)));
        for (const node of quadrature(anchor, u, panels)) {
            const d = surface.d1(node.t, v);
            const values = integrand({ point: d.point, du: d.d1u, dv: d.d1v });
            for (let c = 0; c < components; c++) sum[c] += node.w * values[c];
        }
        return sum;
    };
    for (const { edge, forward, seam } of edges) {
        let curve: ITrimmedCurve;
        try {
            curve = edge.curve;
        } catch {
            continue; // a degenerate edge (a pole) bounds nothing in u
        }
        const t0 = edge.firstParameter();
        const t1 = edge.lastParameter();
        const sign = forward ? 1 : -1;
        const parametersAt = (t: number) => {
            const d = curve.d1(t);
            const uv = surfaceParameters(surface, d.point);
            const v = vr.periodic ? unwrap(uv.v, vCenter, vr.period) : uv.v;
            const u = ur.periodic ? unwrap(uv.u, uCenter, ur.period) : uv.u;
            const s = surface.d1(u, v);
            // C'(t) = Su u' + Sv v': least squares for (u', v').
            const a = s.d1u.dot(s.d1u);
            const b = s.d1u.dot(s.d1v);
            const c = s.d1v.dot(s.d1v);
            const det = a * c - b * b;
            const vDot = det > 1e-24 * a * c ? (a * d.vec.dot(s.d1v) - b * d.vec.dot(s.d1u)) / det : 0;
            return { u, v, vDot };
        };
        let fixedU: number | undefined;
        if (seam && seamU !== undefined) {
            const mid = parametersAt((t0 + t1) / 2);
            if (Math.abs(mid.vDot) < 1e-12) continue; // runs along u: no dv
            const right = mid.vDot * sign > 0 !== domain.reversed;
            if (!right) continue; // G vanishes at the anchor
            fixedU = seamU + ur.period;
        }
        const panels = curvePanels(curve, t1 - t0);
        for (const node of quadrature(t0, t1, panels)) {
            const p = parametersAt(node.t);
            if (p.vDot === 0) continue;
            const g = inner(fixedU ?? p.u, p.v);
            const weight = node.w * p.vDot * sign;
            for (let c = 0; c < components; c++) result[c] += weight * g[c];
        }
    }
    return result;
}

function curvePanels(curve: ITrimmedCurve, span: number): number {
    const type = curve.basisCurve.curveType;
    if (type === "line") return 1;
    if (type === "circle" || type === "ellipse")
        return Math.max(2, Math.ceil(Math.abs(span) / (Math.PI / 8)));
    return 16;
}

export interface OrientedEdge {
    readonly edge: IEdge;
    readonly forward: boolean;
    /** The edge bounds the face on both sides (it appears twice in the face's wires). */
    readonly seam: boolean;
}

/** Every edge of the face's wires with its orientation in the face, and the wrappers to dispose. */
export function orientedEdges(face: IFace): { edges: OrientedEdge[]; shapes: IShape[] } {
    const shapes: IShape[] = [];
    const edges: IEdge[] = [];
    for (const wire of face.directSubShapes()) {
        shapes.push(wire);
        if (wire.shapeType !== ShapeTypes.wire) continue;
        for (const edge of wire.directSubShapes()) {
            shapes.push(edge);
            if (edge.shapeType === ShapeTypes.edge) edges.push(edge as IEdge);
        }
    }
    return {
        edges: edges.map((edge) => ({
            edge,
            forward: edge.orientation() !== "reversed",
            seam: edges.some((other) => other !== edge && other.isSame(edge)),
        })),
        shapes,
    };
}

/** The u of the seam of a face closed in u, at the low end of its UV box. */
function seamParameter(domain: FaceDomain, edges: readonly OrientedEdge[]): number | undefined {
    const seam = edges.find((candidate) => candidate.seam);
    if (seam === undefined) return domain.u.min;
    const t = (seam.edge.firstParameter() + seam.edge.lastParameter()) / 2;
    const uv = surfaceParameters(domain.surface, seam.edge.pointAt(t));
    return unwrap(uv.u, domain.u.min, domain.u.period);
}
