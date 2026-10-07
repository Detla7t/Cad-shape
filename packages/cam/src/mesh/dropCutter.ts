// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Cutter } from "./cutter";
import type { TriangleIndex } from "./triangleIndex";
import type { Yielder } from "./yielder";

/**
 * Drop-cutter (OpenCAMLib style): the lowest tip height at which a cutter standing at (x, y)
 * touches a triangle, from three contact tests — the facet's interior (the plane contact
 * point, if it falls inside the triangle), the three vertices and the three edges. Over a
 * triangle ∩ footprint the function "surface z − profile height" is concave (the profile is
 * convex), so its maximum is the facet contact or lies on an edge, where it is a concave 1D
 * maximization (`Cutter.edgeContact`: closed form for ball and flat, bisection otherwise).
 * The tests are exact for every profile; bisection converges to 1e-10 of the edge length.
 *
 * Whenever a test raises `best`, the touched point of the triangle is written to `CONTACT`.
 */
export function dropTriangle(
    index: TriangleIndex,
    t: number,
    x: number,
    y: number,
    cutter: Cutter,
    best: number,
): number {
    const bounds = index.bounds;
    const b = t * 6;
    if (bounds[b + 5] <= best) return best;
    const R = cutter.radius;
    // The cutter is at least h(distance to the box) above the tip over the triangle.
    const gx = bounds[b] > x ? bounds[b] - x : x > bounds[b + 3] ? x - bounds[b + 3] : 0;
    const gy = bounds[b + 1] > y ? bounds[b + 1] - y : y > bounds[b + 4] ? y - bounds[b + 4] : 0;
    const g2 = gx * gx + gy * gy;
    if (g2 > R * R) return best;
    if (g2 > 0 && bounds[b + 5] - cutter.height(Math.sqrt(g2)) <= best) return best;
    const v = index.vertices;
    const o = t * 9;
    const ax = v[o];
    const ay = v[o + 1];
    const az = v[o + 2];
    const bx = v[o + 3];
    const by = v[o + 4];
    const bz = v[o + 5];
    const cx = v[o + 6];
    const cy = v[o + 7];
    const cz = v[o + 8];

    // Facet.
    const planes = index.planes;
    const p = t * 4;
    const nz = planes[p + 2];
    if (nz > 1e-9) {
        const nx = planes[p];
        const ny = planes[p + 1];
        const nxy = Math.sqrt(nx * nx + ny * ny);
        let px = x;
        let py = y;
        let d = 0;
        if (nxy > 1e-12) {
            d = cutter.contactRadius(nxy / nz);
            px = x - (d * nx) / nxy;
            py = y - (d * ny) / nxy;
        }
        const e1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        const e2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
        const e3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
        if ((e1 >= 0 && e2 >= 0 && e3 >= 0) || (e1 <= 0 && e2 <= 0 && e3 <= 0)) {
            const surface = (planes[p + 3] - nx * px - ny * py) / nz;
            const z = surface - cutter.height(d);
            if (z > best) {
                best = z;
                CONTACT[0] = px;
                CONTACT[1] = py;
                CONTACT[2] = surface;
            }
        }
    }

    // Vertices and edges this triangle owns (shared ones are tested once, by one triangle).
    const owns = index.owns[t];
    const R2 = R * R;
    if (owns & 1 && az > best) {
        const d2 = (ax - x) * (ax - x) + (ay - y) * (ay - y);
        if (d2 <= R2) {
            const z = az - cutter.height(Math.sqrt(d2));
            if (z > best) {
                best = z;
                CONTACT[0] = ax;
                CONTACT[1] = ay;
                CONTACT[2] = az;
            }
        }
    }
    if (owns & 2 && bz > best) {
        const d2 = (bx - x) * (bx - x) + (by - y) * (by - y);
        if (d2 <= R2) {
            const z = bz - cutter.height(Math.sqrt(d2));
            if (z > best) {
                best = z;
                CONTACT[0] = bx;
                CONTACT[1] = by;
                CONTACT[2] = bz;
            }
        }
    }
    if (owns & 4 && cz > best) {
        const d2 = (cx - x) * (cx - x) + (cy - y) * (cy - y);
        if (d2 <= R2) {
            const z = cz - cutter.height(Math.sqrt(d2));
            if (z > best) {
                best = z;
                CONTACT[0] = cx;
                CONTACT[1] = cy;
                CONTACT[2] = cz;
            }
        }
    }

    if (owns & 8) best = dropEdge(x, y, cutter, ax, ay, az, bx, by, bz, best);
    if (owns & 16) best = dropEdge(x, y, cutter, bx, by, bz, cx, cy, cz, best);
    if (owns & 32) best = dropEdge(x, y, cutter, cx, cy, cz, ax, ay, az, best);
    return best;
}

