// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { type OnshapeStdBundle, onshapeStdFromBundle } from "../../../src/featurescript/onshape/stdBundle";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

/** Onshape's std library, version 2960 (MIT; regenerate with `scripts/bundle-onshape-std.mjs`). */
export const STD_BUNDLE: OnshapeStdBundle = JSON.parse(
    gunzipSync(readFileSync(path.join(FIXTURES, "onshape-std-2960.json.gz"))).toString("utf8"),
);

export const ONSHAPE_STD = onshapeStdFromBundle(STD_BUNDLE);

export function fixture(name: string): string {
    return readFileSync(path.join(FIXTURES, name), "utf8");
}
