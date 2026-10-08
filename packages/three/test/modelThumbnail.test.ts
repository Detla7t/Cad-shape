// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Box3, OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import { thumbnailCamera } from "../src/modelThumbnail";

test.each([
    "orthographic",
    "perspective",
])("%s thumbnails frame the full model without moving the viewport camera", (kind) => {
    const source =
        kind === "orthographic"
            ? new OrthographicCamera(-200, 200, 100, -100, 0.1, 5000)
            : new PerspectiveCamera(45, 2, 0.1, 5000);
    source.position.set(500, 300, 200);
    source.up.set(0, 0, 1);
    source.lookAt(0, 0, 0);
    source.zoom = 3;
    source.updateProjectionMatrix();
    source.updateMatrixWorld(true);
    const before = source.toJSON();
    const bounds = new Box3(new Vector3(10, 20, -10), new Vector3(210, 120, 50));
    const camera = thumbnailCamera(source, bounds, 1.6);
    for (const x of [10, 210])
        for (const y of [20, 120])
            for (const z of [-10, 50]) {
                const projected = new Vector3(x, y, z).project(camera);
                expect(Math.abs(projected.x)).toBeLessThan(1);
                expect(Math.abs(projected.y)).toBeLessThan(1);
                expect(Math.abs(projected.z)).toBeLessThan(1);
            }
    expect(source.toJSON()).toEqual(before);
    expect(camera).not.toBe(source);
});