function dropEdge(
    x: number,
    y: number,
    cutter: Cutter,
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    best: number,
): number {
    if (z1 <= best && z2 <= best) return best;
    const ex = x2 - x1;
    const ey = y2 - y1;
    const length2 = ex * ex + ey * ey;
    if (length2 < 1e-24) return best;
    const length = Math.sqrt(length2);
    const ux = ex / length;
    const uy = ey / length;
    const qx = x - x1;
    const qy = y - y1;
    const t0 = qx * ux + qy * uy;
    const d0 = Math.abs(qx * uy - qy * ux);
    const R = cutter.radius;
    if (d0 >= R) return best;
    const w = Math.sqrt(R * R - d0 * d0);
    const lo = t0 - w > 0 ? t0 - w : 0;
    const hi = t0 + w < length ? t0 + w : length;
    if (lo > hi) return best;
    const m = (z2 - z1) / length;
    // Upper bound: the higher end of the covered part, minus the least profile height.
    const zLo = z1 + m * lo;
    const zHi = z1 + m * hi;
    if ((zLo > zHi ? zLo : zHi) - cutter.height(d0) <= best) return best;
    const tc = cutter.edgeContact(t0, d0, m, lo, hi);
    const dt = tc - t0;
    const d = Math.sqrt(d0 * d0 + dt * dt);
    const z = z1 + m * tc - cutter.height(d < R ? d : R);
    if (z <= best) return best;
    CONTACT[0] = x1 + ux * tc;
    CONTACT[1] = y1 + uy * tc;
    CONTACT[2] = z1 + m * tc;
    return z;
}

/** The point of the mesh the last raising contact test touched (see `dropTriangle`). */
export const CONTACT = new Float64Array(3);

/** Upper bound of any contact in a node's box: its top less the profile height at its XY distance. */
function nodeBound(nb: Float64Array, node: number, x: number, y: number, cutter: Cutter): number {
    const o = node * 6;
    const gx = nb[o] > x ? nb[o] - x : x > nb[o + 3] ? x - nb[o + 3] : 0;
    const gy = nb[o + 1] > y ? nb[o + 1] - y : y > nb[o + 4] ? y - nb[o + 4] : 0;
    const g2 = gx * gx + gy * gy;
    if (g2 === 0) return nb[o + 5];
    if (g2 > cutter.radius * cutter.radius) return -Infinity;
    return nb[o + 5] - cutter.height(Math.sqrt(g2));
}

export interface DropCutterOptions {
    /** The height where the cutter touches nothing, and the lowest it goes (a floor). */
    readonly floor?: number;
    /** Added to every contact height: the axial stock to leave above an offset cutter. */
    readonly lift?: number;
    /** A flat holder disc `offset` above the tip, kept off the mesh too. */
    readonly holder?: { readonly radius: number; readonly offset: number };
}

export interface PathSampling {
    /** Largest distance between dropped points. */
    readonly sampling: number;
    /** Chord tolerance: where the path bends more, points are added. */
    readonly tolerance: number;
    /** Smallest distance between dropped points; steps finer than this become vertical. */
    readonly minSampling?: number;
}

/**
 * A cutter dropped on a triangle index: `drop(x, y)` is the cutter-location height (tip z)
 * there. Queries walk the BVH depth first, higher boxes first, skipping every box whose top
 * is below the best contact so far.
 */
export class DropCutter {
    readonly floor: number;
    readonly lift: number;
    private readonly holderCutter?: Cutter;
    private readonly holderOffset: number;
    private readonly stack = new Int32Array(256);
    /** Number of drop queries answered (a statistic). */
    drops = 0;

    constructor(
        readonly index: TriangleIndex,
        readonly cutter: Cutter,
        options: DropCutterOptions = {},
    ) {
        this.floor = options.floor ?? -Infinity;
        this.lift = options.lift ?? 0;
        this.holderOffset = options.holder?.offset ?? 0;
        if (options.holder && options.holder.radius > cutter.radius) {
            this.holderCutter = Cutter.flat(options.holder.radius);
        }
    }

    /** How far from the axis anything can touch the cutter or its holder. */
    get reach(): number {
        return Math.max(this.cutter.radius, this.holderCutter?.radius ?? 0);
    }

    /** Tip height of the cutter at (x, y): never below the floor. */
    drop(x: number, y: number): number {
        this.drops++;
        let z = this.dropWith(this.cutter, x, y, -Infinity) + this.lift;
        if (this.holderCutter) {
            const h = this.dropWith(this.holderCutter, x, y, z + this.holderOffset) - this.holderOffset;
            if (h > z) z = h;
        }
        return z > this.floor ? z : this.floor;
    }

    /**
     * The cutter's own contact (no floor, lift or holder) at (x, y): its tip height, or
     * −Infinity, with the touched mesh point written to `contact` (NaN when none).
     */
    dropContact(x: number, y: number, contact: Float64Array): number {
        this.drops++;
        CONTACT.fill(Number.NaN);
        const z = this.dropWith(this.cutter, x, y, -Infinity);
        contact.set(CONTACT);
        return z;
    }

