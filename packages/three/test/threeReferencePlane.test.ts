// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane, ReferencePlaneNode, XYZ } from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { Mesh, Vector3 } from "three";
import { ThreeReferencePlane } from "../src/threeReferencePlane";

test.each([
    Plane.XY,
    Plane.YZ,
    Plane.ZX,
    new Plane({ origin: new XYZ(4, 7, 8), normal: new XYZ(1, 1, 1), xvec: new XYZ(1, -1, 0) }),
])("plane text stays inside its upper-left corner and coplanar when the plane changes", (plane) => {
    const document = new TestDocument();
    const node = new ReferencePlaneNode({ document, basePlane: plane, size: 200, offset: 25 });
    const visual = new ThreeReferencePlane(node);
    try {
        const label = visual.getObjectByName("plane-label");
        const back = visual.getObjectByName("plane-label-back");
        expect(label).toBeInstanceOf(Mesh);
        expect(back).toBeInstanceOf(Mesh);
        for (const size of [200, 90]) {
            node.size = size;
            visual.updateMatrixWorld(true);
            for (const [x, y] of [
                [-0.5, -0.5],
                [0.5, -0.5],
                [0.5, 0.5],
                [-0.5, 0.5],
            ]) {
                const corner = label!.localToWorld(new Vector3(x, y, 0));
                const relative = new XYZ(corner.x, corner.y, corner.z).sub(node.plane.origin);
                expect(relative.dot(plane.normal)).toBeCloseTo(0, 6);
                expect(relative.dot(plane.xvec)).toBeGreaterThan(-size / 2);
                expect(relative.dot(plane.xvec)).toBeLessThan(size / 2);
                expect(relative.dot(plane.yvec)).toBeGreaterThan(size * 0.4);
                expect(relative.dot(plane.yvec)).toBeLessThan(size / 2);
            }
            const right = new Vector3(1, 0, 0).applyQuaternion(label!.quaternion);
            expect(right.toArray()).toEqual(
                [plane.xvec.x, plane.xvec.y, plane.xvec.z].map((v) => expect.closeTo(v, 6)),
            );
            const backRight = new Vector3(1, 0, 0).applyQuaternion(back!.quaternion);
            expect(backRight.toArray()).toEqual(
                [-plane.xvec.x, -plane.xvec.y, -plane.xvec.z].map((v) => expect.closeTo(v, 6)),
            );
            const backCorner = back!.localToWorld(new Vector3(-0.5, 0.5, 0));
            const relative = new XYZ(backCorner.x, backCorner.y, backCorner.z).sub(node.plane.origin);
            expect(relative.dot(plane.normal)).toBeCloseTo(0, 6);
            expect(relative.dot(plane.xvec)).toBeCloseTo(size * 0.485, 6);
            expect(relative.dot(plane.yvec)).toBeCloseTo(size * 0.485, 6);
        }
    } finally {
        visual.dispose();
        document.dispose();
    }
});
