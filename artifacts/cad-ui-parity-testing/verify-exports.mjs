// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
// Read-only verification of files downloaded through the two CAD interfaces.

import crypto from "node:crypto";
import fs from "node:fs";
import init from "../../packages/wasm/lib/chili-wasm.js";

const directory = new URL("./", import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, directory));
const save = (file, data) => fs.writeFileSync(new URL(file, directory), `${JSON.stringify(data, null, 2)}\n`);
const raw = {};
for (const format of ["step", "dxf"]) {
    const a = read(`onshape/testing-ui.${format}`);
    const b = read(`chili3d/testing-ui.${format}`);
    let first = 0;
    while (first < Math.min(a.length, b.length) && a[first] === b[first]) first++;
    raw[format] = {
        rawByteEqual: a.equals(b),
        onshapeBytes: a.length,
        chili3dBytes: b.length,
        onshapeSHA256: crypto.createHash("sha256").update(a).digest("hex"),
        chili3dSHA256: crypto.createHash("sha256").update(b).digest("hex"),
        firstDifferenceOffsetZeroBased: a.equals(b) ? null : first,
        onshapePrefix: a.subarray(0, 180).toString(),
        chili3dPrefix: b.subarray(0, 180).toString(),
    };
}
save("raw-comparison.json", raw);

const kernel = await init({
    wasmBinary: fs.readFileSync(new URL("../../packages/wasm/lib/chili-wasm.wasm", import.meta.url)),
});
const imported = {};
const geometry = {
    method: "Secondary inspection of the unchanged UI-exported STEP files with OCCT 8.0. No replacement exports or normalization. This does not change the raw-byte verdict.",
    units: "mm",
};
for (const engine of ["onshape", "chili3d"]) {
    const root = kernel.Converter.convertFromStep(read(`${engine}/testing-ui.step`));
    if (!root) throw new Error(`Cannot import ${engine} STEP`);
    const records = [];
    function visit(node) {
        if (node.shape) {
            for (const solid of kernel.Shape.findSubShapes(
                node.shape,
                kernel.TopAbs_ShapeEnum.TopAbs_SOLID,
            )) {
                records.push({
                    shape: solid,
                    name: node.name,
                    volumeMm3: kernel.Shape.volume(solid),
                    valid: kernel.Shape.check(solid),
                    bounds: kernel.Shape.exactBoundingBox(solid),
                    faceCount: kernel.Shape.findSubShapes(solid, kernel.TopAbs_ShapeEnum.TopAbs_FACE).length,
                });
            }
        }
        for (const child of node.getChildren()) visit(child);
    }
    visit(root);
    records.sort((a, b) => a.bounds.min.x - b.bounds.min.x);
    imported[engine] = records;
    geometry[engine] = {
        solids: records.map(({ shape, ...metadata }) => metadata),
        totalVolumeMm3: records.reduce((sum, record) => sum + record.volumeMm3, 0),
    };
}
geometry.pairwiseChecks = imported.onshape.map((a, index) => {
    const b = imported.chili3d[index];
    if (!b) throw new Error("Different solid counts");
    const ab = kernel.ShapeFactory.booleanCut([a.shape], [b.shape]);
    const ba = kernel.ShapeFactory.booleanCut([b.shape], [a.shape]);
    const differences = ["min", "max"].flatMap((bound) =>
        ["x", "y", "z"].map((axis) => Math.abs(a.bounds[bound][axis] - b.bounds[bound][axis])),
    );
    return {
        onshapePart: a.name,
        chili3dPart: b.name,
        absoluteVolumeDifferenceMm3: Math.abs(a.volumeMm3 - b.volumeMm3),
        maximumBoundingCoordinateDifferenceMm: Math.max(...differences),
        booleanDifferenceSucceeded: ab.isOk && ba.isOk,
        symmetricDifferenceVolumeMm3:
            ab.isOk && ba.isOk
                ? Math.abs(kernel.Shape.volume(ab.shape)) + Math.abs(kernel.Shape.volume(ba.shape))
                : null,
    };
});
save("geometry-inspection.json", geometry);
console.log(JSON.stringify({ raw, geometry }, null, 2));
