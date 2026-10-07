// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IPoint64 } from "clipper2-js";

/**
 * Clipping open lines to a region, without clipper2-js: its open-path clipping (1.2.4) drops
 * diagonal and vertical lines and returns pieces outside the region. Regions here are clean
 * (outer loops and holes that do not overlap, as booleans return them), so even-odd crossing
 * parity decides inside. Edges are bucketed in horizontal bands for speed.
 */

type Pt = { readonly x: number; readonly y: number };

interface Edge {
    readonly ax: number;
    readonly ay: number;
    readonly bx: number;
    readonly by: number;
    readonly minY: number;
    readonly maxY: number;
    readonly minX: number;
    readonly maxX: number;
}

const BANDS = 64;

export class RegionIndex {
    private readonly edges: Edge[] = [];
    private readonly bands: number[][];
    private readonly y0: number;
    private readonly bandHeight: number;
    readonly empty: boolean;

    constructor(region: readonly (readonly Pt[])[]) {
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const path of region) {
            for (let i = 0; i < path.length; i++) {
                const a = path[i];
                const b = path[(i + 1) % path.length];
                if (a.x === b.x && a.y === b.y) continue;
                this.edges.push({
                    ax: a.x,
                    ay: a.y,
                    bx: b.x,
                    by: b.y,
                    minY: Math.min(a.y, b.y),
                    maxY: Math.max(a.y, b.y),
                    minX: Math.min(a.x, b.x),
                    maxX: Math.max(a.x, b.x),
                });
                minY = Math.min(minY, a.y);
                maxY = Math.max(maxY, a.y);
            }
        }
        this.empty = this.edges.length === 0;
        this.y0 = minY;
        this.bandHeight = Math.max(1e-9, (maxY - minY) / BANDS);
        this.bands = Array.from({ length: BANDS }, () => []);
        this.edges.forEach((edge, i) => {
            const first = this.band(edge.minY);
            const last = this.band(edge.maxY);
            for (let k = first; k <= last; k++) this.bands[k].push(i);
        });
    }

    private band(y: number): number {
        return Math.max(0, Math.min(BANDS - 1, Math.floor((y - this.y0) / this.bandHeight)));
    }

    /** Even-odd inside test (a ray towards +x). */
    contains(p: Pt): boolean {
        if (this.empty) return false;
        let inside = false;
        for (const i of this.bands[this.band(p.y)]) {
            const e = this.edges[i];
            if (e.ay > p.y !== e.by > p.y) {
                const x = e.ax + ((p.y - e.ay) * (e.bx - e.ax)) / (e.by - e.ay);
                if (p.x < x) inside = !inside;
            }
        }
        return inside;
    }

    /** Parameters t ∈ (0, 1) where segment a→b crosses the region's edges, sorted. */
    crossings(a: Pt, b: Pt): number[] {
        const ts: number[] = [];
        if (this.empty) return ts;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const segMinX = Math.min(a.x, b.x);
        const segMaxX = Math.max(a.x, b.x);
        const segMinY = Math.min(a.y, b.y);
        const segMaxY = Math.max(a.y, b.y);
        const seen = new Set<number>();
        for (let k = this.band(segMinY); k <= this.band(segMaxY); k++) {
            for (const i of this.bands[k]) {
                if (seen.has(i)) continue;
                seen.add(i);
                const e = this.edges[i];
                if (e.maxX < segMinX || e.minX > segMaxX || e.maxY < segMinY || e.minY > segMaxY) continue;
                const ex = e.bx - e.ax;
                const ey = e.by - e.ay;
                const denominator = dx * ey - dy * ex;
                if (denominator === 0) continue;
                const t = ((e.ax - a.x) * ey - (e.ay - a.y) * ex) / denominator;
                const u = ((e.ax - a.x) * dy - (e.ay - a.y) * dx) / denominator;
                if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
            }
        }
        return ts.sort((p, q) => p - q);
    }
}

const lerp = (a: Pt, b: Pt, t: number): IPoint64 => ({
    x: Math.round(a.x + (b.x - a.x) * t),
    y: Math.round(a.y + (b.y - a.y) * t),
});

