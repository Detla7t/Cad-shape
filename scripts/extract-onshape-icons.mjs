// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const directory = new URL("../packages/element/src/icons/", import.meta.url);
const source = gunzipSync(readFileSync(new URL("onshape-icons.v1.4.425.svg.gz", directory))).toString();
const mapping = JSON.parse(readFileSync(new URL("onshapeIconMap.json", directory), "utf8"));
const symbols = new Map(
    [...source.matchAll(/<symbol\b[^>]*\bid="([^"]+)"[^>]*>.*?<\/symbol>/gs)].map((match) => [
        match[1],
        match[0],
    ]),
);
const used = [...new Set(Object.values(mapping))].sort().map((name) => {
    const symbol = symbols.get(`svg-icon-${name}`);
    if (!symbol) throw new Error(`Missing source icon: ${name}`);
    return symbol;
});
writeFileSync(
    new URL("onshapeToolbar.svg", directory),
    [
        "<!-- Source: https://cad.onshape.com/images/icons.v1.4.425.min.svg ; PTC / Onshape artwork. Original rights retained. -->",
        '<svg xmlns="http://www.w3.org/2000/svg">',
        ...used,
        "</svg>",
        "",
    ].join("\n"),
);
console.log(`Extracted ${used.length} toolbar symbols from ${symbols.size} archived source symbols.`);
