// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BufferGeometry,
    Float32BufferAttribute,
    type Intersection,
    Mesh,
    type Object3D,
    PlaneGeometry,
    Points,
    Vector3,
} from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { preferSmallerTargets } from "../src/pickPriority";

function surfaceHit(mesh: Mesh, distance: number, point: Vector3): Intersection<Object3D> {
    return {
        object: mesh,
        distance,
        point,
        face: { a: 0, b: 1, c: 2, normal: new Vector3(0, 0, 1), materialIndex: 0 },
    };
}

function lineHit(line: LineSegments2, distance: number, pointOnLine: Vector3): Intersection<Object3D> {
    // A line hit's `point` is on the ray, its `pointOnLine` on the segment.
    return { object: line, distance, point: new Vector3(0, 0, -distance), pointOnLine };
}

function pointHit(points: Points, distance: number, index: number): Intersection<Object3D> {
    return { object: points, distance, point: new Vector3(0, 0, -distance), index };
}

function vertexCloud(...positions: number[]) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    return new Points(geometry);
}

describe("preferSmallerTargets", () => {
    test("a curve and a point drawn on a plane win over the plane, even when the ray reports them behind it", () => {
        const plane = new Mesh(new PlaneGeometry(10, 10));
        const curve = new LineSegments2();
        const below = new LineSegments2();
        const points = vertexCloud(0.1, 0, 0);
        const hits = [
            surfaceHit(plane, 10, new Vector3(0, 0, 0)),
            lineHit(curve, 10.01, new Vector3(0.02, 0, 0)),
            pointHit(points, 10.02, 0),
            lineHit(below, 12, new Vector3(0, 0, -2)),
        ];
        expect(preferSmallerTargets(hits, 1e-3).map((hit) => hit.object)).toEqual([
            points,
            curve,
            plane,
            below,
        ]);
    });

    test("the surface's world orientation decides what lies on it", () => {
        const plane = new Mesh(new PlaneGeometry(10, 10));
        plane.rotation.x = Math.PI / 2; // local +Z becomes world -Y: the plane is y = 0
        plane.updateMatrixWorld();
        const onPlane = new LineSegments2();
        const offPlane = new LineSegments2();
        const hits = [
            surfaceHit(plane, 5, new Vector3(0, 0, 0)),
            lineHit(offPlane, 5.01, new Vector3(0, 0.5, 0.2)),
            lineHit(onPlane, 5.02, new Vector3(1, 0, 3)),
        ];
        expect(preferSmallerTargets(hits, 1e-3).map((hit) => hit.object)).toEqual([onPlane, plane, offPlane]);
    });

    test("depth order stands when nothing lies on a nearer surface", () => {
        const front = new Mesh(new PlaneGeometry(10, 10));
        const back = new Mesh(new PlaneGeometry(10, 10));
        const nearCurve = new LineSegments2();
        const hits = [
            lineHit(nearCurve, 4, new Vector3(0, 0, 6)),
            surfaceHit(front, 10, new Vector3(0, 0, 0)),
            surfaceHit(back, 12, new Vector3(0, 0, -2)),
        ];
        expect(preferSmallerTargets(hits, 1e-3)).toEqual(hits);
    });
});
