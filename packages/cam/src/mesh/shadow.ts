// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { offset, type Point2 } from "../geometry2d";
import { Cutter } from "./cutter";
import { DropCutter } from "./dropCutter";
import { HeightField } from "./heightField";
import { TriangleIndex } from "./triangleIndex";
import type { Yielder } from "./yielder";

/**
 * The XY shadow (silhouette) of a mesh, grown by `grow`: the set of points within `grow` of
 * some triangle's projection, traced as the level set "a flat cutter of radius `grow` touches
 * anything" of its drop height field, crossings placed to the tolerance. With `grow` at least
 * the grid spacing no part of the shadow falls between grid nodes; the result is
 * shadow ⊕ grow exactly (to the tolerance), and `offset` by −grow gives the shadow closed
 * over gaps narrower than 2·grow.
 *
 * (A union of the projected triangles would be exact, but a polygon union of 100k triangles
 * is neither fast nor robust enough here.)
 */
export async function grownShadow(
    index: TriangleIndex,
    grow: number,
    spacing: number,
    tolerance: number,
    yielder?: Yielder,
): Promise<Point2[][]> {
    if (index.count === 0) return [];
    const drop = new DropCutter(index, Cutter.flat(Math.max(grow, spacing)));
    const field = await HeightField.build(
        drop,
        { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity },
        spacing,
        yielder,
    );
    // Any contact stands at or above the lowest vertex.
    return field.contours(index.min[2] - 1, tolerance, yielder);
}

/** The shadow grown by `delta` (shrunk when negative), on a grid of `spacing`. */
export async function shadowRegion(
    index: TriangleIndex,
    delta: number,
    spacing: number,
    tolerance: number,
    yielder?: Yielder,
): Promise<Point2[][]> {
    const grow = Math.max(spacing, Math.min(Math.max(delta, 0), 4 * spacing));
    const grown = await grownShadow(index, grow, spacing, tolerance, yielder);
    return Math.abs(delta - grow) < 1e-12 ? grown : offset(grown, delta - grow, { tolerance: tolerance / 2 });
}

/** A triangle index over face meshes (flat xyz positions + indices each). */
export function indexOfMeshes(
    meshes: readonly { readonly position: ArrayLike<number>; readonly index: ArrayLike<number> }[],
): TriangleIndex {
    let vertices = 0;
    let triangles = 0;
    for (const mesh of meshes) {
        vertices += mesh.position.length / 3;
        triangles += Math.floor(mesh.index.length / 3);
    }
    const positions = new Float64Array(vertices * 3);
    const indices = new Uint32Array(triangles * 3);
    let v = 0;
    let t = 0;
    for (const mesh of meshes) {
        for (let k = 0; k < mesh.position.length; k++) positions[v * 3 + k] = mesh.position[k];
        for (let k = 0; k + 2 < mesh.index.length; k += 3) {
            indices[t++] = mesh.index[k] + v;
            indices[t++] = mesh.index[k + 1] + v;
            indices[t++] = mesh.index[k + 2] + v;
        }
        v += mesh.position.length / 3;
    }
    return new TriangleIndex(positions, indices);
}
