// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { WeldedMesh } from "../geometry/mesh";
import { cleanPaths, FillRule, type Path, type Paths, SCALE, signedArea, union } from "../geometry/polygons";

/**
 * Cuts a welded mesh with horizontal planes into closed polygons.
 *
 * Every vertex is classified strictly above or not above the plane, so no vertex lies on it
 * and every crossing triangle has exactly two crossing edges. A crossing point is identified
 * by its (welded) edge, so the two triangles sharing an edge produce the same point and the
 * segments chain topologically, without distance tolerances. Segments are oriented by the
 * triangle's winding (outward normals give counter-clockwise outer loops and clockwise holes).
 * Chains a non-manifold mesh leaves open are joined end to end when their gaps are small;
 * what still does not close is dropped and reported.
 */

export interface LayerSliceResult {
    /** The cut region (outer loops CCW, holes CW), integer units. */
    readonly region: Paths;
    /** Chains that could not be closed (open mesh). */
    readonly openChains: number;
}

interface Segment {
    readonly from: number;
    readonly to: number;
    readonly fromPoint: readonly [number, number];
    readonly toPoint: readonly [number, number];
}

const GAP_CLOSE_MM = 0.05;

/** Slices at each z (ascending order is fastest; any order works). */
export function sliceMesh(mesh: WeldedMesh, zs: readonly number[]): LayerSliceResult[] {
    const v = mesh.vertices;
    const t = mesh.triangles;
    const triangleCount = t.length / 3;
    const zMin = new Float64Array(triangleCount);
    const zMax = new Float64Array(triangleCount);
    for (let i = 0; i < triangleCount; i++) {
        const za = v[t[i * 3] * 3 + 2];
        const zb = v[t[i * 3 + 1] * 3 + 2];
        const zc = v[t[i * 3 + 2] * 3 + 2];
        zMin[i] = Math.min(za, zb, zc);
        zMax[i] = Math.max(za, zb, zc);
    }
    const byMin = Array.from({ length: triangleCount }, (_, i) => i).sort((a, b) => zMin[a] - zMin[b]);
    const order = zs.map((z, i) => ({ z, i })).sort((a, b) => a.z - b.z);
    const results: LayerSliceResult[] = new Array(zs.length);
    let next = 0;
    let active: number[] = [];
    for (const { z, i } of order) {
        while (next < triangleCount && zMin[byMin[next]] <= z) active.push(byMin[next++]);
        active = active.filter((tri) => zMax[tri] > z);
        results[i] = sliceAt(mesh, active, z);
    }
    return results;
}

function sliceAt(mesh: WeldedMesh, triangles: readonly number[], z: number): LayerSliceResult {
    const v = mesh.vertices;
    const t = mesh.triangles;
    const vertexCount = v.length / 3;
    const segments: Segment[] = [];
    const corner = [0, 0, 0];
    for (const tri of triangles) {
        corner[0] = t[tri * 3];
        corner[1] = t[tri * 3 + 1];
        corner[2] = t[tri * 3 + 2];
        let down: [number, readonly [number, number]] | undefined;
        let up: [number, readonly [number, number]] | undefined;
        for (let k = 0; k < 3; k++) {
            const a = corner[k];
            const b = corner[(k + 1) % 3];
            const aAbove = v[a * 3 + 2] > z;
            const bAbove = v[b * 3 + 2] > z;
            if (aAbove === bAbove) continue;
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            const za = v[lo * 3 + 2];
            const zb = v[hi * 3 + 2];
            const s = (z - za) / (zb - za);
            const point: readonly [number, number] = [
                v[lo * 3] + s * (v[hi * 3] - v[lo * 3]),
                v[lo * 3 + 1] + s * (v[hi * 3 + 1] - v[lo * 3 + 1]),
            ];
            const key = lo * vertexCount + hi;
            if (aAbove) down = [key, point];
            else up = [key, point];
        }
        if (down === undefined || up === undefined || down[0] === up[0]) continue;
        segments.push({ from: down[0], to: up[0], fromPoint: down[1], toPoint: up[1] });
    }
    return chainSegments(segments);
}

