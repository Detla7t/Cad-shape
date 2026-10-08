// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Application display preferences; never alter modeling tolerances or geometry. */
export interface GraphicsPreferences {
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
    firstDash: number;
    firstGap: number;
    secondDash: number;
    secondGap: number;
}

export const DEFAULT_GRAPHICS: Readonly<GraphicsPreferences> = Object.freeze({
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
    firstDash: 4,
    firstGap: 6,
    secondDash: 30,
    secondGap: 6,
});
