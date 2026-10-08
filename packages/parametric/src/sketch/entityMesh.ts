// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { EdgeMeshData, Plane } from "@chili3d/core";
import { arcAngles, SKETCH_EDGE_LINE_WIDTH, type SketchEntityData, toWorld } from "./sketchModel";

/** Analytic display geometry; never used as modeling topology. Chord error is below 0.2 screen pixels. */
export function entityDisplayMesh(
    plane: Plane,
    entity: SketchEntityData,
    color: number,
    dashed = false,
    pixelSize = 0.1,
): EdgeMeshData {
    const p = entity.params;
    const points: number[] = [];
    const add = (u: number, v: number) => {
        const world = toWorld(plane, u, v);
        points.push(world.x, world.y, world.z);
    };
    if (entity.type === "line") {
        add(p[0], p[1]);
        add(p[2], p[3]);
    } else {
        const radius = entity.type === "circle" ? p[2] : Math.hypot(p[2] - p[0], p[3] - p[1]);
        const [start, sweep] = entity.type === "circle" ? [0, Math.PI * 2] : arcAngles(p);
        const angle =
            2 *
            Math.acos(
                Math.max(-1, Math.min(1, 1 - (Math.max(pixelSize, 1e-6) * 0.2) / Math.max(radius, 1e-6))),
            );
        const count = Math.min(4096, Math.max(16, Math.ceil(sweep / Math.max(angle, 1e-4))));
        for (let i = 0; i < count; i++) {
            for (const step of [i, i + 1]) {
                const t = start + (sweep * step) / count;
                add(p[0] + radius * Math.cos(t), p[1] + radius * Math.sin(t));
            }
        }
    }
    return {
        position: new Float32Array(points),
        range: [],
        color,
        lineType: dashed ? "dash" : "solid",
        lineWidth: SKETCH_EDGE_LINE_WIDTH,
        dashSize: pixelSize * 7,
        gapSize: pixelSize * 4,
    };
}

/** Physical gaps for the node mesh, which combines several line styles into one buffer. */
export function dashedPositions(position: Float32Array, dash = 1.4, gap = 0.8): Float32Array {
    const result: number[] = [];
    let travelled = 0;
    for (let i = 0; i < position.length; i += 6) {
        const a = position.subarray(i, i + 3);
        const b = position.subarray(i + 3, i + 6);
        const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (length === 0) continue;
        for (let offset = 0; offset < length; ) {
            const phase = (travelled + offset) % (dash + gap);
            const drawing = phase < dash;
            const end = Math.min(length, offset + (drawing ? dash - phase : dash + gap - phase));
            if (end <= offset + 1e-10) {
                offset += 1e-9;
                continue;
            }
            if (drawing)
                for (const distance of [offset, end])
                    for (let axis = 0; axis < 3; axis++)
                        result.push(a[axis] + ((b[axis] - a[axis]) * distance) / length);
            offset = end;
        }
        travelled += length;
    }
    return new Float32Array(result);
}
