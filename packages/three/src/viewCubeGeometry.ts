// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Vector3 } from "three";

export interface CubeRegion {
    name: string;
    kind: "face" | "edge" | "corner";
    normal: Vector3;
    vertices: Vector3[];
    up?: Vector3;
}

const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const names = [
    ["Left", "Right"],
    ["Front", "Back"],
    ["Bottom", "Top"],
];
const bevel = 0.78;

/** A chamfered cube: six face targets, twelve edges, and eight corners. */
export function createCubeRegions(): CubeRegion[] {
    const regions: CubeRegion[] = [];
    for (let axis = 0; axis < 3; axis++) {
        for (const sign of [-1, 1]) {
            const normal = axes[axis].clone().multiplyScalar(sign);
            const up = axis === 2 ? new Vector3(0, sign, 0) : new Vector3(0, 0, 1);
            const right = up.clone().cross(normal);
            regions.push({
                name: names[axis][(sign + 1) / 2],
                kind: "face",
                normal,
                up,
                vertices: [
                    [-1, -1],
                    [1, -1],
                    [1, 1],
                    [-1, 1],
                ].map(([x, y]) =>
                    normal
                        .clone()
                        .addScaledVector(right, x * bevel)
                        .addScaledVector(up, y * bevel),
                ),
            });
        }
    }
    for (let free = 0; free < 3; free++) {
        const a = (free + 1) % 3;
        const b = (free + 2) % 3;
        for (const sa of [-1, 1])
            for (const sb of [-1, 1]) {
                const normal = axes[a].clone().multiplyScalar(sa).addScaledVector(axes[b], sb);
                const point = (x: number, y: number, z: number) =>
                    axes[a]
                        .clone()
                        .multiplyScalar(x * sa)
                        .addScaledVector(axes[b], y * sb)
                        .addScaledVector(axes[free], z * bevel);
                regions.push({
                    name: `${names[a][(sa + 1) / 2]} ${names[b][(sb + 1) / 2]}`,
                    kind: "edge",
                    normal,
                    vertices: [
                        point(1, bevel, -1),
                        point(bevel, 1, -1),
                        point(bevel, 1, 1),
                        point(1, bevel, 1),
                    ],
                });
            }
    }
    for (const x of [-1, 1])
        for (const y of [-1, 1])
            for (const z of [-1, 1]) {
                regions.push({
                    name: `${names[2][(z + 1) / 2]} ${names[1][(y + 1) / 2]} ${names[0][(x + 1) / 2]}`,
                    kind: "corner",
                    normal: new Vector3(x, y, z),
                    vertices: [
                        new Vector3(x, y * bevel, z * bevel),
                        new Vector3(x * bevel, y, z * bevel),
                        new Vector3(x * bevel, y * bevel, z),
                    ],
                });
            }
    return regions;
}
