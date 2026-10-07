// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamMesh } from "../../model/operation";

/**
 * Triangle meshes for printing: welding (B-rep meshes repeat a vertex per face, a printable
 * mesh shares them), bounds, and placement on the bed.
 */

/** A welded triangle mesh: shared vertices (xyz triples, mm) and three indices per triangle. */
export interface WeldedMesh {
    readonly vertices: Float64Array;
    readonly triangles: Uint32Array;
}

export interface MeshBounds {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
}

/** Merges coincident vertices (on a `tolerance` mm grid) and drops collapsed triangles. */
export function weldMesh(mesh: CamMesh, tolerance = 1e-5): WeldedMesh {
    const vertices: number[] = [];
    const remap = new Map<string, number>();
    const scale = 1 / tolerance;
    const vertexCount = Math.floor(mesh.positions.length / 3);
    const local = new Int32Array(vertexCount).fill(-1);
    const indexOf = (i: number) => {
        if (local[i] >= 0) return local[i];
        const x = mesh.positions[i * 3];
        const y = mesh.positions[i * 3 + 1];
        const z = mesh.positions[i * 3 + 2];
        const key = `${Math.round(x * scale)},${Math.round(y * scale)},${Math.round(z * scale)}`;
        let index = remap.get(key);
        if (index === undefined) {
            index = vertices.length / 3;
            remap.set(key, index);
            vertices.push(x, y, z);
        }
        local[i] = index;
        return index;
    };
    const triangles: number[] = [];
    for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
        const a = indexOf(mesh.indices[t]);
        const b = indexOf(mesh.indices[t + 1]);
        const c = indexOf(mesh.indices[t + 2]);
        if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
    }
    return { vertices: Float64Array.from(vertices), triangles: Uint32Array.from(triangles) };
}

export function meshBounds(vertices: ArrayLike<number>): MeshBounds | undefined {
    if (vertices.length < 3) return undefined;
    const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (let i = 0; i + 2 < vertices.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const v = vertices[i + k];
            if (v < min[k]) min[k] = v;
            if (v > max[k]) max[k] = v;
        }
    }
    return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}

/** Signed volume (mm³) of a closed mesh; negative when its triangles face inwards. */
export function meshVolume(mesh: WeldedMesh): number {
    const v = mesh.vertices;
    let volume = 0;
    for (let t = 0; t < mesh.triangles.length; t += 3) {
        const a = mesh.triangles[t] * 3;
        const b = mesh.triangles[t + 1] * 3;
        const c = mesh.triangles[t + 2] * 3;
        volume +=
            v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
            v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
            v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
    }
    return volume / 6;
}

export function translateMesh(mesh: WeldedMesh, dx: number, dy: number, dz: number): WeldedMesh {
    const vertices = new Float64Array(mesh.vertices.length);
    for (let i = 0; i < vertices.length; i += 3) {
        vertices[i] = mesh.vertices[i] + dx;
        vertices[i + 1] = mesh.vertices[i + 1] + dy;
        vertices[i + 2] = mesh.vertices[i + 2] + dz;
    }
    return { vertices, triangles: mesh.triangles };
}

/**
 * Where parts go on the bed: `keep` leaves their XY as modelled (the WCS is the bed frame),
 * `center` moves their common bounding box to the bed centre, `auto` keeps them when they
 * fit on the bed with `margin` mm to spare (room for a skirt and brim) and centres them
 * otherwise. Parts always drop onto the bed (min z = 0).
 */
export type BedPlacement = "auto" | "keep" | "center";

export interface BedData {
    /** Bed rectangle in printer coordinates. */
    readonly min: readonly [number, number];
    readonly max: readonly [number, number];
    readonly maxHeight: number;
}

/** The translation that places meshes with these bounds on the bed. */
export function bedPlacement(
    bounds: MeshBounds,
    bed: BedData,
    placement: BedPlacement = "auto",
    margin = 0,
): readonly [number, number, number] {
    const dz = 0 - bounds.min[2];
    const fits =
        bounds.min[0] - margin >= bed.min[0] - 1e-6 &&
        bounds.min[1] - margin >= bed.min[1] - 1e-6 &&
        bounds.max[0] + margin <= bed.max[0] + 1e-6 &&
        bounds.max[1] + margin <= bed.max[1] + 1e-6;
    if (placement === "keep" || (placement === "auto" && fits)) return [0, 0, dz];
    const cx = (bed.min[0] + bed.max[0]) / 2 - (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bed.min[1] + bed.max[1]) / 2 - (bounds.min[1] + bounds.max[1]) / 2;
    return [cx, cy, dz];
}

/** Why placed meshes do not fit the printer, or undefined when they do. */
export function bedFitProblem(bounds: MeshBounds, bed: BedData): string | undefined {
    const tolerance = 1e-3;
    const size = (k: number) => (bounds.max[k] - bounds.min[k]).toFixed(1);
    if (
        bounds.min[0] < bed.min[0] - tolerance ||
        bounds.min[1] < bed.min[1] - tolerance ||
        bounds.max[0] > bed.max[0] + tolerance ||
        bounds.max[1] > bed.max[1] + tolerance
    ) {
        return `the parts (${size(0)} × ${size(1)} mm) do not fit on the ${bed.max[0] - bed.min[0]} × ${bed.max[1] - bed.min[1]} mm bed`;
    }
    if (bounds.max[2] > bed.maxHeight + tolerance) {
        return `the parts are ${size(2)} mm tall, the printer builds ${bed.maxHeight} mm`;
    }
    return undefined;
}
