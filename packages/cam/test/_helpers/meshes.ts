// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamMesh } from "../../src";

/** An indexed triangle mesh in double precision (tests compare against closed forms). */
export interface TestMesh {
    readonly positions: Float64Array;
    readonly indices: Uint32Array;
}

class MeshBuilder {
    readonly positions: number[] = [];
    readonly indices: number[] = [];

    vertex(x: number, y: number, z: number): number {
        this.positions.push(x, y, z);
        return this.positions.length / 3 - 1;
    }

    triangle(a: number, b: number, c: number): void {
        this.indices.push(a, b, c);
    }

    quad(a: number, b: number, c: number, d: number): void {
        this.triangle(a, b, c);
        this.triangle(a, c, d);
    }

    build(): TestMesh {
        return { positions: new Float64Array(this.positions), indices: new Uint32Array(this.indices) };
    }
}

/** A square grid of `n`×`n` cells at height z, centred on the origin. */
export function planeMesh(z: number, size: number, n = 4): TestMesh {
    const builder = new MeshBuilder();
    const ids: number[] = [];
    for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
            ids.push(builder.vertex(-size / 2 + (size * i) / n, -size / 2 + (size * j) / n, z));
        }
    }
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const a = ids[j * (n + 1) + i];
            builder.quad(a, a + 1, a + n + 2, a + n + 1);
        }
    }
    return builder.build();
}

/** The upper half of a sphere of radius `radius` centred at (cx, cy, cz): `segments` around, `rings` up. */
export function hemisphereMesh(
    radius: number,
    segments: number,
    rings: number,
    center = [0, 0, 0],
): TestMesh {
    const builder = new MeshBuilder();
    const [cx, cy, cz] = center;
    const rows: number[][] = [];
    for (let j = 0; j < rings; j++) {
        const phi = (Math.PI / 2) * (j / rings);
        const row: number[] = [];
        for (let i = 0; i < segments; i++) {
            const theta = (2 * Math.PI * i) / segments;
            row.push(
                builder.vertex(
                    cx + radius * Math.cos(phi) * Math.cos(theta),
                    cy + radius * Math.cos(phi) * Math.sin(theta),
                    cz + radius * Math.sin(phi),
                ),
            );
        }
        rows.push(row);
    }
    const pole = builder.vertex(cx, cy, cz + radius);
    for (let j = 0; j + 1 < rings; j++) {
        for (let i = 0; i < segments; i++) {
            const k = (i + 1) % segments;
            builder.quad(rows[j][i], rows[j][k], rows[j + 1][k], rows[j + 1][i]);
        }
    }
    for (let i = 0; i < segments; i++)
        builder.triangle(rows[rings - 1][i], rows[rings - 1][(i + 1) % segments], pole);
    return builder.build();
}

/** A closed cylinder of radius `radius` on the XY plane from z0 to z1, with `segments` sides. */
export function cylinderMesh(
    radius: number,
    z0: number,
    z1: number,
    segments: number,
    center = [0, 0],
): TestMesh {
    const builder = new MeshBuilder();
    const bottom: number[] = [];
    const top: number[] = [];
    for (let i = 0; i < segments; i++) {
        const theta = (2 * Math.PI * i) / segments;
        const x = center[0] + radius * Math.cos(theta);
        const y = center[1] + radius * Math.sin(theta);
        bottom.push(builder.vertex(x, y, z0));
        top.push(builder.vertex(x, y, z1));
    }
    const cb = builder.vertex(center[0], center[1], z0);
    const ct = builder.vertex(center[0], center[1], z1);
    for (let i = 0; i < segments; i++) {
        const k = (i + 1) % segments;
        builder.quad(bottom[i], bottom[k], top[k], top[i]);
        builder.triangle(ct, top[i], top[k]);
        builder.triangle(cb, bottom[k], bottom[i]);
    }
    return builder.build();
}

/** An axis-aligned box. */
export function boxMesh(min: readonly number[], max: readonly number[]): TestMesh {
    const builder = new MeshBuilder();
    const v = (i: number) =>
        builder.vertex(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]);
    const c = [0, 1, 2, 3, 4, 5, 6, 7].map(v);
    builder.quad(c[0], c[2], c[3], c[1]); // bottom
    builder.quad(c[4], c[5], c[7], c[6]); // top
    builder.quad(c[0], c[1], c[5], c[4]); // -y
    builder.quad(c[2], c[6], c[7], c[3]); // +y
    builder.quad(c[0], c[4], c[6], c[2]); // -x
    builder.quad(c[1], c[3], c[7], c[5]); // +x
    return builder.build();
}

/** A convex XZ profile (counter-clockwise seen from −y) extruded from y0 to y1. */
export function extrudeXZ(profile: readonly (readonly [number, number])[], y0: number, y1: number): TestMesh {
    const builder = new MeshBuilder();
    const front = profile.map(([x, z]) => builder.vertex(x, y0, z));
    const back = profile.map(([x, z]) => builder.vertex(x, y1, z));
    const n = profile.length;
    for (let i = 0; i < n; i++) builder.quad(front[i], front[(i + 1) % n], back[(i + 1) % n], back[i]);
    for (let i = 1; i + 1 < n; i++) {
        builder.triangle(front[0], front[i + 1], front[i]);
        builder.triangle(back[0], back[i], back[i + 1]);
    }
    return builder.build();
}

/** Several meshes as one. */
export function mergeMeshes(...meshes: TestMesh[]): TestMesh {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const mesh of meshes) {
        const base = positions.length / 3;
        for (const value of mesh.positions) positions.push(value);
        for (const i of mesh.indices) indices.push(i + base);
    }
    return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

/** The mesh as the single-precision `CamMesh` an operation context hands out. */
export function toCamMesh(mesh: TestMesh): CamMesh {
    return { positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) };
}
