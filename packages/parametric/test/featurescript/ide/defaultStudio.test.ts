// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { formatFeatureScript } from "@chili3d/featurescript/ide";
import { DEFAULT_STUDIO_SOURCE } from "../../../src/featurescript/featureStudioNode";

test("format document leaves a new studio's default source as it is", () => {
    expect(formatFeatureScript(DEFAULT_STUDIO_SOURCE)).toBe(DEFAULT_STUDIO_SOURCE);
});
