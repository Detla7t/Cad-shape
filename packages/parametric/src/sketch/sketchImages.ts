// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { FaceMeshData, Plane } from "@chili3d/core";
import { type SketchImageData, toWorld } from "./sketchModel";
export function sketchImageMeshes(plane: Plane, images: SketchImageData[] = []): FaceMeshData[] {
    return images.map((image) => {
        const { x, y, width: w, height: h } = image,
            points = [
                [x, y],
                [x + w, y],
                [x + w, y + h],
                [x, y + h],
            ].map(([u, v]) => toWorld(plane, u, v));
        return {
            position: new Float32Array(points.flatMap((p) => [p.x, p.y, p.z])),
            normal: new Float32Array(points.flatMap(() => [plane.normal.x, plane.normal.y, plane.normal.z])),
            uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            index: new Uint32Array([0, 1, 2, 0, 2, 3]),
            groups: [],
            range: [],
            texture: image.dataUrl,
        };
    });
}
