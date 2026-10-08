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
    const integrityErrors = [];
    try {
        const manifest = JSON.parse(readFileSync(resolve(directory, "onshape/manifest.json"), "utf8"));
        const local = JSON.parse(readFileSync(resolve(directory, "chili3d/measurements.json"), "utf8"));
        const source = readFileSync(resolve(directory, "onshape", manifest.source));
        const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
        if (manifest.sourceSha256 !== hash(source) || local.sourceSha256 !== hash(source))
            integrityErrors.push("Source differs from the cached Onshape or Chili3D execution");
        if (manifest.libraryVersion !== local.libraryVersion)
            integrityErrors.push("FeatureScript standard library versions differ");
        for (const name of names) {
            const cached = manifest.files[name];
            if (!cached) integrityErrors.push(`Missing Onshape cache provenance for ${name}`);
            else {
                const bytes = readFileSync(resolve(directory, "onshape", name));
                if (bytes.length !== cached.bytes || hash(bytes) !== cached.sha256)
                    integrityErrors.push(`Cached Onshape export was changed: ${name}`);
            }
        }
    } catch (error) {
        integrityErrors.push(`Cannot verify execution provenance: ${String(error)}`);
    }
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
        passed: integrityErrors.length === 0 && results.every((result) => result.equal),
        integrityErrors,
        results,
    };
    writeFileSync(resolve(directory, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`);
    for (const result of results)
        console.log(`${result.equal ? "PASS" : "FAIL"} ${result.file}: ${JSON.stringify(result)}`);
    process.exitCode = report.passed ? 0 : 1;
}