function chainSegments(segments: readonly Segment[]): LayerSliceResult {
    const byFrom = new Map<number, number[]>();
    const byTo = new Map<number, number[]>();
    segments.forEach((segment, i) => {
        const from = byFrom.get(segment.from);
        if (from) from.push(i);
        else byFrom.set(segment.from, [i]);
        const to = byTo.get(segment.to);
        if (to) to.push(i);
        else byTo.set(segment.to, [i]);
    });
    const used = new Uint8Array(segments.length);
    const take = (list: number[] | undefined) => {
        if (!list) return -1;
        for (const index of list) if (!used[index]) return index;
        return -1;
    };
    const loops: (readonly [number, number])[][] = [];
    const open: (readonly [number, number])[][] = [];
    for (let start = 0; start < segments.length; start++) {
        if (used[start]) continue;
        used[start] = 1;
        const first = segments[start];
        const points: (readonly [number, number])[] = [first.fromPoint];
        let key = first.to;
        let point = first.toPoint;
        let closed = false;
        for (;;) {
            if (key === first.from) {
                closed = true;
                break;
            }
            points.push(point);
            let nextIndex = take(byFrom.get(key));
            if (nextIndex >= 0) {
                used[nextIndex] = 1;
                key = segments[nextIndex].to;
                point = segments[nextIndex].toPoint;
                continue;
            }
            // A flipped triangle: follow its segment backwards.
            nextIndex = take(byTo.get(key));
            if (nextIndex >= 0) {
                used[nextIndex] = 1;
                key = segments[nextIndex].from;
                point = segments[nextIndex].fromPoint;
                continue;
            }
            break;
        }
        if (closed) loops.push(points);
        else open.push(points);
    }
    const openChains = closeOpenChains(open, loops);
    const paths = cleanPaths(
        loops.map((loop) => loop.map(([x, y]) => ({ x: Math.round(x * SCALE), y: Math.round(y * SCALE) }))),
    );
    return { region: orientedUnion(paths), openChains };
}

/** Joins open chains whose ends meet within `GAP_CLOSE_MM`; returns how many stayed open. */
function closeOpenChains(
    open: (readonly [number, number])[][],
    loops: (readonly [number, number])[][],
): number {
    const gap = GAP_CLOSE_MM;
    const near = (a: readonly [number, number], b: readonly [number, number]) =>
        Math.hypot(a[0] - b[0], a[1] - b[1]) <= gap;
    const chains = open.map((chain) => [...chain]);
    let remaining = 0;
    while (chains.length > 0) {
        const chain = chains.pop() as (readonly [number, number])[];
        let grown = true;
        while (grown) {
            grown = false;
            if (chain.length > 2 && near(chain[chain.length - 1], chain[0])) break;
            for (let i = 0; i < chains.length; i++) {
                const other = chains[i];
                const end = chain[chain.length - 1];
                if (near(end, other[0])) chain.push(...other);
                else if (near(end, other[other.length - 1])) chain.push(...[...other].reverse());
                else continue;
                chains.splice(i, 1);
                grown = true;
                break;
            }
        }
        if (chain.length > 2 && near(chain[chain.length - 1], chain[0])) loops.push(chain);
        else remaining++;
    }
    return remaining;
}

/**
 * Unions the loops by winding. A mesh whose triangles all face inwards gives a negative total
 * area; its loops are reversed first, so inside-out meshes slice like proper ones.
 */
function orientedUnion(paths: Paths): Paths {
    let total = 0;
    for (const path of paths) total += signedArea(path);
    const oriented: Path[] = total < 0 ? paths.map((path) => [...path].reverse()) : paths;
    return union(oriented, [], FillRule.Positive);
}
