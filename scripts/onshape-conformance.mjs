// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../packages/parametric/test/featurescript/fixtures/conformance",
);
export const manifest = JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8"));

/**
 * @typedef {{id: string, file: string, inputs: Record<string, number | boolean | string>,
 * expectedUnsupported?: string, expectedOperationErrors?: boolean, knownDifferencePaths?: string[],
 * limitation?: string, absoluteTolerance?: number, relativeTolerance?: number, toleranceReason?: string}} ConformanceCase
 */

/** @returns {(ConformanceCase & {source: string, sourceSha256: string})[]} */
export function cases() {
    return manifest.cases.map((item) => {
        const source = readFileSync(join(FIXTURES, item.file), "utf8");
        const sourceSha256 = createHash("sha256").update(source).digest("hex");
        return { ...item, source, sourceSha256 };
    });
}

/** Same lambda locally and remotely; newContext prevents changes to the selected Part Studio. */
export function evaluationScript(item) {
    return `function(existing is Context, queries) { const run = ${item.source}; return run(newContext(), ${JSON.stringify(item.inputs)}); }`;
}

/** Decode only explicit, dimensionless JSON data. Unknown values and missing results fail closed. */
export function decodeOnshape(value) {
    if (!value || typeof value !== "object") throw new Error("Missing FeatureScript result");
    const type = value.btType ?? value.typeName;
    for (const [suffix, primitive] of [
        ["BTFSValueNumber", "number"],
        ["BTFSValueString", "string"],
        ["BTFSValueBoolean", "boolean"],
    ]) {
        if (!type?.endsWith(suffix)) continue;
        if (typeof value.value !== primitive) throw new Error(`Invalid ${primitive} reference result`);
        if (primitive === "number" && !Number.isFinite(value.value))
            throw new Error("Non-finite reference result");
        return value.value;
    }
    if (type?.endsWith("BTFSValueArray")) return value.value.map(decodeOnshape);
    if (type?.endsWith("BTFSValueMap"))
        return Object.fromEntries(
            value.value.map((entry) => [decodeOnshape(entry.key), decodeOnshape(entry.value)]),
        );
    throw new Error(`Unsupported reference value: ${type}`);
}

/** Report all mismatches with paths; topology/booleans/array lengths are exact, measurements toleranced. */
export function differences(
    expected,
    actual,
    at = "$",
    absolute = manifest.absoluteTolerance,
    relative = manifest.relativeTolerance,
) {
    if (expected === undefined || actual === undefined) return [`${at}: missing result or field`];
    if (typeof expected === "number" && typeof actual === "number") {
        const tolerance = /\.(bodies|solids|faces|edges)$/.test(at)
            ? 0
            : absolute + relative * Math.abs(expected);
        return Number.isFinite(actual) && Math.abs(expected - actual) <= tolerance
            ? []
            : [`${at}: expected ${expected}, got ${actual} (tolerance ${tolerance})`];
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || expected.length !== actual.length)
            return [`${at}: array length/type differs`];
        return expected.flatMap((item, i) => differences(item, actual[i], `${at}[${i}]`, absolute, relative));
    }
    if (expected !== null && typeof expected === "object") {
        if (actual === null || typeof actual !== "object" || Array.isArray(actual))
            return [`${at}: object type differs`];
        const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
        return keys.flatMap((key) =>
            differences(expected[key], actual[key], `${at}.${key}`, absolute, relative),
        );
    }
    return expected === actual
        ? []
        : [`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [mode, input, output] = process.argv.slice(2);
    if (mode === "requests") {
        const requests = cases().map((item) => ({
            id: item.id,
            sourceSha256: item.sourceSha256,
            inputs: item.inputs,
            body: { libraryVersion: manifest.libraryVersion, script: evaluationScript(item) },
        }));
        writeFileSync(input, `${JSON.stringify(requests, null, 2)}\n`);
        console.log(`Wrote ${requests.length} evaluation requests to ${input}`);
    } else if (mode === "compare") {
        const reference = JSON.parse(readFileSync(input, "utf8"));
        const local = JSON.parse(readFileSync(output, "utf8"));
        if (
            reference.engine !== "Onshape" ||
            local.engine !== "Chili3D" ||
            reference.libraryVersion !== manifest.libraryVersion ||
            local.libraryVersion !== manifest.libraryVersion
        ) {
            throw new Error(
                "Comparison requires Onshape and Chili3D results for the same pinned standard library",
            );
        }
        let failures = 0;
        for (const item of cases()) {
            const expected = reference.cases.find((c) => c.id === item.id);
            const actual = local.cases.find((c) => c.id === item.id);
            let issues;
            if (!expected || !actual) issues = ["Missing execution result"];
            else if (
                expected.sourceSha256 !== item.sourceSha256 ||
                actual.sourceSha256 !== item.sourceSha256 ||
                JSON.stringify(expected.inputs) !== JSON.stringify(item.inputs) ||
                JSON.stringify(actual.inputs) !== JSON.stringify(item.inputs)
            )
                issues = ["Stale source or inputs"];
            else if (expected.error || actual.error)
                issues = [
                    `Execution failure: Onshape=${expected.error ?? "none"}, Chili3D=${actual.error ?? "none"}`,
                ];
            else
                issues = differences(
                    expected.result,
                    actual.result,
                    "$",
                    item.absoluteTolerance,
                    item.relativeTolerance,
                );
            if (issues.length) failures++;
            console.log(
                `${issues.length ? "FAIL" : "PASS"} ${item.id}${issues.length ? `\n  ${issues.join("\n  ")}` : ""}`,
            );
        }
        console.log(
            `${manifest.cases.length - failures}/${manifest.cases.length} cases match Onshape std ${manifest.libraryVersion}`,
        );
        process.exitCode = failures ? 1 : 0;
    } else {
        console.error(
            "Usage: node scripts/onshape-conformance.mjs requests <output.json> | compare <onshape.json> <chili3d.json>",
        );
        process.exitCode = 2;
    }
}
