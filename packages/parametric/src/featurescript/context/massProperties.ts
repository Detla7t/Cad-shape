// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEdge, IFace, XYZ } from "@chili3d/core";
import { fail } from "../lang/values";
import type { Vec3 } from "../std/geometry";
import { faceDomain, integrateFace, quadrature, type SurfaceSample } from "./faceDomain";
import { type EntityRef, entityShape, MM_PER_METER } from "./fsContext";
import { curveTypeOf } from "./queries";

/**
 * Mass properties (per unit density) of entities of one dimension: solids by the
 * divergence theorem over their faces, faces by their area element, edges by arc length,
 * vertices as unit point masses. Every face integral runs over the exact trimmed face
 * (see `integrateFace`), so results are exact up to quadrature for analytic geometry.
 * Moments up to third order are kept (the third ones tell mirror images apart).
 */

/** Exponents (a, b, c) of the monomials x^a y^b z^c integrated, up to degree 3. */
const MONOMIALS: readonly (readonly [number, number, number])[] = (() => {
    const list: [number, number, number][] = [];
    for (let degree = 0; degree <= 3; degree++)
        for (let a = degree; a >= 0; a--)
            for (let b = degree - a; b >= 0; b--) list.push([a, b, degree - a - b]);
    return list;
})();

const index = (a: number, b: number, c: number) =>
    MONOMIALS.findIndex(([x, y, z]) => x === a && y === b && z === c);

export interface MassData {
    /** 3 for solids, 2 faces, 1 edges, 0 vertices. */
    readonly dimension: number;
    /** Volume, area, length (meters^dimension) or vertex count. */
    readonly measure: number;
    /** Centroid in meters. */
    readonly centroid: Vec3;
    /** Central second moments ∫ (p - c)(p - c)ᵀ (meters^(dimension + 2)). */
    readonly second: number[][];
    /** Central third moment ∫ ((p - c)·a)((p - c)·b)((p - c)·c), meters^(dimension + 3). */
    third(a: Vec3, b: Vec3, c: Vec3): number;
}

/** The dimension an entity contributes in. */
export function entityDimension(ref: EntityRef): number {
    if (ref.kind === "VERTEX") return 0;
    if (ref.kind === "EDGE") return 1;
    if (ref.kind === "FACE") return 2;
    return { SOLID: 3, SHEET: 2, WIRE: 1, POINT: 0 }[ref.body.kind];
}

/** Mass properties of the highest-dimensional entities among `refs`. */
export function massData(refs: readonly EntityRef[]): MassData {
    if (refs.length === 0) fail("Mass properties need at least one entity");
    const dimension = Math.max(...refs.map(entityDimension));
    const used = refs.filter((ref) => entityDimension(ref) === dimension);
    const reference = referencePoint(used);
    const raw = new Array<number>(MONOMIALS.length).fill(0);
    const add = (values: number[]) => {
        for (let i = 0; i < values.length; i++) raw[i] += values[i];
    };
    const monomials = (p: XYZ) => {
        const x = p.x - reference[0];
        const y = p.y - reference[1];
        const z = p.z - reference[2];
        return MONOMIALS.map(([a, b, c]) => x ** a * y ** b * z ** c);
    };
    for (const ref of used) {
        if (dimension === 3) {
            for (const face of ref.body.faces()) add(faceIntegral(face, (s) => flux(s, reference)));
        } else if (dimension === 2) {
            const faces = ref.kind === "FACE" ? [entityShape(ref) as IFace] : ref.body.faces();
            for (const face of faces)
                add(
                    faceIntegral(
                        face,
                        (s) => {
                            const area = s.du.cross(s.dv).length();
                            return monomials(s.point).map((m) => m * area);
                        },
                        true,
                    ),
                );
        } else if (dimension === 1) {
            const edges = ref.kind === "EDGE" ? [entityShape(ref) as IEdge] : ref.body.edges();
            for (const edge of edges) add(edgeIntegral(edge, monomials));
        } else {
            const vertices = ref.kind === "VERTEX" ? [ref.body.vertices()[ref.index]] : ref.body.vertices();
            for (const vertex of vertices) add(monomials(vertex.point()));
        }
    }
    return fromRaw(raw, dimension, reference);
}

/** The flux of F = (x^(a+1) y^b z^c / (a+1), 0, 0), whose divergence is the monomial. */
function flux(sample: SurfaceSample, reference: Vec3): number[] {
    const x = sample.point.x - reference[0];
    const y = sample.point.y - reference[1];
    const z = sample.point.z - reference[2];
    const nx = sample.du.y * sample.dv.z - sample.du.z * sample.dv.y;
    return MONOMIALS.map(([a, b, c]) => ((x ** (a + 1) * y ** b * z ** c) / (a + 1)) * nx);
}

/**
 * ∫∫ over the face. A flux integrand comes out outward either way; an area integrand
 * gets its sign from the face orientation, which is removed.
 */
function faceIntegral(face: IFace, integrand: (sample: SurfaceSample) => number[], area = false): number[] {
    const domain = faceDomain(face);
    try {
        const values = integrateFace(domain, integrand, MONOMIALS.length);
        return area && domain.reversed ? values.map((value) => -value) : values;
    } finally {
        domain.dispose();
    }
}

