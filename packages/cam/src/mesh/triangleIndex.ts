// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamMesh } from "../model/operation";

/**
 * The triangles of a part mesh as flat Float64 arrays plus an XY bounding-volume hierarchy
 * over them, for the 3-axis strategies' cutter queries (drop-cutter, height fields).
 *
 * Triangles are reordered so every BVH leaf is a contiguous range of the arrays. Degenerate
 * (zero-area) triangles are dropped. The tree splits on the longer XY extent at the centroid
 * median: queries are vertical columns (a cutter footprint), and each node keeps its full 3D
 * box so drop queries prune by `maxZ` (branch and bound on the best height found so far).
 */
export class TriangleIndex {
    readonly count: number;
    /** 9 per triangle: ax ay az bx by bz cx cy cz. */
    readonly vertices: Float64Array;
    /** 4 per triangle: the unit normal turned to nz ≥ 0, then the plane constant n·a. */
    readonly planes: Float64Array;
    /** 6 per triangle: minX minY minZ maxX maxY maxZ. */
    readonly bounds: Float64Array;
    /**
     * Per triangle, which of its vertices (bits 0–2: a, b, c) and edges (bits 3–5: ab, bc, ca)
     * it tests: each shared vertex and edge belongs to one triangle, so a drop tests it once.
     * (Valid with pruning: an owner's box contains its vertices and edges.)
     */
    readonly owns: Uint8Array;
    /** 6 per node, as `bounds`. */
    readonly nodeBounds: Float64Array;
    /** Leaf: the first triangle; inner node: the right child (the left child is the next node). */
    readonly nodeFirst: Int32Array;
    /** Leaf: its triangle count (> 0); inner node: 0. */
    readonly nodeCount: Int32Array;
    readonly nodeTotal: number;
    /** Bounds of the whole mesh (Infinity / -Infinity when empty). */
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];

    constructor(positions: ArrayLike<number>, indices?: ArrayLike<number>) {
        const triangleTotal = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);
        const raw = new Float64Array(triangleTotal * 9);
        let kept = 0;
        for (let t = 0; t < triangleTotal; t++) {
            const o = kept * 9;
            for (let k = 0; k < 3; k++) {
                const vertex = indices ? indices[t * 3 + k] : t * 3 + k;
                raw[o + k * 3] = positions[vertex * 3];
                raw[o + k * 3 + 1] = positions[vertex * 3 + 1];
                raw[o + k * 3 + 2] = positions[vertex * 3 + 2];
            }
            const ux = raw[o + 3] - raw[o];
            const uy = raw[o + 4] - raw[o + 1];
            const uz = raw[o + 5] - raw[o + 2];
            const vx = raw[o + 6] - raw[o];
            const vy = raw[o + 7] - raw[o + 1];
            const vz = raw[o + 8] - raw[o + 2];
            const cx = uy * vz - uz * vy;
            const cy = uz * vx - ux * vz;
            const cz = ux * vy - uy * vx;
            const scale = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz);
            if (cx * cx + cy * cy + cz * cz > 1e-24 * scale * scale && Number.isFinite(cx + cy + cz)) kept++;
        }
        this.count = kept;
        const n = kept;
        const centroids = new Float64Array(n * 2);
        for (let t = 0; t < n; t++) {
            const o = t * 9;
            centroids[t * 2] = (raw[o] + raw[o + 3] + raw[o + 6]) / 3;
            centroids[t * 2 + 1] = (raw[o + 1] + raw[o + 4] + raw[o + 7]) / 3;
        }
        const order = new Int32Array(n);
        for (let t = 0; t < n; t++) order[t] = t;
        const maxNodes = Math.max(1, n);
        this.nodeBounds = new Float64Array(maxNodes * 6);
        this.nodeFirst = new Int32Array(maxNodes);
        this.nodeCount = new Int32Array(maxNodes);
        const triBounds = new Float64Array(n * 6);
        for (let t = 0; t < n; t++) {
            const o = t * 9;
            const b = t * 6;
            triBounds[b] = Math.min(raw[o], raw[o + 3], raw[o + 6]);
            triBounds[b + 1] = Math.min(raw[o + 1], raw[o + 4], raw[o + 7]);
            triBounds[b + 2] = Math.min(raw[o + 2], raw[o + 5], raw[o + 8]);
            triBounds[b + 3] = Math.max(raw[o], raw[o + 3], raw[o + 6]);
            triBounds[b + 4] = Math.max(raw[o + 1], raw[o + 4], raw[o + 7]);
            triBounds[b + 5] = Math.max(raw[o + 2], raw[o + 5], raw[o + 8]);
        }
        this.nodeTotal = n === 0 ? 0 : this.build(order, centroids, triBounds);

        this.vertices = new Float64Array(n * 9);
        this.planes = new Float64Array(n * 4);
        this.bounds = new Float64Array(n * 6);
        for (let t = 0; t < n; t++) {
            const src = order[t];
            this.vertices.set(raw.subarray(src * 9, src * 9 + 9), t * 9);
            this.bounds.set(triBounds.subarray(src * 6, src * 6 + 6), t * 6);
            const o = t * 9;
            const v = this.vertices;
            const ux = v[o + 3] - v[o];
            const uy = v[o + 4] - v[o + 1];
            const uz = v[o + 5] - v[o + 2];
            const vx = v[o + 6] - v[o];
            const vy = v[o + 7] - v[o + 1];
            const vz = v[o + 8] - v[o + 2];
            let nx = uy * vz - uz * vy;
            let ny = uz * vx - ux * vz;
            let nz = ux * vy - uy * vx;
            const length = Math.hypot(nx, ny, nz);
            nx /= length;
            ny /= length;
            nz /= length;
            if (nz < 0) {
                nx = -nx;
                ny = -ny;
                nz = -nz;
            }
            const p = t * 4;
            this.planes[p] = nx;
            this.planes[p + 1] = ny;
            this.planes[p + 2] = nz;
            this.planes[p + 3] = nx * v[o] + ny * v[o + 1] + nz * v[o + 2];
        }
        this.owns = ownership(this.vertices, n);
        if (n === 0) {
            this.min = [Infinity, Infinity, Infinity];
            this.max = [-Infinity, -Infinity, -Infinity];
        } else {
            const b = this.nodeBounds;
            this.min = [b[0], b[1], b[2]];
            this.max = [b[3], b[4], b[5]];
        }
    }

    static fromMesh(mesh: CamMesh): TriangleIndex {
        return new TriangleIndex(mesh.positions, mesh.indices);
    }

    /** Builds the tree over `order[0..n)`, returning the node count. */
    private build(order: Int32Array, centroids: Float64Array, triBounds: Float64Array): number {
        let next = 0;
        const build = (lo: number, hi: number): number => {
            const node = next++;
            const nb = node * 6;
            let minX = Infinity;
            let minY = Infinity;
            let minZ = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            let maxZ = -Infinity;
            let cMinX = Infinity;
            let cMinY = Infinity;
            let cMaxX = -Infinity;
            let cMaxY = -Infinity;
            for (let k = lo; k < hi; k++) {
                const t = order[k];
                const b = t * 6;
                if (triBounds[b] < minX) minX = triBounds[b];
                if (triBounds[b + 1] < minY) minY = triBounds[b + 1];
                if (triBounds[b + 2] < minZ) minZ = triBounds[b + 2];
                if (triBounds[b + 3] > maxX) maxX = triBounds[b + 3];
                if (triBounds[b + 4] > maxY) maxY = triBounds[b + 4];
                if (triBounds[b + 5] > maxZ) maxZ = triBounds[b + 5];
                const cx = centroids[t * 2];
                const cy = centroids[t * 2 + 1];
                if (cx < cMinX) cMinX = cx;
                if (cx > cMaxX) cMaxX = cx;
                if (cy < cMinY) cMinY = cy;
                if (cy > cMaxY) cMaxY = cy;
            }
            const nodeBounds = this.nodeBounds;
            nodeBounds[nb] = minX;
            nodeBounds[nb + 1] = minY;
            nodeBounds[nb + 2] = minZ;
            nodeBounds[nb + 3] = maxX;
            nodeBounds[nb + 4] = maxY;
            nodeBounds[nb + 5] = maxZ;
            if (hi - lo <= LEAF_SIZE) {
                this.nodeFirst[node] = lo;
                this.nodeCount[node] = hi - lo;
                return node;
            }
            const axis = cMaxX - cMinX >= cMaxY - cMinY ? 0 : 1;
            const mid = (lo + hi) >> 1;
            selectNth(order, centroids, axis, lo, hi - 1, mid);
            build(lo, mid);
            this.nodeFirst[node] = build(mid, hi);
            this.nodeCount[node] = 0;
            return node;
        };
        build(0, order.length);
        return next;
    }

    /** Triangles whose XY box overlaps the rectangle, calling `visit` with each index. */
    forEachInRect(minX: number, minY: number, maxX: number, maxY: number, visit: (t: number) => void): void {
        if (this.nodeTotal === 0) return;
        const stack = new Int32Array(128);
        let top = 0;
        stack[top++] = 0;
        const nb = this.nodeBounds;
        const tb = this.bounds;
        while (top > 0) {
            const node = stack[--top];
            const o = node * 6;
            if (nb[o] > maxX || nb[o + 3] < minX || nb[o + 1] > maxY || nb[o + 4] < minY) continue;
            const count = this.nodeCount[node];
            if (count > 0) {
                const first = this.nodeFirst[node];
                for (let t = first; t < first + count; t++) {
                    const b = t * 6;
                    if (tb[b] > maxX || tb[b + 3] < minX || tb[b + 1] > maxY || tb[b + 4] < minY) continue;
                    visit(t);
                }
            } else {
                stack[top++] = this.nodeFirst[node];
                stack[top++] = node + 1;
            }
        }
    }
}

