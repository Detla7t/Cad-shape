// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Box3,
    BoxGeometry,
    Group,
    Mesh,
    Object3D,
    OrthographicCamera,
    PerspectiveCamera,
    Vector3,
} from "three";
import { modelBounds, THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH, thumbnailCamera } from "../src/modelThumbnail";

const ASPECT = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;

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
    const camera = thumbnailCamera(source, bounds, ASPECT);
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

test.each(["orthographic", "perspective"])("%s thumbnails preserve a circle's proportions", (kind) => {
    const source =
        kind === "orthographic"
            ? new OrthographicCamera(-200, 200, 100, -100, 0.1, 5000)
            : new PerspectiveCamera(45, 2, 0.1, 5000);
    source.position.set(0, 0, 100);
    source.lookAt(0, 0, 0);
    source.updateMatrixWorld(true);
    const camera = thumbnailCamera(
        source,
        new Box3(new Vector3(-20, -20, 0), new Vector3(20, 20, 0)),
        ASPECT,
    );
    const left = new Vector3(-20, 0, 0).project(camera);
    const right = new Vector3(20, 0, 0).project(camera);
    const top = new Vector3(0, 20, 0).project(camera);
    const bottom = new Vector3(0, -20, 0).project(camera);
    // NDC must be scaled by the actual thumbnail target, not the source viewport.
    expect((right.x - left.x) * THUMBNAIL_WIDTH).toBeCloseTo((top.y - bottom.y) * THUMBNAIL_HEIGHT, 8);
});

test("model bounds skip objects whose geometry is not a BufferGeometry", () => {
    const models = new Group();
    models.add(new Mesh(new BoxGeometry(10, 20, 30)));
    // A PMI annotation's `geometry` is its PmiGeometry description.
    const annotation = Object.assign(new Object3D(), { geometry: { lines: [] } });
    models.add(annotation);
    models.updateMatrixWorld(true);
    const bounds = modelBounds(models);
    expect(bounds.min.toArray()).toEqual([-5, -10, -15]);
    expect(bounds.max.toArray()).toEqual([5, 10, 15]);
});
