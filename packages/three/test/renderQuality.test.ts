// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    describeProfile,
    FULL_QUALITY,
    PROFILE_SETTINGS,
    QUALITY_LEVELS,
    QualityController,
} from "../src/renderQuality";

describe("quality controller", () => {
    test("profiles start at their moving level and settle as they say", () => {
        const automatic = new QualityController("automatic");
        expect(automatic.moving).toEqual(QUALITY_LEVELS[4]);
        expect(automatic.still).toEqual(FULL_QUALITY);
        const performance = new QualityController("performance");
        expect(performance.still).toEqual({ scale: 1, ao: "half" });
        expect(performance.targetFps).toBe(120);
        const quality = new QualityController("quality");
        expect(quality.moving).toEqual(FULL_QUALITY);
        expect(describeProfile("balanced")).toBe("Balanced (60 fps)");
    });

    test("missed frames step the moving level down, with a cooldown between steps", () => {
        const controller = new QualityController("automatic");
        let now = 0;
        // 25 fps against a 60 fps target.
        const slow = () => {
            now += 40;
            return controller.observe(40, now);
        };
        expect([slow(), slow()]).toEqual([false, false]);
        expect(slow()).toBe(true);
        expect(controller.movingLevel).toBe(3);
        // The cooldown holds the next step back until it elapses.
        expect([slow(), slow(), slow()]).toEqual([false, false, false]);
        now += 400;
        expect([slow(), slow(), slow()].some(Boolean)).toBe(true);
        expect(controller.movingLevel).toBe(2);
        expect(controller.fps).toBeCloseTo(25, 0);
    });

    test("room to spare steps the level back up, never past the profile's ceiling", () => {
        const controller = new QualityController("performance");
        let now = 0;
        // 250 fps against a 120 fps target, each frame past the cooldown.
        const fast = () => {
            now += 500;
            return controller.observe(4, now);
        };
        let climbed = 0;
        for (let i = 0; i < 40; i++) if (fast()) climbed++;
        expect(climbed).toBe(
            PROFILE_SETTINGS.performance.movingMax - PROFILE_SETTINGS.performance.movingStart,
        );
        expect(controller.movingLevel).toBe(PROFILE_SETTINGS.performance.movingMax);
    });

    test("the quality profile never drops below full scale and pauses do not count", () => {
        const controller = new QualityController("quality");
        let now = 0;
        for (let i = 0; i < 20; i++) {
            now += 500;
            controller.observe(100, now);
        }
        expect(controller.movingLevel).toBe(PROFILE_SETTINGS.quality.movingMin);
        expect(controller.moving.scale).toBe(1);
        const before = controller.frameIntervalMs;
        expect(controller.observe(5000, now + 5000)).toBe(false);
        expect(controller.frameIntervalMs).toBe(before);
    });

    test("switching profile restarts from that profile's start level", () => {
        const controller = new QualityController("automatic");
        let now = 0;
        for (let i = 0; i < 6; i++) {
            now += 500;
            controller.observe(50, now);
        }
        expect(controller.movingLevel).toBeLessThan(4);
        controller.setProfile("balanced");
        expect(controller.movingLevel).toBe(PROFILE_SETTINGS.balanced.movingStart);
        expect(controller.fps).toBeUndefined();
    });
});
