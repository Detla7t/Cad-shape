// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = new URL("../", import.meta.url);
const report = JSON.parse(readFileSync(new URL("docs/onshape-compatibility.json", root), "utf8"));
const bundle = JSON.parse(
    gunzipSync(readFileSync(new URL("packages/onshape-std/std/onshape-std-3083.json.gz", root))),
);
const names = new Set();
for (const tool of report.tools) {
    if (names.has(tool.tool)) throw new Error(`Duplicate tool: ${tool.tool}`);
    names.add(tool.tool);
    const source = bundle.files[tool.module];
    if (!source) throw new Error(`Missing std module for ${tool.tool}: ${tool.module}`);
    if (tool.feature && !source.includes(`export const ${tool.feature}`))
        throw new Error(`Stale export: ${tool.feature}`);
    if (!report.definitions[tool.status]) throw new Error(`Unknown status: ${tool.status}`);
    if (tool.status === "verified-subset" && !tool.evidence.length)
        throw new Error(`No evidence for ${tool.tool}`);
    for (const path of tool.evidence)
        if (!existsSync(new URL(path, root))) throw new Error(`Missing evidence file: ${path}`);
}
if (bundle.version !== report.stdVersion)
    throw new Error("Compatibility report uses a different std version");
console.log(`Onshape std ${bundle.version}: ${report.tools.length} requested tools inventoried.`);
for (const status of Object.keys(report.definitions))
    console.log(`${status}: ${report.tools.filter((tool) => tool.status === status).length}`);
console.log(`Full behavioral parity: NOT CERTIFIED. Inventory validation does not execute geometric tests.`);
console.log(
    `Evidence and release criteria: ${fileURLToPath(new URL("docs/onshape-compatibility.json", root))}`,
);
if (process.argv.includes("--require-parity")) {
    console.error(
        "Release blocked: every listed tool still requires full cross-application parity evidence.",
    );
    process.exitCode = 1;
}
