// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { decodeOnshapeStd, ONSHAPE_STD_VERSION } from "../src";

const BUNDLE = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../std/onshape-std-3083.json.gz"),
);

describe("the bundled Onshape std", () => {
    test("decodes to every std module, its version and its MIT license", async () => {
        const std = await decodeOnshapeStd(BUNDLE);
        expect(std.version).toBe(ONSHAPE_STD_VERSION);
        expect(Object.keys(std.files)).toHaveLength(276);
        expect(std.files["geometry.fs"]).toMatch(/^FeatureScript 3083;/);
        expect(std.license).toMatch(/^The MIT License \(MIT\) for the FeatureScript Standard Library/);
    });

    test("also reads a bundle a server already decompressed", async () => {
        const decompressed = new Uint8Array(gunzipSync(BUNDLE));
        const std = await decodeOnshapeStd(decompressed);
        expect(std.files["geometry.fs"]).toMatch(/^FeatureScript 3083;/);
    });
});
