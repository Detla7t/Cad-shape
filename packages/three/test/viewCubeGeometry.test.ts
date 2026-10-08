// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Vector3 } from "three";
import { visibleCubeAxis } from "../src/viewCubeGeometry";

const face = [new Vector3(-1, -1, 0), new Vector3(1, -1, 0), new Vector3(1, 1, 0), new Vector3(-1, 1, 0)];

test.each([1, -1])("cube axis visibility uses depth with polygon winding %s", (winding) => {
    const polygon = winding > 0 ? face : [...face].reverse();
    const foreground = visibleCubeAxis(new Vector3(-2, 0, 1), new Vector3(2, 0, 1), [polygon]);
    expect(foreground.map((pair) => pair.map((p) => p.toArray()))).toEqual([
        [
            [-2, 0, 1],
            [2, 0, 1],
        ],
    ]);
    const background = visibleCubeAxis(new Vector3(-2, 0, -1), new Vector3(2, 0, -1), [polygon]);
    expect(background.map((pair) => pair.map((p) => p.toArray()))).toEqual([
        [
            [-2, 0, -1],
            [-1, 0, -1],
        ],
        [
            [1, 0, -1],
            [2, 0, -1],
        ],
    ]);
});

test("an axis passing through a face remains visible in front of it", () => {
    const visible = visibleCubeAxis(new Vector3(-0.5, 0, -1), new Vector3(0.5, 0, 1), [face]);
    expect(visible).toHaveLength(1);
    expect(visible[0][0].x).toBeCloseTo(0, 5);
    expect(visible[0][1].toArray()).toEqual([0.5, 0, 1]);
});

test("occlusion from overlapping projected faces is merged", () => {
    const second = face.map((p) => p.clone().add(new Vector3(1, 0, 1)));
    const visible = visibleCubeAxis(new Vector3(-2, 0, -1), new Vector3(3, 0, -1), [second, face]);
    expect(visible.map((pair) => pair.map((p) => p.toArray()))).toEqual([
        [
            [-2, 0, -1],
            [-1, 0, -1],
        ],
        [
            [2, 0, -1],
            [3, 0, -1],
        ],
    ]);
});
