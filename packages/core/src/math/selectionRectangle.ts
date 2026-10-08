// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { XYLike } from "./xy";

/** Window selection encloses geometry; crossing selection intersects its projected segments/triangles. */
export class SelectionRectangle {
    readonly crossing: boolean;
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
    constructor(x1: number, y1: number, x2: number, y2: number) {
        this.crossing = x2 < x1;
        this.minX = Math.min(x1, x2);
        this.maxX = Math.max(x1, x2);
        this.minY = Math.min(y1, y2);
        this.maxY = Math.max(y1, y2);
    }
    contains(p: XYLike): boolean {
        return p.x >= this.minX && p.x <= this.maxX && p.y >= this.minY && p.y <= this.maxY;
    }
    segment(a: XYLike, b: XYLike): boolean {
        if (!this.crossing) return this.contains(a) && this.contains(b);
        let lo = 0,
            hi = 1;
        const dx = b.x - a.x,
            dy = b.y - a.y;
        for (const [p, q] of [
            [-dx, a.x - this.minX],
            [dx, this.maxX - a.x],
            [-dy, a.y - this.minY],
            [dy, this.maxY - a.y],
        ]) {
            if (p === 0) {
                if (q < 0) return false;
                continue;
            }
            const t = q / p;
            if (p < 0) lo = Math.max(lo, t);
            else hi = Math.min(hi, t);
            if (lo > hi) return false;
        }
        return true;
    }
    triangle(a: XYLike, b: XYLike, c: XYLike): boolean {
        if (!this.crossing) return [a, b, c].every((p) => this.contains(p));
        if (this.segment(a, b) || this.segment(b, c) || this.segment(c, a)) return true;
        const cross = (p: XYLike, q: XYLike, r: XYLike) =>
            (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        if (Math.abs(cross(a, b, c)) < 1e-10) return false;
        const corner = { x: this.minX, y: this.minY };
        const signs = [cross(a, b, corner), cross(b, c, corner), cross(c, a, corner)];
        return signs.every((x) => x >= 0) || signs.every((x) => x <= 0);
    }
}
