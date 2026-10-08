// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { SelectionRectangle } from "../src";

test("right-to-left crosses a long line even with both endpoints outside; left-to-right encloses", () => {
    const crossing = new SelectionRectangle(60, 40, 40, 60);
    const window = new SelectionRectangle(40, 40, 60, 60);
    expect(crossing.segment({ x: 0, y: 50 }, { x: 100, y: 50 })).toBe(true);
    expect(window.segment({ x: 0, y: 50 }, { x: 100, y: 50 })).toBe(false);
    expect(window.segment({ x: 45, y: 45 }, { x: 55, y: 55 })).toBe(true);
    expect(crossing.segment({ x: 0, y: 70 }, { x: 100, y: 70 })).toBe(false);
    expect(crossing.segment({ x: 0, y: 0 }, { x: 35, y: 55 })).toBe(false);
});

test("crossing can lie inside a face, but an overlapping bounding box alone does not select geometry", () => {
    const crossing = new SelectionRectangle(55, 45, 45, 55);
    expect(crossing.triangle({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 })).toBe(true);
    expect(crossing.triangle({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 50 })).toBe(false);
    const window = new SelectionRectangle(45, 45, 55, 55);
    expect(window.triangle({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 })).toBe(false);
});