    /** The raw contact height of one cutter (−Infinity when nothing is under it), above `best`. */
    dropWith(cutter: Cutter, x: number, y: number, best: number): number {
        const index = this.index;
        if (index.nodeTotal === 0) return best;
        const R = cutter.radius;
        const minX = x - R;
        const maxX = x + R;
        const minY = y - R;
        const maxY = y + R;
        const nb = index.nodeBounds;
        const first = index.nodeFirst;
        const counts = index.nodeCount;
        const stack = this.stack;
        let top = 0;
        stack[top++] = 0;
        const R2 = R * R;
        while (top > 0) {
            const node = stack[--top];
            const o = node * 6;
            if (nb[o + 5] <= best) continue;
            if (nb[o] > maxX || nb[o + 3] < minX || nb[o + 1] > maxY || nb[o + 4] < minY) continue;
            const gx = nb[o] > x ? nb[o] - x : x > nb[o + 3] ? x - nb[o + 3] : 0;
            const gy = nb[o + 1] > y ? nb[o + 1] - y : y > nb[o + 4] ? y - nb[o + 4] : 0;
            const g2 = gx * gx + gy * gy;
            if (g2 > R2) continue;
            if (g2 > 0 && nb[o + 5] - cutter.height(Math.sqrt(g2)) <= best) continue;
            const count = counts[node];
            if (count > 0) {
                const start = first[node];
                for (let t = start; t < start + count; t++) best = dropTriangle(index, t, x, y, cutter, best);
            } else {
                const left = node + 1;
                const right = first[node];
                // Visit the child with the higher bound first: it tightens `best` sooner.
                if (nodeBound(nb, left, x, y, cutter) > nodeBound(nb, right, x, y, cutter)) {
                    stack[top++] = right;
                    stack[top++] = left;
                } else {
                    stack[top++] = left;
                    stack[top++] = right;
                }
            }
        }
        return best;
    }

    /** `drop` on every node of the grid x0 + i·spacing, y0 + j·spacing (row-major, nx per row). */
    async rasterize(
        x0: number,
        y0: number,
        spacing: number,
        nx: number,
        ny: number,
        yielder?: Yielder,
    ): Promise<Float64Array> {
        const heights = new Float64Array(nx * ny);
        for (let j = 0; j < ny; j++) {
            const y = y0 + j * spacing;
            for (let i = 0; i < nx; i++) heights[j * nx + i] = this.drop(x0 + i * spacing, y);
            await yielder?.tick();
        }
        return heights;
    }

    /**
     * Cutter locations along the straight XY segment (x0, y0) → (x1, y1), as xyz triples.
     * Points are dropped every `sampling` and halved where the midpoint leaves the chord by
     * more than the tolerance; where that is still so at `minSampling` (a wall), the step is
     * made vertical on the lower side so the move never dips under the surface.
     */
    dropPath(x0: number, y0: number, x1: number, y1: number, options: PathSampling): number[] {
        const length = Math.hypot(x1 - x0, y1 - y0);
        const sampling = Math.max(options.sampling, 1e-6);
        const tolerance = Math.max(options.tolerance, 1e-6);
        const minSampling = Math.min(options.minSampling ?? tolerance / 4, sampling);
        const out: number[] = [];
        const n = Math.max(1, Math.ceil(length / sampling - 1e-9));
        const dx = x1 - x0;
        const dy = y1 - y0;
        let prevX = x0;
        let prevY = y0;
        let prevZ = this.drop(x0, y0);
        out.push(prevX, prevY, prevZ);
        const refine = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
            const span = Math.hypot(bx - ax, by - ay);
            if (span <= minSampling) {
                if (Math.abs(bz - az) > tolerance) {
                    if (bz > az) out.push(ax, ay, bz);
                    else out.push(bx, by, az);
                }
                return;
            }
            const mx = 0.5 * (ax + bx);
            const my = 0.5 * (ay + by);
            const mz = this.drop(mx, my);
            if (Math.abs(mz - 0.5 * (az + bz)) > tolerance) {
                refine(ax, ay, az, mx, my, mz);
                out.push(mx, my, mz);
                refine(mx, my, mz, bx, by, bz);
            } else {
                out.push(mx, my, mz);
            }
        };
        for (let i = 1; i <= n; i++) {
            const x = i === n ? x1 : x0 + (dx * i) / n;
            const y = i === n ? y1 : y0 + (dy * i) / n;
            const z = this.drop(x, y);
            refine(prevX, prevY, prevZ, x, y, z);
            out.push(x, y, z);
            prevX = x;
            prevY = y;
            prevZ = z;
        }
        return out;
    }

    /**
     * Whether the straight move a → b keeps the tip on or above the cutter-location surface,
     * checked every `step` (default an eighth of the cutter radius).
     */
    isClear(a: readonly number[], b: readonly number[], step?: number): boolean {
        const length = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.abs(b[2] - a[2]));
        const spacing = step ?? Math.max(this.cutter.radius / 8, 1e-3);
        const n = Math.max(1, Math.ceil(length / spacing));
        for (let i = 0; i <= n; i++) {
            const s = i / n;
            const x = a[0] + (b[0] - a[0]) * s;
            const y = a[1] + (b[1] - a[1]) * s;
            const z = a[2] + (b[2] - a[2]) * s;
            if (this.drop(x, y) > z + 1e-7) return false;
        }
        return true;
    }
}
