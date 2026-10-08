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

/** Visible pieces of an axis in camera space (+Z faces the viewer), behind a convex cube. */
export function visibleCubeAxis(
    start: Vector3,
    end: Vector3,
    faces: readonly (readonly Vector3[])[],
): [Vector3, Vector3][] {
    const hidden: [number, number][] = [];
    for (const face of faces) {
        let lo = 0;
        let hi = 1;
        // Clip the axis parameter against a linear half-plane f(t) >= 0.
        const clip = (f0: number, f1: number) => {
            const delta = f1 - f0;
            if (Math.abs(delta) < 1e-10) return f0 >= 0;
            const t = -f0 / delta;
            if (delta > 0) lo = Math.max(lo, t);
            else hi = Math.min(hi, t);
            return lo < hi;
        };
        const area = face.reduce((sum, a, i) => {
            const b = face[(i + 1) % face.length];
            return sum + a.x * b.y - b.x * a.y;
        }, 0);
        if (Math.abs(area) < 1e-10) continue;
        const sign = Math.sign(area);
        const inside = face.every((a, i) => {
            const b = face[(i + 1) % face.length];
            const side = (p: Vector3) => sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
            return clip(side(start), side(end));
        });
        if (!inside) continue;
        const normal = face[1].clone().sub(face[0]).cross(face[2].clone().sub(face[0]));
        const depthBehind = (p: Vector3) =>
            (normal.dot(face[0]) - normal.x * p.x - normal.y * p.y) / normal.z - p.z - 1e-6;
        if (clip(depthBehind(start), depthBehind(end))) hidden.push([lo, hi]);
    }
    hidden.sort((a, b) => a[0] - b[0]);
    const visible: [Vector3, Vector3][] = [];
    const point = (t: number) => start.clone().lerp(end, t);
    let cursor = 0;
    for (const [lo, hi] of hidden) {
        if (lo > cursor) visible.push([point(cursor), point(lo)]);
        cursor = Math.max(cursor, hi);
    }
    if (cursor < 1) visible.push([point(cursor), point(1)]);
    return visible;
}

/** Round the projected patches without changing their larger face/edge/corner hit targets. */
export function roundedCubePatch(points: readonly { x: number; y: number }[], radius: number): string {
    const corners = points.map((point, i) => {
        const before = points[(i + points.length - 1) % points.length];
        const after = points[(i + 1) % points.length];
        const incoming = Math.hypot(before.x - point.x, before.y - point.y);
        const outgoing = Math.hypot(after.x - point.x, after.y - point.y);
        const r = Math.min(radius, incoming / 2, outgoing / 2);
        const along = (next: { x: number; y: number }, length: number) => ({
            x: point.x + ((next.x - point.x) * r) / (length || 1),
            y: point.y + ((next.y - point.y) * r) / (length || 1),
        });
        return { point, entry: along(before, incoming), exit: along(after, outgoing) };
    });
    return `${corners
        .map(
            ({ point, entry, exit }, i) =>
                `${i === 0 ? "M" : "L"}${entry.x},${entry.y} Q${point.x},${point.y} ${exit.x},${exit.y}`,
        )
        .join(" ")} Z`;
}

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
