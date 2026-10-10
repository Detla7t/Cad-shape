// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DisplayScale, PubSub } from "../src";

afterEach(() => {
    DisplayScale.reset();
    PubSub.default.removeAll("displayScaleChanged");
});

test("pixel sizes fall into bands a factor 1.5 apart, anchored on 0.1", () => {
    expect(DisplayScale.band(0.1)).toBeCloseTo(0.1);
    expect(DisplayScale.band(0.12)).toBeCloseTo(0.1);
    expect(DisplayScale.band(0.14)).toBeCloseTo(0.15);
    expect(DisplayScale.band(1)).toBeCloseTo(0.1 * 1.5 ** 6);
    expect(DisplayScale.band(0.01)).toBeCloseTo(0.1 / 1.5 ** 6);
    // Nonsense keeps the current band.
    expect(DisplayScale.band(0)).toBe(DisplayScale.value);
    expect(DisplayScale.band(Number.NaN)).toBe(DisplayScale.value);
});

test("a dash pattern's period snaps to 1-2-5 steps of model units at the current pixel size", () => {
    // 120 px of pattern at 0.01 units/px is 1.2 units: snapped to 1 → 1/120 units per pixel
    expect(DisplayScale.dashUnit(0.01, 120)).toBeCloseTo(1 / 120, 12);
    // 1.8 units snaps to 2, 4 to 5, 8 to 10
    expect(DisplayScale.dashUnit(0.015, 120) * 120).toBeCloseTo(2, 12);
    expect(DisplayScale.dashUnit(1 / 30, 120) * 120).toBeCloseTo(5, 12);
    expect(DisplayScale.dashUnit(8 / 120, 120) * 120).toBeCloseTo(10, 12);
    // the dashes stay within the readable range of the preference on screen
    for (const pixel of [0.01, 0.013, 0.02, 0.04, 0.07, 0.1, 0.15, 0.3])
        expect(DisplayScale.dashUnit(pixel, 120) / pixel).toBeGreaterThan(0.6);
    for (const pixel of [0.01, 0.013, 0.02, 0.04, 0.07, 0.1, 0.15, 0.3])
        expect(DisplayScale.dashUnit(pixel, 120) / pixel).toBeLessThan(1.7);
    // nonsense input falls back to the pixel itself
    expect(DisplayScale.dashUnit(0, 120)).toBe(0);
    expect(DisplayScale.dashUnit(0.01, 0)).toBe(0.01);
});

test("the view's reports publish only when the band changes", () => {
    const heard: number[] = [];
    PubSub.default.sub("displayScaleChanged", (value) => heard.push(value));
    expect(DisplayScale.update(0.11)).toBe(false);
    expect(DisplayScale.update(0.16)).toBe(true);
    expect(DisplayScale.value).toBeCloseTo(0.15);
    expect(DisplayScale.update(0.15)).toBe(false);
    expect(DisplayScale.update(0.4)).toBe(true);
    expect(heard.map((value) => Number(value.toFixed(4)))).toEqual([0.15, 0.3375]);
    DisplayScale.reset();
    expect(DisplayScale.value).toBe(0.1);
});
