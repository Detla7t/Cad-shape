// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Point2 } from "../geometry2d";
import type { DropCutter } from "./dropCutter";
import { simplifyClosed } from "./polyline";
import type { Yielder } from "./yielder";

/**
 * The cutter-location height field H(x, y) = drop(x, y) on a regular grid, and its level sets.
 *
 * A waterline at height z is the boundary of the region {H > z} — where a cutter with its tip
 * at z would cut into the part (the slice of the offset surface at z). `contours(z)` marches
 * the grid squares to find which grid edges cross the level and how they connect (saddles
 * decided by a drop at the cell centre), then places every crossing exactly by a 1D search
 * along the grid edge with real drops (a push of the cutter along that fiber), and finally
 * refines each chord where the true contour leaves it by more than the tolerance. Crossings
 * are reported on the safe side (H ≤ z) to within a quarter of the tolerance.
 *
 * Loops are closed and oriented with the forbidden region on their left: counter-clockwise
 * around material (islands), clockwise around pockets — the non-zero-rule polygon of the
 * region the cutter must not enter.
 */
export class HeightField {
    private constructor(
        readonly drop: DropCutter,
        readonly x0: number,
        readonly y0: number,
        readonly spacing: number,
        readonly nx: number,
        readonly ny: number,
        readonly z: Float64Array,
    ) {}

    /**
     * Drops the cutter on every grid node over `area`, grown so the border nodes are clear of
     * the mesh (the contours then always close).
     */
    static async build(
        drop: DropCutter,
        area: { minX: number; minY: number; maxX: number; maxY: number },
        spacing: number,
        yielder?: Yielder,
    ): Promise<HeightField> {
        const index = drop.index;
        const reach = drop.reach + 2 * spacing;
        const minX = Math.max(area.minX, index.min[0] - reach);
        const minY = Math.max(area.minY, index.min[1] - reach);
        const maxX = Math.min(area.maxX, index.max[0] + reach);
        const maxY = Math.min(area.maxY, index.max[1] + reach);
        const x0 = (Number.isFinite(minX) ? minX : 0) - spacing;
        const y0 = (Number.isFinite(minY) ? minY : 0) - spacing;
        const nx = Math.max(2, Math.ceil(((Number.isFinite(maxX) ? maxX : 0) + spacing - x0) / spacing) + 1);
        const ny = Math.max(2, Math.ceil(((Number.isFinite(maxY) ? maxY : 0) + spacing - y0) / spacing) + 1);
        const z = await drop.rasterize(x0, y0, spacing, nx, ny, yielder);
        return new HeightField(drop, x0, y0, spacing, nx, ny, z);
    }

    value(i: number, j: number): number {
        return this.z[j * this.nx + i];
    }

    /** The highest node value (−Infinity when the cutter touches nothing). */
    max(): number {
        let max = -Infinity;
        for (const value of this.z) if (value > max) max = value;
        return max;
    }

