// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { type OnshapeStdBundle, onshapeStdFromBundle } from "../../../src/featurescript/onshape/stdBundle";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../fixtures");

/** Onshape's std library as the app ships it: the `@chili3d/onshape-std` bundle (std 3083, MIT). */
export const STD_BUNDLE: OnshapeStdBundle = JSON.parse(
    gunzipSync(
        readFileSync(path.resolve(HERE, "../../../../onshape-std/std/onshape-std-3083.json.gz")),
    ).toString("utf8"),
);

export const ONSHAPE_STD = onshapeStdFromBundle(STD_BUNDLE);

export function fixture(name: string): string {
    return readFileSync(path.join(FIXTURES, name), "utf8");
}