function edgeIntegral(edge: IEdge, monomials: (p: XYZ) => number[]): number[] {
    const sum = new Array<number>(MONOMIALS.length).fill(0);
    let curve: IEdge["curve"];
    try {
        curve = edge.curve;
    } catch {
        return sum; // degenerate
    }
    const t0 = edge.firstParameter();
    const t1 = edge.lastParameter();
    const type = curveTypeOf(edge);
    const panels =
        type === "LINE"
            ? 1
            : type === "CIRCLE" || type === "ARC"
              ? Math.max(2, Math.ceil((t1 - t0) / (Math.PI / 8)))
              : 16;
    for (const node of quadrature(t0, t1, panels)) {
        const d = curve.d1(node.t);
        const speed = d.vec.length();
        const values = monomials(d.point);
        for (let i = 0; i < values.length; i++) sum[i] += node.w * speed * values[i];
    }
    return sum;
}

function referencePoint(refs: readonly EntityRef[]): Vec3 {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const ref of refs) {
        const box = entityShape(ref).boundingBox();
        min[0] = Math.min(min[0], box.min.x);
        min[1] = Math.min(min[1], box.min.y);
        min[2] = Math.min(min[2], box.min.z);
        max[0] = Math.max(max[0], box.max.x);
        max[1] = Math.max(max[1], box.max.y);
        max[2] = Math.max(max[2], box.max.z);
    }
    return [0, 1, 2].map((k) => (Number.isFinite(min[k]) ? (min[k] + max[k]) / 2 : 0)) as Vec3;
}

/** Raw moments about `reference` (mm) → mass data in meters about the centroid. */
function fromRaw(raw: readonly number[], dimension: number, reference: Vec3): MassData {
    // Faces of a reversed shell (or a reversed face) integrate negative: orientation-free measures.
    const sign = raw[0] < 0 ? -1 : 1;
    const m = raw.map(
        (value, i) =>
            (sign * value) /
            MM_PER_METER ** (dimension + MONOMIALS[i][0] + MONOMIALS[i][1] + MONOMIALS[i][2]),
    );
    const measure = m[0];
    const local: Vec3 =
        measure === 0
            ? [0, 0, 0]
            : [m[index(1, 0, 0)] / measure, m[index(0, 1, 0)] / measure, m[index(0, 0, 1)] / measure];
    const centroid = local.map((c, k) => c + reference[k] / MM_PER_METER) as Vec3;
    /** ∫ (x - cx)^a (y - cy)^b (z - cz)^c by binomial expansion of the raw moments. */
    const central = (a: number, b: number, c: number) => {
        let sum = 0;
        for (let i = 0; i <= a; i++)
            for (let j = 0; j <= b; j++)
                for (let k = 0; k <= c; k++)
                    sum +=
                        binomial(a, i) *
                        binomial(b, j) *
                        binomial(c, k) *
                        (-local[0]) ** (a - i) *
                        (-local[1]) ** (b - j) *
                        (-local[2]) ** (c - k) *
                        m[index(i, j, k)];
        return sum;
    };
    const exponent = (axes: number[]) =>
        [0, 1, 2].map((axis) => axes.filter((a) => a === axis).length) as [number, number, number];
    const second = [0, 1, 2].map((i) => [0, 1, 2].map((j) => central(...exponent([i, j]))));
    const thirdMoments = new Map<string, number>();
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            for (let k = 0; k < 3; k++) {
                const key = exponent([i, j, k]).join();
                if (!thirdMoments.has(key)) thirdMoments.set(key, central(...exponent([i, j, k])));
            }
    const third = (a: Vec3, b: Vec3, c: Vec3) => {
        let sum = 0;
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++)
                for (let k = 0; k < 3; k++)
                    sum += a[i] * b[j] * c[k] * (thirdMoments.get(exponent([i, j, k]).join()) ?? 0);
        return sum;
    };
    return { dimension, measure, centroid, second, third };
}

function binomial(n: number, k: number): number {
    let result = 1;
    for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
    return result;
}

/** The inertia tensor of central second moments S: tr(S) E - S. */
export function inertiaTensor(second: readonly (readonly number[])[]): number[][] {
    const trace = second[0][0] + second[1][1] + second[2][2];
    return [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? trace : 0) - second[i][j]));
}

/** Eigen-decomposition of a symmetric 3x3 matrix (Jacobi): ascending values, unit vectors (columns of a rotation). */
export function symmetricEigen(matrix: readonly (readonly number[])[]): {
    values: number[];
    vectors: Vec3[];
} {
    const a = matrix.map((row) => [...row]);
    const v = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
    ];
    for (let sweep = 0; sweep < 50; sweep++) {
        const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
        if (off < 1e-300) break;
        for (const [p, q] of [
            [0, 1],
            [0, 2],
            [1, 2],
        ]) {
            if (Math.abs(a[p][q]) < 1e-300) continue;
            const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            for (let k = 0; k < 3; k++) {
                const akp = a[k][p];
                const akq = a[k][q];
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for (let k = 0; k < 3; k++) {
                const apk = a[p][k];
                const aqk = a[q][k];
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = v[k][p];
                const vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq;
                v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    const order = [0, 1, 2].sort((x, y) => a[x][x] - a[y][y]);
    const vectors = order.map((j) => [v[0][j], v[1][j], v[2][j]] as Vec3);
    // A right-handed frame.
    const [e0, e1] = vectors;
    vectors[2] = [
        e0[1] * e1[2] - e0[2] * e1[1],
        e0[2] * e1[0] - e0[0] * e1[2],
        e0[0] * e1[1] - e0[1] * e1[0],
    ];
    return { values: order.map((j) => a[j][j]), vectors };
}