    /** See the class note. `tolerance` bounds the chord error of the loops. */
    async contours(level: number, tolerance: number, yielder?: Yielder): Promise<Point2[][]> {
        const { nx, ny, x0, y0, spacing } = this;
        const H = this.z;
        const zc = level + LEVEL_EPSILON;
        const horizontal = (nx - 1) * ny;
        const next = new Map<number, number>();
        const hEdge = (i: number, j: number) => j * (nx - 1) + i;
        const vEdge = (i: number, j: number) => horizontal + j * nx + i;
        for (let j = 0; j + 1 < ny; j++) {
            for (let i = 0; i + 1 < nx; i++) {
                const v0 = H[j * nx + i] > zc;
                const v1 = H[j * nx + i + 1] > zc;
                const v2 = H[(j + 1) * nx + i + 1] > zc;
                const v3 = H[(j + 1) * nx + i] > zc;
                const code = (v0 ? 1 : 0) | (v1 ? 2 : 0) | (v2 ? 4 : 0) | (v3 ? 8 : 0);
                if (code === 0 || code === 15) continue;
                const e0 = hEdge(i, j);
                const e1 = vEdge(i + 1, j);
                const e2 = hEdge(i, j + 1);
                const e3 = vEdge(i, j);
                if (code === 5 || code === 10) {
                    const center = this.drop.drop(x0 + (i + 0.5) * spacing, y0 + (j + 0.5) * spacing) > zc;
                    if (code === 5) {
                        if (center) {
                            next.set(e0, e1);
                            next.set(e2, e3);
                        } else {
                            next.set(e0, e3);
                            next.set(e2, e1);
                        }
                    } else if (center) {
                        next.set(e1, e2);
                        next.set(e3, e0);
                    } else {
                        next.set(e1, e0);
                        next.set(e3, e2);
                    }
                    continue;
                }
                // Walking the cell counter-clockwise, an inside → outside edge starts the
                // segment (inside on its left) and an outside → inside edge ends it.
                let start = -1;
                let end = -1;
                if (v0 && !v1) start = e0;
                else if (!v0 && v1) end = e0;
                if (v1 && !v2) start = e1;
                else if (!v1 && v2) end = e1;
                if (v2 && !v3) start = e2;
                else if (!v2 && v3) end = e2;
                if (v3 && !v0) start = e3;
                else if (!v3 && v0) end = e3;
                next.set(start, end);
            }
            await yielder?.tick();
        }

        const xtol = Math.min(tolerance / 4, spacing / 16);
        const crossings = new Map<number, Point2>();
        const crossingOf = (edge: number): Point2 => {
            const known = crossings.get(edge);
            if (known) return known;
            let i: number;
            let j: number;
            let di = 0;
            let dj = 0;
            if (edge < horizontal) {
                j = Math.floor(edge / (nx - 1));
                i = edge - j * (nx - 1);
                di = 1;
            } else {
                const k = edge - horizontal;
                j = Math.floor(k / nx);
                i = k - j * nx;
                dj = 1;
            }
            const ha = H[j * nx + i];
            const hb = H[(j + dj) * nx + i + di];
            const ax = x0 + i * spacing;
            const ay = y0 + j * spacing;
            const bx = ax + di * spacing;
            const by = ay + dj * spacing;
            const point =
                ha > zc
                    ? this.crossing(bx, by, hb - zc, ax, ay, ha - zc, zc, xtol)
                    : this.crossing(ax, ay, ha - zc, bx, by, hb - zc, zc, xtol);
            crossings.set(edge, point);
            return point;
        };

        const loops: Point2[][] = [];
        const visited = new Set<number>();
        for (const first of next.keys()) {
            if (visited.has(first)) continue;
            const loop: Point2[] = [];
            let edge: number | undefined = first;
            while (edge !== undefined && !visited.has(edge)) {
                visited.add(edge);
                loop.push(crossingOf(edge));
                edge = next.get(edge);
            }
            const refined = this.refine(loop, zc, tolerance, xtol);
            const simplified = simplifyClosed(dedupe(refined), tolerance / 4);
            if (simplified.length >= 3) loops.push(simplified);
            await yielder?.tick();
        }
        return loops;
    }

