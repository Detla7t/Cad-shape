// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamMesh } from "../../src";

/**
 * Test meshes laid out the way B-rep triangulations come: every face carries its own copy of
 * its vertices (nothing shared), triangles counter-clockwise seen from outside.
 */

function meshFrom(triangles: number[][]): CamMesh {
    const positions = new Float32Array(triangles.flat());
    const indices = new Uint32Array(triangles.length * 3).map((_, i) => i);
    return { positions, indices };
}

const quad = (a: number[], b: number[], c: number[], d: number[]) => [
    [...a, ...b, ...c],
    [...a, ...c, ...d],
];

/** Axis-aligned box from (x0, y0, z0) to (x1, y1, z1). */
export function boxMesh(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): CamMesh {
    const p = (x: number, y: number, z: number) => [x, y, z];
    return meshFrom([
        ...quad(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)), // bottom (−z)
        ...quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)), // top (+z)
        ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)), // front (−y)
        ...quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)), // right (+x)
        ...quad(p(x1, y1, z0), p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1)), // back (+y)
        ...quad(p(x0, y1, z0), p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1)), // left (−x)
    ]);
}

/** Vertical cylinder around (cx, cy) from z0 to z1, `segments` facets. */
export function cylinderMesh(
    cx: number,
    cy: number,
    radius: number,
    z0: number,
    z1: number,
    segments = 64,
): CamMesh {
    const triangles: number[][] = [];
    const at = (k: number) => {
        const a = (2 * Math.PI * k) / segments;
        return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
    };
    for (let k = 0; k < segments; k++) {
        const [x0, y0] = at(k);
        const [x1, y1] = at(k + 1);
        triangles.push(...quad([x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1]));
        triangles.push([cx, cy, z0, x1, y1, z0, x0, y0, z0]);
        triangles.push([cx, cy, z1, x0, y0, z1, x1, y1, z1]);
    }
    return meshFrom(triangles);
}

/** Two meshes as one. */
export function mergeMeshes(...meshes: CamMesh[]): CamMesh {
    const positions = new Float32Array(meshes.reduce((n, m) => n + m.positions.length, 0));
    const indices = new Uint32Array(meshes.reduce((n, m) => n + m.indices.length, 0));
    let p = 0;
    let i = 0;
    for (const mesh of meshes) {
        positions.set(mesh.positions, p);
        for (let k = 0; k < mesh.indices.length; k++) indices[i + k] = mesh.indices[k] + p / 3;
        p += mesh.positions.length;
        i += mesh.indices.length;
    }
    return { positions, indices };
}
