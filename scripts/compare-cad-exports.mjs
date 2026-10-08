// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Compare untouched bytes, including metadata, whitespace and line endings. */
export function compareBytes(reference, actual) {
    let firstDifference = 0;
    while (
        firstDifference < Math.min(reference.length, actual.length) &&
        reference[firstDifference] === actual[firstDifference]
    )
        firstDifference++;
    const equal = reference.equals(actual);
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    return {
        equal,
        onshape: { bytes: reference.length, sha256: hash(reference) },
        chili3d: { bytes: actual.length, sha256: hash(actual) },
        firstDifference: equal
            ? null
            : {
                  offset: firstDifference,
                  onshapeByte: reference[firstDifference] ?? null,
                  chili3dByte: actual[firstDifference] ?? null,
              },
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const directory = resolve(process.argv[2] ?? "artifacts/cad-parity-testing");
    const names = ["gallery.step", "drawing.dxf"];
    const results = names.map((name) => {
        try {
            return {
                file: name,
                ...compareBytes(
                    readFileSync(resolve(directory, "onshape", name)),
                    readFileSync(resolve(directory, "chili3d", name)),
                ),
            };
        } catch (error) {
            return { file: name, equal: false, error: String(error) };
        }
    });
    const report = {
        requirement: "Byte-for-byte equality of raw CAD exports; no normalization or tolerances",
        passed: results.every((result) => result.equal),
        results,
    };
    writeFileSync(resolve(directory, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`);
    for (const result of results)
        console.log(`${result.equal ? "PASS" : "FAIL"} ${result.file}: ${JSON.stringify(result)}`);
    process.exitCode = report.passed ? 0 : 1;
}