    /**
     * The level crossing between a (outside, fa = H − zc ≤ 0) and b (inside, fb > 0), on the
     * outside within `xtol`: Illinois regula falsi; once its estimates settle, a probe a hair
     * past the estimate closes the bracket (smooth surfaces take a handful of drops), and
     * every other step bisects after the sixth (a wall's step function).
     */
    crossing(
        ax: number,
        ay: number,
        fa: number,
        bx: number,
        by: number,
        fb: number,
        zc: number,
        xtol: number,
    ): Point2 {
        const length = Math.hypot(bx - ax, by - ay);
        const tol = xtol / Math.max(length, 1e-300);
        let sa = 0;
        let sb = 1;
        let side = 0;
        let previous = Number.NaN;
        const at = (s: number) => this.drop.drop(ax + (bx - ax) * s, ay + (by - ay) * s) - zc;
        const update = (s: number, f: number) => {
            if (f > 0) {
                sb = s;
                fb = f;
                if (side === 1) fa *= 0.5;
                side = 1;
            } else {
                sa = s;
                fa = f;
                if (side === -1) fb *= 0.5;
                side = -1;
            }
        };
        for (let iteration = 0; iteration < 80 && sb - sa > tol; iteration++) {
            const bisect = iteration >= 6 && iteration % 2 === 0;
            let s = bisect || !(fb - fa > 0) ? 0.5 * (sa + sb) : (sa * fb - sb * fa) / (fb - fa);
            if (!(s > sa && s < sb)) s = 0.5 * (sa + sb);
            const f = at(s);
            update(s, f);
            if (sb - sa <= tol) break;
            if (Math.abs(s - previous) < tol) {
                const probe = f > 0 ? s - 0.75 * tol : s + 0.75 * tol;
                if (probe > sa && probe < sb) update(probe, at(probe));
            }
            previous = s;
        }
        return [ax + (bx - ax) * sa, ay + (by - ay) * sa];
    }

    /** Inserts exact contour points where a chord strays from the contour by more than the tolerance. */
    private refine(loop: Point2[], zc: number, tolerance: number, xtol: number): Point2[] {
        if (loop.length < 2) return loop;
        const out: Point2[] = [];
        const visit = (a: Point2, b: Point2, depth: number) => {
            out.push(a);
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const length = Math.hypot(dx, dy);
            if (depth > 12 || length < 4 * xtol || length < tolerance) return;
            const nx = -dy / length;
            const ny = dx / length;
            const mx = 0.5 * (a[0] + b[0]);
            const my = 0.5 * (a[1] + b[1]);
            const reach = Math.max(0.75 * length, 4 * xtol);
            const ox = mx - nx * reach;
            const oy = my - ny * reach;
            const ix = mx + nx * reach;
            const iy = my + ny * reach;
            const fo = this.drop.drop(ox, oy) - zc;
            if (fo > 0) return;
            const fi = this.drop.drop(ix, iy) - zc;
            if (!(fi > 0)) return;
            const point = this.crossing(ox, oy, fo, ix, iy, fi, zc, xtol);
            if (Math.hypot(point[0] - mx, point[1] - my) <= tolerance / 2) return;
            out.pop();
            visit(a, point, depth + 1);
            visit(point, b, depth + 1);
        };
        // A chord of length L on a curve turning by θ per chord sags about L·θ / 8: chords
        // whose neighbours barely turn are left alone (most of a smooth contour), saving the
        // searches; corners and tight curves still get refined.
        const n = loop.length;
        const turn = loop.map((point, k) => {
            const prev = loop[(k + n - 1) % n];
            const next = loop[(k + 1) % n];
            const a = Math.atan2(point[1] - prev[1], point[0] - prev[0]);
            const b = Math.atan2(next[1] - point[1], next[0] - point[0]);
            const d = Math.abs(b - a);
            return d > Math.PI ? 2 * Math.PI - d : d;
        });
        for (let k = 0; k < n; k++) {
            const a = loop[k];
            const b = loop[(k + 1) % n];
            const sag = (Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.max(turn[k], turn[(k + 1) % n])) / 8;
            if (sag < tolerance / 8) out.push(a);
            else visit(a, b, 0);
        }
        return out;
    }
}

/** Nodes count as inside the level when H > level + LEVEL_EPSILON (a floor at the level is outside). */
export const LEVEL_EPSILON = 1e-6;

function dedupe(points: Point2[]): Point2[] {
    const out: Point2[] = [];
    for (const point of points) {
        const last = out[out.length - 1];
        if (!last || Math.abs(last[0] - point[0]) > 1e-9 || Math.abs(last[1] - point[1]) > 1e-9)
            out.push(point);
    }
    while (
        out.length > 1 &&
        Math.abs(out[0][0] - out[out.length - 1][0]) <= 1e-9 &&
        Math.abs(out[0][1] - out[out.length - 1][1]) <= 1e-9
    ) {
        out.pop();
    }
    return out;
}