const LEAF_SIZE = 4;

/** Quickselect: puts the element of rank `nth` (by centroid on `axis`) at `nth`, smaller ones before. */
function selectNth(
    order: Int32Array,
    centroids: Float64Array,
    axis: number,
    lo: number,
    hi: number,
    nth: number,
) {
    while (hi > lo) {
        const pivot = centroids[order[(lo + hi) >> 1] * 2 + axis];
        let i = lo;
        let j = hi;
        while (i <= j) {
            while (centroids[order[i] * 2 + axis] < pivot) i++;
            while (centroids[order[j] * 2 + axis] > pivot) j--;
            if (i <= j) {
                const swap = order[i];
                order[i] = order[j];
                order[j] = swap;
                i++;
                j--;
            }
        }
        if (nth <= j) hi = j;
        else if (nth >= i) lo = i;
        else return;
    }
}

/** See `TriangleIndex.owns`: vertices welded on exact coordinates, edges on welded ends. */
function ownership(vertices: Float64Array, n: number): Uint8Array {
    const owns = new Uint8Array(n);
    let capacity = 16;
    while (capacity < n * 6) capacity *= 2;
    const mask = capacity - 1;
    const bits = new Float64Array(1);
    const words = new Uint32Array(bits.buffer);
    const mix = (h: number, value: number) => {
        bits[0] = value + 0; // −0 → 0
        h = Math.imul(h ^ words[0], 0x9e3779b1);
        return Math.imul(h ^ words[1], 0x85ebca6b) ^ (h >>> 15);
    };
    const vertexTable = new Int32Array(capacity).fill(-1);
    const ids = new Int32Array(n * 3);
    const firstCorner: number[] = [];
    for (let c = 0; c < n * 3; c++) {
        const x = vertices[c * 3];
        const y = vertices[c * 3 + 1];
        const z = vertices[c * 3 + 2];
        let slot = mix(mix(mix(0x811c9dc5, x), y), z) & mask;
        for (;;) {
            const entry = vertexTable[slot];
            if (entry < 0) {
                vertexTable[slot] = firstCorner.length;
                ids[c] = firstCorner.length;
                firstCorner.push(c);
                owns[Math.floor(c / 3)] |= 1 << (c % 3);
                break;
            }
            const k = firstCorner[entry] * 3;
            if (vertices[k] === x && vertices[k + 1] === y && vertices[k + 2] === z) {
                ids[c] = entry;
                break;
            }
            slot = (slot + 1) & mask;
        }
    }
    const edgeMask = capacity * 2 - 1;
    const edgeTable = new Int32Array(capacity * 2).fill(-1);
    const edgeA = new Int32Array(n * 3);
    const edgeB = new Int32Array(n * 3);
    let edges = 0;
    for (let t = 0; t < n; t++) {
        for (let e = 0; e < 3; e++) {
            const p = ids[t * 3 + e];
            const q = ids[t * 3 + ((e + 1) % 3)];
            const a = p < q ? p : q;
            const b = p < q ? q : p;
            let slot = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca6b)) & edgeMask;
            for (;;) {
                const entry = edgeTable[slot];
                if (entry < 0) {
                    edgeTable[slot] = edges;
                    edgeA[edges] = a;
                    edgeB[edges] = b;
                    edges++;
                    owns[t] |= 8 << e;
                    break;
                }
                if (edgeA[entry] === a && edgeB[entry] === b) break;
                slot = (slot + 1) & edgeMask;
            }
        }
    }
    return owns;
}
