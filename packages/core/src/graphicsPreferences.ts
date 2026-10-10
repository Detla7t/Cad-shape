// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Application display preferences; never alter modeling tolerances or geometry. */
/** How the viewport trades picture for frame rate while the camera moves (see `renderQuality.ts`). */
export type RenderQualityProfile = "automatic" | "performance" | "balanced" | "quality";

export interface GraphicsPreferences {
    /** Automatic (60 fps), Performance (120 fps), Balanced (60 fps) or Quality (30 fps). */
    quality: RenderQualityProfile;
    ambientOcclusion: number;
    fieldOfView: number;
    bodyLineWidth: number;
    shininess: number;
    specularColor: string;
    phantomLineWidth: number;
    phantomColor: string;
    meshLineWidth: number;
    activeLineWidth: number;
    constrainedColor: string | null;
    underconstrainedColor: string;
    occludedColor: string;
    inactiveLineWidth: number;
    inactiveColor: string;
    /** Fill of an inactive sketch's closed regions, in percent (0 hides the fill). */
    inactiveRegionOpacity: number;
    /** Size of an inactive sketch's entity points (endpoints, centers), in pixels; 0 hides them. */
    inactivePointSize: number;
    firstDash: number;
    firstGap: number;
    secondDash: number;
    secondGap: number;
}

export const DEFAULT_GRAPHICS: Readonly<GraphicsPreferences> = Object.freeze({
    quality: "automatic",
    ambientOcclusion: 37.5,
    fieldOfView: 45,
    bodyLineWidth: 1,
    shininess: 3,
    specularColor: "#999999",
    phantomLineWidth: 0.5,
    phantomColor: "#262626",
    meshLineWidth: 0.3,
    activeLineWidth: 2,
    constrainedColor: null,
    underconstrainedColor: "#1400d6",
    occludedColor: "#4444ff",
    inactiveLineWidth: 1,
    inactiveColor: "#999999",
    inactiveRegionOpacity: 12,
    inactivePointSize: 4,
    firstDash: 36,
    firstGap: 54,
    secondDash: 270,
    secondGap: 54,
});

/** The construction pattern before 10 October 2026, three times denser: saved copies of it read as the default. */
export const LEGACY_CONSTRUCTION_PATTERN = {
    firstDash: 12,
    firstGap: 18,
    secondDash: 90,
    secondGap: 18,
} as const;
