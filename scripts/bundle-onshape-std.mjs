// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Packs a checkout of Onshape's FeatureScript standard library (MIT-licensed `onshape/std`,
// e.g. a clone of github.com/javawizard/onshape-std-library-mirror) into one gzipped JSON
// bundle `{ version, license, files: { "<name>.fs": source } }` that
// `onshapeStdFromBundle` reads. Mirrors replace version numbers with "✨"; the bundle
// carries the real version instead.
//
//   node scripts/bundle-onshape-std.mjs <std-dir> <version> <out.json.gz>

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const MIT_LICENSE = `The MIT License (MIT) for the FeatureScript Standard Library (std).

Copyright (c) 2013-Present PTC Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`;

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
// Every module states the std is MIT-licensed; a checkout without the LICENSE tab gets its text.
const license = existsSync(join(dir, "LICENSE.txt"))
    ? readFileSync(join(dir, "LICENSE.txt"), "utf8")
    : MIT_LICENSE;
writeFileSync(out, gzipSync(JSON.stringify({ version, license, files }), { level: 9 }));
console.log(`${Object.keys(files).length} modules, version ${version} -> ${out}`);
