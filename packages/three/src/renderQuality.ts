// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Rendering quality as a ladder of levels and the profiles that walk it.
 *
 * A level is what one frame costs: the render scale (the drawing buffer's share of the
 * display pixel ratio — 0.5 draws a quarter of the pixels) and the ambient occlusion
 * pass (off, at half the buffer's resolution, or at full resolution). The model's
 * geometry, lines and labels are never simplified: a lower level is the same picture at
 * fewer pixels, which is what reads as responsive while the camera moves.
 *
 * A profile says what the user wants of the frame rate while the camera moves and how
 * the settled frame draws:
 * - **Performance** aims at 120 fps while moving and settles with a minor degradation
 *   (full scale, half-resolution occlusion);
 * - **Balanced** aims at 60 fps while moving and settles at full quality;
 * - **Quality** aims at 30 fps while moving, never dropping below full scale, and
 *   settles at full quality;
 * - **Automatic** aims at 60 fps while moving, walking the whole ladder as needed, and
 *   settles at full quality.
 *
 * The controller measures the interval between consecutive moving frames (what the
 * user sees as responsiveness, GPU back-pressure included) and steps the moving level
 * down when the target is missed, up when there is room — with hysteresis, so the
 * picture does not flicker between levels.
 */

export type QualityProfile = "automatic" | "performance" | "balanced" | "quality";

export const QUALITY_PROFILES: readonly QualityProfile[] = [
    "automatic",
    "performance",
    "balanced",
    "quality",
];

export interface QualityLevel {
    /** Share of the display pixel ratio the drawing buffer uses (0.5 … 1). */
    readonly scale: number;
    /** The ambient occlusion pass: skipped, at half the buffer's resolution, or at full. */
    readonly ao: "off" | "half" | "full";
}

/** Cheapest first. */
export const QUALITY_LEVELS: readonly QualityLevel[] = [
    { scale: 0.5, ao: "off" },
    { scale: 0.65, ao: "off" },
    { scale: 0.75, ao: "off" },
    { scale: 0.85, ao: "half" },
    { scale: 1, ao: "half" },
    { scale: 1, ao: "full" },
];

export const FULL_QUALITY: QualityLevel = QUALITY_LEVELS[QUALITY_LEVELS.length - 1];

export interface QualityProfileSettings {
    /** Frames per second the moving frames aim at. */
    readonly targetFps: number;
    /** The moving level to start from (index into `QUALITY_LEVELS`). */
    readonly movingStart: number;
    /** The lowest moving level the profile may fall to. */
    readonly movingMin: number;
    /** The highest moving level the profile climbs to. */
    readonly movingMax: number;
    /** The level of a settled frame. */
    readonly still: number;
}

export const PROFILE_SETTINGS: Readonly<Record<QualityProfile, QualityProfileSettings>> = {
    performance: { targetFps: 120, movingStart: 2, movingMin: 0, movingMax: 4, still: 4 },
    balanced: { targetFps: 60, movingStart: 4, movingMin: 0, movingMax: 5, still: 5 },
    quality: { targetFps: 30, movingStart: 5, movingMin: 4, movingMax: 5, still: 5 },
    automatic: { targetFps: 60, movingStart: 4, movingMin: 0, movingMax: 5, still: 5 },
};

/** The profile's name and target as the menus show it. */
export function describeProfile(profile: QualityProfile): string {
    const name = profile[0].toUpperCase() + profile.slice(1);
    return `${name} (${PROFILE_SETTINGS[profile].targetFps} fps)`;
}

/** Frames the target must be missed before the level drops. */
const SLOW_FRAMES = 3;
/** Frames with room to spare before the level climbs. */
const FAST_FRAMES = 12;
/** Least time between two level changes, ms. */
const CHANGE_COOLDOWN_MS = 400;
/** A frame counts as missed when it runs this much over the target period. */
const MISS_FACTOR = 1.25;
/** A frame counts as having room when it runs under this share of the target period. */
const ROOM_FACTOR = 0.6;
/** Intervals over this are a pause (a dropped tab, a stall), not a slow frame. */
const PAUSE_MS = 1000;

export class QualityController {
    private settings: QualityProfileSettings;
    private level: number;
    private slow = 0;
    private fast = 0;
    private lastChangeAt = Number.NEGATIVE_INFINITY;
    private emaMs: number | undefined;

    constructor(private profile: QualityProfile = "automatic") {
        this.settings = PROFILE_SETTINGS[profile];
        this.level = this.settings.movingStart;
    }

    get currentProfile(): QualityProfile {
        return this.profile;
    }

    /** The level moving frames draw at now. */
    get moving(): QualityLevel {
        return QUALITY_LEVELS[this.level];
    }

    /** The level a settled frame draws at. */
    get still(): QualityLevel {
        return QUALITY_LEVELS[this.settings.still];
    }

    /** Index of the moving level, for readouts. */
    get movingLevel(): number {
        return this.level;
    }

    /** The smoothed interval between moving frames, ms; undefined before the first pair. */
    get frameIntervalMs(): number | undefined {
        return this.emaMs;
    }

    /** The smoothed moving frame rate; undefined before the first pair. */
    get fps(): number | undefined {
        return this.emaMs === undefined || this.emaMs <= 0 ? undefined : 1000 / this.emaMs;
    }

    get targetFps(): number {
        return this.settings.targetFps;
    }

    setProfile(profile: QualityProfile): void {
        if (profile === this.profile) return;
        this.profile = profile;
        this.settings = PROFILE_SETTINGS[profile];
        this.level = this.settings.movingStart;
        this.slow = 0;
        this.fast = 0;
        this.emaMs = undefined;
    }

    /** Forgets the measured cadence — a new interaction starts clean. */
    reset(): void {
        this.slow = 0;
        this.fast = 0;
        this.emaMs = undefined;
    }

    /**
     * Records the interval since the previous moving frame. Returns true when the moving
     * level changed, so the caller re-applies it.
     */
    observe(intervalMs: number, now: number): boolean {
        if (!(intervalMs > 0) || intervalMs > PAUSE_MS) return false;
        const period = 1000 / this.settings.targetFps;
        this.emaMs = this.emaMs === undefined ? intervalMs : this.emaMs * 0.7 + intervalMs * 0.3;
        if (this.emaMs > period * MISS_FACTOR) {
            this.slow++;
            this.fast = 0;
        } else if (this.emaMs < period * ROOM_FACTOR) {
            this.fast++;
            this.slow = 0;
        } else {
            this.slow = 0;
            this.fast = 0;
        }
        if (now - this.lastChangeAt < CHANGE_COOLDOWN_MS) return false;
        if (this.slow >= SLOW_FRAMES && this.level > this.settings.movingMin) {
            this.level--;
            this.slow = 0;
            this.lastChangeAt = now;
            return true;
        }
        if (this.fast >= FAST_FRAMES && this.level < this.settings.movingMax) {
            this.level++;
            this.fast = 0;
            this.lastChangeAt = now;
            return true;
        }
        return false;
    }
}
