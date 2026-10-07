// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Packs a checkout of Onshape's FeatureScript standard library (MIT-licensed `onshape/std`,
// e.g. a clone of github.com/javawizard/onshape-std-library-mirror) into one gzipped JSON
// bundle `{ version, license, files: { "<name>.fs": source } }` that
// `onshapeStdFromBundle` reads. Mirrors replace version numbers with "✨"; the bundle
// carries the real version instead.
//
//   node scripts/bundle-onshape-std.mjs <std-dir> <version> <out.json.gz>

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const [dir, versionArg, out] = process.argv.slice(2);
if (!dir || !versionArg || !out) {
    console.error("usage: node scripts/bundle-onshape-std.mjs <std-dir> <version> <out.json.gz>");
    process.exit(1);
}
const version = Number(versionArg);
const files = {};
for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".fs")) continue;
    files[name] = readFileSync(join(dir, name), "utf8")
        .replace(/FeatureScript\s+✨\s*;/g, `FeatureScript ${version};`)
        .replace(/"✨"/g, `"${version}.0"`);
}
const license = readFileSync(join(dir, "LICENSE.txt"), "utf8");
writeFileSync(out, gzipSync(JSON.stringify({ version, license, files }), { level: 9 }));
console.log(`${Object.keys(files).length} modules, version ${version} -> ${out}`);