/** The parts of polylines inside a region, as polylines (pieces joined across vertices). */
export function clipPolylines(lines: readonly (readonly Pt[])[], index: RegionIndex): IPoint64[][] {
    const out: IPoint64[][] = [];
    if (index.empty) return out;
    for (const line of lines) {
        let current: IPoint64[] | undefined;
        for (let i = 0; i + 1 < line.length; i++) {
            const a = line[i];
            const b = line[i + 1];
            if (a.x === b.x && a.y === b.y) continue;
            const ts = [0, ...index.crossings(a, b), 1];
            for (let k = 0; k + 1 < ts.length; k++) {
                const t0 = ts[k];
                const t1 = ts[k + 1];
                if (t1 - t0 < 1e-12) continue;
                const inside = index.contains({
                    x: a.x + (b.x - a.x) * ((t0 + t1) / 2),
                    y: a.y + (b.y - a.y) * ((t0 + t1) / 2),
                });
                if (!inside) {
                    if (current) out.push(current);
                    current = undefined;
                    continue;
                }
                const start = lerp(a, b, t0);
                const end = lerp(a, b, t1);
                const last = current?.[current.length - 1];
                if (current && (t0 === 0 || (last?.x === start.x && last?.y === start.y))) current.push(end);
                else {
                    if (current) out.push(current);
                    current = [start, end];
                }
            }
        }
        if (current) out.push(current);
    }
    return out.map(dedupe).filter((piece) => piece.length >= 2);
}

function dedupe(path: IPoint64[]): IPoint64[] {
    const out: IPoint64[] = [];
    for (const p of path) {
        const last = out[out.length - 1];
        if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
    }
    return out;
}

/**
 * Parallel scan lines through a region: lines at `angle` radians from +X, one every `pitch`
 * units at offsets `k · pitch + phase` (perpendicular distance from the origin), clipped
 * exactly (edge crossings along each line, paired by parity).
 */
export function scanLines(
    region: readonly (readonly Pt[])[],
    angle: number,
    pitch: number,
    phase: number,
): IPoint64[][] {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Rotate by −angle: lines become horizontal (v = const).
    const rotated = region.map((path) =>
        path.map((p) => ({ u: p.x * cos + p.y * sin, v: -p.x * sin + p.y * cos })),
    );
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const path of rotated) {
        for (const p of path) {
            minV = Math.min(minV, p.v);
            maxV = Math.max(maxV, p.v);
        }
    }
    const out: IPoint64[][] = [];
    if (!Number.isFinite(minV)) return out;
    const first = Math.ceil((minV - phase) / pitch);
    const last = Math.floor((maxV - phase) / pitch);
    const edges: { au: number; av: number; bu: number; bv: number }[] = [];
    for (const path of rotated) {
        for (let i = 0; i < path.length; i++) {
            const a = path[i];
            const b = path[(i + 1) % path.length];
            if (a.v !== b.v) edges.push({ au: a.u, av: a.v, bu: b.u, bv: b.v });
        }
    }
    edges.sort((p, q) => Math.min(p.av, p.bv) - Math.min(q.av, q.bv));
    const back = (u: number, v: number): IPoint64 => ({
        x: Math.round(u * cos - v * sin),
        y: Math.round(u * sin + v * cos),
    });
    for (let k = first; k <= last; k++) {
        const v = k * pitch + phase;
        const us: number[] = [];
        for (const e of edges) {
            if (Math.min(e.av, e.bv) > v) break;
            if (e.av > v !== e.bv > v) us.push(e.au + ((v - e.av) * (e.bu - e.au)) / (e.bv - e.av));
        }
        us.sort((p, q) => p - q);
        for (let i = 0; i + 1 < us.length; i += 2) {
            if (us[i + 1] - us[i] < 1) continue;
            out.push([back(us[i], v), back(us[i + 1], v)]);
        }
    }
    return out;
}

/** Whether the straight segment a→b lies inside the region (no edge crossing, midpoint in). */
export function segmentInside(index: RegionIndex, a: Pt, b: Pt): boolean {
    if (index.crossings(a, b).length > 0) return false;
    return index.contains({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
}
